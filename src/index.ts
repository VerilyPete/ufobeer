/**
 * Beer Enrichment API - Cloudflare Worker Entry Point
 *
 * A minimal routing dispatcher that delegates to extracted handler modules.
 * Provides endpoints for:
 * - GET /beers - Fetch beers from Flying Saucer with enrichment data
 * - POST /beers/batch - Batch lookup enrichment data
 * - GET /health - Health check with quota status
 * - POST /admin/enrich/trigger - Manual enrichment trigger
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
} from './analytics';
import {
  hashApiKey,
  validateApiKey,
  authorizeAdmin,
  createRequestContext,
} from './auth';
import type { Env, EnrichmentMessage } from './types';
import { VALID_STORE_IDS } from './config';
import { getCorsHeaders } from './context';
import { checkRateLimit } from './rate-limit';
import { writeAuditLog, writeAdminAuditLog } from './audit';
import {
  handleEnrichmentTrigger,
  handleDlqList,
  handleDlqStats,
  handleDlqReplay,
  handleDlqAcknowledge,
  handleBeerList,
  handleBatchLookup,
  handleHealthCheck,
  handleScheduledEnrichment,
} from './handlers';
import { handleEnrichmentBatch, handleDlqBatch } from './queue';

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
    if (!(await validateApiKey(request, env, requestContext))) {
      return respond({ error: 'Unauthorized' }, 401, corsHeaders, 'Invalid API key');
    }

    // Rate limit
    const rateLimit = parseInt(env.RATE_LIMIT_RPM, 10) || 60;
    const rateLimitResult = await checkRateLimit(env.DB, requestContext.clientIdentifier, rateLimit);

    if (!rateLimitResult.allowed) {
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

    // Common headers for authenticated responses
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

      storeIdForAnalytics = storeId;
      const result = await handleBeerList(env, ctx, { ...corsHeaders, ...rateLimitHeaders }, requestContext, storeId);
      beersReturnedCount = result.beersReturned;
      upstreamLatency = result.upstreamLatencyMs;

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
      ctx.waitUntil(writeAuditLog(env.DB, requestContext, request.method, url.pathname, result.response.status));

      return result.response;
    }

    // Route: POST /beers/batch
    if (url.pathname === '/beers/batch' && request.method === 'POST') {
      const result = await handleBatchLookup(request, env, { ...corsHeaders, ...rateLimitHeaders }, requestContext);
      trackRequest(env.ANALYTICS, {
        endpoint: url.pathname,
        method: request.method,
        statusCode: result.status,
        clientId: requestContext.clientIdentifier,
        responseTimeMs: Date.now() - requestContext.startTime,
      });
      ctx.waitUntil(writeAuditLog(env.DB, requestContext, request.method, url.pathname, result.status));
      return result;
    }

    // ========================================================================
    // Admin Routes - Require additional ADMIN_SECRET authentication
    // ========================================================================
    if (url.pathname.startsWith('/admin/')) {
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

      // Route: GET /admin/dlq
      if (url.pathname === '/admin/dlq' && request.method === 'GET') {
        const operationStart = Date.now();
        const result = await handleDlqList(env, { ...corsHeaders, ...rateLimitHeaders }, requestContext, url.searchParams);
        let messageCount = 0;
        try {
          const responseBody = await result.clone().json() as { data?: { messages?: unknown[] } };
          messageCount = responseBody.data?.messages?.length || 0;
        } catch { /* ignore */ }
        trackAdminDlq(env.ANALYTICS, { operation: 'dlq_list', success: result.status === 200, messageCount, durationMs: Date.now() - operationStart });
        ctx.waitUntil(writeAdminAuditLog(env.DB, requestContext, 'dlq_list', { message_count: messageCount }, adminSecretHash));
        return result;
      }

      // Route: GET /admin/dlq/stats
      if (url.pathname === '/admin/dlq/stats' && request.method === 'GET') {
        const operationStart = Date.now();
        const result = await handleDlqStats(env, { ...corsHeaders, ...rateLimitHeaders }, requestContext);
        trackAdminDlq(env.ANALYTICS, { operation: 'dlq_stats', success: result.status === 200, messageCount: 0, durationMs: Date.now() - operationStart });
        ctx.waitUntil(writeAdminAuditLog(env.DB, requestContext, 'dlq_stats', {}, adminSecretHash));
        return result;
      }

      // Route: POST /admin/dlq/replay
      if (url.pathname === '/admin/dlq/replay' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleDlqReplay(request, env, { ...corsHeaders, ...rateLimitHeaders }, requestContext);
        let replayedCount = 0;
        try {
          const responseBody = await result.clone().json() as { data?: { replayed_count?: number } };
          replayedCount = responseBody.data?.replayed_count || 0;
        } catch { /* ignore */ }
        trackAdminDlq(env.ANALYTICS, { operation: 'dlq_replay', success: result.status === 200, messageCount: replayedCount, durationMs: Date.now() - operationStart });
        ctx.waitUntil(writeAdminAuditLog(env.DB, requestContext, 'dlq_replay', { replayed_count: replayedCount }, adminSecretHash));
        return result;
      }

      // Route: POST /admin/dlq/acknowledge
      if (url.pathname === '/admin/dlq/acknowledge' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleDlqAcknowledge(request, env, { ...corsHeaders, ...rateLimitHeaders }, requestContext);
        let acknowledgedCount = 0;
        try {
          const responseBody = await result.clone().json() as { data?: { acknowledged_count?: number } };
          acknowledgedCount = responseBody.data?.acknowledged_count || 0;
        } catch { /* ignore */ }
        trackAdminDlq(env.ANALYTICS, { operation: 'dlq_acknowledge', success: result.status === 200, messageCount: acknowledgedCount, durationMs: Date.now() - operationStart });
        ctx.waitUntil(writeAdminAuditLog(env.DB, requestContext, 'dlq_acknowledge', { acknowledged_count: acknowledgedCount }, adminSecretHash));
        return result;
      }

      // Route: POST /admin/enrich/trigger
      if (url.pathname === '/admin/enrich/trigger' && request.method === 'POST') {
        const operationStart = Date.now();
        const result = await handleEnrichmentTrigger(request, env, { ...corsHeaders, ...rateLimitHeaders }, requestContext);
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
        ctx.waitUntil(writeAdminAuditLog(env.DB, requestContext, 'enrich_trigger', { beers_queued: beersQueued, skip_reason: skipReason, duration_ms: Date.now() - operationStart }, adminSecretHash));
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

  // Cron job: Delegate to scheduled handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron triggered:', event.cron);
    await handleScheduledEnrichment(env, ctx);
  },

  // Queue consumer: Route to appropriate handler based on queue name
  async queue(
    batch: MessageBatch<EnrichmentMessage>,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    console.log(`Queue batch received: messageCount=${batch.messages.length}, queue=${batch.queue}, requestId=${requestId}`);

    if (batch.queue === 'beer-enrichment-dlq') {
      await handleDlqBatch(batch, env, requestId);
    } else if (batch.queue === 'beer-enrichment') {
      await handleEnrichmentBatch(batch, env);
    } else {
      console.warn(`Unknown queue: ${batch.queue}, acknowledging messages to prevent infinite loops`);
      for (const message of batch.messages) {
        message.ack();
      }
    }
  },
};
