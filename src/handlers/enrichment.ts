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
import {
  TriggerEnrichmentRequestSchema,
} from '../schemas/request';

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
    const raw = await request.json().catch(() => ({}));
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

    // Query beers with pending enrichment status
    let query = `
      SELECT id, brew_name, brewer
      FROM enriched_beers
      WHERE enrichment_status = 'pending'
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

    // Mark blocklisted beers as skipped
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
