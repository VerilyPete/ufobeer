// ============================================================================
// Authentication and Security Helpers
// ============================================================================

import type { Env, RequestContext } from './types';

/**
 * Timing-safe string comparison to prevent timing attacks on API key validation.
 * Hashes both inputs to fixed-length buffers to prevent length leakage.
 */
export async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aEncoded = encoder.encode(a);
  const bEncoded = encoder.encode(b);

  // Hash both inputs to fixed-length 32-byte buffers to prevent length leakage
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', aEncoded),
    crypto.subtle.digest('SHA-256', bEncoded),
  ]);

  return crypto.subtle.timingSafeEqual(aHash, bHash);
}

/**
 * Hash an API key for storage (we don't want to log actual keys).
 *
 * Uses SHA-256 hashing and returns first 8 bytes (16 hex chars) as a
 * short identifier for audit logging purposes.
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate API key from request headers.
 *
 * Extracts X-API-Key header and performs timing-safe comparison with
 * the configured API_KEY environment variable. Updates the request context
 * with hashed API key for audit logging.
 *
 * @param request - The incoming HTTP request
 * @param env - Environment bindings (contains API_KEY secret)
 * @param reqCtx - Request context to update with API key hash
 * @returns true if API key is valid, false otherwise
 */
export async function validateApiKey(
  request: Request,
  env: Env,
  reqCtx: RequestContext
): Promise<boolean> {
  const apiKey = request.headers.get('X-API-Key');

  if (!apiKey) {
    console.warn(JSON.stringify({
      event: 'auth_failed',
      reason: 'missing_api_key',
      requestId: reqCtx.requestId,
      clientIp: reqCtx.clientIp,
      userAgent: reqCtx.userAgent,
    }));
    return false;
  }

  const isValid = await timingSafeCompare(apiKey, env.API_KEY);

  if (isValid) {
    // Store hashed API key in context for audit logging
    reqCtx.apiKeyHash = await hashApiKey(apiKey);
  } else {
    console.warn(JSON.stringify({
      event: 'auth_failed',
      reason: 'invalid_api_key',
      requestId: reqCtx.requestId,
      clientIp: reqCtx.clientIp,
      userAgent: reqCtx.userAgent,
      apiKeyPrefix: apiKey.substring(0, 4) + '...', // First 4 chars for debugging
    }));
  }

  return isValid;
}

/**
 * Authorize admin access for /admin/* routes.
 *
 * Requires both valid API key (already checked) AND valid ADMIN_SECRET.
 * Validates the X-Admin-Secret header using timing-safe comparison.
 *
 * @param request - The incoming HTTP request
 * @param env - Environment bindings (contains ADMIN_SECRET)
 * @param reqCtx - Request context for audit logging
 * @returns Object with authorized flag and optional error message
 */
export async function authorizeAdmin(
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
 * Generate a unique request ID for tracking and correlation.
 *
 * Uses crypto.randomUUID() to generate a RFC4122 v4 UUID.
 * This ID is included in all responses and audit logs.
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Extract client IP address from request headers.
 *
 * Cloudflare provides the real client IP via CF-Connecting-IP header.
 * Falls back to X-Forwarded-For if CF header is not available.
 *
 * @param request - The incoming HTTP request
 * @returns Client IP address or null if not available
 */
export function getClientIp(request: Request): string | null {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For');
}

/**
 * Extract or generate client identifier for rate limiting.
 *
 * Uses X-Client-ID header if provided by client, otherwise falls back
 * to client IP address. Truncates to 64 characters for database storage.
 *
 * @param request - The incoming HTTP request
 * @returns Client identifier string (max 64 chars)
 */
export function getClientIdentifier(request: Request): string {
  const clientIp = getClientIp(request);
  const clientId = request.headers.get('X-Client-ID') || clientIp || 'unknown';
  return clientId.substring(0, 64); // Truncate for DB storage
}

/**
 * Create request context from incoming request.
 *
 * Initializes a RequestContext object with metadata for audit logging,
 * analytics, and request tracking. This context is passed through the
 * entire request lifecycle.
 *
 * @param request - The incoming HTTP request
 * @returns RequestContext object
 */
export function createRequestContext(request: Request): RequestContext {
  return {
    requestId: generateRequestId(),
    startTime: Date.now(),
    clientIdentifier: getClientIdentifier(request),
    apiKeyHash: null, // Set later by validateApiKey
    clientIp: getClientIp(request),
    userAgent: request.headers.get('User-Agent'),
  };
}
