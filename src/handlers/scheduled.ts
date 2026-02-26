/**
 * Scheduled Handler
 *
 * Business logic for cron-triggered enrichment processing.
 * Includes:
 * - handleScheduledEnrichment() - Main cron job logic for queuing unenriched beers
 *
 * This handler:
 * - Checks quota limits (daily/monthly)
 * - Queries for unenriched beers
 * - Filters out blocklisted items
 * - Queues beers for enrichment
 * - Cleans up old data (enrichment_limits, DLQ)
 *
 * Extracted from index.ts as part of Phase 7 refactoring.
 */

import type { Env } from '../types';
import { trackCron } from '../analytics';
import { shouldSkipEnrichment } from '../config';
import { cleanupOldDlqMessages } from './dlq';
import { getToday } from '../utils/date';

// ============================================================================
// Scheduled Enrichment Handler
// ============================================================================

/**
 * Handle scheduled (cron) enrichment processing
 *
 * Circuit breaker layers (checked in order):
 * - Layer 3: Kill switch (ENRICHMENT_ENABLED=false)
 * - Layer 2: Monthly limit
 * - Layer 1: Daily limit
 *
 * After processing, performs cleanup:
 * - Old enrichment_limits entries (>90 days)
 * - Old DLQ messages (>30 days)
 */
export async function handleScheduledEnrichment(
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const cronStartTime = Date.now();

  // Layer 3: Kill switch
  if (env.ENRICHMENT_ENABLED === 'false') {
    console.log('Enrichment disabled via kill switch, skipping cron');
    trackCron(env.ANALYTICS, {
      beersQueued: 0,
      dailyRemaining: 0,
      monthlyRemaining: 0,
      durationMs: Date.now() - cronStartTime,
      success: true,
      skipReason: 'kill_switch',
    });
    return;
  }

  const today = getToday();
  const monthStart = today.slice(0, 7) + '-01';
  const monthEnd = today.slice(0, 7) + '-31';
  const dailyLimit = parseInt(env.DAILY_ENRICHMENT_LIMIT || '500');
  const monthlyLimit = parseInt(env.MONTHLY_ENRICHMENT_LIMIT || '2000');

  try {
    // Layer 2: Monthly limit check
    const monthlyCount = await env.DB.prepare(
      `SELECT SUM(request_count) as total FROM enrichment_limits
       WHERE date >= ? AND date <= ?`
    ).bind(monthStart, monthEnd).first<{ total: number }>();

    const monthlyUsed = monthlyCount?.total || 0;

    if (monthlyUsed >= monthlyLimit) {
      console.log(`Monthly limit reached (${monthlyLimit}), skipping cron`);
      trackCron(env.ANALYTICS, {
        beersQueued: 0,
        dailyRemaining: 0,
        monthlyRemaining: 0,
        durationMs: Date.now() - cronStartTime,
        success: true,
        skipReason: 'monthly_limit',
      });
      return;
    }

    // Layer 1: Daily limit check
    const dailyCount = await env.DB.prepare(
      `SELECT request_count FROM enrichment_limits WHERE date = ?`
    ).bind(today).first<{ request_count: number }>();

    const currentCount = dailyCount?.request_count || 0;
    const remainingToday = dailyLimit - currentCount;

    if (remainingToday <= 0) {
      console.log(`Daily limit reached (${dailyLimit}), skipping cron`);
      trackCron(env.ANALYTICS, {
        beersQueued: 0,
        dailyRemaining: 0,
        monthlyRemaining: monthlyLimit - monthlyUsed,
        durationMs: Date.now() - cronStartTime,
        success: true,
        skipReason: 'daily_limit',
      });
      return;
    }

    // Only queue as many as we can process today (max 100)
    const batchSize = Math.min(100, remainingToday);

    // Query beers with NULL ABV
    // Column names match Flying Saucer API / mobile app convention
    const beersToEnrich = await env.DB.prepare(`
      SELECT id, brew_name, brewer
      FROM enriched_beers
      WHERE abv IS NULL
      LIMIT ?
    `).bind(batchSize).all<{ id: string; brew_name: string; brewer: string }>();

    if (!beersToEnrich.results || beersToEnrich.results.length === 0) {
      console.log('No beers need enrichment');
      trackCron(env.ANALYTICS, {
        beersQueued: 0,
        dailyRemaining: remainingToday,
        monthlyRemaining: monthlyLimit - monthlyUsed,
        durationMs: Date.now() - cronStartTime,
        success: true,
        skipReason: 'no_beers',
      });
      return;
    }

    // Filter out blocklisted items (flights, mixed drinks, etc.)
    const eligibleBeers = beersToEnrich.results.filter(
      beer => !shouldSkipEnrichment(beer.brew_name)
    );

    if (eligibleBeers.length === 0) {
      console.log(`[cron] All ${beersToEnrich.results.length} beers are blocklisted`);
      trackCron(env.ANALYTICS, {
        beersQueued: 0,
        dailyRemaining: remainingToday,
        monthlyRemaining: monthlyLimit - monthlyUsed,
        durationMs: Date.now() - cronStartTime,
        success: true,
        skipReason: 'no_beers',
      });
      return;
    }

    const skippedCount = beersToEnrich.results.length - eligibleBeers.length;
    if (skippedCount > 0) {
      console.log(`[cron] Skipped ${skippedCount} blocklisted items`);
    }

    // Queue each beer for enrichment (processed in parallel by consumers)
    // Using sendBatch for efficiency instead of individual sends
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
    console.log(`Queued ${beersQueued} beers for enrichment (${remainingToday - beersQueued} slots remaining today)`);

    // Track successful cron execution
    trackCron(env.ANALYTICS, {
      beersQueued,
      dailyRemaining: remainingToday - beersQueued,
      monthlyRemaining: monthlyLimit - monthlyUsed,
      durationMs: Date.now() - cronStartTime,
      success: true,
    });

    // Cleanup old enrichment_limits entries (older than 90 days)
    // Runs every cron execution since cron only runs twice daily
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const cutoffDate = getToday(ninetyDaysAgo);

    const deleteResult = await env.DB.prepare(
      'DELETE FROM enrichment_limits WHERE date < ?'
    ).bind(cutoffDate).run();

    if (deleteResult.meta.changes > 0) {
      console.log(`Cleaned up ${deleteResult.meta.changes} old enrichment_limits entries`);
    }

    // Cleanup old DLQ messages (older than 30 days)
    const cronRequestId = crypto.randomUUID();
    await cleanupOldDlqMessages(env.DB, cronRequestId);

  } catch (error) {
    console.error('Failed to queue beers for enrichment:', error);
    trackCron(env.ANALYTICS, {
      beersQueued: 0,
      dailyRemaining: 0,
      monthlyRemaining: 0,
      durationMs: Date.now() - cronStartTime,
      success: false,
      errorType: 'exception',
    });
  }
}
