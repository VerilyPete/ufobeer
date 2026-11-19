/**
 * Unit tests for handleCleanupTrigger function.
 *
 * Tests cover:
 * - Request validation (mode, confirm, body)
 * - Mode: all confirmation gate
 * - Cooldown enforcement
 * - Dry run mode
 *
 * Row selection, the 500-beer clamp, hashes and marks run against real D1 in
 * cleanupTrigger.integration.test.ts.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { handleCleanupTrigger } from '../../src/handlers/cleanupTrigger';
import type { Env, RequestContext } from '../../src/types';

// Mock the queue module
vi.mock('../../src/queue', () => ({
  queueBeersForCleanup: vi.fn().mockResolvedValue({ queued: 1, queuedIds: ['beer-1'] }),
}));

import { queueBeersForCleanup } from '../../src/queue';

// ============================================================================
// Test Helpers
// ============================================================================

interface MockBeer {
  id: string;
  brew_name: string;
  brewer: string | null;
  brew_description_original: string;
  brew_description_cleaned: string | null;
  queued_for_cleanup_at?: number | null;
}

function createMockEnv(options: {
  beers?: MockBeer[];
  lastCooldownRun?: number | null;
}): Env {
  const beers = options.beers || [];
  const lastCooldownRun = options.lastCooldownRun ?? null;

  const mockPrepare = vi.fn().mockImplementation((sql: string) => {
    // Cooldown check (SELECT from system_state)
    if (sql.includes('system_state') && sql.includes('SELECT')) {
      return {
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(
            lastCooldownRun ? { last_run: lastCooldownRun } : null
          ),
        }),
      };
    }

    // Cooldown update (INSERT INTO system_state)
    if (sql.includes('system_state') && sql.includes('INSERT')) {
      return {
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      };
    }

    // Beer count query (COUNT(*))
    if (sql.includes('COUNT(*)')) {
      let filtered = beers;
      // Filter for mode: 'missing' (brew_description_cleaned IS NULL)
      if (sql.includes('brew_description_cleaned IS NULL')) {
        filtered = filtered.filter(b => !b.brew_description_cleaned);
      }
      // Filter out already queued beers (queued_for_cleanup_at IS NULL)
      if (sql.includes('queued_for_cleanup_at IS NULL')) {
        filtered = filtered.filter(b => b.queued_for_cleanup_at == null);
      }
      const first = vi.fn().mockResolvedValue({ count: filtered.length });
      return { first, bind: vi.fn().mockReturnValue({ first }) };
    }

    // Beer select query
    if (sql.includes('SELECT id, brew_name')) {
      let filtered = beers;
      // Filter for mode: 'missing' (brew_description_cleaned IS NULL)
      if (sql.includes('brew_description_cleaned IS NULL')) {
        filtered = filtered.filter(b => !b.brew_description_cleaned);
      }
      // Filter out already queued beers (queued_for_cleanup_at IS NULL)
      if (sql.includes('queued_for_cleanup_at IS NULL')) {
        filtered = filtered.filter(b => b.queued_for_cleanup_at == null);
      }
      return {
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: filtered }),
        }),
      };
    }

    // Update statements (UPDATE enriched_beers)
    if (sql.includes('UPDATE enriched_beers')) {
      return {
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      };
    }

    // Default
    return {
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    };
  });

  return {
    DB: {
      prepare: mockPrepare,
      batch: vi.fn().mockImplementation((statements: readonly unknown[]) =>
        Promise.resolve(statements.map(() => ({ meta: { changes: 1 } })))),
    } as unknown as D1Database,
    CLEANUP_QUEUE: {
      sendBatch: vi.fn().mockResolvedValue({ successful: true }),
    } as unknown as Queue,
  } as unknown as Env;
}

function createMockRequest(body: object): Request {
  return new Request('https://api.example.com/admin/cleanup/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createMockContext(): RequestContext {
  return {
    requestId: 'test-request-id',
    startTime: Date.now(),
    clientIdentifier: 'test-client',
    apiKeyHash: 'test-hash',
    clientIp: '127.0.0.1',
    userAgent: 'test-agent',
  };
}

const headers = { 'Content-Type': 'application/json' };

// ============================================================================
// Tests
// ============================================================================

/**
 * Resets module-level mocks to default implementations.
 */
function resetMocks() {
  vi.clearAllMocks();
  vi.mocked(queueBeersForCleanup).mockResolvedValue({ queued: 1, queuedIds: ['beer-1'] });
}

describe('handleCleanupTrigger', () => {
  beforeEach(() => {
    resetMocks();
  });

  // --------------------------------------------------------------------------
  // Validation Tests
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('returns INVALID_MODE when mode is missing', async () => {
      const env = createMockEnv({});
      const request = createMockRequest({});
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { success: boolean; error: { code: string } };

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_MODE');
    });

    it('returns INVALID_MODE when mode is invalid', async () => {
      const env = createMockEnv({});
      const request = createMockRequest({ mode: 'invalid' });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { success: boolean; error: { code: string } };

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('INVALID_MODE');
    });

  });

  // --------------------------------------------------------------------------
  // Mode: all Tests
  // --------------------------------------------------------------------------

  describe('mode: all', () => {
    it('returns CONFIRMATION_REQUIRED without confirm: true', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: 'Cleaned' },
        ],
      });
      const request = createMockRequest({ mode: 'all' });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { error: { code: string }; preview: object };

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('CONFIRMATION_REQUIRED');
      expect(body.preview).toBeDefined();
    });

    it('allows mode: all with dry_run without confirm', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: 'Cleaned' },
          { id: '2', brew_name: 'Beer 2', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: 'Cleaned' },
        ],
      });
      const request = createMockRequest({ mode: 'all', dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { success: boolean; data: { beers_queued: number; beers_reset: number; dry_run: boolean } };

      // Should return 200 with dry run results, not CONFIRMATION_REQUIRED
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.dry_run).toBe(true);
      expect(body.data.beers_queued).toBe(2);
      expect(body.data.beers_reset).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Cooldown Tests
  // --------------------------------------------------------------------------

  describe('cooldown', () => {
    it('blocks requests within 5-minute window', async () => {
      const recentRun = Date.now() - (2 * 60 * 1000); // 2 minutes ago
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
        lastCooldownRun: recentRun,
      });
      const request = createMockRequest({ mode: 'missing' });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { error: { code: string } };

      expect(response.status).toBe(429);
      expect(body.error.code).toBe('OPERATION_IN_PROGRESS');
    });

    it('allows requests after cooldown expires', async () => {
      const oldRun = Date.now() - (10 * 60 * 1000); // 10 minutes ago
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
        lastCooldownRun: oldRun,
      });
      const request = createMockRequest({ mode: 'missing' });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { success: boolean };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('succeeds on first run (no cooldown entry)', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
        lastCooldownRun: null,
      });
      const request = createMockRequest({ mode: 'missing' });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { success: boolean };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('skips cooldown check for dry_run', async () => {
      const recentRun = Date.now() - (1 * 60 * 1000); // 1 minute ago
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
        lastCooldownRun: recentRun,
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { success: boolean };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Dry Run Tests
  // --------------------------------------------------------------------------

  describe('dry run', () => {
    it('does not call queue sendBatch', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      await handleCleanupTrigger(request, env, headers, ctx);

      expect(queueBeersForCleanup).not.toHaveBeenCalled();
    });

    it('does not call DB batch for updates', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      await handleCleanupTrigger(request, env, headers, ctx);

      expect(env.DB.batch).not.toHaveBeenCalled();
    });

    it('returns accurate counts', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
          { id: '2', brew_name: 'Beer 2', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { data: { beers_queued: number; dry_run: boolean } };

      expect(body.data.dry_run).toBe(true);
      expect(body.data.beers_queued).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Invalid Request Body Tests
  // --------------------------------------------------------------------------

  describe('Invalid request body', () => {
    it('returns INVALID_JSON when body is not valid JSON', async () => {
      const env = createMockEnv({});
      const request = new Request('https://example.com/admin/cleanup/trigger', {
        method: 'POST',
        body: 'not valid json',
        headers: { 'Content-Type': 'application/json' },
      });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const json = await response.json() as { success: boolean; error: { code: string; message: string } };

      // Shared bounded-body-reader contract (src/utils/body.ts): malformed
      // JSON is a 400 with code INVALID_JSON, consistent across every
      // body-bearing route rather than this route's own bespoke code.
      expect(response.status).toBe(400);
      expect(json.error.code).toBe('INVALID_JSON');
      expect(json.error.message).toBe('Request body is not valid JSON');
    });

    it('returns INVALID_MODE when body is empty object', async () => {
      const env = createMockEnv({});
      const request = createMockRequest({});
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const json = await response.json() as { success: boolean; error: { code: string; message: string } };

      expect(response.status).toBe(400);
      expect(json.error.code).toBe('INVALID_MODE');
      expect(json.error.message).toBe('mode is required and must be "all" or "missing"');
    });

    it('returns INVALID_BODY when body is a string instead of object', async () => {
      const env = createMockEnv({});
      const request = new Request('https://example.com/admin/cleanup/trigger', {
        method: 'POST',
        body: JSON.stringify('string'),
        headers: { 'Content-Type': 'application/json' },
      });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const json = await response.json() as { success: boolean; error: { code: string; message: string } };

      expect(response.status).toBe(400);
      expect(json.error.code).toBe('INVALID_BODY');
      expect(json.error.message).toBe('Request body must be a JSON object');
    });

    it('returns INVALID_BODY when body is null', async () => {
      const env = createMockEnv({});
      const request = new Request('https://example.com/admin/cleanup/trigger', {
        method: 'POST',
        body: JSON.stringify(null),
        headers: { 'Content-Type': 'application/json' },
      });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const json = await response.json() as { success: boolean; error: { code: string; message: string } };

      expect(response.status).toBe(400);
      expect(json.error.code).toBe('INVALID_BODY');
      expect(json.error.message).toBe('Request body must be a JSON object');
    });
  });

  // --------------------------------------------------------------------------
  // Bounded body guard
  // --------------------------------------------------------------------------

  describe('bounded body guard', () => {
    it('returns 415 when Content-Type is not application/json', async () => {
      const env = createMockEnv({});
      const request = new Request('https://example.com/admin/cleanup/trigger', {
        method: 'POST',
        body: JSON.stringify({ mode: 'missing' }),
        headers: { 'Content-Type': 'text/plain' },
      });

      const response = await handleCleanupTrigger(request, env, headers, createMockContext());
      const json = await response.json() as { error: { code: string } };

      expect(response.status).toBe(415);
      expect(json.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('returns 413 when the body exceeds SMALL_JSON_BODY_MAX_BYTES', async () => {
      const env = createMockEnv({});
      const oversized = JSON.stringify({ mode: 'missing', note: 'x'.repeat(100_000) });
      const request = new Request('https://example.com/admin/cleanup/trigger', {
        method: 'POST',
        body: oversized,
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await handleCleanupTrigger(request, env, headers, createMockContext());
      const json = await response.json() as { error: { code: string } };

      expect(response.status).toBe(413);
      expect(json.error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });
});
