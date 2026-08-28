/**
 * Enrichment quota tracking and circuit breaker logic.
 * Extracted from index.ts as part of Phase 6 refactoring.
 */

import type { Env, EnrichmentQuotaStatus } from '../types';
import { getToday, getMonthStart, getMonthEnd } from '../utils/date';

/**
 * Result of attempting to reserve one enrichment quota slot.
 */
export type EnrichmentReservation = {
  /** Whether a slot was actually consumed (false = daily limit reached) */
  readonly reserved: boolean;
  /** The day's request count after the reservation attempt */
  readonly requestCount: number;
};

/**
 * Atomically reserve one Perplexity API slot for today, BEFORE the API call.
 *
 * Pattern (shared with reserveCleanupQuotaBatch in queue/cleanupHelpers.ts):
 * seed the day's row, read the pre-reservation count, then run a single
 * conditional UPDATE that only increments while within the limit. RETURNING
 * exposes the post-update count; `reserved` is computed as post > pre, i.e.
 * a slot was genuinely consumed.
 *
 * Why not compute `reserved` inside the RETURNING clause: RETURNING sees the
 * post-update value, so `request_count <= limit` reports "reserved" when the
 * counter is parked exactly at the limit with no increment (the original bug
 * this function replaces), and `request_count < limit` wrongly rejects the
 * limit-th call. post > pre is correct at every boundary.
 *
 * Concurrency: the pre-read is not part of the gate — the conditional UPDATE
 * is. This is safe because the enrichment queue consumer
 * (max_concurrency: 1 in wrangler.jsonc) is the only writer to
 * enrichment_limits; if that setting is ever raised, the pre-read becomes
 * racy (two readers can both see pre, and the loser computes a phantom
 * reservation) and this must move to serialized storage (e.g., Durable
 * Objects). Costs three D1 round trips per message instead of one —
 * negligible at current volumes.
 */
export async function reserveEnrichmentSlot(
  db: D1Database,
  date: string,
  dailyLimit: number
): Promise<EnrichmentReservation> {
  const now = Date.now();

  // Ensure the day's row exists
  await db.prepare(`
    INSERT INTO enrichment_limits (date, request_count, last_updated)
    VALUES (?, 0, ?)
    ON CONFLICT(date) DO NOTHING
  `).bind(date, now).run();

  const currentRow = await db.prepare(`
    SELECT request_count FROM enrichment_limits WHERE date = ?
  `).bind(date).first<{ request_count: number }>();
  const previousCount = currentRow?.request_count ?? 0;

  const result = await db.prepare(`
    UPDATE enrichment_limits
    SET request_count = CASE
        WHEN request_count + 1 <= ? THEN request_count + 1
        ELSE request_count
      END,
      last_updated = ?
    WHERE date = ?
    RETURNING request_count as new_count
  `).bind(dailyLimit, now, date).first<{ new_count: number }>();

  if (!result) {
    return { reserved: false, requestCount: previousCount };
  }

  return {
    reserved: result.new_count > previousCount,
    requestCount: result.new_count,
  };
}

/**
 * Get enrichment quota status with circuit breaker checks.
 * Checks daily and monthly limits, plus global kill switch.
 *
 * Circuit breaker layers (checked in order):
 * - Layer 3: Kill switch (ENRICHMENT_ENABLED=false)
 * - Layer 2: Monthly limit
 * - Layer 1: Daily limit
 *
 * @returns Quota status indicating whether processing can continue
 */
export async function getEnrichmentQuotaStatus(
  db: D1Database,
  env: Env
): Promise<EnrichmentQuotaStatus> {
  const dailyLimit = parseInt(env.DAILY_ENRICHMENT_LIMIT || '500');
  const monthlyLimit = parseInt(env.MONTHLY_ENRICHMENT_LIMIT || '2000');
  const today = getToday();
  const monthStart = getMonthStart();
  const monthEnd = getMonthEnd();

  // Layer 3: Kill switch check
  if (env.ENRICHMENT_ENABLED === 'false') {
    return {
      canProcess: false,
      skipReason: 'kill_switch',
      daily: { used: 0, limit: dailyLimit, remaining: dailyLimit },
      monthly: { used: 0, limit: monthlyLimit, remaining: monthlyLimit }
    };
  }

  // Get current quota usage (read-only)
  let dailyUsed = 0;
  let monthlyUsed = 0;

  try {
    const dailyCount = await db.prepare(
      `SELECT request_count FROM enrichment_limits WHERE date = ?`
    ).bind(today).first<{ request_count: number }>();
    dailyUsed = dailyCount?.request_count || 0;

    const monthlyCount = await db.prepare(
      `SELECT SUM(request_count) as total FROM enrichment_limits
       WHERE date >= ? AND date <= ?`
    ).bind(monthStart, monthEnd).first<{ total: number }>();
    monthlyUsed = monthlyCount?.total || 0;
  } catch (dbError) {
    console.error(`[quota] D1 unavailable:`, dbError);
    // Fail closed if DB is down
    return {
      canProcess: false,
      skipReason: 'kill_switch', // Effectively a kill switch if DB is down
      daily: { used: 0, limit: dailyLimit, remaining: 0 },
      monthly: { used: 0, limit: monthlyLimit, remaining: 0 }
    };
  }

  // Layer 2: Monthly limit check
  if (monthlyUsed >= monthlyLimit) {
    return {
      canProcess: false,
      skipReason: 'monthly_limit',
      daily: { used: dailyUsed, limit: dailyLimit, remaining: Math.max(0, dailyLimit - dailyUsed) },
      monthly: { used: monthlyUsed, limit: monthlyLimit, remaining: 0 }
    };
  }

  // Layer 1: Daily limit check
  const dailyRemaining = dailyLimit - dailyUsed;
  if (dailyRemaining <= 0) {
    return {
      canProcess: false,
      skipReason: 'daily_limit',
      daily: { used: dailyUsed, limit: dailyLimit, remaining: 0 },
      monthly: { used: monthlyUsed, limit: monthlyLimit, remaining: Math.max(0, monthlyLimit - monthlyUsed) }
    };
  }

  return {
    canProcess: true,
    daily: { used: dailyUsed, limit: dailyLimit, remaining: dailyRemaining },
    monthly: { used: monthlyUsed, limit: monthlyLimit, remaining: Math.max(0, monthlyLimit - monthlyUsed) }
  };
}
