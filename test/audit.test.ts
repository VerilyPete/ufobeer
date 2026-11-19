/**
 * Unit tests for audit logging functions.
 *
 * @module test/audit.test
 */

import { describe, it, expect, vi } from 'vitest';
import { writeAuditLog, writeAdminAuditLog, reapOldAuditLog } from '../src/audit';
import type { RequestContext } from '../src/types';

// ============================================================================
// Factory Functions
// ============================================================================

const getMockDb = () => {
  const mockRun = vi.fn().mockResolvedValue(undefined);
  const mockBind = vi.fn().mockReturnValue({ run: mockRun });
  const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
  return {
    prepare: mockPrepare,
    _bind: mockBind,
    _run: mockRun,
  };
};

const getMockCtx = (overrides?: Partial<RequestContext>): RequestContext => ({
  requestId: 'req-audit-test',
  startTime: Date.now() - 100,
  clientIdentifier: 'test-client',
  apiKeyHash: 'abc123',
  clientIp: '1.2.3.4',
  userAgent: 'TestAgent/1.0',
  ...overrides,
});

// ============================================================================
// writeAuditLog Tests
// ============================================================================

describe('writeAuditLog', () => {

  it('does not throw when db.prepare().bind().run() rejects', async () => {
    const db = getMockDb();
    db._run.mockRejectedValue(new Error('D1 write failed'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 200)).resolves.toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('never issues a second (cleanup) prepare call regardless of Math.random — row-growth cleanup moved to the cron reaper', async () => {
    const db = getMockDb();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // would have tripped the old 0.1% probabilistic cleanup
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 200);
    expect(db.prepare).toHaveBeenCalledTimes(1);
    randomSpy.mockRestore();
  });
});

// ============================================================================
// reapOldAuditLog Tests
// ============================================================================

describe('reapOldAuditLog', () => {

  it('propagates a rejection when the delete fails (no swallow — the cron handler decides how to handle it)', async () => {
    const run = vi.fn().mockRejectedValue(new Error('D1 unavailable'));
    const bind = vi.fn().mockReturnValue({ run });
    const db = { prepare: vi.fn().mockReturnValue({ bind }) };

    await expect(reapOldAuditLog(db as unknown as D1Database)).rejects.toThrow('D1 unavailable');
  });

  it('runs successfully even when a prior writeAuditLog insert on the same db failed — no shared try/catch anymore', async () => {
    const insertRun = vi.fn().mockRejectedValue(new Error('insert failed'));
    const insertBind = vi.fn().mockReturnValue({ run: insertRun });

    const deleteRun = vi.fn().mockResolvedValue({ meta: { changes: 3 } });
    const deleteBind = vi.fn().mockReturnValue({ run: deleteRun });

    const prepare = vi.fn()
      .mockReturnValueOnce({ bind: insertBind })
      .mockReturnValueOnce({ bind: deleteBind });
    const db = { prepare };

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The insert fails internally (writeAuditLog swallows it), but the
    // separate reaper call on the same db still succeeds — they no longer
    // share a try/catch.
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 200);
    const deleted = await reapOldAuditLog(db as unknown as D1Database);

    expect(deleted).toBe(3);
    consoleSpy.mockRestore();
  });
});

// ============================================================================
// writeAdminAuditLog Tests
// ============================================================================

describe('writeAdminAuditLog', () => {

  it('does not throw when db.prepare().bind().run() rejects', async () => {
    const db = getMockDb();
    db._run.mockRejectedValue(new Error('D1 write failed'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      writeAdminAuditLog(
        db as unknown as D1Database,
        getMockCtx(),
        'dlq_replay',
        {},
        'admin-hash',
      ),
    ).resolves.toBeUndefined();
    consoleSpy.mockRestore();
  });

  describe('with structured outcome options', () => {
    it('defaults to status 200 when options are omitted (legacy call sites)', async () => {
      const db = getMockDb();
      await writeAdminAuditLog(db as unknown as D1Database, getMockCtx(), 'dlq_replay', {}, 'admin-hash');
      const boundArgs = db._bind.mock.calls[0] as unknown[];
      expect(boundArgs[7]).toBe(200);
    });

    it('persists the caller-supplied statusCode instead of the hardcoded 200', async () => {
      const db = getMockDb();
      await writeAdminAuditLog(
        db as unknown as D1Database, getMockCtx(), 'dlq_replay', {}, 'admin-hash',
        { statusCode: 500, outcome: 'failed' },
      );
      const boundArgs = db._bind.mock.calls[0] as unknown[];
      expect(boundArgs[7]).toBe(500);
    });

    it('merges outcome into the persisted details JSON', async () => {
      const db = getMockDb();
      await writeAdminAuditLog(
        db as unknown as D1Database, getMockCtx(), 'dlq_replay', { replayed_count: 2 }, 'admin-hash',
        { statusCode: 200, outcome: 'partial', succeededCount: 2, failedCount: 1 },
      );
      const boundArgs = db._bind.mock.calls[0] as unknown[];
      const details = JSON.parse(boundArgs[9] as string) as Record<string, unknown>;
      expect(details['outcome']).toBe('partial');
      expect(details['succeeded_count']).toBe(2);
      expect(details['failed_count']).toBe(1);
    });

    it('records a denied attempt distinctly from a successful one', async () => {
      const db = getMockDb();
      await writeAdminAuditLog(
        db as unknown as D1Database, getMockCtx(), 'admin_denied', {}, 'admin-hash',
        { statusCode: 403, outcome: 'denied', failureReason: 'Invalid admin credentials' },
      );
      const boundArgs = db._bind.mock.calls[0] as unknown[];
      expect(boundArgs[7]).toBe(403);
      const details = JSON.parse(boundArgs[9] as string) as Record<string, unknown>;
      expect(details['outcome']).toBe('denied');
      expect(details['failure_reason']).toBe('Invalid admin credentials');
    });

    it('records a dry-run operation as attempted rather than successful', async () => {
      const db = getMockDb();
      await writeAdminAuditLog(
        db as unknown as D1Database, getMockCtx(), 'cleanup_trigger', {}, 'admin-hash',
        { statusCode: 200, outcome: 'attempted' },
      );
      const boundArgs = db._bind.mock.calls[0] as unknown[];
      const details = JSON.parse(boundArgs[9] as string) as Record<string, unknown>;
      expect(details['outcome']).toBe('attempted');
    });

    it('bounds targetIds to ADMIN_AUDIT_MAX_TARGET_IDS and flags truncation', async () => {
      const db = getMockDb();
      const manyIds = Array.from({ length: 150 }, (_, i) => i);
      await writeAdminAuditLog(
        db as unknown as D1Database, getMockCtx(), 'dlq_replay', {}, 'admin-hash',
        { targetIds: manyIds },
      );
      const boundArgs = db._bind.mock.calls[0] as unknown[];
      const details = JSON.parse(boundArgs[9] as string) as { target_ids: number[]; target_ids_truncated: boolean };
      expect(details.target_ids.length).toBe(100);
      expect(details.target_ids_truncated).toBe(true);
    });

    it('does not set target_ids_truncated when targetIds fits within the bound', async () => {
      const db = getMockDb();
      await writeAdminAuditLog(
        db as unknown as D1Database, getMockCtx(), 'dlq_acknowledge', {}, 'admin-hash',
        { targetIds: [1, 2, 3] },
      );
      const boundArgs = db._bind.mock.calls[0] as unknown[];
      const details = JSON.parse(boundArgs[9] as string) as Record<string, unknown>;
      expect(details['target_ids']).toEqual([1, 2, 3]);
      expect(details['target_ids_truncated']).toBeUndefined();
    });
  });
});
