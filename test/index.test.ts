/**
 * Tests for the top-level fetch handler in src/index.ts.
 *
 * These tests verify that:
 * - Unhandled exceptions in the routing layer are caught and return JSON 500
 * - The 500 response includes a requestId and generic error message
 * - No raw error details are leaked to clients
 * - No response carries CORS headers, whatever Origin is sent
 * - OPTIONS is refused with 403 outside the try/catch, without D1 or auth
 *
 * Strategy: mock `validateApiKey` to throw an uncaught error. Unlike DB
 * operations (which have their own internal error handling in rate-limit.ts and
 * handlers/beers.ts), the call to validateApiKey in index.ts is NOT wrapped in
 * its own try/catch — so a throw there is guaranteed to propagate to the outer
 * try/catch we are testing.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import worker from '../src/index';
import { trackRequest } from '../src/analytics';
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
function createMockEnv(options: { db?: D1Database } = {}): Env {
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
});

/**
 * Creates a mock Env DB whose rate-limit `.first()` results can be sequenced
 * per call (pre-auth limiter, post-auth limiter, sync limiter, ...).
 */
function createSequencedDbMock(): { db: D1Database; first: Mock } {
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

  it('returns 503 when the /usage per-IP limiter cannot run', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 1 });
    first.mockRejectedValueOnce(new Error('D1 unavailable'));
    vi.mocked(validateApiKey).mockResolvedValueOnce({ valid: true, apiKeyHash: 'hash-123' });
    const env = createMockEnv({ db });
    const ctx = createMockCtx();
    const request = new Request('https://api.ufobeer.app/usage', {
      method: 'POST',
      headers: { 'X-API-Key': 'test-api-key', 'Content-Type': 'application/json' },
      body: '{}',
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('10');
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
// Tests: no response carries CORS headers, whatever Origin is sent
// ============================================================================

const FORMER_ALLOWED_ORIGIN = 'https://ufobeer.app';

function accessControlHeaderNames(headers: Headers): string[] {
  return [...headers.keys()].filter(name => name.startsWith('access-control-'));
}

function createBrowserGetRequest(path: string): Request {
  return new Request(`https://api.ufobeer.app${path}`, {
    method: 'GET',
    headers: {
      'X-API-Key': 'test-api-key',
      'X-Client-ID': 'test-client',
      'Origin': FORMER_ALLOWED_ORIGIN,
    },
  });
}

/**
 * An env that still carries the removed ALLOWED_ORIGIN var, matching the
 * Origin these tests send. It proves the Worker ignores leftover config,
 * not merely that it was given none.
 */
function createLegacyConfiguredEnv(options: { db?: D1Database } = {}): Env {
  return Object.assign(createMockEnv(options), { ALLOWED_ORIGIN: FORMER_ALLOWED_ORIGIN });
}

describe('no CORS headers on any response', () => {
  it('passes handlers only non-CORS headers for a keyed GET /beers with an Origin', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 1 });
    first.mockResolvedValueOnce({ request_count: 1 });
    vi.mocked(validateApiKey).mockResolvedValueOnce({ valid: true, apiKeyHash: 'hash-app' });
    const env = createLegacyConfiguredEnv({ db });
    const ctx = createMockCtx();

    await worker.fetch(createBrowserGetRequest('/beers?sid=13879'), env, ctx);

    const suppliedHeaders = vi.mocked(handleBeerList).mock.calls[0]?.[3] ?? {};
    expect(Object.keys(suppliedHeaders).filter(name => name.toLowerCase().startsWith('access-control-'))).toEqual([]);
    expect(Object.keys(suppliedHeaders).sort()).toEqual([
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'X-Request-ID',
    ]);
  });

  it('serves a keyed GET /beers from an env with no ALLOWED_ORIGIN', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 1 });
    first.mockResolvedValueOnce({ request_count: 1 });
    vi.mocked(validateApiKey).mockResolvedValueOnce({ valid: true, apiKeyHash: 'hash-app' });
    const env = createMockEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(createBrowserGetRequest('/beers?sid=13879'), env, ctx);

    expect('ALLOWED_ORIGIN' in env).toBe(false);
    expect(response.status).toBe(200);
  });

  it('sends none on a pre-auth 429 and keeps its rate-limit headers', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 31 });
    const env = createLegacyConfiguredEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(createBrowserGetRequest('/beers?sid=13879'), env, ctx);

    expect(response.status).toBe(429);
    expect(accessControlHeaderNames(response.headers)).toEqual([]);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('X-RateLimit-Reset')).not.toBeNull();
    expect(response.headers.get('Retry-After')).not.toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sends none on an unknown-route 404 and keeps its rate-limit and request-ID headers', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 1 });
    first.mockResolvedValueOnce({ request_count: 1 });
    vi.mocked(validateApiKey).mockResolvedValueOnce({ valid: true, apiKeyHash: 'hash-app' });
    const env = createLegacyConfiguredEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(createBrowserGetRequest('/no-such-route'), env, ctx);

    expect(response.status).toBe(404);
    expect(accessControlHeaderNames(response.headers)).toEqual([]);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(response.headers.get('X-RateLimit-Remaining')).not.toBeNull();
    expect(response.headers.get('X-RateLimit-Reset')).not.toBeNull();
    expect(response.headers.get('X-Request-ID')).not.toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sends none on a rate-limiter-degraded 503 and keeps Retry-After', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockRejectedValueOnce(new Error('D1 unavailable'));
    const env = createLegacyConfiguredEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(createBrowserGetRequest('/beers?sid=13879'), env, ctx);

    expect(response.status).toBe(503);
    expect(accessControlHeaderNames(response.headers)).toEqual([]);
    expect(response.headers.get('Retry-After')).toBe('10');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sends none on the catch-block 500', async () => {
    const env = createLegacyConfiguredEnv();
    const ctx = createMockCtx();

    const response = await worker.fetch(createBrowserGetRequest('/beers?sid=13879'), env, ctx);

    expect(response.status).toBe(500);
    expect(accessControlHeaderNames(response.headers)).toEqual([]);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sends none on a keyed /beers 304 and keeps its ETag, cache and rate-limit headers', async () => {
    const { db, first } = createSequencedDbMock();
    first.mockResolvedValueOnce({ request_count: 1 });
    first.mockResolvedValueOnce({ request_count: 1 });
    vi.mocked(validateApiKey).mockResolvedValueOnce({ valid: true, apiKeyHash: 'hash-app' });
    vi.mocked(handleBeerList).mockImplementationOnce(async (_request, _env, _ctx, headers) => {
      const notModified = new Response(null, {
        status: 304,
        headers: { ETag: '"combined-etag"', 'Cache-Control': 'private, max-age=300' },
      });
      for (const [key, value] of Object.entries(headers)) {
        notModified.headers.set(key, value);
      }
      return { response: notModified, beersReturned: 0, upstreamLatencyMs: 0, cacheOutcome: 'conditional' };
    });
    const env = createLegacyConfiguredEnv({ db });
    const ctx = createMockCtx();

    const response = await worker.fetch(createBrowserGetRequest('/beers?sid=13879'), env, ctx);

    expect(response.status).toBe(304);
    expect(accessControlHeaderNames(response.headers)).toEqual([]);
    expect(response.headers.get('ETag')).toBe('"combined-etag"');
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(response.headers.get('X-Request-ID')).not.toBeNull();
    expect(response.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(response.headers.get('X-RateLimit-Remaining')).not.toBeNull();
    expect(response.headers.get('X-RateLimit-Reset')).not.toBeNull();
  });
});

// ============================================================================
// Tests: OPTIONS is refused outside the try/catch, without D1 or auth
// ============================================================================

function createOptionsRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.ufobeer.app${path}`, { method: 'OPTIONS', headers });
}

const FULL_PREFLIGHT_HEADERS = {
  'Origin': FORMER_ALLOWED_ORIGIN,
  'Access-Control-Request-Method': 'GET',
  'Access-Control-Request-Headers': 'x-api-key',
};

describe('fetch handler OPTIONS refusal', () => {
  it.each([
    ['a full preflight from the former origin', createOptionsRequest('/beers', FULL_PREFLIGHT_HEADERS)],
    ['a preflight with no Origin', createOptionsRequest('/beers', { 'Access-Control-Request-Method': 'GET' })],
    ['a bare OPTIONS', createOptionsRequest('/beers')],
    ['OPTIONS on an unknown path', createOptionsRequest('/no-such-route', FULL_PREFLIGHT_HEADERS)],
    ['OPTIONS /admin/dlq', createOptionsRequest('/admin/dlq', FULL_PREFLIGHT_HEADERS)],
  ])('refuses %s with a bodiless, uncacheable 403 and no CORS headers', async (_name, request) => {
    const env = createLegacyConfiguredEnv();
    const ctx = createMockCtx();

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(403);
    expect(accessControlHeaderNames(response.headers)).toEqual([]);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await response.text()).toBe('');
  });

  it('answers without touching D1, auth or the audit log, and still tracks the request', async () => {
    const prepare = vi.fn(() => { throw new Error('D1 must not be called'); });
    const batch = vi.fn(() => { throw new Error('D1 must not be called'); });
    const env = createLegacyConfiguredEnv({ db: { prepare, batch } as unknown as D1Database });
    const ctx = createMockCtx();

    const response = await worker.fetch(createOptionsRequest('/beers', FULL_PREFLIGHT_HEADERS), env, ctx);

    expect(response.status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(authorizeAdmin).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(trackRequest).toHaveBeenCalledWith(undefined, expect.objectContaining({
      endpoint: '/beers',
      method: 'OPTIONS',
      statusCode: 403,
    }));
  });

  it('creates no D1 audit row for high-volume OPTIONS traffic', async () => {
    const env = createLegacyConfiguredEnv();
    const ctx = createMockCtx();

    for (let i = 0; i < 25; i++) {
      await worker.fetch(createOptionsRequest('/beers', { 'Origin': 'https://evil.com' }), env, ctx);
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
