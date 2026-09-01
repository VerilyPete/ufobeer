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
import { validateApiKey, authorizeAdmin } from '../src/auth';
import { writeAuditLog, writeAdminAuditLog } from '../src/audit';
import { handleBeerList } from '../src/handlers';
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
//
// authorizeAdmin is also mocked (rather than left real): its real
// implementation uses crypto.subtle.timingSafeEqual, which the Node
// (test:unit) pool does not provide — see test/auth.test.ts's polyfill,
// which only applies within that file. Defaults to denied; individual
// tests override with mockResolvedValueOnce.
vi.mock('../src/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/auth')>();
  return {
    ...real,
    validateApiKey: vi.fn().mockRejectedValue(
      new Error('D1_ERROR: no such table: audit_log (SQLite error: no such table)')
    ),
    authorizeAdmin: vi.fn().mockResolvedValue({ authorized: false, error: 'Missing admin credentials' }),
  };
});

// Mock handleBeerList so GET /beers tests don't depend on beers.ts's real
// upstream-fetch/cache internals — index.ts's job is routing and gating,
// not taplist logic.
vi.mock('../src/handlers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/handlers')>();
  return {
    ...real,
    handleBeerList: vi.fn().mockResolvedValue({
      response: new Response(JSON.stringify({ beers: [] }), { status: 200 }),
      beersReturned: 0,
      upstreamLatencyMs: 5,
      cacheOutcome: 'miss',
    }),
  };
});

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a minimal mock Env.
 */
function createMockEnv(options: { allowedOrigin?: string; db?: D1Database } = {}): Env {
  const allowedOrigin = options.allowedOrigin ?? 'https://ufobeer.app';
  return {
    DB: options.db ?? {
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

  it('sets CORS header when Origin matches ALLOWED_ORIGIN and an error is thrown', async () => {
    const env = createMockEnv({ allowedOrigin: 'https://ufobeer.app' });
    const ctx = createMockCtx();
    const request = new Request('https://api.ufobeer.app/beers?sid=13879', {
      method: 'GET',
      headers: { 'X-API-Key': 'test-api-key', 'Origin': 'https://ufobeer.app' },
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ufobeer.app');
  });

  it('omits CORS header when Origin does not match ALLOWED_ORIGIN and an error is thrown', async () => {
    const env = createMockEnv({ allowedOrigin: 'https://ufobeer.app' });
    const ctx = createMockCtx();
    const request = new Request('https://api.ufobeer.app/beers?sid=13879', {
      method: 'GET',
      headers: { 'X-API-Key': 'test-api-key', 'Origin': 'https://evil.com' },
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('omits CORS header when ALLOWED_ORIGIN is not configured and an error is thrown', async () => {
    const env = createMockEnv({ allowedOrigin: '' });
    const ctx = createMockCtx();
    const request = createGetRequest('/beers?sid=13879');

    const response = await worker.fetch(request, env, ctx);

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

/**
 * Creates a mock Env DB whose rate-limit `.first()` results can be sequenced
 * per call (pre-auth limiter, post-auth limiter, sync limiter, ...).
 */
function createSequencedDbMock(): { db: D1Database; first: ReturnType<typeof vi.fn> } {
  const first = vi.fn();
  const db = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first,
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }),
    batch: vi.fn().mockResolvedValue([]),
  } as unknown as D1Database;
  return { db, first };
}

// ============================================================================
// Tests: rate limiter wiring and fail-closed behavior
// ============================================================================

describe('rate limiter wiring', () => {
  it('returns 429 when the pre-auth limit is exceeded', async () => {
    const { db, first } = createSequencedDbMock();
    // PRE_AUTH_RPM unset -> default 30; this request lands as #31.
    first.mockResolvedValueOnce({ request_count: 31 });
    const env = createMockEnv({ db });
    const ctx = createMockCtx();
    const request = createGetRequest('/beers?sid=13879');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(429);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30');
    const body = await response.json() as Record<string, unknown>;
    expect(body['error']).toBe('Rate limit exceeded');
  });

  it('returns 503 (not 429 or 500) when the pre-auth limiter cannot run', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockRejectedValueOnce(new Error('D1 unavailable'));
    const env = createMockEnv({ db });
    const ctx = createMockCtx();
    const request = createGetRequest('/beers?sid=13879');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('10');
    const body = await response.json() as Record<string, unknown>;
    expect(body['error']).toBe('Service temporarily unavailable');
  });

  it('returns 503 when the post-auth limiter fails after auth succeeded', async () => {
    const { db, first } = createSequencedDbMock();
    // Pre-auth check passes, post-auth check fails.
    first.mockResolvedValueOnce({ request_count: 1 });
    first.mockRejectedValueOnce(new Error('D1 unavailable'));

    // The file-level auth mock rejects; a passing auth result is required to
    // reach the post-auth limiter.
    vi.mocked(validateApiKey).mockResolvedValueOnce({ valid: true, apiKeyHash: 'hash-123' });

    const env = createMockEnv({ db });
    const ctx = createMockCtx();
    const request = createGetRequest('/beers?sid=13879');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body['error']).toBe('Service temporarily unavailable');
  });

  it('throttles /health under the pre-auth limit', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 31 });
    const env = createMockEnv({ db });
    const ctx = createMockCtx();
    const request = new Request('https://api.ufobeer.app/health', { method: 'GET' });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(429);
    expect(first).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Tests: CORS preflight stays outside the try/catch, and is validated
// ============================================================================

/**
 * Builds an OPTIONS preflight request. Defaults to a legitimate preflight
 * for GET /beers from the configured origin; override individual fields to
 * construct an invalid one.
 */
function createPreflightRequest(overrides: {
  path?: string;
  origin?: string | null;
  requestMethod?: string | null;
  requestHeaders?: string | null;
} = {}): Request {
  const {
    path = '/beers',
    origin = 'https://ufobeer.app',
    requestMethod = 'GET',
    requestHeaders = null,
  } = overrides;
  const headers: Record<string, string> = {};
  if (origin !== null) headers['Origin'] = origin;
  if (requestMethod !== null) headers['Access-Control-Request-Method'] = requestMethod;
  if (requestHeaders !== null) headers['Access-Control-Request-Headers'] = requestHeaders;
  return new Request(`https://api.ufobeer.app${path}`, { method: 'OPTIONS', headers });
}

describe('fetch handler OPTIONS preflight', () => {
  it('returns 204 for a legitimate preflight even when the handler would throw', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createPreflightRequest();

    // OPTIONS is handled BEFORE the try block, so it must succeed even
    // if validateApiKey (mocked to throw) would have been called later.
    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(204);
  });

  it('returns the trimmed CORS headers on a valid preflight', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createPreflightRequest();

    const response = await worker.fetch(request, env, ctx);

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ufobeer.app');
    expect(response.headers.get('Access-Control-Allow-Methods')).not.toContain('DELETE');
    expect(response.headers.get('Access-Control-Allow-Headers')).not.toContain('X-Admin-Secret');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-API-Key');
  });

  it('sets security headers on a valid preflight response', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createPreflightRequest();

    const response = await worker.fetch(request, env, ctx);

    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('rejects a preflight with no Origin header (403)', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createPreflightRequest({ origin: null });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(403);
  });

  it('rejects a preflight from a non-configured origin (403)', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createPreflightRequest({ origin: 'https://evil.com' });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(403);
  });

  it('rejects a preflight requesting a method the route does not use (403)', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    // /beers is GET-only.
    const request = createPreflightRequest({ requestMethod: 'DELETE' });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(403);
  });

  it('rejects a preflight for a path with no documented CORS contract (403)', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createPreflightRequest({ path: '/admin/dlq', requestMethod: 'GET' });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(403);
  });

  it('rejects a preflight requesting a disallowed header (X-Admin-Secret)', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createPreflightRequest({ requestHeaders: 'content-type, x-admin-secret' });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(403);
  });

  it('accepts a preflight requesting only documented headers', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    const request = createPreflightRequest({ requestHeaders: 'content-type, x-api-key' });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(204);
  });

  it('creates no D1 audit row for a valid preflight', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();
    await worker.fetch(createPreflightRequest(), env, ctx);

    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it('creates no D1 audit row for high-volume or invalid preflight traffic', async () => {
    const env = createMockEnv();
    const ctx = createMockCtx();

    for (let i = 0; i < 25; i++) {
      await worker.fetch(createPreflightRequest({ origin: 'https://evil.com' }), env, ctx);
    }

    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Tests: fresh=true is gated to admin credentials
// ============================================================================

describe('GET /beers fresh=true admin gate', () => {
  function createFreshRequest(headers: Record<string, string> = {}): Request {
    return new Request('https://api.ufobeer.app/beers?sid=13879&fresh=true', {
      method: 'GET',
      headers,
    });
  }

  it('returns 403 when fresh=true is requested with no API key at all', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 1 }); // pre-auth limiter
    const env = createMockEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(createFreshRequest(), env, ctx);

    expect(response.status).toBe(403);
    expect(handleBeerList).not.toHaveBeenCalled();
  });

  it('returns 403 when fresh=true is requested with a plain app key (no admin secret)', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 1 }); // pre-auth limiter
    const env = createMockEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(
      createFreshRequest({ 'X-API-Key': 'test-api-key' }),
      env,
      ctx
    );

    expect(response.status).toBe(403);
    expect(handleBeerList).not.toHaveBeenCalled();
  });

  it('allows fresh=true and forwards it to handleBeerList when the admin credential is valid', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 1 }); // pre-auth limiter
    first.mockResolvedValueOnce({ request_count: 1 }); // post-auth limiter
    vi.mocked(authorizeAdmin).mockResolvedValueOnce({ authorized: true });
    vi.mocked(validateApiKey).mockResolvedValueOnce({ valid: true, apiKeyHash: 'hash-admin' });
    const env = createMockEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(
      createFreshRequest({ 'X-API-Key': 'test-api-key', 'X-Admin-Secret': 'admin-secret' }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(handleBeerList).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), '13879', true
    );
  });

  it('does not trigger the admin gate for a plain app-key request without fresh (normal cached response)', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 1 }); // pre-auth limiter
    first.mockResolvedValueOnce({ request_count: 1 }); // post-auth limiter
    vi.mocked(validateApiKey).mockResolvedValueOnce({ valid: true, apiKeyHash: 'hash-app' });
    const env = createMockEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(
      new Request('https://api.ufobeer.app/beers?sid=13879', {
        method: 'GET',
        headers: { 'X-API-Key': 'test-api-key' },
      }),
      env,
      ctx
    );

    expect(authorizeAdmin).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(handleBeerList).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), '13879', false
    );
  });
});

// ============================================================================
// Tests: POST /admin/dlq/acknowledge audit fidelity (Cloudflare security
// review, "dlq_acknowledge audit fidelity" -- classifyAdminOutcome must be
// able to distinguish a partial acknowledge from a full success, the same
// way it already does for dlq_replay).
// ============================================================================

describe('POST /admin/dlq/acknowledge audit fidelity', () => {
  /**
   * A DB mock that sequences .first() calls (rate limiters, via `first`)
   * the same way createSequencedDbMock does, but gives the
   * `UPDATE dlq_messages ... WHERE id IN (...)` statement a `.run()` that
   * reports a caller-chosen `meta.changes`, so a partial acknowledge (fewer
   * rows changed than requested) can actually be exercised end to end
   * through the real handleDlqAcknowledge handler.
   */
  function createDlqAcknowledgeDbMock(changes: number): { db: D1Database; first: ReturnType<typeof vi.fn> } {
    const first = vi.fn();
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('UPDATE dlq_messages')) {
          return {
            bind: vi.fn().mockReturnValue({
              run: vi.fn().mockResolvedValue({ meta: { changes } }),
            }),
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            first,
            run: vi.fn().mockResolvedValue({ success: true }),
          }),
        };
      }),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database;
    return { db, first };
  }

  function createAcknowledgeRequest(ids: number[]): Request {
    return new Request('https://api.ufobeer.app/admin/dlq/acknowledge', {
      method: 'POST',
      headers: {
        'X-API-Key': 'test-api-key',
        'X-Admin-Secret': 'admin-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids }),
    });
  }

  it('persists outcome "partial" with requested/succeeded/failed counts when only some IDs are acknowledged', async () => {
    // 3 requested, only 2 actually matched status='pending' and changed.
    const { db, first } = createDlqAcknowledgeDbMock(2);
    first.mockResolvedValueOnce({ request_count: 1 }); // pre-auth limiter
    first.mockResolvedValueOnce({ request_count: 1 }); // post-auth limiter
    vi.mocked(authorizeAdmin).mockResolvedValueOnce({ authorized: true });
    vi.mocked(validateApiKey).mockResolvedValueOnce({ valid: true, apiKeyHash: 'hash-admin' });
    const env = createMockEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(createAcknowledgeRequest([1, 2, 3]), env, ctx);

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { acknowledged_count: number; requested_count: number; failed_count: number } };
    expect(body.data).toEqual({ acknowledged_count: 2, requested_count: 3, failed_count: 1 });

    expect(writeAdminAuditLog).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      'dlq_acknowledge',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        statusCode: 200,
        outcome: 'partial',
        requestedCount: 3,
        succeededCount: 2,
        failedCount: 1,
      })
    );
  });

  it('persists outcome "success" with matching counts when every ID is acknowledged', async () => {
    const { db, first } = createDlqAcknowledgeDbMock(3);
    first.mockResolvedValueOnce({ request_count: 1 });
    first.mockResolvedValueOnce({ request_count: 1 });
    vi.mocked(authorizeAdmin).mockResolvedValueOnce({ authorized: true });
    vi.mocked(validateApiKey).mockResolvedValueOnce({ valid: true, apiKeyHash: 'hash-admin' });
    const env = createMockEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(createAcknowledgeRequest([1, 2, 3]), env, ctx);

    expect(response.status).toBe(200);
    expect(writeAdminAuditLog).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      'dlq_acknowledge',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        outcome: 'success',
        requestedCount: 3,
        succeededCount: 3,
        failedCount: 0,
      })
    );
  });

  it('persists outcome "failed" with requestedCount and zero succeeded when no IDs match', async () => {
    const { db, first } = createDlqAcknowledgeDbMock(0);
    first.mockResolvedValueOnce({ request_count: 1 });
    first.mockResolvedValueOnce({ request_count: 1 });
    vi.mocked(authorizeAdmin).mockResolvedValueOnce({ authorized: true });
    vi.mocked(validateApiKey).mockResolvedValueOnce({ valid: true, apiKeyHash: 'hash-admin' });
    const env = createMockEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(createAcknowledgeRequest([1, 2, 3]), env, ctx);

    expect(response.status).toBe(200);
    expect(writeAdminAuditLog).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      'dlq_acknowledge',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        outcome: 'failed',
        requestedCount: 3,
        succeededCount: 0,
        failedCount: 3,
      })
    );
  });
});

// ============================================================================
// Tests: /livez liveness endpoint and /health method restriction
// ============================================================================

describe('/livez liveness endpoint', () => {
  it('returns 200 for GET /livez', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 1 });
    const env = createMockEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(new Request('https://api.ufobeer.app/livez'), env, ctx);

    expect(response.status).toBe(200);
  });

  it('returns 405 with an Allow header for POST /livez', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 1 });
    const env = createMockEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(
      new Request('https://api.ufobeer.app/livez', { method: 'POST' }),
      env,
      ctx
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toContain('GET');
  });
});

describe('/health method restriction', () => {
  it('returns 405 with an Allow header for POST /health (previously returned 200)', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 1 });
    const env = createMockEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(
      new Request('https://api.ufobeer.app/health', { method: 'POST' }),
      env,
      ctx
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toContain('GET');
  });
});

// ============================================================================
// Tests: security response headers via respond()
// ============================================================================

describe('security response headers on respond()', () => {
  it('sets X-Content-Type-Options: nosniff and Cache-Control: no-store on a respond()-built error response', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 31 }); // trip the pre-auth limiter -> respond() 429
    const env = createMockEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(createGetRequest('/beers?sid=13879'), env, ctx);

    expect(response.status).toBe(429);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
