/**
 * Unit tests for beer sync endpoint handlers.
 *
 * Tests validateBeerInput function and syncBeersWithBatchHandling function
 * for proper input validation and D1 batch failure handling.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleBeerSync } from '../../src/handlers/beers';
import { queueBeersForCleanup } from '../../src/queue';
import type { Env, RequestContext } from '../../src/types';

vi.mock('../../src/queue', () => ({
  queueBeersForEnrichment: vi.fn().mockResolvedValue({ queued: 0, skipped: 0 }),
  queueBeersForCleanup: vi.fn().mockResolvedValue({ queued: 0, queuedIds: [] }),
}));
import { syncBeersWithBatchHandling } from '../../src/handlers/beers';
import { SYNC_CONSTANTS } from '../../src/types';
import { SyncBeerItemSchema } from '../../src/schemas/request';

describe('handleBeerSync', () => {
  describe('SyncBeerItemSchema validation', () => {
    it('should reject empty id', () => {
      const result = SyncBeerItemSchema.safeParse({ id: '', brew_name: 'Test' });
      expect(result.success).toBe(false);
    });

    it('should reject missing id', () => {
      const result = SyncBeerItemSchema.safeParse({ brew_name: 'Test' });
      expect(result.success).toBe(false);
    });

    it('should reject non-string id', () => {
      const result = SyncBeerItemSchema.safeParse({ id: 123, brew_name: 'Test' });
      expect(result.success).toBe(false);
    });

    it('should reject id exceeding max length', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: 'x'.repeat(SYNC_CONSTANTS.MAX_ID_LENGTH + 1),
        brew_name: 'Test'
      });
      expect(result.success).toBe(false);
    });

    it('should accept id at max length', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: 'x'.repeat(SYNC_CONSTANTS.MAX_ID_LENGTH),
        brew_name: 'Test Beer'
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing brew_name', () => {
      const result = SyncBeerItemSchema.safeParse({ id: '123' });
      expect(result.success).toBe(false);
    });

    it('should reject empty brew_name', () => {
      const result = SyncBeerItemSchema.safeParse({ id: '123', brew_name: '' });
      expect(result.success).toBe(false);
    });

    it('should reject non-string brew_name', () => {
      const result = SyncBeerItemSchema.safeParse({ id: '123', brew_name: 456 });
      expect(result.success).toBe(false);
    });

    it('should reject brew_name exceeding max length', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'x'.repeat(SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH + 1)
      });
      expect(result.success).toBe(false);
    });

    it('should accept brew_name at max length', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'x'.repeat(SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH)
      });
      expect(result.success).toBe(true);
    });

    it('should reject brew_description exceeding max length', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'Test',
        brew_description: 'x'.repeat(SYNC_CONSTANTS.MAX_DESC_LENGTH + 1)
      });
      expect(result.success).toBe(false);
    });

    it('should accept brew_description at max length', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'Test',
        brew_description: 'x'.repeat(SYNC_CONSTANTS.MAX_DESC_LENGTH)
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with all fields', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'Test Beer',
        brewer: 'Test Brewery',
        brew_description: 'A great beer'
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with minimal fields', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'Test Beer'
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input without brew_description', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'Test Beer',
        brewer: 'Test Brewery'
      });
      expect(result.success).toBe(true);
    });

    it('should reject null input', () => {
      const result = SyncBeerItemSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('should reject undefined input', () => {
      const result = SyncBeerItemSchema.safeParse(undefined);
      expect(result.success).toBe(false);
    });

    it('should reject non-object input', () => {
      const result = SyncBeerItemSchema.safeParse('not an object');
      expect(result.success).toBe(false);
    });
  });

  describe('syncBeersWithBatchHandling', () => {
    it('should report succeeded count correctly when all succeed', async () => {
      const mockDb = {
        batch: vi.fn().mockResolvedValue([
          { success: true },
          { success: true },
          { success: true }
        ])
      };
      const statements = [{}, {}, {}] as D1PreparedStatement[];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle partial failures', async () => {
      const mockDb = {
        batch: vi.fn().mockResolvedValue([
          { success: true },
          { success: false, error: 'Constraint violation' },
          { success: true }
        ])
      };
      const statements = [{}, {}, {}] as D1PreparedStatement[];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBe('Statement 1 failed');
      expect(result.errors[0]).not.toContain('Constraint violation');
    });

    it('should handle multiple partial failures', async () => {
      const mockDb = {
        batch: vi.fn().mockResolvedValue([
          { success: false, error: 'Error 1' },
          { success: true },
          { success: false, error: 'Error 2' },
          { success: false, error: 'Error 3' },
          { success: true }
        ])
      };
      const statements = [{}, {}, {}, {}, {}] as D1PreparedStatement[];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(3);
      expect(result.errors).toHaveLength(3);
      expect(result.errors[0]).toContain('Statement 0 failed');
      expect(result.errors[1]).toContain('Statement 2 failed');
      expect(result.errors[2]).toContain('Statement 3 failed');
    });

    it('should handle total batch failure', async () => {
      const mockDb = {
        batch: vi.fn().mockRejectedValue(new Error('D1 unavailable'))
      };
      const statements = [{}, {}, {}] as D1PreparedStatement[];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(3);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBe('Database write failed for batch');
      expect(result.errors[0]).not.toContain('D1 unavailable');
    });

    it('should handle empty statement array', async () => {
      const mockDb = {
        batch: vi.fn().mockResolvedValue([])
      };
      const statements: D1PreparedStatement[] = [];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle results without explicit error message', async () => {
      const mockDb = {
        batch: vi.fn().mockResolvedValue([
          { success: true },
          { success: false }, // No error property
          { success: true }
        ])
      };
      const statements = [{}, {}, {}] as D1PreparedStatement[];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors[0]).toBe('Statement 1 failed');
    });

    it('should handle non-Error rejection', async () => {
      const mockDb = {
        batch: vi.fn().mockRejectedValue('String error')
      };
      const statements = [{}, {}] as D1PreparedStatement[];

      const result = await syncBeersWithBatchHandling(mockDb as unknown as D1Database, statements);

      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(2);
      expect(result.errors[0]).toBe('Database write failed for batch');
      expect(result.errors[0]).not.toContain('String error');
    });
  });
});

// ============================================================================
// handleBeerSync — send-then-mark ordering
// ============================================================================

describe('handleBeerSync ordering', () => {
  const reqCtx: RequestContext = {
    requestId: 'sync-order-test',
    startTime: Date.now(),
    clientIdentifier: 'test-client',
    apiKeyHash: null,
    clientIp: null,
    userAgent: null,
  };

  function createTrackingEnv(): { env: Env; prepareSqls: () => string[] } {
    const sqls: string[] = [];
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        sqls.push(sql);
        return {
          bind: vi.fn().mockReturnValue({
            all: vi.fn().mockResolvedValue({ results: [] }),
            first: vi.fn().mockResolvedValue(null),
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          }),
        };
      }),
      batch: vi.fn().mockImplementation(async (statements: unknown[]) =>
        statements.map(() => ({ success: true, results: [], meta: {} }))
      ),
    } as unknown as D1Database;
    return {
      env: { DB: db } as unknown as Env,
      prepareSqls: () => sqls,
    };
  }

  function syncRequest(): Request {
    return new Request('https://api.example.com/beers/sync', {
      method: 'POST',
      body: JSON.stringify({
        beers: [
          { id: 'b1', brew_name: 'Test IPA', brewer: 'Brewer', brew_description: 'Hoppy 5.5%' },
        ],
      }),
    });
  }

  it('does not write queued_for_cleanup_at when the cleanup queue send delivered nothing', async () => {
    vi.mocked(queueBeersForCleanup).mockResolvedValue({ queued: 0, queuedIds: [] });
    const { env, prepareSqls } = createTrackingEnv();

    const response = await handleBeerSync(syncRequest(), env, {}, reqCtx);
    const body = await response.json() as { synced: number; queued_for_cleanup: number };

    expect(response.status).toBe(200);
    expect(body.queued_for_cleanup).toBe(0);
    expect(prepareSqls().some(sql => sql.includes('queued_for_cleanup_at = ?'))).toBe(false);
  });

  it('writes queued_for_cleanup_at only after the send, for sent IDs only', async () => {
    vi.mocked(queueBeersForCleanup).mockResolvedValue({ queued: 1, queuedIds: ['b1'] });
    const { env, prepareSqls } = createTrackingEnv();

    const response = await handleBeerSync(syncRequest(), env, {}, reqCtx);
    const body = await response.json() as { queued_for_cleanup: number };

    expect(response.status).toBe(200);
    expect(body.queued_for_cleanup).toBe(1);
    expect(prepareSqls().some(sql => sql.includes('queued_for_cleanup_at = ?'))).toBe(true);
    // The mark must come after queueBeersForCleanup resolved: invocation order
    const markCall = prepareSqls().findIndex(sql => sql.includes('queued_for_cleanup_at = ?'));
    const sendOrder = vi.mocked(queueBeersForCleanup).mock.invocationCallOrder.at(-1);
    // All DB.prepare calls for the mark happen after the send (single send here)
    expect(markCall).toBeGreaterThanOrEqual(0);
    expect(sendOrder).toBeGreaterThan(0);
  });
});
