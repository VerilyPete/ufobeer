/**
 * Enrichment quota tracking and circuit breaker logic.
 * Extracted from index.ts as part of Phase 6 refactoring.
 */

import type { Env, EnrichmentQuotaStatus } from '../types';
import { getToday, getMonthStart, getMonthEnd } from '../utils/date';

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
