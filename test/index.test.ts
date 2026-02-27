/**
 * Tests for the top-level fetch handler in src/index.ts.
 *
 * These tests verify that:
 * - Unhandled exceptions in the routing layer are caught and return JSON 500
 * - The 500 response includes a requestId and generic error message
 * - No raw error details are leaked to clients
 * - CORS headers are set when ALLOWED_ORIGIN is configured
 * - CORS preflight (OPTIONS) is NOT affected by the try/catch
 *
 * Strategy: mock `validateApiKey` to throw an uncaught error. Unlike DB
 * operations (which have their own internal error handling in rate-limit.ts and
 * handlers/beers.ts), the call to validateApiKey in index.ts is NOT wrapped in
 * its own try/catch — so a throw there is guaranteed to propagate to the outer
 * try/catch we are testing.
 */

import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';

// ============================================================================
// Mock Modules
// ============================================================================

// Mock analytics so trackRequest does not throw when ANALYTICS is undefined
vi.mock('../src/analytics', () => ({
  trackRequest: vi.fn(),
  trackRateLimit: vi.fn(),
  trackAdminDlq: vi.fn(),
  trackAdminTrigger: vi.fn(),
  trackCleanupTrigger: vi.fn(),
}));

// Mock audit so writeAuditLog does not throw when DB is broken
vi.mock('../src/audit', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  writeAdminAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// Mock validateApiKey so it throws an unexpected internal error.
// The call to validateApiKey in index.ts is NOT wrapped in a try/catch,
// so this throw will propagate directly to the outer try/catch boundary
// we are testing — making the test deterministic regardless of handler
// internals.
vi.mock('../src/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/auth')>();
  return {
    ...real,
    validateApiKey: vi.fn().mockRejectedValue(
      new Error('D1_ERROR: no such table: audit_log (SQLite error: no such table)')
    ),
  };
});

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a minimal mock Env.
 */
function createMockEnv(options: { allowedOrigin?: string } = {}): Env {
  const allowedOrigin = options.allowedOrigin ?? 'https://ufobeer.app';
  return {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      }),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database,
    ENRICHMENT_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue,
    CLEANUP_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue,
    AI: {} as Ai,
    API_KEY: 'test-api-key',
    FLYING_SAUCER_API_BASE: 'https://example.com',
    ALLOWED_ORIGIN: allowedOrigin,
    RATE_LIMIT_RPM: '60',
  } as Env;
}

/**
 * Creates a mock ExecutionContext.
 */
function createMockCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

/**
 * Creates a GET /health request (no API key required, goes through auth check).
 * We send any GET request so it lands in the try block and hits validateApiKey.
 */
function createGetRequest(path: string, apiKey: string = 'test-api-key'): Request {
  return new Request(`https://api.ufobeer.app${path}`, {
    method: 'GET',
    headers: {
      'X-API-Key': apiKey,
      'X-Client-ID': 'test-client',
    },
  });
}

// ============================================================================
// Tests: Unhandled exception returns JSON 500
// ============================================================================

describe('fetch handler top-level error boundary', () => {
  it('returns HTTP 500 when an unexpected error is thrown in the handler', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createGetRequest('/beers?sid=13879');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(500);
  });

  it('returns JSON Content-Type on unexpected error', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createGetRequest('/beers?sid=13879');

    const response = await worker.fetch(request, env, ctx);

    expect(response.headers.get('Content-Type')).toContain('application/json');
  });

  it('returns body with error field set to "Internal Server Error"', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createGetRequest('/beers?sid=13879');

    const response = await worker.fetch(request, env, ctx);
    const body = await response.json() as Record<string, unknown>;

    expect(body['error']).toBe('Internal Server Error');
  });

  it('returns body with a requestId string', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createGetRequest('/beers?sid=13879');

    const response = await worker.fetch(request, env, ctx);
    const body = await response.json() as Record<string, unknown>;

    expect(typeof body['requestId']).toBe('string');
    expect((body['requestId'] as string).length).toBeGreaterThan(0);
  });

  it('does not expose the raw error message from the thrown exception', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createGetRequest('/beers?sid=13879');

    const response = await worker.fetch(request, env, ctx);
    const text = await response.text();

    expect(text).not.toContain('no such table');
    expect(text).not.toContain('audit_log');
    expect(text).not.toContain('D1_ERROR');
    expect(text).not.toContain('SQLite');
  });

  it('sets CORS header from ALLOWED_ORIGIN when an error is thrown', async () => {
    const env = createMockEnv({ allowedOrigin: 'https://ufobeer.app' });
    const ctx = createMockCtx();
    const request = createGetRequest('/beers?sid=13879');

    const response = await worker.fetch(request, env, ctx);

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ufobeer.app');
  });

  it('omits CORS header when ALLOWED_ORIGIN is not configured and an error is thrown', async () => {
    const env = createMockEnv({ allowedOrigin: '' });
    const ctx = createMockCtx();
    const request = createGetRequest('/beers?sid=13879');

    const response = await worker.fetch(request, env, ctx);

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

// ============================================================================
// Tests: CORS preflight stays outside the try/catch
// ============================================================================

describe('fetch handler OPTIONS preflight', () => {
  it('returns 204 for OPTIONS even when the handler would throw', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = new Request('https://api.ufobeer.app/beers', {
      method: 'OPTIONS',
    });

    // OPTIONS is handled BEFORE the try block, so it must succeed even
    // if validateApiKey (mocked to throw) would have been called later.
    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(204);
  });
});
