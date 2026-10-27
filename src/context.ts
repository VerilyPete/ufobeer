// ============================================================================
// Request Context and Middleware Functions
// ============================================================================
// This module handles:
// - CORS headers configuration
// - Standardized error responses
// - Shared security response headers
//
// These functions are used by the main fetch handler to provide consistent
// request handling across routes.
// ============================================================================

import type { Env, ErrorResponseOptions } from './types';

// ============================================================================
// CORS Configuration
// ============================================================================

/**
 * Get CORS headers. Returns null when ALLOWED_ORIGIN is not configured,
 * or when the request Origin does not match ALLOWED_ORIGIN.
 *
 * Non-browser clients (curl, mobile apps) don't send Origin headers —
 * returning null for those requests is correct; CORS headers are meaningless
 * without a browser enforcing the same-origin policy.
 *
 * Methods and headers are trimmed to the documented browser contract:
 * DELETE is not used by any route, and X-Admin-Secret is intentionally
 * excluded — browser-based admin tooling is not supported, so admin routes
 * are reachable only by non-browser clients that don't need a CORS grant.
 */
export function getCorsHeaders(env: Env, requestOrigin?: string | null): Record<string, string> | null {
  if (!env.ALLOWED_ORIGIN || requestOrigin !== env.ALLOWED_ORIGIN) return null;
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Access-Control-Max-Age': '86400',
  };
}

// ============================================================================
// Shared Security Response Headers
// ============================================================================

/**
 * Security headers applied to every response from the shared response
 * helpers below (`errorResponse`) as well as `respond()` in index.ts and
 * the health/liveness handlers.
 *
 * - `X-Content-Type-Options: nosniff` stops a browser from MIME-sniffing a
 *   JSON body as HTML/script.
 * - `Referrer-Policy: no-referrer` avoids leaking request paths (which can
 *   carry store IDs or request IDs) to a referrer-reading third party.
 *
 * HSTS is intentionally NOT set here — it is a zone-level setting (see the
 * Cloudflare dashboard checklist in the security review), not something a
 * Worker response header can safely establish on its own.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * Merge the shared security headers and an explicit Cache-Control directive
 * into a response's headers. Centralizes the header set so the three
 * response paths that build headers by hand (`respond()` in index.ts,
 * `errorResponse()` below, and the health/liveness handlers) don't each
 * duplicate it.
 *
 * An explicit Cache-Control on every response is load-bearing, not
 * belt-and-braces: Workers Caching's automatic authenticated-request bypass
 * keys on the `Authorization` header, and this API authenticates with
 * `X-API-Key` instead — so that safety net never applies here.
 */
export function withResponseHeaders(
  headers: Record<string, string>,
  cacheControl: string
): Record<string, string> {
  return {
    ...headers,
    ...SECURITY_HEADERS,
    'Cache-Control': cacheControl,
  };
}

// ============================================================================
// Error Response Helper
// ============================================================================

/**
 * Create a standardized error response.
 *
 * Always no-store: every caller of errorResponse() is, by construction, an
 * error path — there is no cacheable success case here.
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
      headers: withResponseHeaders(options.headers, 'no-store'),
    }
  );
}
