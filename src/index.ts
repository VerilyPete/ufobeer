import {
  type AnalyticsEngineDataset,
  trackRequest,
  trackEnrichment,
  trackCron,
  trackRateLimit,
  trackAdminDlq,
  trackDlqConsumer,
  trackAdminTrigger,
} from './analytics';

// Types for queue messages
interface EnrichmentMessage {
  beerId: string;
  beerName: string;
  brewer: string;
}

export interface Env {
  // Database
  DB: D1Database;

  // Queue (from Phase 1) - used for enrichment and DLQ replay
  ENRICHMENT_QUEUE: Queue<EnrichmentMessage>;

  // Analytics Engine (optional - graceful degradation if not configured)
  ANALYTICS?: AnalyticsEngineDataset;

  // Secrets (set via wrangler secret put)
  API_KEY: string;
  FLYING_SAUCER_API_BASE: string;
  PERPLEXITY_API_KEY?: string;
  ADMIN_SECRET?: string; // Required for /admin/* routes

  // Environment variables (set in wrangler.jsonc vars)
  ALLOWED_ORIGIN: string;
  RATE_LIMIT_RPM: string;

  // Circuit breaker (from Phase 1)
  DAILY_ENRICHMENT_LIMIT?: string;
  MONTHLY_ENRICHMENT_LIMIT?: string;
  ENRICHMENT_ENABLED?: string;
}

// Valid Flying Saucer store IDs
// Starting with Sugar Land only - add more locations as needed
const VALID_STORE_IDS = new Set([
  '13879',    // Sugar Land
]);

// Future locations (uncomment when ready to expand):
// '13885',    // Little Rock
// '13888',    // Charlotte
// '13877',    // Raleigh
// '13883',    // Cordova
// '13881',    // Memphis
// '18686214', // Cypress Waters
// '13891',    // Fort Worth
// '13884',    // The Lake
// '18262641', // DFW Airport
// '13880',    // Houston
// '13882',    // San Antonio

// ============================================================================
// Type Guards
// ============================================================================

interface FlyingSaucerBeer {
  id: string;
  brew_name: string;
  brewer: string;
  brew_description?: string;
  container_type?: string;
  [key: string]: unknown;
}

/**
 * Type guard: Validates that an object is a valid FlyingSaucerBeer.
 */
function isValidBeer(beer: unknown): beer is FlyingSaucerBeer {
  return (
    typeof beer === 'object' &&
    beer !== null &&
    'id' in beer &&
    typeof (beer as FlyingSaucerBeer).id === 'string' &&
    (beer as FlyingSaucerBeer).id.length > 0 &&
    'brew_name' in beer &&
    typeof (beer as FlyingSaucerBeer).brew_name === 'string'
  );
}

/**
 * Type guard: Checks if an object contains a brewInStock array.
 * Flying Saucer API returns: [{...}, {brewInStock: [...]}]
 */
function hasBeerStock(item: unknown): item is { brewInStock: unknown[] } {
  return (
    item !== null &&
    typeof item === 'object' &&
    'brewInStock' in item &&
    Array.isArray((item as { brewInStock?: unknown }).brewInStock)
  );
}

// ============================================================================
// Security Helpers
// ============================================================================

/**
 * Timing-safe string comparison to prevent timing attacks on API key validation.
 */
async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) {
    // Still do a comparison to avoid leaking length info via timing
    const encoder = new TextEncoder();
    const aEncoded = encoder.encode(a);
    const bEncoded = encoder.encode(a); // Compare a with itself
    await crypto.subtle.timingSafeEqual(aEncoded, bEncoded);
    return false;
  }
  const encoder = new TextEncoder();
  const aEncoded = encoder.encode(a);
  const bEncoded = encoder.encode(b);
  return crypto.subtle.timingSafeEqual(aEncoded, bEncoded);
}

/**
 * Hash an API key for storage (we don't want to log actual keys).
 */
async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get CORS headers. Fails explicitly if ALLOWED_ORIGIN is not configured.
 */
function getCorsHeaders(env: Env): Record<string, string> | null {
  if (!env.ALLOWED_ORIGIN) {
    console.error('ALLOWED_ORIGIN not configured - CORS will be blocked');
    return null;
  }
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Client-ID',
    'Access-Control-Max-Age': '86400',
  };
}

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Check and update rate limit for a client.
 * Returns true if request is allowed, false if rate limited.
 */
async function checkRateLimit(
  db: D1Database,
  clientIdentifier: string,
  limitPerMinute: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60000);
  const resetAt = (minuteBucket + 1) * 60000;

  try {
    // Atomic upsert - increment counter
    await db.prepare(`
      INSERT INTO rate_limits (client_identifier, minute_bucket, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(client_identifier, minute_bucket)
      DO UPDATE SET request_count = request_count + 1
    `).bind(clientIdentifier, minuteBucket).run();

    // Check new count
    const result = await db.prepare(
      'SELECT request_count FROM rate_limits WHERE client_identifier = ? AND minute_bucket = ?'
    ).bind(clientIdentifier, minuteBucket).first<{ request_count: number }>();

    const count = result?.request_count || 1;

    if (count > limitPerMinute) {
      return { allowed: false, remaining: 0, resetAt };
    }

    // Occasional cleanup (1% of requests)
    if (Math.random() < 0.01) {
      await db.prepare('DELETE FROM rate_limits WHERE minute_bucket < ?')
        .bind(minuteBucket - 60).run();
    }

    return { allowed: true, remaining: Math.max(0, limitPerMinute - count), resetAt };
  } catch (error) {
    // On error, allow request but log
    console.error('Rate limit check failed:', error);
    return { allowed: true, remaining: limitPerMinute, resetAt };
  }
}

// ============================================================================
// Audit Logging
// ============================================================================

interface RequestContext {
  requestId: string;
  startTime: number;
  clientIdentifier: string;
  apiKeyHash: string | null;
  clientIp: string | null;
  userAgent: string | null;
}

/**
 * Write an audit log entry for a request.
 */
async function writeAuditLog(
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

    // Cleanup old entries (older than 7 days) - 0.1% of requests
    if (Math.random() < 0.001) {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      await db.prepare('DELETE FROM audit_log WHERE timestamp < ?').bind(sevenDaysAgo).run();
    }
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
}

// ============================================================================
// Admin Authentication
// ============================================================================

/**
 * Authorize admin access for /admin/* routes.
 * Requires both valid API key (already checked) AND valid ADMIN_SECRET.
 */
async function authorizeAdmin(
  request: Request,
  env: Env,
  reqCtx: RequestContext
): Promise<{ authorized: boolean; error?: string }> {
  // Check if ADMIN_SECRET is configured
  if (!env.ADMIN_SECRET) {
    console.error('ADMIN_SECRET not configured - admin endpoints disabled');
    return { authorized: false, error: 'Admin endpoints not configured' };
  }

  // Check for X-Admin-Secret header
  const adminSecret = request.headers.get('X-Admin-Secret');
  if (!adminSecret) {
    return { authorized: false, error: 'Missing admin credentials' };
  }

  // Timing-safe comparison
  if (!(await timingSafeCompare(adminSecret, env.ADMIN_SECRET))) {
    return { authorized: false, error: 'Invalid admin credentials' };
  }

  return { authorized: true };
}

/**
 * Write admin audit log entry for privileged operations.
 */
async function writeAdminAuditLog(
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

// ============================================================================
// Admin DLQ Types (D1-based storage)
// ============================================================================

interface DlqMessageRow {
  id: number;
  message_id: string;
  beer_id: string;
  beer_name: string | null;
  brewer: string | null;
  failed_at: number;
  failure_count: number;
  failure_reason: string | null;
  source_queue: string;
  status: string;
  replay_count: number;
  replayed_at: number | null;
  acknowledged_at: number | null;
  raw_message: string | null;
}

interface PaginationCursor {
  failed_at: number;
  id: number;
}

interface DlqReplayRequest {
  ids: number[];           // D1 row IDs to replay
  delay_seconds?: number;  // Delay before processing (default 0)
}

interface DlqAcknowledgeRequest {
  ids: number[];  // D1 row IDs to acknowledge
}

// ============================================================================
// Manual Enrichment Trigger Types
// ============================================================================

interface TriggerEnrichmentRequest {
  /** Maximum number of beers to queue (default: 50, max: 100) */
  limit?: number;
  /** Only queue beers that have never been attempted (exclude DLQ failures) */
  exclude_failures?: boolean;
}

interface QuotaStatus {
  used: number;
  limit: number;
  remaining: number;
}

interface TriggerEnrichmentData {
  beers_queued: number;
  skip_reason?: 'kill_switch' | 'daily_limit' | 'monthly_limit' | 'no_eligible_beers';
  quota: {
    daily: QuotaStatus;
    monthly: QuotaStatus;
  };
  enabled: boolean;
  filters: {
    exclude_failures: boolean;
  };
}

// ============================================================================
// Error Response Helper
// ============================================================================

interface ErrorResponseOptions {
  requestId: string;
  headers: Record<string, string>;
  status?: number;
}

/**
 * Create a standardized error response.
 */
function errorResponse(
  message: string,
  code: string,
  options: ErrorResponseOptions
): Response {
  return Response.json(
    {
      success: false,
      error: {
        message,
        code,
      },
      requestId: options.requestId,
    },
    {
      status: options.status || 400,
      headers: options.headers,
    }
  );
}

// ============================================================================
// Admin DLQ Handlers (D1-based)
// ============================================================================

/**
 * GET /admin/dlq - List DLQ messages from D1 with cursor-based pagination
 */
async function handleDlqList(
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext,
  params: URLSearchParams
): Promise<Response> {
  const status = params.get('status') || 'pending';
  const beerId = params.get('beer_id');
  const limit = Math.min(parseInt(params.get('limit') || '50', 10), 100);
  const cursorParam = params.get('cursor');
  const includeRaw = params.get('include_raw') === 'true';

  // Decode cursor if provided
  let cursor: PaginationCursor | null = null;
  if (cursorParam) {
    try {
      cursor = JSON.parse(atob(cursorParam));
    } catch {
      return errorResponse(
        'Invalid cursor format',
        'INVALID_CURSOR',
        { requestId: reqCtx.requestId, headers, status: 400 }
      );
    }
  }

  try {
    // Build query with cursor-based pagination
    let query = 'SELECT * FROM dlq_messages WHERE 1=1';
    const bindings: (string | number)[] = [];

    if (status && status !== 'all') {
      query += ' AND status = ?';
      bindings.push(status);
    }

    if (beerId) {
      query += ' AND beer_id = ?';
      bindings.push(beerId);
    }

    // Cursor-based pagination: get records after the cursor position
    if (cursor) {
      query += ' AND (failed_at < ? OR (failed_at = ? AND id < ?))';
      bindings.push(cursor.failed_at, cursor.failed_at, cursor.id);
    }

    // Order by failed_at DESC, id DESC for consistent pagination
    query += ' ORDER BY failed_at DESC, id DESC LIMIT ?';
    bindings.push(limit + 1); // Fetch one extra to check if there are more

    const { results } = await env.DB.prepare(query)
      .bind(...bindings)
      .all<DlqMessageRow>();

    // Check if there are more results
    const hasMore = results.length > limit;
    const pageResults = hasMore ? results.slice(0, limit) : results;

    // Generate next cursor from the last item
    let nextCursor: string | null = null;
    if (hasMore && pageResults.length > 0) {
      const lastItem = pageResults[pageResults.length - 1];
      const cursorData: PaginationCursor = {
        failed_at: lastItem.failed_at,
        id: lastItem.id,
      };
      nextCursor = btoa(JSON.stringify(cursorData));
    }

    // Get total count for the filtered status (for display purposes)
    let countQuery = 'SELECT COUNT(*) as count FROM dlq_messages WHERE 1=1';
    const countBindings: (string | number)[] = [];

    if (status && status !== 'all') {
      countQuery += ' AND status = ?';
      countBindings.push(status);
    }

    if (beerId) {
      countQuery += ' AND beer_id = ?';
      countBindings.push(beerId);
    }

    const countResult = await env.DB.prepare(countQuery)
      .bind(...countBindings)
      .first<{ count: number }>();

    const messages = pageResults.map(row => {
      const base = {
        id: row.id,
        message_id: row.message_id,
        beer_id: row.beer_id,
        beer_name: row.beer_name,
        brewer: row.brewer,
        failed_at: row.failed_at,
        failure_count: row.failure_count,
        failure_reason: row.failure_reason,
        source_queue: row.source_queue,
        status: row.status,
        replay_count: row.replay_count,
        replayed_at: row.replayed_at,
        acknowledged_at: row.acknowledged_at,
      };

      // Optionally include raw_message (can be large)
      if (includeRaw) {
        return { ...base, raw_message: row.raw_message };
      }
      return base;
    });

    return Response.json({
      success: true,
      requestId: reqCtx.requestId,
      data: {
        messages,
        total_count: countResult?.count || 0,
        limit,
        next_cursor: nextCursor,
        has_more: hasMore,
      },
    }, { headers });
  } catch (error) {
    console.error('Failed to list DLQ messages:', error);
    return errorResponse(
      'Failed to retrieve DLQ messages',
      'DB_ERROR',
      { requestId: reqCtx.requestId, headers, status: 500 }
    );
  }
}

/**
 * GET /admin/dlq/stats - Get DLQ statistics
 */
async function handleDlqStats(
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  try {
    // Get counts by status
    const { results: statusCounts } = await env.DB.prepare(`
      SELECT status, COUNT(*) as count
      FROM dlq_messages
      GROUP BY status
    `).all<{ status: string; count: number }>();

    // Get oldest pending message
    const oldestPending = await env.DB.prepare(`
      SELECT failed_at
      FROM dlq_messages
      WHERE status = 'pending'
      ORDER BY failed_at ASC
      LIMIT 1
    `).first<{ failed_at: number }>();

    // Get failure breakdown (top brewers with failures)
    const { results: topFailures } = await env.DB.prepare(`
      SELECT brewer, COUNT(*) as count
      FROM dlq_messages
      WHERE status = 'pending' AND brewer IS NOT NULL
      GROUP BY brewer
      ORDER BY count DESC
      LIMIT 10
    `).all<{ brewer: string; count: number }>();

    // Get recent activity (last 24 hours)
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentActivity = await env.DB.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'replayed' AND replayed_at > ? THEN 1 END) as replayed_24h,
        COUNT(CASE WHEN status = 'acknowledged' AND acknowledged_at > ? THEN 1 END) as acknowledged_24h,
        COUNT(CASE WHEN failed_at > ? THEN 1 END) as new_failures_24h
      FROM dlq_messages
    `).bind(dayAgo, dayAgo, dayAgo).first<{
      replayed_24h: number;
      acknowledged_24h: number;
      new_failures_24h: number;
    }>();

    // Get messages with multiple replays (indicates persistent issues)
    const { results: repeatFailures } = await env.DB.prepare(`
      SELECT beer_id, beer_name, replay_count
      FROM dlq_messages
      WHERE status = 'pending' AND replay_count > 0
      ORDER BY replay_count DESC
      LIMIT 10
    `).all<{ beer_id: string; beer_name: string | null; replay_count: number }>();

    const stats: Record<string, number> = {};
    for (const row of statusCounts) {
      stats[row.status] = row.count;
    }

    const oldestAgeHours = oldestPending
      ? (Date.now() - oldestPending.failed_at) / (60 * 60 * 1000)
      : 0;

    return Response.json({
      success: true,
      requestId: reqCtx.requestId,
      data: {
        by_status: {
          pending: stats['pending'] || 0,
          replaying: stats['replaying'] || 0,
          replayed: stats['replayed'] || 0,
          acknowledged: stats['acknowledged'] || 0,
        },
        oldest_pending_age_hours: Math.round(oldestAgeHours * 10) / 10,
        top_failing_brewers: topFailures,
        repeat_failures: repeatFailures,
        last_24h: recentActivity || {
          replayed_24h: 0,
          acknowledged_24h: 0,
          new_failures_24h: 0,
        },
      },
    }, { headers });
  } catch (error) {
    console.error('Failed to get DLQ stats:', error);
    return errorResponse(
      'Failed to retrieve DLQ statistics',
      'DB_ERROR',
      { requestId: reqCtx.requestId, headers, status: 500 }
    );
  }
}

/**
 * POST /admin/dlq/replay - Replay messages back to the main enrichment queue
 *
 * Uses optimistic status update to prevent race conditions:
 * 1. Set status to 'replaying' before queue send
 * 2. Rollback to 'pending' on failure
 * 3. Set to 'replayed' and increment replay_count on success
 */
async function handleDlqReplay(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  try {
    const body = await request.json() as DlqReplayRequest;
    const { ids, delay_seconds = 0 } = body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return errorResponse(
        'ids array required',
        'INVALID_REQUEST',
        { requestId: reqCtx.requestId, headers, status: 400 }
      );
    }

    // Limit batch size
    const limitedIds = ids.slice(0, 50);
    const now = Date.now();

    // STEP 1: Optimistically update status to 'replaying' to prevent race conditions
    const placeholders = limitedIds.map(() => '?').join(',');
    const updateResult = await env.DB.prepare(
      `UPDATE dlq_messages
       SET status = 'replaying'
       WHERE id IN (${placeholders}) AND status = 'pending'`
    ).bind(...limitedIds).run();

    const claimedCount = updateResult.meta.changes;

    if (claimedCount === 0) {
      return Response.json({
        success: true,
        requestId: reqCtx.requestId,
        data: {
          requested_count: limitedIds.length,
          replayed_count: 0,
          message: 'No pending messages found to replay',
        },
      }, { headers });
    }

    // STEP 2: Fetch the messages we just claimed
    const { results } = await env.DB.prepare(
      `SELECT id, raw_message, replay_count FROM dlq_messages
       WHERE id IN (${placeholders}) AND status = 'replaying'`
    ).bind(...limitedIds).all<{ id: number; raw_message: string; replay_count: number }>();

    let replayedCount = 0;
    const replayedIds: number[] = [];
    const failedIds: number[] = [];

    // STEP 3: Send messages to queue
    for (const row of results) {
      try {
        const messageBody = JSON.parse(row.raw_message) as EnrichmentMessage;

        await env.ENRICHMENT_QUEUE.send(messageBody, {
          delaySeconds: delay_seconds > 0 ? delay_seconds : undefined,
        });

        replayedIds.push(row.id);
        replayedCount++;

        console.log(`DLQ message replayed: dlqId=${row.id}, beerId=${messageBody.beerId}, replayCount=${row.replay_count + 1}`);
      } catch (error) {
        console.error(`Failed to replay DLQ message: dlqId=${row.id}, error=${String(error)}`);
        failedIds.push(row.id);
      }
    }

    // STEP 4: Update successfully replayed messages
    if (replayedIds.length > 0) {
      const successPlaceholders = replayedIds.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE dlq_messages
         SET status = 'replayed', replayed_at = ?, replay_count = replay_count + 1
         WHERE id IN (${successPlaceholders})`
      ).bind(now, ...replayedIds).run();
    }

    // STEP 5: Rollback failed messages back to 'pending'
    if (failedIds.length > 0) {
      const failPlaceholders = failedIds.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE dlq_messages
         SET status = 'pending'
         WHERE id IN (${failPlaceholders})`
      ).bind(...failedIds).run();

      console.warn(`Rolled back failed replay attempts: failedIds=${JSON.stringify(failedIds)}`);
    }

    return Response.json({
      success: true,
      requestId: reqCtx.requestId,
      data: {
        requested_count: limitedIds.length,
        claimed_count: claimedCount,
        replayed_count: replayedCount,
        failed_count: failedIds.length,
        queued_to: 'beer-enrichment',
      },
    }, { headers });

  } catch (error) {
    console.error('Failed to replay DLQ messages:', error);
    return errorResponse(
      'Failed to replay messages',
      'REPLAY_ERROR',
      { requestId: reqCtx.requestId, headers, status: 500 }
    );
  }
}

/**
 * POST /admin/dlq/acknowledge - Acknowledge (dismiss) messages without replaying
 */
async function handleDlqAcknowledge(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  try {
    const body = await request.json() as DlqAcknowledgeRequest;
    const { ids } = body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return errorResponse(
        'ids array required',
        'INVALID_REQUEST',
        { requestId: reqCtx.requestId, headers, status: 400 }
      );
    }

    // Limit batch size
    const limitedIds = ids.slice(0, 100);
    const now = Date.now();

    const placeholders = limitedIds.map(() => '?').join(',');
    const result = await env.DB.prepare(
      `UPDATE dlq_messages
       SET status = 'acknowledged', acknowledged_at = ?
       WHERE id IN (${placeholders}) AND status = 'pending'`
    ).bind(now, ...limitedIds).run();

    console.log(`DLQ messages acknowledged: requestedCount=${limitedIds.length}, acknowledgedCount=${result.meta.changes}`);

    return Response.json({
      success: true,
      requestId: reqCtx.requestId,
      data: {
        acknowledged_count: result.meta.changes,
      },
    }, { headers });

  } catch (error) {
    console.error('Failed to acknowledge DLQ messages:', error);
    return errorResponse(
      'Failed to acknowledge messages',
      'DB_ERROR',
      { requestId: reqCtx.requestId, headers, status: 500 }
    );
  }
}

// ============================================================================
// Manual Enrichment Trigger Handler
// ============================================================================

/**
 * POST /admin/enrich/trigger - Manually trigger enrichment queue processing
 *
 * IMPORTANT: This endpoint only CHECKS quota and queues beers.
 * The queue consumer is the single source of truth for quota reservation.
 * This avoids double-counting that would occur if both trigger and consumer
 * reserved quota.
 */
async function handleEnrichmentTrigger(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  const dailyLimit = parseInt(env.DAILY_ENRICHMENT_LIMIT || '500');
  const monthlyLimit = parseInt(env.MONTHLY_ENRICHMENT_LIMIT || '2000');
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const monthStart = today.slice(0, 7) + '-01';
  // Calculate last day of current month correctly
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthEnd = today.slice(0, 7) + '-' + String(lastDayOfMonth).padStart(2, '0');

  try {
    // Parse request body
    const body = await request.json().catch(() => ({})) as TriggerEnrichmentRequest;
    const requestedLimit = Math.min(Math.max(1, body.limit || 50), 100); // Clamp to 1-100
    const excludeFailures = body.exclude_failures ?? false;

    // Helper to build response
    const buildResponse = (
      beersQueued: number,
      skipReason: TriggerEnrichmentData['skip_reason'] | undefined,
      dailyUsed: number,
      monthlyUsed: number
    ): Response => {
      const data: TriggerEnrichmentData = {
        beers_queued: beersQueued,
        skip_reason: skipReason,
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

      // Remove skip_reason if not set
      if (!data.skip_reason) {
        delete data.skip_reason;
      }

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

    // Query beers with NULL ABV
    let query = `
      SELECT id, brew_name, brewer
      FROM enriched_beers
      WHERE abv IS NULL
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

    // Queue beers for enrichment using sendBatch (max 100 messages)
    await env.ENRICHMENT_QUEUE.sendBatch(
      beersToEnrich.results.map((beer) => ({
        body: {
          beerId: beer.id,
          beerName: beer.brew_name,
          brewer: beer.brewer,
        },
      }))
    );

    const beersQueued = beersToEnrich.results.length;
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

// ============================================================================
// DLQ Cleanup
// ============================================================================

/**
 * Clean up old acknowledged and replayed DLQ messages.
 * Should be called from scheduled() handler.
 */
async function cleanupOldDlqMessages(
  db: D1Database,
  requestId: string
): Promise<void> {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const batchLimit = 1000; // Limit deletions per iteration to avoid long-running queries

  // Delete acknowledged messages older than 30 days (in batches)
  let ackDeleted = 0;
  let ackResult;
  do {
    ackResult = await db.prepare(`
      DELETE FROM dlq_messages
      WHERE id IN (
        SELECT id FROM dlq_messages
        WHERE status = 'acknowledged'
          AND acknowledged_at < ?
        LIMIT ?
      )
    `).bind(thirtyDaysAgo, batchLimit).run();
    ackDeleted += ackResult.meta.changes;
  } while (ackResult.meta.changes === batchLimit);

  // Delete replayed messages older than 30 days (in batches)
  let replayDeleted = 0;
  let replayResult;
  do {
    replayResult = await db.prepare(`
      DELETE FROM dlq_messages
      WHERE id IN (
        SELECT id FROM dlq_messages
        WHERE status = 'replayed'
          AND replayed_at < ?
        LIMIT ?
      )
    `).bind(thirtyDaysAgo, batchLimit).run();
    replayDeleted += replayResult.meta.changes;
  } while (replayResult.meta.changes === batchLimit);

  if (ackDeleted > 0 || replayDeleted > 0) {
    console.log(`DLQ cleanup completed: acknowledged_deleted=${ackDeleted}, replayed_deleted=${replayDeleted}, requestId=${requestId}`);
  }
}

// ============================================================================
// Database Helpers
// ============================================================================

/**
 * Extract ABV percentage from beer description HTML.
 * Ported from mobile app's beerGlassType.ts extractABV function.
 *
 * Supports multiple formats:
 * - "5.2%" or "8%"
 * - "5.2 ABV" or "ABV 5.2"
 * - "5.2% ABV" or "ABV: 5.2%"
 *
 * @param description - HTML description string containing ABV percentage
 * @returns ABV as a number or null if not found/invalid
 */
function extractABV(description: string | undefined): number | null {
  if (!description) return null;

  // Strip HTML tags to get plain text
  const plainText = description.replace(/<[^>]*>/g, '');

  // Pattern 1: Look for percentage pattern (e.g., "5.2%" or "8%")
  const percentageMatch = plainText.match(/\b(\d+(?:\.\d+)?)\s*%/);
  if (percentageMatch && percentageMatch[1]) {
    const abv = parseFloat(percentageMatch[1]);
    if (!isNaN(abv) && abv >= 0 && abv <= 100) {
      return abv;
    }
  }

  // Pattern 2: Look for "ABV" near a number (e.g., "5.2 ABV", "ABV 5.2", "ABV: 5.2")
  const abvPattern = /(?:ABV[:\s]*\b(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s*ABV)/i;
  const abvMatch = plainText.match(abvPattern);

  if (abvMatch) {
    // Match could be in group 1 (ABV first) or group 2 (number first)
    const abvString = abvMatch[1] || abvMatch[2];
    if (abvString) {
      const abv = parseFloat(abvString);
      if (!isNaN(abv) && abv >= 0 && abv <= 100) {
        return abv;
      }
    }
  }

  return null;
}

/**
 * Insert placeholder records for beers that need enrichment.
 * Uses INSERT OR IGNORE so existing beers are not overwritten.
 * Uses chunking to respect D1's parameter limits.
 *
 * IMPORTANT: Extracts ABV from brew_description when available.
 * Only beers where ABV couldn't be parsed will have NULL abv and
 * be candidates for Perplexity enrichment.
 *
 * This syncs beers from Flying Saucer to our enriched_beers table,
 * enabling the trigger endpoint and cron to find beers to enrich.
 */
async function insertPlaceholders(
  db: D1Database,
  beers: Array<{ id: string; brew_name: string; brewer: string; brew_description?: string }>,
  requestId: string
): Promise<void> {
  if (beers.length === 0) {
    return;
  }

  const CHUNK_SIZE = 25; // D1 has limits on batched operations
  const now = Date.now();

  let withAbv = 0;
  let withoutAbv = 0;

  for (let i = 0; i < beers.length; i += CHUNK_SIZE) {
    const chunk = beers.slice(i, i + CHUNK_SIZE);
    // Use INSERT ... ON CONFLICT UPDATE to:
    // 1. Always update last_seen_at when beer is seen (for cleanup tracking)
    // 2. Only set ABV/confidence/source if currently NULL (preserve Perplexity data)
    const stmt = db.prepare(`
      INSERT INTO enriched_beers (id, brew_name, brewer, abv, confidence, enrichment_source, updated_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        -- Only update ABV/confidence/source if we have a parsed ABV from description
        -- (don't overwrite Perplexity data with NULL)
        abv = CASE
          WHEN enriched_beers.enrichment_source = 'perplexity' THEN enriched_beers.abv
          WHEN excluded.abv IS NOT NULL THEN excluded.abv
          ELSE enriched_beers.abv
        END,
        confidence = CASE
          WHEN enriched_beers.enrichment_source = 'perplexity' THEN enriched_beers.confidence
          WHEN excluded.abv IS NOT NULL THEN excluded.confidence
          ELSE enriched_beers.confidence
        END,
        enrichment_source = CASE
          WHEN enriched_beers.enrichment_source = 'perplexity' THEN 'perplexity'
          WHEN excluded.abv IS NOT NULL THEN 'description'
          ELSE enriched_beers.enrichment_source
        END
    `);
    const batch = chunk.map(b => {
      const abv = extractABV(b.brew_description);
      if (abv !== null) {
        withAbv++;
      } else {
        withoutAbv++;
      }
      // Confidence 0.9 for description-extracted ABV (reliable but not verified)
      // NULL confidence for beers needing enrichment
      const confidence = abv !== null ? 0.9 : null;
      // Source: 'description' for parsed ABV, NULL for beers needing enrichment
      // (Perplexity consumer will set 'perplexity' when it enriches)
      const source = abv !== null ? 'description' : null;
      // last_seen_at = now for both insert and update
      return stmt.bind(b.id, b.brew_name, b.brewer, abv, confidence, source, now, now);
    });

    try {
      await db.batch(batch);
    } catch (error) {
      console.error(`[insertPlaceholders] Error inserting chunk ${i / CHUNK_SIZE + 1}:`, error);
      // Continue with next chunk - don't fail the entire operation
    }
  }

  console.log(`[insertPlaceholders] Synced ${beers.length} beers (${withAbv} with ABV, ${withoutAbv} need enrichment), requestId=${requestId}`);
}

// ============================================================================
// Endpoint Handlers
// ============================================================================

/**
 * Result from handleGetBeers for analytics tracking
 */
interface GetBeersResult {
  response: Response;
  beersReturned: number;
  upstreamLatencyMs: number;
}

/**
 * GET /beers?sid= - Fetch beers from Flying Saucer and merge with enrichment data
 */
async function handleGetBeers(
  env: Env,
  ctx: ExecutionContext,
  headers: Record<string, string>,
  reqCtx: RequestContext,
  storeId: string
): Promise<GetBeersResult> {
  const upstreamStartTime = Date.now();

  try {
    // 1. Fetch from Flying Saucer
    const fsUrl = `${env.FLYING_SAUCER_API_BASE}?sid=${storeId}`;
    const fsResp = await fetch(fsUrl, {
      headers: { 'User-Agent': 'BeerSelector/1.0' }
    });

    const upstreamLatencyMs = Date.now() - upstreamStartTime;

    if (!fsResp.ok) {
      console.error(`Flying Saucer API error: ${fsResp.status}`);
      return {
        response: new Response(JSON.stringify({ error: 'Upstream Error' }), {
          status: 502,
          headers: { ...headers, 'Content-Type': 'application/json' }
        }),
        beersReturned: 0,
        upstreamLatencyMs,
      };
    }

    const fsData = await fsResp.json() as unknown[];

    // 2. Parse response with type guards
    // Flying Saucer API returns: [{...}, {brewInStock: [...]}]
    let rawBeersUnvalidated: unknown[] = [];

    if (Array.isArray(fsData)) {
      const stockObject = fsData.find(hasBeerStock);
      if (stockObject) {
        rawBeersUnvalidated = stockObject.brewInStock;
      }
    }

    // Filter to only valid beer objects
    const rawBeers = rawBeersUnvalidated.filter(isValidBeer);

    // 3. Fetch enrichment data from D1
    const { results } = await env.DB.prepare(
      'SELECT id, abv, confidence, enrichment_source FROM enriched_beers'
    ).all<{ id: string; abv: number | null; confidence: number; enrichment_source: string | null }>();

    const enrichmentMap = new Map(
      results.map(r => [r.id, { abv: r.abv, confidence: r.confidence, source: r.enrichment_source }])
    );

    // 4. Merge data
    const enrichedBeers = rawBeers.map(beer => {
      const enrichment = enrichmentMap.get(beer.id);
      return {
        ...beer,
        enriched_abv: enrichment?.abv ?? null,
        enrichment_confidence: enrichment?.confidence ?? null,
        enrichment_source: enrichment?.source ?? null,
      };
    });

    // 5. Sync beers to enriched_beers table (background task)
    // This populates the table so cron/trigger can find beers to enrich.
    // ABV is extracted from brew_description when available - only beers
    // without parseable ABV will be queued for Perplexity enrichment.
    const beersForPlaceholders = rawBeers.map(beer => ({
      id: beer.id,
      brew_name: beer.brew_name,
      brewer: beer.brewer,
      brew_description: beer.brew_description,
    }));
    ctx.waitUntil(insertPlaceholders(env.DB, beersForPlaceholders, reqCtx.requestId));

    return {
      response: Response.json({
        beers: enrichedBeers,
        storeId,
        requestId: reqCtx.requestId
      }, { headers }),
      beersReturned: enrichedBeers.length,
      upstreamLatencyMs,
    };

  } catch (error) {
    console.error('Error in handleGetBeers:', error);
    return {
      response: new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { ...headers, 'Content-Type': 'application/json' }
      }),
      beersReturned: 0,
      upstreamLatencyMs: Date.now() - upstreamStartTime,
    };
  }
}

/**
 * POST /beers/batch - Batch lookup enrichment data by beer IDs
 */
async function handleBatchLookup(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  try {
    const body = await request.json() as { ids?: string[] };
    const ids = body.ids;

    // Validate input
    if (!Array.isArray(ids) || ids.length === 0) {
      return Response.json(
        { error: 'ids array required', requestId: reqCtx.requestId },
        { status: 400, headers }
      );
    }

    // Limit batch size to 100
    const limitedIds = ids.slice(0, 100);

    // Build parameterized query
    const placeholders = limitedIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, abv, confidence, enrichment_source, is_verified FROM enriched_beers WHERE id IN (${placeholders})`
    ).bind(...limitedIds).all<{
      id: string;
      abv: number | null;
      confidence: number;
      enrichment_source: string | null;
      is_verified: number;
    }>();

    // Format response
    const enrichmentData: Record<string, { abv: number | null; confidence: number; source: string | null; is_verified: boolean }> = {};
    for (const row of results) {
      enrichmentData[row.id] = {
        abv: row.abv,
        confidence: row.confidence,
        source: row.enrichment_source,
        is_verified: Boolean(row.is_verified),
      };
    }

    return Response.json({
      enrichments: enrichmentData,
      requestId: reqCtx.requestId
    }, { headers });

  } catch (error) {
    console.error('Error in handleBatchLookup:', error);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' }
    });
  }
}

// ============================================================================
// Main Export
// ============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(env);

    // Create request context
    const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For');
    const clientIdentifier = request.headers.get('X-Client-ID') || clientIp || 'unknown';

    const requestContext: RequestContext = {
      requestId: crypto.randomUUID(),
      startTime: Date.now(),
      clientIdentifier: clientIdentifier.substring(0, 64),
      apiKeyHash: null,
      clientIp,
      userAgent: request.headers.get('User-Agent'),
    };

    // Track metrics for the current request (populated by handlers)
    let beersReturnedCount: number | undefined;
    let upstreamLatency: number | undefined;
    let storeIdForAnalytics: string | undefined;

    // Helper to create response and log audit
    const respond = async (
      body: string | object | null,
      status: number,
      headers: Record<string, string>,
      error?: string
    ): Promise<Response> => {
      // Audit log to D1
      ctx.waitUntil(writeAuditLog(env.DB, requestContext, request.method, url.pathname, status, error));

      // Track in Analytics Engine (non-blocking via ctx.waitUntil is not needed - writeDataPoint is already non-blocking)
      trackRequest(env.ANALYTICS, {
        endpoint: url.pathname,
        method: request.method,
        storeId: storeIdForAnalytics,
        statusCode: status,
        errorType: error,
        clientId: requestContext.clientIdentifier,
        responseTimeMs: Date.now() - requestContext.startTime,
        beersReturned: beersReturnedCount,
        upstreamLatencyMs: upstreamLatency,
      });

      if (body === null) return new Response(null, { status, headers });
      if (typeof body === 'object') return Response.json(body, { status, headers });
      return new Response(body, { status, headers });
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return respond(null, 204, corsHeaders || {});
    }

    // Health check (no auth required)
    if (url.pathname === '/health') {
      return handleHealth(env);
    }

    // Require CORS config for all other routes
    if (!corsHeaders) {
      return respond({ error: 'Server misconfigured: ALLOWED_ORIGIN not set' }, 500, {});
    }

    // Authenticate
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey || !(await timingSafeCompare(apiKey, env.API_KEY))) {
      return respond({ error: 'Unauthorized' }, 401, corsHeaders, 'Invalid API key');
    }
    requestContext.apiKeyHash = await hashApiKey(apiKey);

    // Rate limit
    const rateLimit = parseInt(env.RATE_LIMIT_RPM, 10) || 60;
    const rateLimitResult = await checkRateLimit(env.DB, requestContext.clientIdentifier, rateLimit);

    if (!rateLimitResult.allowed) {
      // Track rate limit event specifically for detailed monitoring
      trackRateLimit(env.ANALYTICS, requestContext.clientIdentifier, url.pathname);

      return respond(
        { error: 'Rate limit exceeded', requestId: requestContext.requestId },
        429,
        {
          ...corsHeaders,
          'X-RateLimit-Limit': String(rateLimit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor(rateLimitResult.resetAt / 1000)),
          'Retry-After': String(Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)),
        },
        'Rate limited'
      );
    }

    // Rate limit headers for all responses
    const rateLimitHeaders = {
      'X-RateLimit-Limit': String(rateLimit),
      'X-RateLimit-Remaining': String(rateLimitResult.remaining),
      'X-RateLimit-Reset': String(Math.floor(rateLimitResult.resetAt / 1000)),
      'X-Request-ID': requestContext.requestId,
    };

    // Route: GET /beers
    if (url.pathname === '/beers' && request.method === 'GET') {
      const storeId = url.searchParams.get('sid');

      if (!storeId) {
        return respond(
          { error: 'Missing required parameter: sid', requestId: requestContext.requestId },
          400,
          { ...corsHeaders, ...rateLimitHeaders }
        );
      }

      if (!VALID_STORE_IDS.has(storeId)) {
        return respond(
          { error: 'Invalid store ID', requestId: requestContext.requestId },
          400,
          { ...corsHeaders, ...rateLimitHeaders }
        );
      }

      // Set store ID for analytics tracking
      storeIdForAnalytics = storeId;

      // Call handler and track metrics
      const result = await handleGetBeers(env, ctx, { ...corsHeaders, ...rateLimitHeaders }, requestContext, storeId);

      // Set analytics metrics from handler result
      beersReturnedCount = result.beersReturned;
      upstreamLatency = result.upstreamLatencyMs;

      // Track the request with analytics (we need to track here since handleGetBeers bypasses respond())
      trackRequest(env.ANALYTICS, {
        endpoint: url.pathname,
        method: request.method,
        storeId: storeIdForAnalytics,
        statusCode: result.response.status,
        clientId: requestContext.clientIdentifier,
        responseTimeMs: Date.now() - requestContext.startTime,
        beersReturned: beersReturnedCount,
        upstreamLatencyMs: upstreamLatency,
      });

      // Write audit log for this request (since we're not using respond())
      ctx.waitUntil(writeAuditLog(env.DB, requestContext, request.method, url.pathname, result.response.status));

      return result.response;
    }

    // Route: POST /beers/batch
    if (url.pathname === '/beers/batch' && request.method === 'POST') {
      const result = await handleBatchLookup(request, env, { ...corsHeaders, ...rateLimitHeaders }, requestContext);

      // Track the request with analytics
      trackRequest(env.ANALYTICS, {
        endpoint: url.pathname,
        method: request.method,
        statusCode: result.status,
        clientId: requestContext.clientIdentifier,
        responseTimeMs: Date.now() - requestContext.startTime,
      });

      // Write audit log for this request (since handleBatchLookup bypasses respond())
      ctx.waitUntil(writeAuditLog(env.DB, requestContext, request.method, url.pathname, result.status));

      return result;
    }

    // ========================================================================
    // Admin Routes - Require additional ADMIN_SECRET authentication
    // ========================================================================

    if (url.pathname.startsWith('/admin/')) {
      // Admin routes require additional authentication
      const adminAuth = await authorizeAdmin(request, env, requestContext);
      if (!adminAuth.authorized) {
        return respond(
          { error: adminAuth.error || 'Unauthorized', requestId: requestContext.requestId },
          403,
          { ...corsHeaders, ...rateLimitHeaders },
          'Admin auth failed'
        );
      }

      const adminSecretHash = await hashApiKey(request.headers.get('X-Admin-Secret') || '');

      // Route: GET /admin/dlq - List DLQ messages
      if (url.pathname === '/admin/dlq' && request.method === 'GET') {
        const operationStart = Date.now();
        const result = await handleDlqList(env, { ...corsHeaders, ...rateLimitHeaders }, requestContext, url.searchParams);

        // Parse response to get message count for analytics
        let messageCount = 0;
        try {
          const responseBody = await result.clone().json() as { data?: { messages?: unknown[] } };
          messageCount = responseBody.data?.messages?.length || 0;
        } catch {
          // Ignore parse errors
        }

        // Track admin operation
        trackAdminDlq(env.ANALYTICS, {
          operation: 'dlq_list',
          success: result.status === 200,
          messageCount,
          durationMs: Date.now() - operationStart,
        });

        // Write admin audit log
        ctx.waitUntil(writeAdminAuditLog(env.DB, requestContext, 'dlq_list', {
          message_count: messageCount,
        }, adminSecretHash));

        return result;
      }

      // Route: GET /admin/dlq/stats - Get DLQ statistics
      if (url.pathname === '/admin/dlq/stats' && request.method === 'GET') {
        const operationStart = Date.now();
        const result = await handleDlqStats(env, { ...corsHeaders, ...rateLimitHeaders }, requestContext);

        // Track admin operation
        trackAdminDlq(env.ANALYTICS, {
          operation: 'dlq_stats',
          success: result.status === 200,
          messageCount: 0,
          durationMs: Date.now() - operationStart,
        });

        // Write admin audit log
        ctx.waitUntil(writeAdminAuditLog(env.DB, requestContext, 'dlq_stats', {}, adminSecretHash));

        return result;
      }

      // Route: POST /admin/dlq/replay - Replay DLQ messages
      if (url.pathname === '/admin/dlq/replay' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleDlqReplay(request, env, { ...corsHeaders, ...rateLimitHeaders }, requestContext);

        // Parse response to get replayed count for analytics
        let replayedCount = 0;
        try {
          const responseBody = await result.clone().json() as { data?: { replayed_count?: number } };
          replayedCount = responseBody.data?.replayed_count || 0;
        } catch {
          // Ignore parse errors
        }

        // Track admin operation
        trackAdminDlq(env.ANALYTICS, {
          operation: 'dlq_replay',
          success: result.status === 200,
          messageCount: replayedCount,
          durationMs: Date.now() - operationStart,
        });

        // Write admin audit log
        ctx.waitUntil(writeAdminAuditLog(env.DB, requestContext, 'dlq_replay', {
          replayed_count: replayedCount,
        }, adminSecretHash));

        return result;
      }

      // Route: POST /admin/dlq/acknowledge - Acknowledge DLQ messages
      if (url.pathname === '/admin/dlq/acknowledge' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleDlqAcknowledge(request, env, { ...corsHeaders, ...rateLimitHeaders }, requestContext);

        // Parse response to get acknowledged count for analytics
        let acknowledgedCount = 0;
        try {
          const responseBody = await result.clone().json() as { data?: { acknowledged_count?: number } };
          acknowledgedCount = responseBody.data?.acknowledged_count || 0;
        } catch {
          // Ignore parse errors
        }

        // Track admin operation
        trackAdminDlq(env.ANALYTICS, {
          operation: 'dlq_acknowledge',
          success: result.status === 200,
          messageCount: acknowledgedCount,
          durationMs: Date.now() - operationStart,
        });

        // Write admin audit log
        ctx.waitUntil(writeAdminAuditLog(env.DB, requestContext, 'dlq_acknowledge', {
          acknowledged_count: acknowledgedCount,
        }, adminSecretHash));

        return result;
      }

      // Route: POST /admin/enrich/trigger - Manually trigger enrichment
      if (url.pathname === '/admin/enrich/trigger' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleEnrichmentTrigger(request, env, { ...corsHeaders, ...rateLimitHeaders }, requestContext);

        // Parse response to get beers queued count for analytics/logging
        let beersQueued = 0;
        let skipReason: 'kill_switch' | 'daily_limit' | 'monthly_limit' | 'no_eligible_beers' | undefined;
        let dailyRemaining = 0;
        let monthlyRemaining = 0;
        try {
          const responseBody = await result.clone().json() as {
            data?: {
              beers_queued?: number;
              skip_reason?: 'kill_switch' | 'daily_limit' | 'monthly_limit' | 'no_eligible_beers';
              quota?: {
                daily?: { remaining?: number };
                monthly?: { remaining?: number };
              };
            }
          };
          beersQueued = responseBody.data?.beers_queued || 0;
          skipReason = responseBody.data?.skip_reason;
          dailyRemaining = responseBody.data?.quota?.daily?.remaining || 0;
          monthlyRemaining = responseBody.data?.quota?.monthly?.remaining || 0;
        } catch {
          // Ignore parse errors
        }

        // Track analytics
        trackAdminTrigger(env.ANALYTICS, {
          beersQueued,
          dailyRemaining,
          monthlyRemaining,
          durationMs: Date.now() - operationStart,
          success: result.status === 200,
          skipReason,
        });

        // Write admin audit log
        ctx.waitUntil(writeAdminAuditLog(env.DB, requestContext, 'enrich_trigger', {
          beers_queued: beersQueued,
          skip_reason: skipReason,
          duration_ms: Date.now() - operationStart,
        }, adminSecretHash));

        console.log(`[admin] enrich_trigger completed: beersQueued=${beersQueued}, skipReason=${skipReason || 'none'}, durationMs=${Date.now() - operationStart}, requestId=${requestContext.requestId}`);

        return result;
      }

      // Admin route not found
      return respond(
        { error: 'Admin endpoint not found', requestId: requestContext.requestId },
        404,
        { ...corsHeaders, ...rateLimitHeaders }
      );
    }

    return respond(
      { error: 'Not Found', requestId: requestContext.requestId },
      404,
      { ...corsHeaders, ...rateLimitHeaders }
    );
  },

  // Cron job: Query beers needing enrichment and queue them
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron triggered:', event.cron);
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

    const today = new Date().toISOString().split('T')[0];
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

      // Queue each beer for enrichment (processed in parallel by consumers)
      // Using sendBatch for efficiency instead of individual sends
      await env.ENRICHMENT_QUEUE.sendBatch(
        beersToEnrich.results.map((beer) => ({
          body: {
            beerId: beer.id,
            beerName: beer.brew_name,
            brewer: beer.brewer,
          },
        }))
      );

      const beersQueued = beersToEnrich.results.length;
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
      const cutoffDate = ninetyDaysAgo.toISOString().split('T')[0];

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
  },

  // Queue consumer: Handle BOTH main enrichment queue AND DLQ
  async queue(
    batch: MessageBatch<EnrichmentMessage>,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const requestId = crypto.randomUUID();

    console.log(`Queue batch received: messageCount=${batch.messages.length}, queue=${batch.queue}, requestId=${requestId}`);

    // Route based on which queue the message came from
    if (batch.queue === 'beer-enrichment-dlq') {
      // DLQ messages - store to D1
      await handleDlqBatch(batch, env, requestId);
    } else if (batch.queue === 'beer-enrichment') {
      // Main queue messages - process enrichment
      await handleEnrichmentBatch(batch, env);
    } else {
      console.warn(`Unknown queue: ${batch.queue}, acknowledging messages to prevent infinite loops`);
      for (const message of batch.messages) {
        message.ack();
      }
    }
  },
};

// ============================================================================
// Queue Batch Handlers
// ============================================================================

/**
 * Handle DLQ messages - store to D1 for admin inspection and replay
 */
async function handleDlqBatch(
  batch: MessageBatch<EnrichmentMessage>,
  env: Env,
  requestId: string
): Promise<void> {
  for (const message of batch.messages) {
    const storeStartTime = Date.now();

    try {
      await storeDlqMessage(env.DB, message, batch.queue);
      message.ack();

      // Analytics tracking for DLQ storage
      trackDlqConsumer(env.ANALYTICS, {
        beerId: message.body?.beerId || 'unknown',
        attempts: message.attempts,
        sourceQueue: 'beer-enrichment', // The source queue that sent to DLQ
        success: true,
        durationMs: Date.now() - storeStartTime,
      });

      console.log(`DLQ message stored: messageId=${message.id}, beerId=${message.body?.beerId}, attempts=${message.attempts}, requestId=${requestId}`);
    } catch (error) {
      console.error(`Failed to store DLQ message: messageId=${message.id}, error=${String(error)}, requestId=${requestId}`);

      // Track failed storage attempt
      trackDlqConsumer(env.ANALYTICS, {
        beerId: message.body?.beerId || 'unknown',
        attempts: message.attempts,
        sourceQueue: 'beer-enrichment',
        success: false,
        durationMs: Date.now() - storeStartTime,
        errorType: 'db_write_error',
      });

      // With max_retries: 3, retry() will requeue the message
      // After 3 failures, the message will be dropped
      message.retry();
    }
  }

  console.log(`DLQ batch processed: processedCount=${batch.messages.length}, requestId=${requestId}`);
}

/**
 * Store a DLQ message to D1 for admin inspection
 */
async function storeDlqMessage(
  db: D1Database,
  message: Message<EnrichmentMessage>,
  sourceQueue: string
): Promise<void> {
  const body = message.body;
  const now = Date.now();

  // Note: failure_count comes from message.attempts
  // This is the number of delivery attempts Cloudflare made before sending to DLQ
  await db.prepare(`
    INSERT INTO dlq_messages (
      message_id, beer_id, beer_name, brewer,
      failed_at, failure_count, source_queue, raw_message, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(message_id) DO UPDATE SET
      failed_at = excluded.failed_at,
      failure_count = excluded.failure_count,
      raw_message = excluded.raw_message,
      status = 'pending'
  `).bind(
    message.id,
    body.beerId,
    body.beerName || null,
    body.brewer || null,
    now,
    message.attempts,
    'beer-enrichment', // Original source queue, not the DLQ
    JSON.stringify(body)
  ).run();
}

/**
 * Handle main enrichment queue messages - process with Perplexity API
 */
async function handleEnrichmentBatch(
  batch: MessageBatch<EnrichmentMessage>,
  env: Env
): Promise<void> {
  console.log(`Processing batch of ${batch.messages.length} beers for enrichment`);

  // Layer 3: Kill switch
  if (env.ENRICHMENT_ENABLED === 'false') {
    console.log('Enrichment disabled via kill switch');
    for (const message of batch.messages) {
      message.ack();
    }
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.slice(0, 7) + '-01';
  const monthEnd = today.slice(0, 7) + '-31';
  const dailyLimit = parseInt(env.DAILY_ENRICHMENT_LIMIT || '500');
  const monthlyLimit = parseInt(env.MONTHLY_ENRICHMENT_LIMIT || '2000');

  // Layer 2: Monthly limit check (fail-safe on D1 error)
  let monthlyCount: { total: number } | null = null;
  try {
    monthlyCount = await env.DB.prepare(
      `SELECT SUM(request_count) as total FROM enrichment_limits
       WHERE date >= ? AND date <= ?`
    ).bind(monthStart, monthEnd).first<{ total: number }>();
  } catch (dbError) {
    console.error('D1 unavailable for monthly limit check:', dbError);
    // Fail-safe: retry later when D1 is available
    for (const message of batch.messages) {
      message.retry();
    }
    return;
  }

  if (monthlyCount && monthlyCount.total >= monthlyLimit) {
    console.log(`Monthly limit reached (${monthlyLimit})`);
    for (const message of batch.messages) {
      message.ack();
    }
    return;
  }

  // Delay between API calls to avoid rate limits (Perplexity allows ~50-100 RPM)
  const API_DELAY_MS = 2000; // 2 seconds between calls = 30 requests/minute max

  // Process messages one at a time with atomic reservation
  for (let i = 0; i < batch.messages.length; i++) {
    const message = batch.messages[i];
    const { beerId, beerName, brewer } = message.body;
    const enrichmentStartTime = Date.now();

    // Add delay between API calls (skip delay for first message)
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
    }

    try {
      // Layer 1: Atomic reservation - reserve slot BEFORE API call
      const reservation = await env.DB.prepare(`
        INSERT INTO enrichment_limits (date, request_count, last_updated)
        VALUES (?, 1, ?)
        ON CONFLICT(date) DO UPDATE SET
          request_count = CASE
            WHEN request_count < ? THEN request_count + 1
            ELSE request_count
          END,
          last_updated = ?
        RETURNING request_count, (request_count <= ?) as reserved
      `).bind(today, Date.now(), dailyLimit, Date.now(), dailyLimit)
        .first<{ request_count: number; reserved: number }>();

      if (!reservation || !reservation.reserved) {
        console.log(`Daily limit reached, skipping ${beerId}`);
        message.ack();
        continue;
      }

      // Slot reserved - now make the API call
      // Counter is already incremented, so cost is tracked even if API call fails
      const abv = await fetchAbvFromPerplexity(env, beerName, brewer);

      // Track enrichment success/failure
      trackEnrichment(env.ANALYTICS, {
        beerId,
        source: 'perplexity',
        success: abv !== null,
        durationMs: Date.now() - enrichmentStartTime,
      });

      if (abv !== null) {
        await env.DB.prepare(`
          UPDATE enriched_beers
          SET abv = ?, confidence = 0.7, enrichment_source = 'perplexity', updated_at = ?
          WHERE id = ?
        `).bind(abv, Date.now(), beerId).run();

        console.log(`Enriched ${beerId}: ${beerName} -> ABV ${abv}%`);
      } else {
        console.log(`No ABV found for ${beerId}: ${beerName}`);
      }

      message.ack();
    } catch (error) {
      console.error(`Failed to enrich ${beerId}:`, error);

      // Track failed enrichment attempt
      trackEnrichment(env.ANALYTICS, {
        beerId,
        source: 'perplexity',
        success: false,
        durationMs: Date.now() - enrichmentStartTime,
      });

      // Note: Counter was already incremented via reservation
      // This is intentional - we want to track failed API calls too

      // Check if this is a rate limit error (429) - use longer delay
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('429')) {
        // Rate limited - retry after 2 minutes to let the rate limit window reset
        console.log(`Rate limited for ${beerId}, retrying in 120 seconds`);
        message.retry({ delaySeconds: 120 });
      } else {
        // Other errors - use default retry delay (60 seconds from wrangler.jsonc)
        message.retry();
      }
    }
  }
}

// Fetch ABV from Perplexity API
async function fetchAbvFromPerplexity(
  env: Env,
  beerName: string,
  brewer: string | null
): Promise<number | null> {
  if (!env.PERPLEXITY_API_KEY) {
    console.warn('PERPLEXITY_API_KEY not configured');
    return null;
  }

  const prompt = brewer
    ? `What is the ABV (alcohol by volume) percentage of "${beerName}" by ${brewer}? Reply with ONLY the numeric ABV value (e.g., "5.5" or "8.0"). If you cannot find reliable information, reply with "unknown".`
    : `What is the ABV (alcohol by volume) percentage of "${beerName}"? Reply with ONLY the numeric ABV value (e.g., "5.5" or "8.0"). If you cannot find reliable information, reply with "unknown".`;

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'You are a beer expert assistant. Provide only the requested information, nothing more. Be concise.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 50,
        temperature: 0.1,
        // Explicitly enable web search - "low" is most cost-effective for simple ABV lookups
        // Pricing: $5 per 1K requests (low), $8 (medium), $12 (high)
        web_search_options: {
          search_context_size: 'low',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Perplexity API error (${response.status}):`, errorText);
      throw new Error(`Perplexity API returned ${response.status}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content || content.toLowerCase() === 'unknown') {
      return null;
    }

    // Parse the ABV value
    const abvMatch = content.match(/(\d+\.?\d*)/);
    if (abvMatch) {
      const abv = parseFloat(abvMatch[1]);
      // Sanity check: ABV should be between 0 and 70
      if (abv >= 0 && abv <= 70) {
        return abv;
      }
    }

    console.warn(`Could not parse ABV from Perplexity response: "${content}"`);
    return null;
  } catch (error) {
    console.error('Perplexity API request failed:', error);
    throw error; // Re-throw to trigger retry
  }
}

// Health endpoint with circuit breaker status
async function handleHealth(env: Env): Promise<Response> {
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
