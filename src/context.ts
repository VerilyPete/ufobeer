// ============================================================================
// Request Context and Middleware Functions
// ============================================================================
// This module handles:
// - CORS headers configuration
// - Standardized error responses
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
 */
export function getCorsHeaders(env: Env, requestOrigin?: string | null): Record<string, string> | null {
  if (!env.ALLOWED_ORIGIN || requestOrigin !== env.ALLOWED_ORIGIN) return null;
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Admin-Secret',
    'Access-Control-Max-Age': '86400',
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
