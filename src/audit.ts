// ============================================================================
// Audit Logging
// ============================================================================

import type { RequestContext } from './types';
import { AUDIT_CLEANUP_PROBABILITY, AUDIT_RETENTION_DAYS } from './constants';

/**
 * Write an audit log entry for a request.
 *
 * Logs all API requests with:
 * - Request metadata (ID, timestamp, method, path)
 * - Authentication context (API key hash, client IP, user agent)
 * - Response details (status code, response time)
 * - Optional error message
 *
 * Also performs periodic cleanup of old audit logs (>7 days) on 0.1% of requests.
 */
export async function writeAuditLog(
  db: D1Database,
  ctx: RequestContext,
  method: string,
  path: string,
  statusCode: number,
  error?: string
): Promise<void> {
  const responseTimeMs = Date.now() - ctx.startTime;

  try {
    await db.prepare(`
      INSERT INTO audit_log (request_id, timestamp, method, path, api_key_hash, client_ip, user_agent, status_code, response_time_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      ctx.requestId,
      ctx.startTime,
      method,
      path,
      ctx.apiKeyHash,
      ctx.clientIp,
      ctx.userAgent,
      statusCode,
      responseTimeMs,
      error || null
    ).run();

    // Cleanup old entries probabilistically (0.1% of requests)
    // This approach spreads cleanup load across requests and avoids
    // coordinated cleanup spikes. The randomness is acceptable because:
    // 1. Cleanup is idempotent - extra runs are harmless
    // 2. Missed cleanups are caught on subsequent requests
    if (Math.random() < AUDIT_CLEANUP_PROBABILITY) {
      const retentionMs = AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const cutoffTime = Date.now() - retentionMs;
      await db.prepare('DELETE FROM audit_log WHERE timestamp < ? LIMIT 10000').bind(cutoffTime).run();
    }
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
}

/**
 * Write admin audit log entry for privileged operations.
 *
 * Special audit logging for admin-only operations (DLQ management, enrichment triggers).
 * Logs:
 * - Operation type (e.g., 'dlq_replay', 'enrich_trigger')
 * - Operation details as JSON (e.g., IDs affected, parameters used)
 * - Admin authentication context
 *
 * Uses 'ADMIN' as the method field to distinguish from regular API requests.
 */
export async function writeAdminAuditLog(
  db: D1Database,
  ctx: RequestContext,
  operation: string,
  details: Record<string, unknown>,
  adminSecretHash: string
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO audit_log (request_id, timestamp, method, path, api_key_hash, client_ip, user_agent, status_code, response_time_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      ctx.requestId,
      ctx.startTime,
      'ADMIN',
      operation,
      adminSecretHash,
      ctx.clientIp,
      ctx.userAgent,
      200,
      Date.now() - ctx.startTime,
      JSON.stringify(details)
    ).run();
  } catch (err) {
    console.error('Failed to write admin audit log:', err);
  }
}
