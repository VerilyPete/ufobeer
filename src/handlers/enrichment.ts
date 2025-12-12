/**
 * Enrichment Handlers
 *
 * Handles manual enrichment trigger requests from admin endpoints.
 * Includes:
 * - handleEnrichmentTrigger() - POST /admin/enrich/trigger
 * - validateForceEnrichmentRequest() - Validation for force re-enrichment
 *
 * Extracted from index.ts as part of Phase 7 refactoring.
 */

import type {
  Env,
  RequestContext,
  TriggerEnrichmentRequest,
  TriggerEnrichmentData,
  ForceEnrichmentRequest,
  ForceEnrichmentValidationResult,
  QuotaStatus,
} from '../types';
import { shouldSkipEnrichment } from '../config';
import { errorResponse } from '../context';

// ============================================================================
// Request Validation
// ============================================================================

/**
 * Validate force re-enrichment request.
 * IMPORTANT: Either beer_ids OR criteria is required. Empty body is rejected.
 *
 * Moved from types.ts - this contains validation logic beyond type checking.
 */
export function validateForceEnrichmentRequest(body: unknown): ForceEnrichmentValidationResult {
  // Reject null/undefined/non-object
  if (body === null || body === undefined || typeof body !== 'object') {
    return {
      valid: false,
      error: 'Request body must be a JSON object with beer_ids or criteria',
      errorCode: 'INVALID_BODY',
    };
  }

  const req = body as ForceEnrichmentRequest;

  // Must specify either beer_ids OR criteria (not both, not neither)
  const hasBeerIds = req.beer_ids !== undefined;
  const hasCriteria = req.criteria !== undefined;

  if (hasBeerIds && hasCriteria) {
    return {
      valid: false,
      error: 'Cannot specify both beer_ids and criteria',
      errorCode: 'INVALID_REQUEST_BOTH_SPECIFIED',
    };
  }

  if (!hasBeerIds && !hasCriteria) {
    return {
      valid: false,
      error: 'Must specify either beer_ids or criteria',
      errorCode: 'INVALID_REQUEST_NEITHER_SPECIFIED',
    };
  }

  // Validate beer_ids
  if (hasBeerIds) {
    if (!Array.isArray(req.beer_ids)) {
      return { valid: false, error: 'beer_ids must be an array', errorCode: 'INVALID_BEER_IDS' };
    }
    if (req.beer_ids.length === 0) {
      return { valid: false, error: 'beer_ids cannot be empty', errorCode: 'INVALID_BEER_IDS_EMPTY' };
    }
    if (req.beer_ids.length > 100) {
      return { valid: false, error: 'beer_ids max 100 items', errorCode: 'INVALID_BEER_IDS_TOO_MANY' };
    }
    if (!req.beer_ids.every(id => typeof id === 'string' && id.length > 0)) {
      return { valid: false, error: 'All beer_ids must be non-empty strings', errorCode: 'INVALID_BEER_IDS_FORMAT' };
    }
  }

  // Validate criteria
  if (hasCriteria) {
    if (typeof req.criteria !== 'object' || req.criteria === null) {
      return { valid: false, error: 'criteria must be an object', errorCode: 'INVALID_CRITERIA' };
    }
    if (Object.keys(req.criteria).length === 0) {
      return { valid: false, error: 'criteria cannot be empty', errorCode: 'INVALID_CRITERIA_EMPTY' };
    }

    // confidence_below: 0.0-1.0
    if (req.criteria.confidence_below !== undefined) {
      const c = req.criteria.confidence_below;
      if (typeof c !== 'number' || c < 0 || c > 1) {
        return { valid: false, error: 'confidence_below must be 0.0-1.0', errorCode: 'INVALID_CONFIDENCE' };
      }
    }

    // enrichment_older_than_days: positive integer
    if (req.criteria.enrichment_older_than_days !== undefined) {
      const d = req.criteria.enrichment_older_than_days;
      if (typeof d !== 'number' || d < 1 || !Number.isInteger(d)) {
        return { valid: false, error: 'enrichment_older_than_days must be positive integer', errorCode: 'INVALID_DAYS' };
      }
    }

    // enrichment_source: 'perplexity' | 'manual'
    if (req.criteria.enrichment_source !== undefined) {
      if (!['perplexity', 'manual'].includes(req.criteria.enrichment_source)) {
        return { valid: false, error: "enrichment_source must be 'perplexity' or 'manual'", errorCode: 'INVALID_SOURCE' };
      }
    }
  }

  // Validate limit: 1-100
  if (req.limit !== undefined) {
    if (typeof req.limit !== 'number' || req.limit < 1 || req.limit > 100) {
      return { valid: false, error: 'limit must be 1-100', errorCode: 'INVALID_LIMIT' };
    }
  }

  // Validate dry_run: boolean
  if (req.dry_run !== undefined && typeof req.dry_run !== 'boolean') {
    return { valid: false, error: 'dry_run must be boolean', errorCode: 'INVALID_DRY_RUN' };
  }

  // Validate admin_id: non-empty string if provided
  if (req.admin_id !== undefined) {
    if (typeof req.admin_id !== 'string' || req.admin_id.trim().length === 0) {
      return { valid: false, error: 'admin_id must be non-empty string', errorCode: 'INVALID_ADMIN_ID' };
    }
  }

  return { valid: true };
}

// ============================================================================
// Enrichment Trigger Handler
// ============================================================================

/**
 * POST /admin/enrich/trigger - Manually trigger enrichment queue processing
 *
 * IMPORTANT: This endpoint only CHECKS quota and queues beers.
 * The queue consumer is the single source of truth for quota reservation.
 * This avoids double-counting that would occur if both trigger and consumer
 * reserved quota.
 */
export async function handleEnrichmentTrigger(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  const dailyLimit = parseInt(env.DAILY_ENRICHMENT_LIMIT || '500');
  const monthlyLimit = parseInt(env.MONTHLY_ENRICHMENT_LIMIT || '2000');
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const monthStart = today.slice(0, 7) + '-01';
  // Calculate last day of current month correctly
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthEnd = today.slice(0, 7) + '-' + String(lastDayOfMonth).padStart(2, '0');

  try {
    // Parse request body
    const body = await request.json().catch(() => ({})) as TriggerEnrichmentRequest;
    const requestedLimit = Math.min(Math.max(1, body.limit || 50), 100); // Clamp to 1-100
    const excludeFailures = body.exclude_failures ?? false;

    // Helper to build response
    const buildResponse = (
      beersQueued: number,
      skipReason: TriggerEnrichmentData['skip_reason'] | undefined,
      dailyUsed: number,
      monthlyUsed: number
    ): Response => {
      const data: TriggerEnrichmentData = {
        beers_queued: beersQueued,
        skip_reason: skipReason,
        quota: {
          daily: {
            used: dailyUsed,
            limit: dailyLimit,
            remaining: Math.max(0, dailyLimit - dailyUsed),
          },
          monthly: {
            used: monthlyUsed,
            limit: monthlyLimit,
            remaining: Math.max(0, monthlyLimit - monthlyUsed),
          },
        },
        enabled: env.ENRICHMENT_ENABLED !== 'false',
        filters: {
          exclude_failures: excludeFailures,
        },
      };

      // Remove skip_reason if not set
      if (!data.skip_reason) {
        delete data.skip_reason;
      }

      return Response.json({
        success: true,
        requestId: reqCtx.requestId,
        data,
      }, { headers });
    };

    // Layer 3: Kill switch check
    if (env.ENRICHMENT_ENABLED === 'false') {
      console.log(`[trigger] Kill switch active, requestId=${reqCtx.requestId}`);
      return buildResponse(0, 'kill_switch', 0, 0);
    }

    // Get current quota usage (read-only - no reservation!)
    let dailyUsed = 0;
    let monthlyUsed = 0;
    try {
      const dailyCount = await env.DB.prepare(
        `SELECT request_count FROM enrichment_limits WHERE date = ?`
      ).bind(today).first<{ request_count: number }>();
      dailyUsed = dailyCount?.request_count || 0;

      const monthlyCount = await env.DB.prepare(
        `SELECT SUM(request_count) as total FROM enrichment_limits
         WHERE date >= ? AND date <= ?`
      ).bind(monthStart, monthEnd).first<{ total: number }>();
      monthlyUsed = monthlyCount?.total || 0;
    } catch (dbError) {
      console.error(`[trigger] D1 unavailable for quota check:`, dbError);
      return errorResponse(
        'Database temporarily unavailable',
        'DB_UNAVAILABLE',
        { requestId: reqCtx.requestId, headers, status: 503 }
      );
    }

    // Layer 2: Monthly limit check
    if (monthlyUsed >= monthlyLimit) {
      console.log(`[trigger] Monthly limit reached (${monthlyUsed}/${monthlyLimit}), requestId=${reqCtx.requestId}`);
      return buildResponse(0, 'monthly_limit', dailyUsed, monthlyUsed);
    }

    // Layer 1: Daily limit check
    const dailyRemaining = dailyLimit - dailyUsed;
    if (dailyRemaining <= 0) {
      console.log(`[trigger] Daily limit reached (${dailyUsed}/${dailyLimit}), requestId=${reqCtx.requestId}`);
      return buildResponse(0, 'daily_limit', dailyUsed, monthlyUsed);
    }

    // Calculate effective batch size: min(requested, dailyRemaining, monthlyRemaining, 100)
    // 100 is the max for sendBatch()
    const monthlyRemaining = monthlyLimit - monthlyUsed;
    const effectiveBatchSize = Math.min(requestedLimit, dailyRemaining, monthlyRemaining, 100);

    // Query beers with NULL ABV
    let query = `
      SELECT id, brew_name, brewer
      FROM enriched_beers
      WHERE abv IS NULL
    `;

    // Optionally exclude beers that have failed (exist in DLQ)
    if (excludeFailures) {
      query += `
        AND id NOT IN (
          SELECT beer_id FROM dlq_messages WHERE status = 'pending'
        )
      `;
    }

    query += `LIMIT ?`;

    const beersToEnrich = await env.DB.prepare(query)
      .bind(effectiveBatchSize)
      .all<{ id: string; brew_name: string; brewer: string }>();

    if (!beersToEnrich.results || beersToEnrich.results.length === 0) {
      console.log(`[trigger] No eligible beers found, requestId=${reqCtx.requestId}`);
      return buildResponse(0, 'no_eligible_beers', dailyUsed, monthlyUsed);
    }

    // Filter out blocklisted items (flights, mixed drinks, etc.)
    const eligibleBeers = beersToEnrich.results.filter(
      beer => !shouldSkipEnrichment(beer.brew_name)
    );

    if (eligibleBeers.length === 0) {
      console.log(`[trigger] All ${beersToEnrich.results.length} beers are blocklisted, requestId=${reqCtx.requestId}`);
      return buildResponse(0, 'no_eligible_beers', dailyUsed, monthlyUsed);
    }

    const skippedCount = beersToEnrich.results.length - eligibleBeers.length;
    if (skippedCount > 0) {
      console.log(`[trigger] Skipped ${skippedCount} blocklisted items`);
    }

    // Queue beers for enrichment using sendBatch (max 100 messages)
    await env.ENRICHMENT_QUEUE.sendBatch(
      eligibleBeers.map((beer) => ({
        body: {
          beerId: beer.id,
          beerName: beer.brew_name,
          brewer: beer.brewer,
        },
      }))
    );

    const beersQueued = eligibleBeers.length;
    console.log(`[trigger] Queued ${beersQueued} beers for enrichment, requestId=${reqCtx.requestId}, excludeFailures=${excludeFailures}`);

    return buildResponse(beersQueued, undefined, dailyUsed, monthlyUsed);

  } catch (error) {
    console.error(`[trigger] Failed to trigger enrichment:`, error);
    return errorResponse(
      'Failed to trigger enrichment',
      'TRIGGER_ERROR',
      { requestId: reqCtx.requestId, headers, status: 500 }
    );
  }
}
