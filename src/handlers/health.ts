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

// ============================================================================
// Health Check Handler
// ============================================================================

/**
 * GET /health - Health check endpoint with circuit breaker status
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

    const today = new Date().toISOString().split('T')[0];
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
    return Response.json(
      {
        status: 'error',
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 503 }
    );
  }
}
