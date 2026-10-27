/**
 * Unit tests for request context and middleware functions.
 *
 * @module test/context.test
 */

import { describe, it, expect, vi } from 'vitest';
import { getCorsHeaders, errorResponse, withResponseHeaders, SECURITY_HEADERS } from '../src/context';
import type { Env, ErrorResponseOptions } from '../src/types';

// ============================================================================
// Factory Functions
// ============================================================================

const getMockEnv = (overrides?: Partial<Env>): Env => ({
  ALLOWED_ORIGIN: 'https://ufobeer.app',
  DB: {} as D1Database,
  ...overrides,
} as Env);

const getErrorResponseOptions = (
  overrides?: Partial<ErrorResponseOptions>
): ErrorResponseOptions => ({
  requestId: 'req-test-456',
  headers: { 'Content-Type': 'application/json' },
  ...overrides,
});

// ============================================================================
// getCorsHeaders Tests
// ============================================================================

describe('getCorsHeaders', () => {
  it('returns Access-Control-Allow-Origin set to env.ALLOWED_ORIGIN when Origin matches', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env, 'https://ufobeer.app');
    expect(result).not.toBeNull();
    expect(result!['Access-Control-Allow-Origin']).toBe('https://ufobeer.app');
  });

  it('returns Access-Control-Allow-Methods containing GET when Origin matches', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env, 'https://ufobeer.app');
    expect(result).not.toBeNull();
    expect(result!['Access-Control-Allow-Methods']).toContain('GET');
  });

  it('returns Access-Control-Allow-Methods containing POST when Origin matches', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env, 'https://ufobeer.app');
    expect(result).not.toBeNull();
    expect(result!['Access-Control-Allow-Methods']).toContain('POST');
  });

  it('returns Access-Control-Allow-Headers containing X-API-Key when Origin matches', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env, 'https://ufobeer.app');
    expect(result).not.toBeNull();
    expect(result!['Access-Control-Allow-Headers']).toContain('X-API-Key');
  });

  it('returns null when ALLOWED_ORIGIN is an empty string', () => {
    const env = getMockEnv({ ALLOWED_ORIGIN: '' });
    const result = getCorsHeaders(env, 'https://ufobeer.app');
    expect(result).toBeNull();
  });

  it('returns null when ALLOWED_ORIGIN is undefined', () => {
    const env = getMockEnv({ ALLOWED_ORIGIN: undefined as unknown as string });
    const result = getCorsHeaders(env, 'https://ufobeer.app');
    expect(result).toBeNull();
  });

  it('returns null when Origin does not match ALLOWED_ORIGIN', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env, 'https://evil.com');
    expect(result).toBeNull();
  });

  it('returns null when Origin is undefined', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env, undefined);
    expect(result).toBeNull();
  });

  it('returns null when Origin is null', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env, null);
    expect(result).toBeNull();
  });

  it('does not include X-Client-ID in Access-Control-Allow-Headers', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env, 'https://ufobeer.app');
    expect(result).not.toBeNull();
    expect(result!['Access-Control-Allow-Headers']).not.toContain('X-Client-ID');
  });

  it('does not include X-Admin-Secret in Access-Control-Allow-Headers — browser-based admin tooling is not supported', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env, 'https://ufobeer.app');
    expect(result).not.toBeNull();
    expect(result!['Access-Control-Allow-Headers']).not.toContain('X-Admin-Secret');
  });

  it('does not include DELETE in Access-Control-Allow-Methods — no route uses it', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env, 'https://ufobeer.app');
    expect(result).not.toBeNull();
    expect(result!['Access-Control-Allow-Methods']).not.toContain('DELETE');
  });
});

// ============================================================================
// Shared Security Headers Tests
// ============================================================================

describe('withResponseHeaders', () => {
  it('merges X-Content-Type-Options: nosniff into the given headers', () => {
    const result = withResponseHeaders({}, 'no-store');
    expect(result['X-Content-Type-Options']).toBe('nosniff');
  });

  it('merges a Referrer-Policy header', () => {
    const result = withResponseHeaders({}, 'no-store');
    expect(result['Referrer-Policy']).toBeTruthy();
  });

  it('sets Cache-Control to the provided directive', () => {
    const result = withResponseHeaders({}, 'private, max-age=300');
    expect(result['Cache-Control']).toBe('private, max-age=300');
  });

  it('preserves caller-supplied headers alongside the security headers', () => {
    const result = withResponseHeaders({ 'X-Request-ID': 'req-1' }, 'no-store');
    expect(result['X-Request-ID']).toBe('req-1');
    expect(result['X-Content-Type-Options']).toBe('nosniff');
  });

  it('does not set Strict-Transport-Security (HSTS is a zone setting, not a Worker header)', () => {
    const result = withResponseHeaders({}, 'no-store');
    expect(result['Strict-Transport-Security']).toBeUndefined();
  });
});

describe('SECURITY_HEADERS', () => {
  it('includes nosniff', () => {
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });
});

// ============================================================================
// errorResponse Tests
// ============================================================================

describe('errorResponse', () => {
  it('returns a Response object', () => {
    const options = getErrorResponseOptions();
    const result = errorResponse('Something went wrong', 'GENERIC_ERROR', options);
    expect(result).toBeInstanceOf(Response);
  });

  it('returns response body with success: false', async () => {
    const options = getErrorResponseOptions();
    const result = errorResponse('Bad request', 'BAD_REQUEST', options);
    const body = await result.json() as { success: boolean };
    expect(body.success).toBe(false);
  });

  it('returns response body with error.message equal to the provided message', async () => {
    const options = getErrorResponseOptions();
    const result = errorResponse('Invalid store ID', 'INVALID_STORE', options);
    const body = await result.json() as { error: { message: string } };
    expect(body.error.message).toBe('Invalid store ID');
  });

  it('returns response body with error.code equal to the provided code', async () => {
    const options = getErrorResponseOptions();
    const result = errorResponse('Not found', 'NOT_FOUND', options);
    const body = await result.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns response body with requestId from options', async () => {
    const options = getErrorResponseOptions({ requestId: 'req-unique-789' });
    const result = errorResponse('Error', 'ERR', options);
    const body = await result.json() as { requestId: string };
    expect(body.requestId).toBe('req-unique-789');
  });

  it('returns status 400 when options.status is not provided', () => {
    const options = getErrorResponseOptions();
    const result = errorResponse('Bad input', 'BAD_INPUT', options);
    expect(result.status).toBe(400);
  });

  it('returns the provided status when options.status is specified', () => {
    const options = getErrorResponseOptions({ status: 404 });
    const result = errorResponse('Not found', 'NOT_FOUND', options);
    expect(result.status).toBe(404);
  });

  it('includes extra fields from options.extra in the response body', async () => {
    const options = getErrorResponseOptions({
      extra: { retryAfter: 60, limit: 100 },
    });
    const result = errorResponse('Rate limited', 'RATE_LIMITED', options);
    const body = await result.json() as { retryAfter: number; limit: number };
    expect(body.retryAfter).toBe(60);
    expect(body.limit).toBe(100);
  });

  it('sets X-Content-Type-Options: nosniff', () => {
    const options = getErrorResponseOptions();
    const result = errorResponse('Bad request', 'BAD_REQUEST', options);
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('sets Cache-Control: no-store', () => {
    const options = getErrorResponseOptions();
    const result = errorResponse('Bad request', 'BAD_REQUEST', options);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
  });

  it('preserves caller-supplied headers alongside the security headers', () => {
    const options = getErrorResponseOptions({ headers: { 'X-Request-ID': 'req-1' } });
    const result = errorResponse('Bad request', 'BAD_REQUEST', options);
    expect(result.headers.get('X-Request-ID')).toBe('req-1');
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
