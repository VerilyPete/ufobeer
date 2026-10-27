/**
 * Health Check Handler
 *
 * Provides health/liveness endpoints for monitoring service status.
 * Includes:
 * - handleHealthCheck() - GET /health - Returns service health with quota status
 * - handleLiveness()    - GET/HEAD /livez - Minimal liveness probe, no D1 query
 *
 * Extracted from index.ts as part of Phase 7 refactoring.
 */

import type { Env } from '../types';
import { getToday } from '../utils/date';
import { withResponseHeaders } from '../context';

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
 * The response body SHAPE is unchanged from before this security pass —
 * only response headers (security headers, explicit no-store) were added.
 * Removing fields is explicitly deferred to Phase 2; see handleLiveness()
 * for a cheap D1-free alternative for uptime probes.
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
    }, { headers: withResponseHeaders({}, 'no-store') });
  } catch (error) {
    console.error('Health check DB error:', error);
    return Response.json(
      { status: 'error', database: 'disconnected', error: 'Database connection failed' },
      { status: 503, headers: withResponseHeaders({}, 'no-store') }
    );
  }
}

// ============================================================================
// Liveness Handler
// ============================================================================

/**
 * GET/HEAD /livez - Minimal liveness probe.
 *
 * Deliberately does NOT touch env/D1 at all (the function takes no Env
 * parameter, so a D1 query is not merely avoided by convention — it isn't
 * reachable from here). Exists so uptime monitors and load balancers can
 * probe liveness without incurring the SELECT 1 + quota queries /health
 * performs, and without exposing quota details. /health remains the
 * readiness/quota endpoint used by the Golden Taproom contract.
 */
export function handleLiveness(): Response {
  return Response.json(
    { status: 'ok' },
    { headers: withResponseHeaders({}, 'no-store') }
  );
}
