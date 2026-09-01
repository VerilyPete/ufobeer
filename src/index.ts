/**
 * Beer Enrichment API - Cloudflare Worker Entry Point
 *
 * A minimal routing dispatcher that delegates to extracted handler modules.
 * Provides endpoints for:
 * - GET /beers - Fetch beers from Flying Saucer with enrichment data
 * - POST /beers/batch - Batch lookup enrichment data
 * - GET /health - Health check with quota status
 * - POST /admin/enrich/trigger - Manual enrichment trigger
 * - POST /admin/cleanup/trigger - Manual cleanup trigger
 * - GET /admin/dlq - List DLQ messages
 * - GET /admin/dlq/stats - DLQ statistics
 * - POST /admin/dlq/replay - Replay DLQ messages
 * - POST /admin/dlq/acknowledge - Acknowledge DLQ messages
 *
 * Cron: Scheduled enrichment processing
 * Queue: Enrichment consumer and DLQ storage
 */

import {
  trackRequest,
  trackRateLimit,
  trackAdminDlq,
  trackAdminTrigger,
  trackCleanupTrigger,
} from './analytics';
import {
  hashApiKey,
  validateApiKey,
  authorizeAdmin,
  createRequestContext,
} from './auth';
import type { Env, EnrichmentMessage, CleanupMessage } from './types';
import { ENABLED_STORE_IDS } from './config';
import { getCorsHeaders, withResponseHeaders } from './context';
import { checkRateLimit, getEndpointRateLimitKey, getPreAuthRateLimitKey } from './rate-limit';
import { writeAuditLog, writeAdminAuditLog, type AdminAuditOutcome } from './audit';
import {
  handleEnrichmentTrigger,
  handleDlqList,
  handleDlqStats,
  handleDlqReplay,
  handleDlqAcknowledge,
  handleBeerList,
  handleBatchLookup,
  handleBeerSync,
  handleHealthCheck,
  handleScheduledEnrichment,
  handleCleanupTrigger,
} from './handlers';
import { handleLiveness } from './handlers/health';
import { SYNC_CONSTANTS } from './types';
import { handleEnrichmentBatch, handleCleanupBatch, handleDlqBatch, handleCleanupDlqBatch } from './queue';
import { CORS_PREFLIGHT_ROUTES, CORS_ALLOWED_REQUEST_HEADERS } from './constants';

// CORS_PREFLIGHT_ROUTES and CORS_ALLOWED_REQUEST_HEADERS now live in
// src/constants.ts (imported above) as part of the constants consolidation.

function isPreflightHeadersAllowed(requestedHeaders: string | null): boolean {
  if (!requestedHeaders) return true;
  return requestedHeaders
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(h => h.length > 0)
    .every(h => CORS_ALLOWED_REQUEST_HEADERS.has(h));
}

// ============================================================================
// Admin Audit Outcome Classification
// ============================================================================

/**
 * Classify a privileged admin operation's outcome from its HTTP status and
 * succeeded/failed target counts, for writeAdminAuditLog(). A non-200 status
 * is always 'failed' regardless of counts; a 200 with both successes and
 * failures present is 'partial'; a 200 with only failures is 'failed'.
 */
function classifyAdminOutcome(status: number, succeeded: number, failed: number): AdminAuditOutcome {
  if (status !== 200) return 'failed';
  if (failed > 0 && succeeded > 0) return 'partial';
  if (failed > 0 && succeeded === 0) return 'failed';
  return 'success';
}

/** Extract `error` (string, or `{message}` object) from a parsed response body, if present. */
function extractErrorMessage(body: Record<string, unknown>): string | undefined {
  const err = body['error'];
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as Record<string, unknown>)['message'];
    if (typeof message === 'string') return message;
  }
  return undefined;
}

// ============================================================================
// Admin Response Analytics Helper
// ============================================================================

/**
 * Parse a cloned response body for analytics extraction.
 * Centralizes the repeated clone-parse pattern used in admin routes.
 * Safe: we produced these responses; the cast narrows from unknown to Record.
 */
async function parseResponseAnalytics(
  response: Response
): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.clone().json();
    if (typeof body === 'object' && body !== null) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

// ============================================================================
// Main Export
// ============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(env, request.headers.get('Origin'));
    const requestContext = createRequestContext(request);

    // Track metrics for analytics
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
      ctx.waitUntil(writeAuditLog(env.DB, requestContext, request.method, url.pathname, status, error));

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

      const responseHeaders = withResponseHeaders(headers, 'no-store');
      if (body === null) return new Response(null, { status, headers: responseHeaders });
      if (typeof body === 'object') return Response.json(body, { status, headers: responseHeaders });
      return new Response(body, { status, headers: responseHeaders });
    };

    // Handle CORS preflight
    //
    // OPTIONS stays outside try/catch: it is validated and answered entirely
    // from request headers/URL, so it has no reason to depend on auth,
    // handler logic, or D1 reads. It deliberately does NOT call respond()
    // (and therefore does not schedule writeAuditLog()): persisting a D1
    // audit row for every routine preflight is an unauthenticated,
    // unthrottled write-amplification path — high-volume or invalid OPTIONS
    // traffic must not be able to create audit rows. trackRequest() (an
    // Analytics Engine write, not D1) still gives cheap visibility.
    if (request.method === 'OPTIONS') {
      const requestedMethod = request.headers.get('Access-Control-Request-Method');
      const requestedHeaders = request.headers.get('Access-Control-Request-Headers');

      const isValidPreflight =
        corsHeaders !== null && // Origin present and matches env.ALLOWED_ORIGIN
        requestedMethod !== null &&
        CORS_PREFLIGHT_ROUTES[url.pathname] === requestedMethod &&
        isPreflightHeadersAllowed(requestedHeaders);

      const status = isValidPreflight ? 204 : 403;
      trackRequest(env.ANALYTICS, {
        endpoint: url.pathname,
        method: 'OPTIONS',
        statusCode: status,
        clientId: requestContext.clientIdentifier,
        responseTimeMs: Date.now() - requestContext.startTime,
      });

      const preflightHeaders = withResponseHeaders(isValidPreflight ? (corsHeaders ?? {}) : {}, 'no-store');
      return new Response(null, { status, headers: preflightHeaders });
    }

    try {

    // Pre-auth rate limit: every non-OPTIONS request — including /health and
    // would-be-401 brute force — is throttled per client IP before it can
    // reach auth, audit logging, or handler D1 queries. Without this, the
    // post-auth limiter below never sees rejected traffic.
    const preAuthLimit = parseInt(env.PRE_AUTH_RPM ?? '', 10) || 30;
    const preAuthResult = await checkRateLimit(
      env.DB,
      getPreAuthRateLimitKey(requestContext.clientIdentifier),
      preAuthLimit
    );
    if (!preAuthResult.allowed) {
      if (preAuthResult.degraded) {
        return respond(
          { error: 'Service temporarily unavailable', requestId: requestContext.requestId },
          503,
          { ...(corsHeaders ?? {}), 'Retry-After': '10' },
          'Rate limiter unavailable'
        );
      }
      trackRateLimit(env.ANALYTICS, requestContext.clientIdentifier, url.pathname);
      return respond(
        { error: 'Rate limit exceeded', requestId: requestContext.requestId },
        429,
        {
          ...(corsHeaders ?? {}),
          'X-RateLimit-Limit': String(preAuthLimit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor(preAuthResult.resetAt / 1000)),
          'Retry-After': String(Math.ceil((preAuthResult.resetAt - Date.now()) / 1000)),
        },
        'Pre-auth rate limited'
      );
    }

    // Liveness check (no auth, no D1) — cheap probe distinct from /health;
    // see handleLiveness() for why it takes no Env at all.
    if (url.pathname === '/livez') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, {
          status: 405,
          headers: withResponseHeaders({ Allow: 'GET, HEAD' }, 'no-store'),
        });
      }
      return handleLiveness();
    }

    // Health check (no auth required)
    if (url.pathname === '/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, {
          status: 405,
          headers: withResponseHeaders({ Allow: 'GET, HEAD' }, 'no-store'),
        });
      }
      return handleHealthCheck(env);
    }

    // Restrict fresh=true (GET /beers cache bypass) to admin-authenticated
    // callers. A normal — or absent — mobile credential must not be able to
    // force a Flying Saucer refetch plus D1 write on every request; verified
    // zero client impact (the mobile app never sends `fresh`). Checked before
    // the general API-key gate below so a caller with no key at all and a
    // caller with a plain app key both get the same 403 here, rather than
    // the no-key case surfacing as a 401 that leaks nothing about `fresh`.
    // The cron/scheduled path is unaffected — it calls refreshTaplistForStore()
    // directly and never goes through this HTTP route.
    if (url.pathname === '/beers' && url.searchParams.get('fresh') === 'true') {
      const freshAuth = await authorizeAdmin(request, env, requestContext);
      if (!freshAuth.authorized) {
        return respond(
          { error: 'fresh=true requires admin credentials', requestId: requestContext.requestId },
          403,
          corsHeaders ?? {},
          'fresh bypass denied'
        );
      }
    }

    // Require CORS config for all other routes
    if (!env.ALLOWED_ORIGIN) {
      return respond({ error: 'Server misconfigured: ALLOWED_ORIGIN not set' }, 500, {});
    }

    // Authenticate
    const authResult = await validateApiKey(request, env, requestContext);
    if (!authResult.valid) {
      return respond({ error: 'Unauthorized' }, 401, corsHeaders ?? {}, 'Invalid API key');
    }
    // Create new context with the authenticated API key hash (RequestContext is readonly).
    // Override clientIdentifier with apiKeyHash for stable per-key rate limiting —
    // apiKeyHash is not spoofable (unlike IP-based identifiers in dev/test environments).
    const authedContext = {
      ...requestContext,
      apiKeyHash: authResult.apiKeyHash,
      clientIdentifier: authResult.apiKeyHash ?? requestContext.clientIdentifier,
    };

    // Rate limit
    const rateLimit = parseInt(env.RATE_LIMIT_RPM, 10) || 60;
    const rateLimitResult = await checkRateLimit(env.DB, authedContext.clientIdentifier, rateLimit);

    if (!rateLimitResult.allowed) {
      trackRateLimit(env.ANALYTICS, authedContext.clientIdentifier, url.pathname);
      if (rateLimitResult.degraded) {
        // Limiter could not run (D1 error) — fail closed as transient, not 429.
        return respond(
          { error: 'Service temporarily unavailable', requestId: authedContext.requestId },
          503,
          { ...(corsHeaders ?? {}), 'Retry-After': '10' },
          'Rate limiter unavailable'
        );
      }
      return respond(
        { error: 'Rate limit exceeded', requestId: authedContext.requestId },
        429,
        {
          ...(corsHeaders ?? {}),
          'X-RateLimit-Limit': String(rateLimit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor(rateLimitResult.resetAt / 1000)),
          'Retry-After': String(Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)),
        },
        'Rate limited'
      );
    }

    // Common headers for authenticated responses
    const rateLimitHeaders = {
      'X-RateLimit-Limit': String(rateLimit),
      'X-RateLimit-Remaining': String(rateLimitResult.remaining),
      'X-RateLimit-Reset': String(Math.floor(rateLimitResult.resetAt / 1000)),
      'X-Request-ID': authedContext.requestId,
    };

    // Route: GET /beers
    if (url.pathname === '/beers' && request.method === 'GET') {
      const storeId = url.searchParams.get('sid');

      if (!storeId) {
        return respond(
          { error: 'Missing required parameter: sid', requestId: authedContext.requestId },
          400,
          { ...(corsHeaders ?? {}), ...rateLimitHeaders }
        );
      }

      if (!ENABLED_STORE_IDS.has(storeId)) {
        return respond(
          { error: 'Invalid store ID', requestId: authedContext.requestId },
          400,
          { ...(corsHeaders ?? {}), ...rateLimitHeaders }
        );
      }

      storeIdForAnalytics = storeId;
      const freshRequested = url.searchParams.get('fresh') === 'true';
      const result = await handleBeerList(request, env, ctx, { ...(corsHeaders ?? {}), ...rateLimitHeaders }, authedContext, storeId, freshRequested);
      beersReturnedCount = result.beersReturned;
      upstreamLatency = result.upstreamLatencyMs;

      trackRequest(env.ANALYTICS, {
        endpoint: url.pathname,
        method: request.method,
        storeId: storeIdForAnalytics,
        statusCode: result.response.status,
        clientId: authedContext.clientIdentifier,
        responseTimeMs: Date.now() - authedContext.startTime,
        beersReturned: beersReturnedCount,
        upstreamLatencyMs: upstreamLatency,
        cacheOutcome: result.cacheOutcome,
      });
      ctx.waitUntil(writeAuditLog(env.DB, authedContext, request.method, url.pathname, result.response.status));

      return result.response;
    }

    // Route: POST /beers/batch
    if (url.pathname === '/beers/batch' && request.method === 'POST') {
      const result = await handleBatchLookup(request, env, { ...(corsHeaders ?? {}), ...rateLimitHeaders }, authedContext);
      trackRequest(env.ANALYTICS, {
        endpoint: url.pathname,
        method: request.method,
        statusCode: result.status,
        clientId: authedContext.clientIdentifier,
        responseTimeMs: Date.now() - authedContext.startTime,
      });
      ctx.waitUntil(writeAuditLog(env.DB, authedContext, request.method, url.pathname, result.status));
      return result;
    }

    // Route: POST /beers/sync (with stricter per-endpoint rate limiting)
    if (url.pathname === '/beers/sync' && request.method === 'POST') {
      // Sync endpoint has stricter rate limit (10 RPM) independent of other endpoints
      const syncRateLimitKey = getEndpointRateLimitKey(authedContext.clientIdentifier, 'sync');
      const syncRateLimitResult = await checkRateLimit(env.DB, syncRateLimitKey, SYNC_CONSTANTS.RATE_LIMIT_RPM);

      if (!syncRateLimitResult.allowed) {
        trackRateLimit(env.ANALYTICS, authedContext.clientIdentifier, url.pathname);
        if (syncRateLimitResult.degraded) {
          return respond(
            { error: 'Service temporarily unavailable', requestId: authedContext.requestId },
            503,
            { ...(corsHeaders ?? {}), 'Retry-After': '10' },
            'Rate limiter unavailable (sync)'
          );
        }
        return respond(
          {
            error: 'Rate limit exceeded for sync endpoint',
            requestId: authedContext.requestId,
            retry_after_seconds: Math.ceil((syncRateLimitResult.resetAt - Date.now()) / 1000)
          },
          429,
          {
            ...(corsHeaders ?? {}),
            'X-RateLimit-Limit': String(SYNC_CONSTANTS.RATE_LIMIT_RPM),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.floor(syncRateLimitResult.resetAt / 1000)),
            'Retry-After': String(Math.ceil((syncRateLimitResult.resetAt - Date.now()) / 1000)),
          },
          'Rate limited (sync)'
        );
      }

      const result = await handleBeerSync(request, env, {
        ...(corsHeaders ?? {}),
        ...rateLimitHeaders,
        // Override rate limit headers with sync-specific values
        'X-RateLimit-Limit': String(SYNC_CONSTANTS.RATE_LIMIT_RPM),
        'X-RateLimit-Remaining': String(syncRateLimitResult.remaining),
        'X-RateLimit-Reset': String(Math.floor(syncRateLimitResult.resetAt / 1000)),
      }, authedContext);
      trackRequest(env.ANALYTICS, {
        endpoint: url.pathname,
        method: request.method,
        statusCode: result.status,
        clientId: authedContext.clientIdentifier,
        responseTimeMs: Date.now() - authedContext.startTime,
      });
      ctx.waitUntil(writeAuditLog(env.DB, authedContext, request.method, url.pathname, result.status));
      return result;
    }

    // ========================================================================
    // Admin Routes - Require additional ADMIN_SECRET authentication
    // ========================================================================
    if (url.pathname.startsWith('/admin/')) {
      // Computed before the authorized check so a DENIED attempt can also be
      // recorded in the admin audit log (previously only the generic
      // writeAuditLog() saw admin auth failures — the specialized admin
      // audit trail silently had no row for them at all).
      const adminSecretHash = await hashApiKey(request.headers.get('X-Admin-Secret') || '');

      const adminAuth = await authorizeAdmin(request, env, authedContext);
      if (!adminAuth.authorized) {
        ctx.waitUntil(writeAdminAuditLog(
          env.DB, authedContext, `${url.pathname}_denied`, {},
          adminSecretHash,
          { statusCode: 403, outcome: 'denied', failureReason: adminAuth.error }
        ));
        return respond(
          { error: adminAuth.error || 'Unauthorized', requestId: authedContext.requestId },
          403,
          { ...(corsHeaders ?? {}), ...rateLimitHeaders },
          'Admin auth failed'
        );
      }

      // Route: GET /admin/dlq
      if (url.pathname === '/admin/dlq' && request.method === 'GET') {
        const operationStart = Date.now();
        const result = await handleDlqList(env, { ...(corsHeaders ?? {}), ...rateLimitHeaders }, authedContext, url.searchParams);
        let messageCount = 0;
        let body: Record<string, unknown> = {};
        try {
          body = await parseResponseAnalytics(result);
          const data = body['data'] as Record<string, unknown> | undefined;
          const messages = data?.['messages'] as unknown[] | undefined;
          messageCount = messages?.length || 0;
        } catch { /* ignore */ }
        trackAdminDlq(env.ANALYTICS, { operation: 'dlq_list', success: result.status === 200, messageCount, durationMs: Date.now() - operationStart });
        ctx.waitUntil(writeAdminAuditLog(
          env.DB, authedContext, 'dlq_list', { message_count: messageCount }, adminSecretHash,
          {
            statusCode: result.status,
            outcome: result.status === 200 ? 'success' : 'failed',
            succeededCount: result.status === 200 ? 1 : 0,
            failedCount: result.status === 200 ? 0 : 1,
            failureReason: result.status === 200 ? undefined : extractErrorMessage(body),
          }
        ));
        return result;
      }

      // Route: GET /admin/dlq/stats
      if (url.pathname === '/admin/dlq/stats' && request.method === 'GET') {
        const operationStart = Date.now();
        const result = await handleDlqStats(env, { ...(corsHeaders ?? {}), ...rateLimitHeaders }, authedContext);
        const body = result.status === 200 ? {} : await parseResponseAnalytics(result);
        trackAdminDlq(env.ANALYTICS, { operation: 'dlq_stats', success: result.status === 200, messageCount: 0, durationMs: Date.now() - operationStart });
        ctx.waitUntil(writeAdminAuditLog(
          env.DB, authedContext, 'dlq_stats', {}, adminSecretHash,
          {
            statusCode: result.status,
            outcome: result.status === 200 ? 'success' : 'failed',
            failureReason: result.status === 200 ? undefined : extractErrorMessage(body),
          }
        ));
        return result;
      }

      // Route: POST /admin/dlq/replay
      if (url.pathname === '/admin/dlq/replay' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleDlqReplay(request, env, { ...(corsHeaders ?? {}), ...rateLimitHeaders }, authedContext);
        let replayedCount = 0;
        let requestedCount: number | undefined;
        let failedCount: number | undefined;
        let body: Record<string, unknown> = {};
        try {
          body = await parseResponseAnalytics(result);
          const data = body['data'] as Record<string, unknown> | undefined;
          replayedCount = (data?.['replayed_count'] as number | undefined) || 0;
          requestedCount = data?.['requested_count'] as number | undefined;
          failedCount = data?.['failed_count'] as number | undefined;
        } catch { /* ignore */ }
        trackAdminDlq(env.ANALYTICS, { operation: 'dlq_replay', success: result.status === 200, messageCount: replayedCount, durationMs: Date.now() - operationStart });
        ctx.waitUntil(writeAdminAuditLog(
          env.DB, authedContext, 'dlq_replay', { replayed_count: replayedCount }, adminSecretHash,
          {
            statusCode: result.status,
            outcome: classifyAdminOutcome(result.status, replayedCount, failedCount ?? 0),
            requestedCount,
            succeededCount: replayedCount,
            failedCount,
            failureReason: result.status === 200 ? undefined : extractErrorMessage(body),
          }
        ));
        return result;
      }

      // Route: POST /admin/dlq/acknowledge
      if (url.pathname === '/admin/dlq/acknowledge' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleDlqAcknowledge(request, env, { ...(corsHeaders ?? {}), ...rateLimitHeaders }, authedContext);
        let acknowledgedCount = 0;
        let requestedCount: number | undefined;
        let failedCount: number | undefined;
        let body: Record<string, unknown> = {};
        try {
          body = await parseResponseAnalytics(result);
          const data = body['data'] as Record<string, unknown> | undefined;
          acknowledgedCount = (data?.['acknowledged_count'] as number | undefined) || 0;
          requestedCount = data?.['requested_count'] as number | undefined;
          failedCount = data?.['failed_count'] as number | undefined;
        } catch { /* ignore */ }
        trackAdminDlq(env.ANALYTICS, { operation: 'dlq_acknowledge', success: result.status === 200, messageCount: acknowledgedCount, durationMs: Date.now() - operationStart });
        // handleDlqAcknowledge's response now carries requested_count/
        // failed_count (Cloudflare security review, dlq_acknowledge audit
        // fidelity), so classifyAdminOutcome can distinguish a partial
        // acknowledge from a full success the same way dlq_replay already does.
        ctx.waitUntil(writeAdminAuditLog(
          env.DB, authedContext, 'dlq_acknowledge', { acknowledged_count: acknowledgedCount }, adminSecretHash,
          {
            statusCode: result.status,
            outcome: classifyAdminOutcome(result.status, acknowledgedCount, failedCount ?? 0),
            requestedCount,
            succeededCount: acknowledgedCount,
            failedCount,
            failureReason: result.status === 200 ? undefined : extractErrorMessage(body),
          }
        ));
        return result;
      }

      // Route: POST /admin/enrich/trigger
      if (url.pathname === '/admin/enrich/trigger' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleEnrichmentTrigger(request, env, { ...(corsHeaders ?? {}), ...rateLimitHeaders }, authedContext);
        let beersQueued = 0;
        let skipReason: 'kill_switch' | 'daily_limit' | 'monthly_limit' | 'no_eligible_beers' | undefined;
        let dailyRemaining = 0;
        let monthlyRemaining = 0;
        let body: Record<string, unknown> = {};
        try {
          body = await parseResponseAnalytics(result);
          const data = body['data'] as Record<string, unknown> | undefined;
          beersQueued = (data?.['beers_queued'] as number | undefined) || 0;
          skipReason = data?.['skip_reason'] as typeof skipReason;
          const quota = data?.['quota'] as Record<string, unknown> | undefined;
          const daily = quota?.['daily'] as Record<string, unknown> | undefined;
          const monthly = quota?.['monthly'] as Record<string, unknown> | undefined;
          dailyRemaining = (daily?.['remaining'] as number | undefined) || 0;
          monthlyRemaining = (monthly?.['remaining'] as number | undefined) || 0;
        } catch { /* ignore */ }
        trackAdminTrigger(env.ANALYTICS, { beersQueued, dailyRemaining, monthlyRemaining, durationMs: Date.now() - operationStart, success: result.status === 200, skipReason });
        ctx.waitUntil(writeAdminAuditLog(
          env.DB, authedContext, 'enrich_trigger',
          { beers_queued: beersQueued, skip_reason: skipReason, duration_ms: Date.now() - operationStart },
          adminSecretHash,
          {
            statusCode: result.status,
            outcome: result.status === 200 ? 'success' : 'failed',
            succeededCount: beersQueued,
            failureReason: result.status === 200 ? undefined : extractErrorMessage(body),
          }
        ));
        console.log(`[admin] enrich_trigger completed: beersQueued=${beersQueued}, skipReason=${skipReason || 'none'}, durationMs=${Date.now() - operationStart}, requestId=${authedContext.requestId}`);
        return result;
      }

      // Route: POST /admin/cleanup/trigger
      if (url.pathname === '/admin/cleanup/trigger' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleCleanupTrigger(request, env, { ...(corsHeaders ?? {}), ...rateLimitHeaders }, authedContext);

        // Extract response data for logging and analytics
        let beersQueued = 0;
        let beersReset = 0;
        let mode = 'unknown';
        let dryRun = false;
        let body: Record<string, unknown> = {};
        try {
          body = await parseResponseAnalytics(result);
          const data = body['data'] as Record<string, unknown> | undefined;
          beersQueued = (data?.['beers_queued'] as number | undefined) ?? 0;
          beersReset = (data?.['beers_reset'] as number | undefined) ?? 0;
          mode = (data?.['mode'] as string | undefined) ?? 'unknown';
          dryRun = (data?.['dry_run'] as boolean | undefined) ?? false;
        } catch { /* ignore parse errors */ }

        // Analytics tracking
        if (env.ANALYTICS) {
          ctx.waitUntil(
            Promise.resolve(trackCleanupTrigger(env.ANALYTICS, {
              action: 'cleanup_trigger',
              mode,
              beersQueued,
              beersReset,
              durationMs: Date.now() - operationStart,
              dryRun,
            }))
          );
        }

        // Audit log. A dry run is classified 'attempted' — nothing was
        // actually changed — rather than 'success', regardless of status.
        ctx.waitUntil(
          writeAdminAuditLog(
            env.DB, authedContext, 'cleanup_trigger',
            { beers_queued: beersQueued, mode, duration_ms: Date.now() - operationStart },
            adminSecretHash,
            {
              statusCode: result.status,
              outcome: dryRun ? 'attempted' : (result.status === 200 ? 'success' : 'failed'),
              succeededCount: beersQueued,
              failureReason: result.status === 200 ? undefined : extractErrorMessage(body),
            }
          )
        );

        console.log(`[admin] cleanup_trigger completed: beersQueued=${beersQueued}, mode=${mode}, durationMs=${Date.now() - operationStart}, requestId=${authedContext.requestId}`);

        return result;
      }

      // Admin route not found
      return respond(
        { error: 'Admin endpoint not found', requestId: authedContext.requestId },
        404,
        { ...(corsHeaders ?? {}), ...rateLimitHeaders }
      );
    }

    return respond(
      { error: 'Not Found', requestId: authedContext.requestId },
      404,
      { ...(corsHeaders ?? {}), ...rateLimitHeaders }
    );

    } catch (error) {
      // Log the full error server-side (visible in Cloudflare observability logs)
      console.error('Unhandled fetch error:', error);
      // Return a generic message — do NOT expose error.message to clients.
      // Raw error text can contain D1 internals, table names, or SQL fragments.
      //
      // Compute CORS headers directly from env rather than using the `corsHeaders`
      // variable: the error may have occurred before getCorsHeaders() ran, or
      // getCorsHeaders() itself may have thrown.
      const origin = request.headers.get('Origin');
      const allowed = env.ALLOWED_ORIGIN;
      const errorHeaders: Record<string, string> = origin === allowed && allowed
        ? { 'Access-Control-Allow-Origin': allowed }
        : {};
      return Response.json(
        { error: 'Internal Server Error', requestId: requestContext.requestId },
        { status: 500, headers: withResponseHeaders(errorHeaders, 'no-store') }
      );
    }
  },

  // Cron job: Delegate to scheduled handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron triggered:', event.cron);
    await handleScheduledEnrichment(env, ctx);
  },

  // Queue consumer: Route to appropriate handler based on queue name
  //
  // Cast safety: wrangler.jsonc binds each queue name to a specific message type.
  // The Cloudflare Workers runtime guarantees that batch.queue matches the producer's
  // type, so these casts from the union type to the specific message type are safe.
  async queue(
    batch: MessageBatch<EnrichmentMessage | CleanupMessage>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    console.log(`Queue batch received: messageCount=${batch.messages.length}, queue=${batch.queue}, requestId=${requestId}`);

    if (batch.queue === 'beer-enrichment-dlq') {
      // Safe: wrangler.jsonc binds this queue to EnrichmentMessage producers
      await handleDlqBatch(batch as MessageBatch<EnrichmentMessage>, env, requestId);
    } else if (batch.queue === 'beer-enrichment') {
      // Safe: wrangler.jsonc binds this queue to EnrichmentMessage producers
      await handleEnrichmentBatch(batch as MessageBatch<EnrichmentMessage>, env);
    } else if (batch.queue === 'description-cleanup') {
      // Safe: wrangler.jsonc binds this queue to CleanupMessage producers
      await handleCleanupBatch(batch as MessageBatch<CleanupMessage>, env);
    } else if (batch.queue === 'description-cleanup-dlq') {
      // Safe: wrangler.jsonc binds this queue to CleanupMessage producers
      await handleCleanupDlqBatch(batch as MessageBatch<CleanupMessage>, env, requestId);
    } else {
      console.warn(`Unknown queue: ${batch.queue}, acknowledging messages to prevent infinite loops`);
      for (const message of batch.messages) {
        message.ack();
      }
    }
  },
};
