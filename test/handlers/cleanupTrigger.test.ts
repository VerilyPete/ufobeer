/**
 * Unit tests for handleCleanupTrigger function.
 *
 * Tests cover:
 * - Request validation (mode, limit, confirm)
 * - Mode: missing behavior
 * - Mode: all behavior with confirmation
 * - Cooldown enforcement
 * - Dry run mode
 * - Quota reporting
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleCleanupTrigger } from '../../src/handlers/cleanupTrigger';
import type { Env, RequestContext } from '../../src/types';

// Mock the queue module
vi.mock('../../src/queue', () => ({
  queueBeersForCleanup: vi.fn().mockResolvedValue({ queued: 1, skipped: 0 }),
}));

// Mock the config module
vi.mock('../../src/config', () => ({
  shouldSkipEnrichment: vi.fn().mockImplementation((name: string) => {
    // Simulate blocklist filtering for 'Flight' in name
    return name.toLowerCase().includes('flight');
  }),
}));

import { queueBeersForCleanup } from '../../src/queue';
import { shouldSkipEnrichment } from '../../src/config';

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
  dailyUsed?: number;
  lastCooldownRun?: number | null;
}): Env {
  const beers = options.beers || [];
  const dailyUsed = options.dailyUsed || 0;
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

    // Quota check (SELECT from cleanup_limits)
    if (sql.includes('cleanup_limits')) {
      return {
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ request_count: dailyUsed }),
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
      return {
        first: vi.fn().mockResolvedValue({ count: filtered.length }),
      };
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
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database,
    CLEANUP_QUEUE: {
      sendBatch: vi.fn().mockResolvedValue({ successful: true }),
    } as unknown as Queue,
    DAILY_CLEANUP_LIMIT: '1000',
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

describe('handleCleanupTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations to defaults
    vi.mocked(queueBeersForCleanup).mockResolvedValue({ queued: 1, skipped: 0 });
    vi.mocked(shouldSkipEnrichment).mockImplementation((name: string) => {
      return name.toLowerCase().includes('flight');
    });
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

    it('clamps limit to valid range (1-500)', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
      });
      const request = createMockRequest({ mode: 'missing', limit: 1000, dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      expect(response.status).toBe(200);
      // Limit should be clamped to 500
    });
  });

  // --------------------------------------------------------------------------
  // Mode: missing Tests
  // --------------------------------------------------------------------------

  describe('mode: missing', () => {
    it('selects only beers with NULL brew_description_cleaned', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc 1', brew_description_cleaned: null },
          { id: '2', brew_name: 'Beer 2', brewer: 'Brewer', brew_description_original: 'Desc 2', brew_description_cleaned: 'Cleaned' },
        ],
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { data: { beers_queued: number } };

      expect(response.status).toBe(200);
      expect(body.data.beers_queued).toBe(1);
    });

    it('does not include beers_reset in response', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { data: { beers_reset?: number } };

      expect(response.status).toBe(200);
      expect(body.data.beers_reset).toBeUndefined();
    });

    it('returns no_eligible_beers when all have cleaned descriptions', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: 'Cleaned' },
        ],
      });
      const request = createMockRequest({ mode: 'missing' });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { data: { skip_reason: string } };

      expect(response.status).toBe(200);
      expect(body.data.skip_reason).toBe('no_eligible_beers');
    });

    it('does not return beers with queued_for_cleanup_at already set', async () => {
      const env = createMockEnv({
        beers: [
          // Beer 1: eligible - no cleaned description and not yet queued
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc 1', brew_description_cleaned: null, queued_for_cleanup_at: null },
          // Beer 2: already queued - should be excluded
          { id: '2', brew_name: 'Beer 2', brewer: 'Brewer', brew_description_original: 'Desc 2', brew_description_cleaned: null, queued_for_cleanup_at: Date.now() - 60000 },
          // Beer 3: eligible - no cleaned description and not yet queued
          { id: '3', brew_name: 'Beer 3', brewer: 'Brewer', brew_description_original: 'Desc 3', brew_description_cleaned: null, queued_for_cleanup_at: undefined },
        ],
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { data: { beers_queued: number } };

      expect(response.status).toBe(200);
      // Only Beer 1 and Beer 3 should be eligible (Beer 2 is already queued)
      expect(body.data.beers_queued).toBe(2);
    });

    it('returns no_eligible_beers when all missing beers are already queued', async () => {
      const env = createMockEnv({
        beers: [
          // All beers missing cleaned description but already queued
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc 1', brew_description_cleaned: null, queued_for_cleanup_at: Date.now() - 60000 },
          { id: '2', brew_name: 'Beer 2', brewer: 'Brewer', brew_description_original: 'Desc 2', brew_description_cleaned: null, queued_for_cleanup_at: Date.now() - 30000 },
        ],
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { data: { beers_queued: number; skip_reason?: string } };

      expect(response.status).toBe(200);
      expect(body.data.beers_queued).toBe(0);
      expect(body.data.skip_reason).toBe('no_eligible_beers');
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

    it('includes preview counts in CONFIRMATION_REQUIRED response', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: 'Cleaned' },
        ],
      });
      const request = createMockRequest({ mode: 'all' });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { preview: { beers_would_reset: number } };

      expect(body.preview.beers_would_reset).toBeDefined();
    });

    it('succeeds with confirm: true', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: 'Cleaned' },
        ],
      });
      const request = createMockRequest({ mode: 'all', confirm: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { success: boolean };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('includes beers_reset in response', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: 'Cleaned' },
        ],
      });
      const request = createMockRequest({ mode: 'all', confirm: true, dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { data: { beers_reset: number } };

      expect(response.status).toBe(200);
      expect(body.data.beers_reset).toBe(1);
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
  // Quota Tests
  // --------------------------------------------------------------------------

  describe('quota', () => {
    it('includes projected_after in response', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
        dailyUsed: 100,
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { data: { quota: { daily: { projected_after: number } } } };

      expect(body.data.quota.daily.projected_after).toBe(101); // 100 + 1 beer
    });

    it('shows current usage correctly', async () => {
      const env = createMockEnv({
        beers: [],
        dailyUsed: 500,
      });
      const request = createMockRequest({ mode: 'missing' });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { data: { quota: { daily: { used: number; remaining: number } } } };

      expect(body.data.quota.daily.used).toBe(500);
      expect(body.data.quota.daily.remaining).toBe(500); // 1000 - 500
    });

    it('returns QUOTA_EXCEEDED when operation would exceed daily limit', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
          { id: '2', brew_name: 'Beer 2', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
          { id: '3', brew_name: 'Beer 3', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
        dailyUsed: 999, // 999 used, 3 beers requested = 1002 > 1000 limit
      });
      const request = createMockRequest({ mode: 'missing' });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as {
        success: boolean;
        error: { code: string; message: string };
        quota: { daily: { used: number; limit: number; remaining: number; requested: number } };
      };

      expect(response.status).toBe(429);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('QUOTA_EXCEEDED');
      expect(body.error.message).toContain('Operation would exceed daily quota');
      expect(body.quota.daily.used).toBe(999);
      expect(body.quota.daily.limit).toBe(1000);
      expect(body.quota.daily.remaining).toBe(1);
      expect(body.quota.daily.requested).toBe(3);
    });

    it('allows operation when exactly at limit', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
        dailyUsed: 999, // 999 used, 1 beer requested = 1000 = limit (allowed)
      });
      const request = createMockRequest({ mode: 'missing' });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { success: boolean };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('dry_run bypasses quota enforcement and shows preview', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
          { id: '2', brew_name: 'Beer 2', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
          { id: '3', brew_name: 'Beer 3', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
        dailyUsed: 999, // Would exceed limit, but dry_run should still work
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as {
        success: boolean;
        data: {
          beers_queued: number;
          dry_run: boolean;
          quota: { daily: { projected_after: number } };
        };
      };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.dry_run).toBe(true);
      expect(body.data.beers_queued).toBe(3);
      expect(body.data.quota.daily.projected_after).toBe(1002); // 999 + 3 = 1002 (over limit but shown in preview)
    });

    it('blocks when quota already exceeded before operation', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
        dailyUsed: 1000, // Already at limit
      });
      const request = createMockRequest({ mode: 'missing' });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { success: boolean; error: { code: string } };

      expect(response.status).toBe(429);
      expect(body.error.code).toBe('QUOTA_EXCEEDED');
    });
  });

  // --------------------------------------------------------------------------
  // Blocklist Tests
  // --------------------------------------------------------------------------

  describe('blocklist filtering', () => {
    it('skips blocklisted beers (flights)', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Regular Beer', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
          { id: '2', brew_name: 'Flight Paddle', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { data: { beers_queued: number; beers_skipped: number } };

      // 'Flight Paddle' contains 'flight' so it should be skipped
      expect(body.data.beers_queued).toBe(1);
      expect(body.data.beers_skipped).toBe(1);
    });

    it('returns no_eligible_beers when all beers are blocklisted', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Texas Flight', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
          { id: '2', brew_name: 'Flight Sampler', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { data: { beers_queued: number; beers_skipped: number; skip_reason?: string } };

      expect(body.data.beers_queued).toBe(0);
      expect(body.data.beers_skipped).toBe(2);
      expect(body.data.skip_reason).toBe('no_eligible_beers');
    });
  });

  // --------------------------------------------------------------------------
  // Operation ID Tests
  // --------------------------------------------------------------------------

  describe('operation tracking', () => {
    it('includes operation_id in response', async () => {
      const env = createMockEnv({
        beers: [
          { id: '1', brew_name: 'Beer 1', brewer: 'Brewer', brew_description_original: 'Desc', brew_description_cleaned: null },
        ],
      });
      const request = createMockRequest({ mode: 'missing', dry_run: true });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { data: { operation_id: string } };

      expect(body.data.operation_id).toMatch(/^cleanup-trigger-\d+$/);
    });
  });

  // --------------------------------------------------------------------------
  // Empty Results Tests
  // --------------------------------------------------------------------------

  describe('empty results handling', () => {
    it('handles empty database gracefully', async () => {
      const env = createMockEnv({
        beers: [],
      });
      const request = createMockRequest({ mode: 'missing' });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const body = await response.json() as { success: boolean; data: { beers_queued: number; skip_reason?: string } };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.beers_queued).toBe(0);
      expect(body.data.skip_reason).toBe('no_eligible_beers');
    });
  });

  // --------------------------------------------------------------------------
  // Invalid Request Body Tests
  // --------------------------------------------------------------------------

  describe('Invalid request body', () => {
    it('returns INVALID_PARAMS when body is not valid JSON', async () => {
      const env = createMockEnv({});
      const request = new Request('https://example.com/admin/cleanup/trigger', {
        method: 'POST',
        body: 'not valid json',
        headers: { 'Content-Type': 'application/json' },
      });
      const ctx = createMockContext();

      const response = await handleCleanupTrigger(request, env, headers, ctx);
      const json = await response.json() as { success: boolean; error: { code: string; message: string } };

      expect(response.status).toBe(400);
      expect(json.error.code).toBe('INVALID_PARAMS');
      expect(json.error.message).toBe('Invalid JSON body');
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
});
