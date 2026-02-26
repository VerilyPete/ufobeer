/**
 * Cleanup Trigger Handler
 *
 * Handles manual cleanup trigger requests from admin endpoints.
 * POST /admin/cleanup/trigger
 *
 * Allows triggering description cleanup for:
 * - Historical beers not on current taplist (mode: 'missing')
 * - All beers for re-processing (mode: 'all')
 */

import type {
  Env,
  RequestContext,
  TriggerCleanupData,
  CleanupPreview,
  CleanupTriggerValidationResult,
} from '../types';
import { CLEANUP_TRIGGER_CONSTANTS } from '../types';
import { shouldSkipEnrichment } from '../config';
import { errorResponse } from '../context';
import { queueBeersForCleanup } from '../queue';
import { hashDescription } from '../utils/hash';
import { TriggerCleanupRequestSchema } from '../schemas/request';
import { mapZodIssueToErrorCode, extractZodErrorMessage } from '../schemas/errors';

// ============================================================================
// Types
// ============================================================================

type BeerRow = {
  readonly id: string;
  readonly brew_name: string;
  readonly brewer: string | null;
  readonly brew_description_original: string;
};

// ============================================================================
// Request Validation
// ============================================================================

/**
 * Validate cleanup trigger request using TriggerCleanupRequestSchema.
 * Preserves backwards-compatible error codes via mapZodIssueToErrorCode.
 */
export function validateCleanupTriggerRequest(body: unknown): CleanupTriggerValidationResult {
  if (body === null || body === undefined || typeof body !== 'object') {
    return {
      valid: false,
      error: 'Request body must be a JSON object',
      errorCode: 'INVALID_BODY',
    };
  }

  const result = TriggerCleanupRequestSchema.safeParse(body);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    if (!firstIssue) {
      return { valid: false, error: 'Invalid request', errorCode: 'INVALID_REQUEST' };
    }
    const errorCode = mapZodIssueToErrorCode(firstIssue);
    const errorMessage = extractZodErrorMessage(firstIssue);
    return {
      valid: false,
      error: errorMessage,
      errorCode,
    };
  }
  return { valid: true };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check cooldown and return error response if within window.
 * Returns null if cooldown check passes.
 */
async function checkCooldown(
  db: D1Database,
  headers: Record<string, string>,
  requestId: string
): Promise<Response | null> {
  const now = Date.now();
  const { COOLDOWN_MS, COOLDOWN_KEY } = CLEANUP_TRIGGER_CONSTANTS;

  const current = await db.prepare(
    `SELECT CAST(value AS INTEGER) as last_run FROM system_state WHERE key = ?`
  ).bind(COOLDOWN_KEY).first<{ last_run: number }>();

  if (current && (now - current.last_run) < COOLDOWN_MS) {
    const retryAfter = Math.ceil((COOLDOWN_MS - (now - current.last_run)) / 1000);
    // Manual response to put retry_after_seconds inside error object
    // (errorResponse() puts extra fields at root level due to design limitation)
    return Response.json({
      success: false,
      error: {
        message: 'Another cleanup trigger operation is in progress. Please wait.',
        code: 'OPERATION_IN_PROGRESS',
        retry_after_seconds: retryAfter,
      },
      requestId,
    }, { status: 429, headers });
  }

  return null;
}

/**
 * Update cooldown timestamp atomically.
 */
async function updateCooldown(db: D1Database): Promise<void> {
  const now = Date.now();
  const { COOLDOWN_KEY } = CLEANUP_TRIGGER_CONSTANTS;

  await db.prepare(`
    INSERT INTO system_state (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).bind(COOLDOWN_KEY, String(now), now).run();
}

/**
 * Get preview counts for mode: 'all' without confirm.
 */
async function getPreviewCounts(db: D1Database): Promise<CleanupPreview> {
  // Note: beers_would_skip is an estimate (0) - actual skip count determined at execution time
  // This avoids loading thousands of beer names just for preview
  const result = await db.prepare(`
    SELECT COUNT(*) as count FROM enriched_beers
    WHERE brew_description_original IS NOT NULL
      AND brew_description_original != ''
  `).first<{ count: number }>();

  const total = result?.count ?? 0;

  return {
    beers_would_reset: total,  // Upper bound - actual may be lower due to blocklist
    beers_would_skip: 0,       // Estimate - blocklisted beers determined at execution time
    beers_total: total,
  };
}

/**
 * Get current daily quota usage.
 */
async function getDailyQuotaUsage(db: D1Database): Promise<number> {
  const parts = new Date().toISOString().split('T');
  const today = parts[0] ?? '';
  const result = await db.prepare(
    `SELECT request_count FROM cleanup_limits WHERE date = ?`
  ).bind(today).first<{ request_count: number }>();
  return result?.request_count ?? 0;
}

/**
 * Query eligible beers based on mode.
 */
async function queryEligibleBeers(
  db: D1Database,
  mode: 'all' | 'missing',
  limit: number
): Promise<{ beers: BeerRow[]; totalCount: number }> {
  let query: string;
  let countQuery: string;

  if (mode === 'missing') {
    query = `
      SELECT id, brew_name, brewer, brew_description_original
      FROM enriched_beers
      WHERE brew_description_original IS NOT NULL
        AND brew_description_original != ''
        AND brew_description_cleaned IS NULL
        AND queued_for_cleanup_at IS NULL
      LIMIT ?
    `;
    countQuery = `
      SELECT COUNT(*) as count FROM enriched_beers
      WHERE brew_description_original IS NOT NULL
        AND brew_description_original != ''
        AND brew_description_cleaned IS NULL
        AND queued_for_cleanup_at IS NULL
    `;
  } else {
    query = `
      SELECT id, brew_name, brewer, brew_description_original
      FROM enriched_beers
      WHERE brew_description_original IS NOT NULL
        AND brew_description_original != ''
      LIMIT ?
    `;
    countQuery = `
      SELECT COUNT(*) as count FROM enriched_beers
      WHERE brew_description_original IS NOT NULL
        AND brew_description_original != ''
    `;
  }

  const [beersResult, countResult] = await Promise.all([
    db.prepare(query).bind(limit).all<BeerRow>(),
    db.prepare(countQuery).first<{ count: number }>(),
  ]);

  return {
    beers: beersResult.results ?? [],
    totalCount: countResult?.count ?? 0,
  };
}

/**
 * Beer with computed description hash for database updates.
 */
type BeerWithHash = {
  readonly id: string;
  readonly brew_description_original: string;
  readonly descriptionHash: string;
};

/**
 * Build batch statements for resetting cleanup fields (mode: 'all').
 */
function buildResetStatements(
  db: D1Database,
  beers: BeerWithHash[],
  now: number
): D1PreparedStatement[] {
  // Build UPDATE statements for each beer
  // Using individual statements for clarity; could optimize with batch syntax
  return beers.map(beer =>
    db.prepare(`
      UPDATE enriched_beers SET
        brew_description_cleaned = NULL,
        description_cleaned_at = NULL,
        cleanup_source = NULL,
        description_hash = ?,
        queued_for_cleanup_at = ?
      WHERE id = ?
    `).bind(beer.descriptionHash, now, beer.id)
  );
}

/**
 * Build batch statements for setting queued timestamp (mode: 'missing').
 */
function buildQueuedTimestampStatements(
  db: D1Database,
  beers: BeerWithHash[],
  now: number
): D1PreparedStatement[] {
  return beers.map(beer =>
    db.prepare(`
      UPDATE enriched_beers SET
        description_hash = ?,
        queued_for_cleanup_at = ?
      WHERE id = ?
    `).bind(beer.descriptionHash, now, beer.id)
  );
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * POST /admin/cleanup/trigger - Manually trigger description cleanup
 *
 * Request body:
 * - mode: 'all' | 'missing' (required)
 * - limit: number (1-500, default 500)
 * - dry_run: boolean (default false)
 * - confirm: boolean (required for mode: 'all')
 *
 * Returns stats on beers queued, skipped, and reset.
 */
export async function handleCleanupTrigger(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  const operationId = `cleanup-trigger-${Date.now()}`;
  const { MAX_LIMIT, DEFAULT_LIMIT, D1_BATCH_SIZE } = CLEANUP_TRIGGER_CONSTANTS;
  const dailyLimit = parseInt(env.DAILY_CLEANUP_LIMIT || '1000', 10);

  try {
    // 1. Parse request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(
        'Invalid JSON body',
        'INVALID_PARAMS',
        { requestId: reqCtx.requestId, headers, status: 400 }
      );
    }

    // 2. Validate request body
    const validation = validateCleanupTriggerRequest(body);
    if (!validation.valid) {
      return errorResponse(
        validation.error!,
        validation.errorCode ?? 'INVALID_PARAMS',
        { requestId: reqCtx.requestId, headers, status: 400 }
      );
    }

    // Parse with schema to get typed data (validation already passed above)
    const request_ = TriggerCleanupRequestSchema.parse(body);
    const limit = Math.min(Math.max(request_.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const dryRun = request_.dry_run ?? false;
    const mode = request_.mode;

    // 3. Check cooldown (skip for dry run)
    if (!dryRun) {
      const cooldownError = await checkCooldown(env.DB, headers, reqCtx.requestId);
      if (cooldownError) return cooldownError;
    }

    // 4. For mode='all' without confirm: return preview (unless dry_run which is safe)
    if (mode === 'all' && !request_.confirm && !dryRun) {
      const preview = await getPreviewCounts(env.DB);
      return Response.json({
        success: false,
        error: {
          message: "mode: 'all' requires confirm: true to prevent accidental data reset",
          code: 'CONFIRMATION_REQUIRED',
        },
        preview,
        requestId: reqCtx.requestId,
      }, { status: 400, headers });
    }

    // 5. Get current quota usage
    const quotaUsed = await getDailyQuotaUsage(env.DB);

    // 6. Query eligible beers
    let beers: BeerRow[];
    let totalCount: number;
    try {
      const result = await queryEligibleBeers(env.DB, mode, limit);
      beers = result.beers;
      totalCount = result.totalCount;
    } catch (dbError) {
      console.error(`[cleanup-trigger] D1 unavailable:`, dbError);
      return errorResponse(
        'Database temporarily unavailable',
        'DB_UNAVAILABLE',
        { requestId: reqCtx.requestId, headers, status: 503 }
      );
    }

    if (beers.length === 0) {
      const data: TriggerCleanupData = {
        operation_id: operationId,
        beers_queued: 0,
        beers_skipped: 0,
        ...(mode === 'all' ? { beers_reset: 0 } : {}),
        beers_remaining: 0,
        mode,
        dry_run: dryRun,
        skip_reason: 'no_eligible_beers',
        quota: {
          daily: {
            used: quotaUsed,
            limit: dailyLimit,
            remaining: Math.max(0, dailyLimit - quotaUsed),
            projected_after: quotaUsed,
          },
        },
      };
      return Response.json({ success: true, data, requestId: reqCtx.requestId }, { headers });
    }

    // 7. Filter blocklisted items
    const eligibleBeers = beers.filter(b => !shouldSkipEnrichment(b.brew_name));
    const skippedCount = beers.length - eligibleBeers.length;
    const remainingCount = Math.max(0, totalCount - beers.length);

    if (eligibleBeers.length === 0) {
      const data: TriggerCleanupData = {
        operation_id: operationId,
        beers_queued: 0,
        beers_skipped: skippedCount,
        ...(mode === 'all' ? { beers_reset: 0 } : {}),
        beers_remaining: remainingCount,
        mode,
        dry_run: dryRun,
        skip_reason: 'no_eligible_beers',
        quota: {
          daily: {
            used: quotaUsed,
            limit: dailyLimit,
            remaining: Math.max(0, dailyLimit - quotaUsed),
            projected_after: quotaUsed,
          },
        },
      };
      return Response.json({ success: true, data, requestId: reqCtx.requestId }, { headers });
    }

    // 8. Check quota before processing (skip for dry run - allows preview)
    const projectedAfter = quotaUsed + eligibleBeers.length;
    if (!dryRun && projectedAfter > dailyLimit) {
      return errorResponse(
        `Operation would exceed daily quota. Limit: ${dailyLimit}, Current: ${quotaUsed}, Requested: ${eligibleBeers.length}`,
        'QUOTA_EXCEEDED',
        { requestId: reqCtx.requestId, headers, status: 429, extra: {
          quota: {
            daily: {
              used: quotaUsed,
              limit: dailyLimit,
              remaining: Math.max(0, dailyLimit - quotaUsed),
              requested: eligibleBeers.length,
            },
          },
        }}
      );
    }

    // 9. Dry run - return what would happen without making changes
    if (dryRun) {
      const data: TriggerCleanupData = {
        operation_id: operationId,
        beers_queued: eligibleBeers.length,
        beers_skipped: skippedCount,
        ...(mode === 'all' ? { beers_reset: eligibleBeers.length } : {}),
        beers_remaining: remainingCount,
        mode,
        dry_run: true,
        quota: {
          daily: {
            used: quotaUsed,
            limit: dailyLimit,
            remaining: Math.max(0, dailyLimit - quotaUsed),
            projected_after: projectedAfter,
          },
        },
      };
      return Response.json({ success: true, data, requestId: reqCtx.requestId }, { headers });
    }

    // 10. Compute hashes for all eligible beers
    const beersWithHashes: BeerWithHash[] = await Promise.all(
      eligibleBeers.map(async (beer) => ({
        id: beer.id,
        brew_description_original: beer.brew_description_original,
        descriptionHash: await hashDescription(beer.brew_description_original),
      }))
    );

    // 11. Build and execute batch database updates
    const now = Date.now();
    let statements: D1PreparedStatement[];

    if (mode === 'all') {
      statements = buildResetStatements(env.DB, beersWithHashes, now);
    } else {
      statements = buildQueuedTimestampStatements(env.DB, beersWithHashes, now);
    }

    // Execute in batches (D1 limit)
    try {
      for (let i = 0; i < statements.length; i += D1_BATCH_SIZE) {
        const batch = statements.slice(i, i + D1_BATCH_SIZE);
        await env.DB.batch(batch);
      }
    } catch (dbError) {
      console.error(`[cleanup-trigger] D1 unavailable for batch update:`, dbError);
      return errorResponse(
        'Database temporarily unavailable',
        'DB_UNAVAILABLE',
        { requestId: reqCtx.requestId, headers, status: 503 }
      );
    }

    // 12. Update cooldown timestamp
    await updateCooldown(env.DB);

    // 13. Queue beers for cleanup
    const beersToQueue = eligibleBeers.map(beer => ({
      id: beer.id,
      brew_name: beer.brew_name,
      brewer: beer.brewer || '',
      brew_description: beer.brew_description_original,
    }));

    const queueResult = await queueBeersForCleanup(env, beersToQueue, reqCtx.requestId);

    // 14. Build and return response
    const projectedAfterQueued = quotaUsed + queueResult.queued;
    const data: TriggerCleanupData = {
      operation_id: operationId,
      beers_queued: queueResult.queued,
      beers_skipped: skippedCount + queueResult.skipped,
      ...(mode === 'all' ? { beers_reset: queueResult.queued } : {}),
      beers_remaining: remainingCount,
      mode,
      dry_run: false,
      quota: {
        daily: {
          used: quotaUsed,
          limit: dailyLimit,
          remaining: Math.max(0, dailyLimit - quotaUsed),
          projected_after: projectedAfterQueued,
        },
      },
    };

    console.log(JSON.stringify({
      event: 'cleanup_trigger_complete',
      operation_id: operationId,
      mode,
      beers_queued: queueResult.queued,
      beers_skipped: skippedCount + queueResult.skipped,
      beers_reset: mode === 'all' ? queueResult.queued : 0,
      request_id: reqCtx.requestId,
    }));

    return Response.json({ success: true, data, requestId: reqCtx.requestId }, { headers });

  } catch (error) {
    console.error('[cleanup-trigger] Error:', error);
    return errorResponse(
      'Failed to trigger cleanup',
      'TRIGGER_ERROR',
      { requestId: reqCtx.requestId, headers, status: 500 }
    );
  }
}
