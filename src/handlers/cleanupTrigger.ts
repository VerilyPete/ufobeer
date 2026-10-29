/**
 * Cleanup Trigger Handler
 *
 * Handles manual cleanup trigger requests from admin endpoints.
 * POST /admin/cleanup/trigger
 *
 * Allows triggering description cleanup for:
 * - Historical beers not on current taplist (mode: 'missing')
 * - Beers cleaned by an older CLEANUP_VERSION, for re-processing (mode: 'all')
 */

import type {
  Env,
  RequestContext,
  TriggerCleanupData,
  CleanupPreview,
  CleanupTriggerValidationResult,
} from '../types';
import { CLEANUP_TRIGGER_CONSTANTS } from '../types';
import { errorResponse } from '../context';
import { queueBeersForCleanup } from '../queue';
import { hashDescription } from '../utils/hash';
import { readBoundedJson, boundedJsonErrorResponse } from '../utils/body';
import { CLEANUP_VERSION, SMALL_JSON_BODY_MAX_BYTES } from '../constants';
import { TriggerCleanupRequestSchema } from '../schemas/request';
import { mapZodIssueToErrorCode, extractZodErrorMessage } from '../schemas/errors';

// ============================================================================
// Types
// ============================================================================

/** Beers never cleaned and not already waiting in the queue. */
const NEVER_CLEANED = `
  brew_description_original IS NOT NULL
  AND brew_description_original != ''
  AND brew_description_cleaned IS NULL
  AND queued_for_cleanup_at IS NULL
`;

/**
 * Beers whose cleaned description came from legacy cleanup (NULL version)
 * or an older version of the rules. Binds CLEANUP_VERSION. A re-cleaned
 * beer stops matching, so repeated limited runs work through the table.
 */
const OUTDATED_CLEANUP = `
  brew_description_original IS NOT NULL
  AND brew_description_original != ''
  AND (cleanup_version IS NULL OR cleanup_version < ?)
`;

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
  const result = await db.prepare(`
    SELECT COUNT(*) as count FROM enriched_beers
    WHERE ${OUTDATED_CLEANUP}
  `).bind(CLEANUP_VERSION).first<{ count: number }>();

  const total = result?.count ?? 0;

  return {
    beers_would_reset: total,
    beers_total: total,
  };
}

/**
 * Query eligible beers based on mode.
 */
async function queryEligibleBeers(
  db: D1Database,
  mode: 'all' | 'missing',
  limit: number
): Promise<{ beers: BeerRow[]; totalCount: number }> {
  const [where, params] = mode === 'missing'
    ? [NEVER_CLEANED, []]
    : [OUTDATED_CLEANUP, [CLEANUP_VERSION]];

  const [beersResult, countResult] = await Promise.all([
    db.prepare(`
      SELECT id, brew_name, brewer, brew_description_original
      FROM enriched_beers
      WHERE ${where}
      LIMIT ?
    `).bind(...params, limit).all<BeerRow>(),
    db.prepare(`SELECT COUNT(*) as count FROM enriched_beers WHERE ${where}`)
      .bind(...params).first<{ count: number }>(),
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
 * Build batch statements for re-cleaning outdated beers (mode: 'all'). The
 * cleaned description is left in place so clients keep seeing it until the
 * consumer overwrites it; the hash is refreshed so that write is accepted.
 */
function buildResetStatements(
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

  try {
    // 1. Read and parse the bounded request body
    const bodyResult = await readBoundedJson(request, SMALL_JSON_BODY_MAX_BYTES);
    if (!bodyResult.ok) {
      return boundedJsonErrorResponse(bodyResult, reqCtx.requestId, headers);
    }
    const body: unknown = bodyResult.data;

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
        ...(mode === 'all' ? { beers_reset: 0 } : {}),
        beers_remaining: 0,
        mode,
        dry_run: dryRun,
        skip_reason: 'no_eligible_beers',
      };
      return Response.json({ success: true, data, requestId: reqCtx.requestId }, { headers });
    }

    const remainingCount = Math.max(0, totalCount - beers.length);

    // 8. Dry run - return what would happen without making changes
    if (dryRun) {
      const data: TriggerCleanupData = {
        operation_id: operationId,
        beers_queued: beers.length,
        ...(mode === 'all' ? { beers_reset: beers.length } : {}),
        beers_remaining: remainingCount,
        mode,
        dry_run: true,
      };
      return Response.json({ success: true, data, requestId: reqCtx.requestId }, { headers });
    }

    // 9. Compute hashes for all beers
    const beersWithHashes: BeerWithHash[] = await Promise.all(
      beers.map(async (beer) => ({
        id: beer.id,
        brew_description_original: beer.brew_description_original,
        descriptionHash: await hashDescription(beer.brew_description_original),
      }))
    );

    // 10. Queue beers for cleanup FIRST, then write the marking/reset
    // statements for what was actually sent.
    //
    // The old write-then-send order was a stranding bug here too — worse than
    // the sync path: mode=missing eligibility rides
    // `queued_for_cleanup_at IS NULL`, so beers marked but never sent are
    // excluded from every future run indefinitely (no cooldown-based
    // recovery). Send-then-mark's failure mode (marked-but-duplicated
    // cleanup) is benign because cleanup writes are idempotent.
    const now = Date.now();
    const hashById = new Map(beersWithHashes.map(beer => [beer.id, beer.descriptionHash]));
    const beersToQueue = beers.map(beer => ({
      id: beer.id,
      brew_name: beer.brew_name,
      brewer: beer.brewer || '',
      brew_description: beer.brew_description_original,
      // Same hash already computed above for the D1 write (step 9) --
      // binds the outgoing cleanup message to the exact description version
      // it was built from. NOTE: queueBeersForCleanup (src/queue/helpers.ts)
      // does not yet read or forward this field onto the CleanupMessage it
      // sends -- see the security review's "stale-result binding" item.
      descriptionHash: hashById.get(beer.id) as string,
    }));

    const queueResult = await queueBeersForCleanup(env, beersToQueue, reqCtx.requestId);
    const sentSet = new Set(queueResult.queuedIds ?? []);
    const sentHashes = beersWithHashes.filter(beer => sentSet.has(beer.id));

    let statements: D1PreparedStatement[];
    if (mode === 'all') {
      statements = buildResetStatements(env.DB, sentHashes, now);
    } else {
      statements = buildQueuedTimestampStatements(env.DB, sentHashes, now);
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

    // 11. Update cooldown timestamp
    await updateCooldown(env.DB);

    // 13. Build and return response
    const data: TriggerCleanupData = {
      operation_id: operationId,
      beers_queued: queueResult.queued,
      ...(mode === 'all' ? { beers_reset: queueResult.queued } : {}),
      beers_remaining: remainingCount,
      mode,
      dry_run: false,
    };

    console.log(JSON.stringify({
      event: 'cleanup_trigger_complete',
      operation_id: operationId,
      mode,
      beers_queued: queueResult.queued,
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
