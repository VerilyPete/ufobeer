// ============================================================================
// Audit Logging
// ============================================================================

import type { RequestContext } from './types';
import { AUDIT_RETENTION_DAYS, AUDIT_REAP_LIMIT, ADMIN_AUDIT_MAX_TARGET_IDS } from './constants';

// AUDIT_REAP_LIMIT and ADMIN_AUDIT_MAX_TARGET_IDS now live in
// src/constants.ts (imported above) as part of the constants consolidation.

/**
 * Outcome classification for a privileged admin operation. Distinguishes
 * "we looked at it but changed nothing" (attempted — e.g. a dry run),
 * "the caller wasn't allowed to do this" (denied), a batch operation that
 * partly succeeded, a clean success, and an operation that failed outright.
 */
export type AdminAuditOutcome = 'attempted' | 'denied' | 'partial' | 'success' | 'failed';

/**
 * Optional structured fields for writeAdminAuditLog. All optional and
 * additive so existing call sites keep compiling unchanged; only fields
 * actually supplied are merged into the persisted `details` JSON.
 */
export type AdminAuditOptions = {
  /** Actual HTTP status the handler returned. Defaults to 200 (legacy behavior) when omitted. */
  readonly statusCode?: number | undefined;
  readonly outcome?: AdminAuditOutcome | undefined;
  /** Requested target identifiers (row IDs, beer IDs, ...); bounded to ADMIN_AUDIT_MAX_TARGET_IDS. */
  readonly targetIds?: readonly (string | number)[] | undefined;
  readonly requestedCount?: number | undefined;
  readonly succeededCount?: number | undefined;
  readonly failedCount?: number | undefined;
  readonly failureReason?: string | undefined;
};

/**
 * Write an audit log entry for a request.
 *
 * Logs all API requests with:
 * - Request metadata (ID, timestamp, method, path)
 * - Authentication context (API key hash, client IP, user agent)
 * - Response details (status code, response time)
 * - Optional error message
 *
 * Row-growth cleanup is NOT performed here — see reapOldAuditLog(), which is
 * called deterministically from the cron handler instead. Doing cleanup here
 * (probabilistically, and nested inside this function's own try/catch after
 * the INSERT) meant a failing insert silently disabled trimming exactly when
 * the table was under stress.
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
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
}

/**
 * Delete audit_log rows older than AUDIT_RETENTION_DAYS, bounded per call.
 *
 * Called deterministically from the cron handler (scheduled.ts) rather than
 * probabilistically from the request path (0.1% of requests), and no longer
 * lives inside writeAuditLog's own try/catch — so a run of failing inserts
 * can no longer disable trimming. Idempotent; safe to call repeatedly.
 *
 * @returns number of rows deleted
 */
export async function reapOldAuditLog(
  db: D1Database,
  now: number = Date.now()
): Promise<number> {
  const retentionMs = AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffTime = now - retentionMs;
  const result = await db.prepare(
    'DELETE FROM audit_log WHERE timestamp < ? LIMIT ?'
  ).bind(cutoffTime, AUDIT_REAP_LIMIT).run();
  return result.meta.changes;
}

/**
 * Write admin audit log entry for privileged operations.
 *
 * Special audit logging for admin-only operations (DLQ management, enrichment
 * triggers). Logs the operation type, a JSON details blob, and admin
 * authentication context, using 'ADMIN' as the method field to distinguish
 * from regular API requests.
 *
 * `options` is optional and additive: omitting it reproduces the previous
 * hardcoded behavior (status 200, `details` written verbatim) for callers
 * that have not yet been updated to pass real outcome data. Callers that
 * have a real status/outcome should pass it so a failed or partially
 * successful privileged operation is not misrepresented as a clean success.
 */
export async function writeAdminAuditLog(
  db: D1Database,
  ctx: RequestContext,
  operation: string,
  details: Record<string, unknown>,
  adminSecretHash: string,
  options?: AdminAuditOptions
): Promise<void> {
  const statusCode = options?.statusCode ?? 200;
  const enrichedDetails: Record<string, unknown> = { ...details };

  if (options?.outcome !== undefined) {
    enrichedDetails['outcome'] = options.outcome;
  }
  if (options?.targetIds !== undefined) {
    const bounded = options.targetIds.slice(0, ADMIN_AUDIT_MAX_TARGET_IDS);
    enrichedDetails['target_ids'] = bounded;
    if (bounded.length < options.targetIds.length) {
      enrichedDetails['target_ids_truncated'] = true;
    }
  }
  if (options?.requestedCount !== undefined) {
    enrichedDetails['requested_count'] = options.requestedCount;
  }
  if (options?.succeededCount !== undefined) {
    enrichedDetails['succeeded_count'] = options.succeededCount;
  }
  if (options?.failedCount !== undefined) {
    enrichedDetails['failed_count'] = options.failedCount;
  }
  if (options?.failureReason !== undefined) {
    enrichedDetails['failure_reason'] = options.failureReason;
  }

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
      statusCode,
      Date.now() - ctx.startTime,
      JSON.stringify(enrichedDetails)
    ).run();
  } catch (err) {
    console.error('Failed to write admin audit log:', err);
  }
}
