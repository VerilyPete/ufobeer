// ============================================================================
// Request Context and Middleware Functions
// ============================================================================
// This module handles:
// - CORS headers configuration
// - Request context creation (request ID, client identification, timing)
// - Standardized response helpers (respond, errorResponse)
//
// These functions are used by the main fetch handler to provide consistent
// request handling, audit logging, and analytics tracking.
// ============================================================================

import type { Env, RequestContext, ErrorResponseOptions } from './types';
import type { AnalyticsEngineDataset } from './analytics';
import { trackRequest } from './analytics';

// ============================================================================
// CORS Configuration
// ============================================================================

/**
 * Get CORS headers. Fails explicitly if ALLOWED_ORIGIN is not configured.
 */
export function getCorsHeaders(env: Env): Record<string, string> | null {
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
// Response Helpers
// ============================================================================

/**
 * Options for creating a response with audit logging and analytics.
 */
export type RespondOptions = {
  /** D1 database for audit logging */
  readonly db: D1Database;
  /** Request context */
  readonly requestContext: RequestContext;
  /** Analytics dataset (optional) */
  readonly analytics?: AnalyticsEngineDataset | undefined;
  /** Execution context for waitUntil (audit log writes) */
  readonly ctx: ExecutionContext;
  /** HTTP request object (for method, url) */
  readonly request: Request;
  /** Callback to write audit log (injected to avoid circular dependency) */
  readonly writeAuditLog: (
    db: D1Database,
    ctx: RequestContext,
    method: string,
    path: string,
    statusCode: number,
    error?: string
  ) => Promise<void>;
  /** Store ID for analytics (optional) */
  readonly storeId?: string | undefined;
  /** Number of beers returned (optional, for /beers endpoint) */
  readonly beersReturned?: number | undefined;
  /** Upstream API latency in ms (optional, for /beers endpoint) */
  readonly upstreamLatencyMs?: number | undefined;
};

/**
 * Create a standardized response with audit logging and analytics tracking.
 * This is a factory function that returns a respond function with the current request's context.
 */
export function createResponder(options: RespondOptions) {
  return async (
    body: string | object | null,
    status: number,
    headers: Record<string, string>,
    error?: string
  ): Promise<Response> => {
    const url = new URL(options.request.url);

    // Audit log to D1 (non-blocking)
    options.ctx.waitUntil(
      options.writeAuditLog(
        options.db,
        options.requestContext,
        options.request.method,
        url.pathname,
        status,
        error
      )
    );

    // Track in Analytics Engine (non-blocking, writeDataPoint is already non-blocking)
    trackRequest(options.analytics, {
      endpoint: url.pathname,
      method: options.request.method,
      storeId: options.storeId,
      statusCode: status,
      errorType: error,
      clientId: options.requestContext.clientIdentifier,
      responseTimeMs: Date.now() - options.requestContext.startTime,
      beersReturned: options.beersReturned,
      upstreamLatencyMs: options.upstreamLatencyMs,
    });

    // Return response based on body type
    if (body === null) return new Response(null, { status, headers });
    if (typeof body === 'object') return Response.json(body, { status, headers });
    return new Response(body, { status, headers });
  };
}

// ============================================================================
// Error Response Helper
// ============================================================================

/**
 * Create a standardized error response.
 */
export function errorResponse(
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
      ...(options.extra ?? {}),
    },
    {
      status: options.status || 400,
      headers: options.headers,
    }
  );
}
