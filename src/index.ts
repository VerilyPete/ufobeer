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
import { VALID_STORE_IDS } from './config';
import { getCorsHeaders } from './context';
import { checkRateLimit, getEndpointRateLimitKey } from './rate-limit';
import { writeAuditLog, writeAdminAuditLog } from './audit';
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
import { SYNC_CONSTANTS } from './types';
import { handleEnrichmentBatch, handleCleanupBatch, handleDlqBatch, handleCleanupDlqBatch } from './queue';

// ============================================================================
// Main Export
// ============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(env);
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
      return handleHealthCheck(env);
    }

    // Require CORS config for all other routes
    if (!corsHeaders) {
      return respond({ error: 'Server misconfigured: ALLOWED_ORIGIN not set' }, 500, {});
    }

    // Authenticate
    const authResult = await validateApiKey(request, env, requestContext);
    if (!authResult.valid) {
      return respond({ error: 'Unauthorized' }, 401, corsHeaders, 'Invalid API key');
    }
    // Create new context with the authenticated API key hash (RequestContext is readonly)
    const authedContext = { ...requestContext, apiKeyHash: authResult.apiKeyHash };

    // Rate limit
    const rateLimit = parseInt(env.RATE_LIMIT_RPM, 10) || 60;
    const rateLimitResult = await checkRateLimit(env.DB, authedContext.clientIdentifier, rateLimit);

    if (!rateLimitResult.allowed) {
      trackRateLimit(env.ANALYTICS, authedContext.clientIdentifier, url.pathname);
      return respond(
        { error: 'Rate limit exceeded', requestId: authedContext.requestId },
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
          { ...corsHeaders, ...rateLimitHeaders }
        );
      }

      if (!VALID_STORE_IDS.has(storeId)) {
        return respond(
          { error: 'Invalid store ID', requestId: authedContext.requestId },
          400,
          { ...corsHeaders, ...rateLimitHeaders }
        );
      }

      storeIdForAnalytics = storeId;
      const result = await handleBeerList(env, ctx, { ...corsHeaders, ...rateLimitHeaders }, authedContext, storeId);
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
      });
      ctx.waitUntil(writeAuditLog(env.DB, authedContext, request.method, url.pathname, result.response.status));

      return result.response;
    }

    // Route: POST /beers/batch
    if (url.pathname === '/beers/batch' && request.method === 'POST') {
      const result = await handleBatchLookup(request, env, { ...corsHeaders, ...rateLimitHeaders }, authedContext);
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
        return respond(
          {
            error: 'Rate limit exceeded for sync endpoint',
            requestId: authedContext.requestId,
            retry_after_seconds: Math.ceil((syncRateLimitResult.resetAt - Date.now()) / 1000)
          },
          429,
          {
            ...corsHeaders,
            'X-RateLimit-Limit': String(SYNC_CONSTANTS.RATE_LIMIT_RPM),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.floor(syncRateLimitResult.resetAt / 1000)),
            'Retry-After': String(Math.ceil((syncRateLimitResult.resetAt - Date.now()) / 1000)),
          },
          'Rate limited (sync)'
        );
      }

      const result = await handleBeerSync(request, env, {
        ...corsHeaders,
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
      const adminAuth = await authorizeAdmin(request, env, authedContext);
      if (!adminAuth.authorized) {
        return respond(
          { error: adminAuth.error || 'Unauthorized', requestId: authedContext.requestId },
          403,
          { ...corsHeaders, ...rateLimitHeaders },
          'Admin auth failed'
        );
      }

      const adminSecretHash = await hashApiKey(request.headers.get('X-Admin-Secret') || '');

      // Route: GET /admin/dlq
      if (url.pathname === '/admin/dlq' && request.method === 'GET') {
        const operationStart = Date.now();
        const result = await handleDlqList(env, { ...corsHeaders, ...rateLimitHeaders }, authedContext, url.searchParams);
        let messageCount = 0;
        try {
          const responseBody = await result.clone().json() as { data?: { messages?: unknown[] } };
          messageCount = responseBody.data?.messages?.length || 0;
        } catch { /* ignore */ }
        trackAdminDlq(env.ANALYTICS, { operation: 'dlq_list', success: result.status === 200, messageCount, durationMs: Date.now() - operationStart });
        ctx.waitUntil(writeAdminAuditLog(env.DB, authedContext, 'dlq_list', { message_count: messageCount }, adminSecretHash));
        return result;
      }

      // Route: GET /admin/dlq/stats
      if (url.pathname === '/admin/dlq/stats' && request.method === 'GET') {
        const operationStart = Date.now();
        const result = await handleDlqStats(env, { ...corsHeaders, ...rateLimitHeaders }, authedContext);
        trackAdminDlq(env.ANALYTICS, { operation: 'dlq_stats', success: result.status === 200, messageCount: 0, durationMs: Date.now() - operationStart });
        ctx.waitUntil(writeAdminAuditLog(env.DB, authedContext, 'dlq_stats', {}, adminSecretHash));
        return result;
      }

      // Route: POST /admin/dlq/replay
      if (url.pathname === '/admin/dlq/replay' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleDlqReplay(request, env, { ...corsHeaders, ...rateLimitHeaders }, authedContext);
        let replayedCount = 0;
        try {
          const responseBody = await result.clone().json() as { data?: { replayed_count?: number } };
          replayedCount = responseBody.data?.replayed_count || 0;
        } catch { /* ignore */ }
        trackAdminDlq(env.ANALYTICS, { operation: 'dlq_replay', success: result.status === 200, messageCount: replayedCount, durationMs: Date.now() - operationStart });
        ctx.waitUntil(writeAdminAuditLog(env.DB, authedContext, 'dlq_replay', { replayed_count: replayedCount }, adminSecretHash));
        return result;
      }

      // Route: POST /admin/dlq/acknowledge
      if (url.pathname === '/admin/dlq/acknowledge' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleDlqAcknowledge(request, env, { ...corsHeaders, ...rateLimitHeaders }, authedContext);
        let acknowledgedCount = 0;
        try {
          const responseBody = await result.clone().json() as { data?: { acknowledged_count?: number } };
          acknowledgedCount = responseBody.data?.acknowledged_count || 0;
        } catch { /* ignore */ }
        trackAdminDlq(env.ANALYTICS, { operation: 'dlq_acknowledge', success: result.status === 200, messageCount: acknowledgedCount, durationMs: Date.now() - operationStart });
        ctx.waitUntil(writeAdminAuditLog(env.DB, authedContext, 'dlq_acknowledge', { acknowledged_count: acknowledgedCount }, adminSecretHash));
        return result;
      }

      // Route: POST /admin/enrich/trigger
      if (url.pathname === '/admin/enrich/trigger' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleEnrichmentTrigger(request, env, { ...corsHeaders, ...rateLimitHeaders }, authedContext);
        let beersQueued = 0;
        let skipReason: 'kill_switch' | 'daily_limit' | 'monthly_limit' | 'no_eligible_beers' | undefined;
        let dailyRemaining = 0;
        let monthlyRemaining = 0;
        try {
          const responseBody = await result.clone().json() as {
            data?: { beers_queued?: number; skip_reason?: typeof skipReason; quota?: { daily?: { remaining?: number }; monthly?: { remaining?: number } } }
          };
          beersQueued = responseBody.data?.beers_queued || 0;
          skipReason = responseBody.data?.skip_reason;
          dailyRemaining = responseBody.data?.quota?.daily?.remaining || 0;
          monthlyRemaining = responseBody.data?.quota?.monthly?.remaining || 0;
        } catch { /* ignore */ }
        trackAdminTrigger(env.ANALYTICS, { beersQueued, dailyRemaining, monthlyRemaining, durationMs: Date.now() - operationStart, success: result.status === 200, skipReason });
        ctx.waitUntil(writeAdminAuditLog(env.DB, authedContext, 'enrich_trigger', { beers_queued: beersQueued, skip_reason: skipReason, duration_ms: Date.now() - operationStart }, adminSecretHash));
        console.log(`[admin] enrich_trigger completed: beersQueued=${beersQueued}, skipReason=${skipReason || 'none'}, durationMs=${Date.now() - operationStart}, requestId=${authedContext.requestId}`);
        return result;
      }

      // Route: POST /admin/cleanup/trigger
      if (url.pathname === '/admin/cleanup/trigger' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleCleanupTrigger(request, env, { ...corsHeaders, ...rateLimitHeaders }, authedContext);

        // Extract response data for logging and analytics
        let beersQueued = 0;
        let beersSkipped = 0;
        let beersReset = 0;
        let mode = 'unknown';
        let dryRun = false;
        try {
          const responseBody = await result.clone().json() as {
            data?: { beers_queued?: number; beers_skipped?: number; beers_reset?: number; mode?: string; operation_id?: string; dry_run?: boolean }
          };
          beersQueued = responseBody.data?.beers_queued ?? 0;
          beersSkipped = responseBody.data?.beers_skipped ?? 0;
          beersReset = responseBody.data?.beers_reset ?? 0;
          mode = responseBody.data?.mode ?? 'unknown';
          dryRun = responseBody.data?.dry_run ?? false;
        } catch { /* ignore parse errors */ }

        // Analytics tracking
        if (env.ANALYTICS) {
          ctx.waitUntil(
            Promise.resolve(trackCleanupTrigger(env.ANALYTICS, {
              action: 'cleanup_trigger',
              mode,
              beersQueued,
              beersSkipped,
              beersReset,
              durationMs: Date.now() - operationStart,
              dryRun,
            }))
          );
        }

        // Audit log
        ctx.waitUntil(
          writeAdminAuditLog(env.DB, authedContext, 'cleanup_trigger', {
            beers_queued: beersQueued,
            mode,
            duration_ms: Date.now() - operationStart,
          }, adminSecretHash)
        );

        console.log(`[admin] cleanup_trigger completed: beersQueued=${beersQueued}, mode=${mode}, durationMs=${Date.now() - operationStart}, requestId=${authedContext.requestId}`);

        return result;
      }

      // Admin route not found
      return respond(
        { error: 'Admin endpoint not found', requestId: authedContext.requestId },
        404,
        { ...corsHeaders, ...rateLimitHeaders }
      );
    }

    return respond(
      { error: 'Not Found', requestId: authedContext.requestId },
      404,
      { ...corsHeaders, ...rateLimitHeaders }
    );
  },

  // Cron job: Delegate to scheduled handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron triggered:', event.cron);
    await handleScheduledEnrichment(env, ctx);
  },

  // Queue consumer: Route to appropriate handler based on queue name
  async queue(
    batch: MessageBatch<EnrichmentMessage | CleanupMessage>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    console.log(`Queue batch received: messageCount=${batch.messages.length}, queue=${batch.queue}, requestId=${requestId}`);

    if (batch.queue === 'beer-enrichment-dlq') {
      await handleDlqBatch(batch as MessageBatch<EnrichmentMessage>, env, requestId);
    } else if (batch.queue === 'beer-enrichment') {
      await handleEnrichmentBatch(batch as MessageBatch<EnrichmentMessage>, env);
    } else if (batch.queue === 'description-cleanup') {
      await handleCleanupBatch(batch as MessageBatch<CleanupMessage>, env);
    } else if (batch.queue === 'description-cleanup-dlq') {
      await handleCleanupDlqBatch(batch as MessageBatch<CleanupMessage>, env, requestId);
    } else {
      console.warn(`Unknown queue: ${batch.queue}, acknowledging messages to prevent infinite loops`);
      for (const message of batch.messages) {
        message.ack();
      }
    }
  },
};
