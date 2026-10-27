/**
 * Enrichment Handlers
 *
 * Handles manual enrichment trigger requests from admin endpoints.
 * Includes:
 * - handleEnrichmentTrigger() - POST /admin/enrich/trigger
 *
 * Extracted from index.ts as part of Phase 7 refactoring.
 */

import type {
  Env,
  RequestContext,
  TriggerEnrichmentData,
} from '../types';
import { shouldSkipEnrichment } from '../config';
import { errorResponse } from '../context';
import { getToday, getMonthEnd } from '../utils/date';
import { readBoundedJson, boundedJsonErrorResponse } from '../utils/body';
import { SMALL_JSON_BODY_MAX_BYTES, ABV_LOOKUP_MISS_RETRY_MS, ABV_LOOKUP_RECENTLY_SEEN_MS } from '../constants';
import {
  TriggerEnrichmentRequestSchema,
} from '../schemas/request';

// ============================================================================
// Shared Pending-Beer Queueing (used by the admin trigger and the cron sweep)
// ============================================================================

export type QueuePendingResult = {
  /** Eligible beers actually sent to the enrichment queue */
  readonly beersQueued: number;
  /** Blocklisted beers marked enrichment_status = 'skipped' */
  readonly blocklistedMarked: number;
  /** True when nothing was (or could be) queued */
  readonly noEligibleBeers: boolean;
};

/**
 * Select pending beers, mark blocklisted ones as skipped, and queue the rest.
 *
 * Shared by POST /admin/enrich/trigger and the cron enrichment sweep, which
 * previously carried two divergent copies of this logic. Quota checks and
 * response building stay at the call sites. Blocklisted beers are marked
 * skipped even when nothing is left to queue, so they cannot fill every
 * future selection and starve eligible beers beyond the limit.
 */
export async function selectAndQueuePendingEnrichment(
  env: Env,
  options: { limit: number; excludeFailures?: boolean }
): Promise<QueuePendingResult> {
  // A provider's explicit unknown is a temporary lookup miss, not a permanent
  // exclusion. Revisit only recently seen beers, at most once per day, through
  // the existing quota-checked queue path. Never retry on each client refresh.
  const now = Date.now();
  const missCutoff = now - ABV_LOOKUP_MISS_RETRY_MS;
  const seenCutoff = now - ABV_LOOKUP_RECENTLY_SEEN_MS;
  let query = `
    SELECT id, brew_name, brewer, description_hash, enrichment_status
    FROM enriched_beers
    WHERE (enrichment_status = 'pending' OR (enrichment_status = 'not_found' AND abv IS NULL AND updated_at <= ${missCutoff} AND last_seen_at >= ${seenCutoff}))
  `;
  if (options.excludeFailures) {
    query += `
      AND id NOT IN (
        SELECT beer_id FROM dlq_messages WHERE status = 'pending'
      )
    `;
  }
  query += `LIMIT ?`;

  const beersToEnrich = await env.DB.prepare(query)
    .bind(options.limit)
    .all<{ id: string; brew_name: string; brewer: string; description_hash: string | null; enrichment_status?: string }>();

  if (!beersToEnrich.results || beersToEnrich.results.length === 0) {
    return { beersQueued: 0, blocklistedMarked: 0, noEligibleBeers: true };
  }

  // Filter out blocklisted items (flights, mixed drinks, etc.)
  const candidates = beersToEnrich.results.filter(
    beer => !shouldSkipEnrichment(beer.brew_name)
  );

  const eligibleBeers = [];
  for (const beer of candidates) {
    if (beer.enrichment_status === 'not_found') {
      // Atomic claim: concurrent sweeps or a newly enriched row cannot be
      // overwritten. A send failure leaves pending work recoverable next pass.
      const claim = await env.DB.prepare(`UPDATE enriched_beers
        SET enrichment_status = 'pending', updated_at = ?
        WHERE id = ? AND enrichment_status = 'not_found' AND abv IS NULL
          AND updated_at <= ? AND last_seen_at >= ? AND description_hash IS ?`)
        .bind(now, beer.id, missCutoff, seenCutoff, beer.description_hash).run();
      if (claim.meta?.changes !== 1) continue;
    }
    eligibleBeers.push(beer);
  }

  // Mark blocklisted beers as skipped so they don't appear in future queries.
  // Done before the no-eligible return: otherwise a selection made up only of
  // blocklisted rows is reselected every sweep and starves valid work.
  const blocklistedBeers = beersToEnrich.results.filter(
    beer => shouldSkipEnrichment(beer.brew_name)
  );
  if (blocklistedBeers.length > 0) {
    const skipStatements = blocklistedBeers.map(beer =>
      env.DB.prepare(
        `UPDATE enriched_beers SET enrichment_status = 'skipped' WHERE id = ?`
      ).bind(beer.id)
    );
    await env.DB.batch(skipStatements);
  }

  if (eligibleBeers.length === 0) {
    return { beersQueued: 0, blocklistedMarked: blocklistedBeers.length, noEligibleBeers: true };
  }

  await env.ENRICHMENT_QUEUE.sendBatch(
    eligibleBeers.map((beer) => ({
      body: {
        beerId: beer.id,
        beerName: beer.brew_name,
        brewer: beer.brewer,
        // Stamps the message with the row's current description_hash for
        // stale-result binding parity with cleanup.ts (Cloudflare security
        // review Phase 1, item 2a/5). EnrichmentMessage.descriptionHash is
        // required-but-nullable, so the row's null (no description) is
        // sent as a literal null, not omitted.
        descriptionHash: beer.description_hash,
      },
    }))
  );

  return {
    beersQueued: eligibleBeers.length,
    blocklistedMarked: blocklistedBeers.length,
    noEligibleBeers: false,
  };
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
  const today = getToday(now);
  const monthStart = today.slice(0, 7) + '-01';
  const monthEnd = getMonthEnd(now);

  try {
    // Parse request body - empty body is valid (all fields optional with defaults)
    const bodyResult = await readBoundedJson(request, SMALL_JSON_BODY_MAX_BYTES);
    let raw: unknown;
    if (!bodyResult.ok) {
      // A genuinely empty body is the documented no-op trigger call; only
      // that specific failure is tolerated here. Any other failure (wrong
      // Content-Type, oversized body, or malformed non-empty JSON) is a
      // real client error and must not be silently treated as "no options".
      if (bodyResult.code === 'INVALID_JSON' && bodyResult.bytesRead === 0) {
        raw = {};
      } else {
        return boundedJsonErrorResponse(bodyResult, reqCtx.requestId, headers);
      }
    } else {
      raw = bodyResult.data;
    }
    const isEmpty = typeof raw === 'object' && raw !== null && Object.keys(raw as Record<string, unknown>).length === 0;
    if (!isEmpty) {
      const validation = TriggerEnrichmentRequestSchema.safeParse(raw);
      if (!validation.success) {
        return Response.json(
          { error: 'Invalid request body', requestId: reqCtx.requestId },
          { status: 400, headers }
        );
      }
    }
    const body = TriggerEnrichmentRequestSchema.parse(raw);
    const requestedLimit = Math.min(Math.max(1, body.limit ?? 50), 100); // Clamp to 1-100
    const excludeFailures = body.exclude_failures;

    // Helper to build response
    const buildResponse = (
      beersQueued: number,
      skipReason: TriggerEnrichmentData['skip_reason'] | undefined,
      dailyUsed: number,
      monthlyUsed: number
    ): Response => {
      const data: TriggerEnrichmentData = {
        beers_queued: beersQueued,
        ...(skipReason && { skip_reason: skipReason }),
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

    // Select, mark blocklisted, and queue (shared with the cron sweep)
    const queueResult = await selectAndQueuePendingEnrichment(env, {
      limit: effectiveBatchSize,
      excludeFailures,
    });

    if (queueResult.noEligibleBeers) {
      console.log(`[trigger] No eligible beers found, requestId=${reqCtx.requestId}`);
      return buildResponse(0, 'no_eligible_beers', dailyUsed, monthlyUsed);
    }

    if (queueResult.blocklistedMarked > 0) {
      console.log(`[trigger] Skipped ${queueResult.blocklistedMarked} blocklisted items`);
    }

    console.log(`[trigger] Queued ${queueResult.beersQueued} beers for enrichment, requestId=${reqCtx.requestId}, excludeFailures=${excludeFailures}`);

    return buildResponse(queueResult.beersQueued, undefined, dailyUsed, monthlyUsed);

  } catch (error) {
    console.error(`[trigger] Failed to trigger enrichment:`, error);
    return errorResponse(
      'Failed to trigger enrichment',
      'TRIGGER_ERROR',
      { requestId: reqCtx.requestId, headers, status: 500 }
    );
  }
}
