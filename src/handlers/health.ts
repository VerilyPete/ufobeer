/**
 * Health Check Handler
 *
 * Provides a health check endpoint for monitoring service status.
 * Includes:
 * - handleHealthCheck() - GET /health - Returns service health with quota status
 *
 * Extracted from index.ts as part of Phase 7 refactoring.
 */

import type { Env } from '../types';
import { getToday } from '../utils/date';

// ============================================================================
// Health Check Handler
// ============================================================================

/**
 * GET /health - Health check endpoint with circuit breaker status
 *
 * Intentionally unauthenticated with public quota fields: the Golden Taproom
 * contract test fetches /health with NO API key and requires the enrichment
 * quota blocks (BeerSelector's consumer schema marks them optional, but the
 * contract harness enforces them). Exposure is limited to usage counts and
 * limits — no secrets. Gating these fields is a coordinated cross-repo
 * contract change, not a unilateral edit.
 *
 * Returns:
 * - Service status (ok/error)
 * - Database connection status
 * - Enrichment quota status (daily/monthly usage and limits)
 * - Enrichment enabled flag
 */
export async function handleHealthCheck(env: Env): Promise<Response> {
  try {
    // Test D1 connection
    await env.DB.prepare('SELECT 1').first();

    const today = getToday();
    const monthStart = today.slice(0, 7) + '-01';
    const monthEnd = today.slice(0, 7) + '-31';

    // These queries might fail if table doesn't exist yet - that's ok
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
    } catch (limitError) {
      // Table might not exist yet - report as 0 usage
      console.warn('Could not query enrichment_limits:', limitError);
    }

    const dailyLimit = parseInt(env.DAILY_ENRICHMENT_LIMIT || '500');
    const monthlyLimit = parseInt(env.MONTHLY_ENRICHMENT_LIMIT || '2000');

    return Response.json({
      status: 'ok',
      database: 'connected',
      enrichment: {
        enabled: env.ENRICHMENT_ENABLED !== 'false',
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
    });
  } catch (error) {
    console.error('Health check DB error:', error);
    return Response.json(
      { status: 'error', database: 'disconnected', error: 'Database connection failed' },
      { status: 503 }
    );
  }
}
