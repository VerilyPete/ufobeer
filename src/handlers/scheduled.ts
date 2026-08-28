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
import { ENABLED_STORE_IDS } from '../config';
import {
  CRON_INTERVAL_MS,
  CRON_JITTER_MS,
  CRON_SCHEDULE_KEY,
} from '../constants';
import { cleanupOldDlqMessages } from './dlq';
import { getToday, getCurrentHourCT, isWithinOperatingHours } from '../utils/date';
import { refreshTaplistForStore } from './beers';
import { selectAndQueuePendingEnrichment } from './enrichment';

export function computeNextCronTime(
  now: number,
  random: () => number = Math.random,
): number {
  const jitter = (random() * 2 - 1) * CRON_JITTER_MS;
  return now + CRON_INTERVAL_MS + jitter;
}

export async function checkAndAdvanceCronSchedule(
  db: D1Database,
  random: () => number = Math.random,
): Promise<boolean> {
  const now = Date.now();

  // Fast path: not due → no writes at all (idle crons stay write-free).
  const entry = await db.prepare(
    'SELECT CAST(value AS INTEGER) as next_run FROM system_state WHERE key = ?'
  ).bind(CRON_SCHEDULE_KEY).first<{ next_run: number }>();
  if (entry && entry.next_run > now) {
    return false;
  }

  // Seed with epoch 0 — NOT now+interval — so a fresh system is immediately
  // due, matching the original missing-row-means-due behavior.
  await db.prepare(
    'INSERT OR IGNORE INTO system_state (key, value, updated_at) VALUES (?, ?, ?)'
  ).bind(CRON_SCHEDULE_KEY, '0', now).run();

  // Atomic claim: exactly one concurrent caller can move a due timestamp to
  // the next run time. The WHERE clause fails for every subsequent caller
  // (the value is already in the future), whose RETURNING yields no row.
  // This replaces the previous read-then-write upsert, whose SELECT-to-INSERT
  // gap admitted overlapping claims.
  const nextRun = computeNextCronTime(now, random);
  const claim = await db.prepare(`
    UPDATE system_state
    SET value = ?, updated_at = ?
    WHERE key = ? AND CAST(value AS INTEGER) <= ?
    RETURNING value
  `).bind(String(nextRun), now, CRON_SCHEDULE_KEY, now).first<{ value: string }>();

  return claim !== null;
}

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
  ctx: ExecutionContext
): Promise<void> {
  const cronStartTime = Date.now();
  const cronRequestId = crypto.randomUUID();

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

  // Operating hours gate: skip when the bar is closed (before noon / after 11pm CT)
  if (!isWithinOperatingHours(getCurrentHourCT())) {
    console.log('[cron] Outside operating hours, skipping');
    trackCron(env.ANALYTICS, {
      beersQueued: 0,
      dailyRemaining: 0,
      monthlyRemaining: 0,
      durationMs: Date.now() - cronStartTime,
      success: true,
      skipReason: 'outside_hours',
    });
    return;
  }

  // Schedule gate: only run when the jittered 4-hour interval has elapsed
  const isDue = await checkAndAdvanceCronSchedule(env.DB);
  if (!isDue) {
    console.log('[cron] Not scheduled yet, skipping');
    trackCron(env.ANALYTICS, {
      beersQueued: 0,
      dailyRemaining: 0,
      monthlyRemaining: 0,
      durationMs: Date.now() - cronStartTime,
      success: true,
      skipReason: 'not_scheduled',
    });
    return;
  }

  // Phase 1: Refresh taplist for all active stores
  for (const storeId of ENABLED_STORE_IDS) {
    try {
      const result = await refreshTaplistForStore(env, ctx, storeId, cronRequestId);
      console.log(`[cron] Store ${storeId}: ${result.beersRefreshed} beers refreshed`);
    } catch (error) {
      console.error(`[cron] Store ${storeId} refresh failed:`, error);
      // Continue — don't let one store failure block enrichment
    }
  }

  // Phase 2: Enrichment sweep
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

    // Select, mark blocklisted, and queue (shared with the admin trigger)
    const queueResult = await selectAndQueuePendingEnrichment(env, { limit: batchSize });

    if (queueResult.noEligibleBeers) {
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

    if (queueResult.blocklistedMarked > 0) {
      console.log(`[cron] Skipped ${queueResult.blocklistedMarked} blocklisted items`);
    }

    const beersQueued = queueResult.beersQueued;
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
    // Runs each enrichment execution (~every 2 hours during operating hours)
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
