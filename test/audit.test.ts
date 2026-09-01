/**
 * Unit tests for audit logging functions.
 *
 * @module test/audit.test
 */

import { describe, it, expect, vi } from 'vitest';
import { writeAuditLog, writeAdminAuditLog, reapOldAuditLog } from '../src/audit';
import type { RequestContext } from '../src/types';
import { AUDIT_RETENTION_DAYS, AUDIT_REAP_LIMIT } from '../src/constants';

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
  it('records the request in the audit log', async () => {
    const db = getMockDb();
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 200);
    expect(db._run).toHaveBeenCalledTimes(1);
  });

  it('passes ctx.requestId in the bound values', async () => {
    const db = getMockDb();
    const ctx = getMockCtx({ requestId: 'req-unique-id' });
    await writeAuditLog(db as unknown as D1Database, ctx, 'GET', '/beers', 200);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[0]).toBe('req-unique-id');
  });

  it('passes ctx.startTime in the bound values', async () => {
    const db = getMockDb();
    const ctx = getMockCtx({ startTime: 1700000000000 });
    await writeAuditLog(db as unknown as D1Database, ctx, 'GET', '/beers', 200);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[1]).toBe(1700000000000);
  });

  it('passes the provided method in the bound values', async () => {
    const db = getMockDb();
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'POST', '/beers/sync', 200);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[2]).toBe('POST');
  });

  it('passes the provided path in the bound values', async () => {
    const db = getMockDb();
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/health', 200);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[3]).toBe('/health');
  });

  it('passes the provided statusCode in the bound values', async () => {
    const db = getMockDb();
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 404);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[7]).toBe(404);
  });

  it('passes null for error when no error is provided', async () => {
    const db = getMockDb();
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 200);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[9]).toBeNull();
  });

  it('passes the error string when provided', async () => {
    const db = getMockDb();
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 500, 'Something broke');
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[9]).toBe('Something broke');
  });

  it('passes a non-negative responseTimeMs in the bound values', async () => {
    const db = getMockDb();
    const ctx = getMockCtx({ startTime: Date.now() - 50 });
    await writeAuditLog(db as unknown as D1Database, ctx, 'GET', '/beers', 200);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    const responseTimeMs = boundArgs[8] as number;
    expect(responseTimeMs).toBeGreaterThanOrEqual(0);
  });

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
  it('deletes rows older than AUDIT_RETENTION_DAYS, bounded by AUDIT_REAP_LIMIT', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 42 } });
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare };

    const now = new Date('2026-09-01T00:00:00.000Z').getTime();
    const deleted = await reapOldAuditLog(db as unknown as D1Database, now);

    expect(deleted).toBe(42);
    const sql = prepare.mock.calls[0]![0] as string;
    expect(sql).toContain('DELETE FROM audit_log');
    expect(sql).toContain('LIMIT');
    const [cutoffTime, limit] = bind.mock.calls[0] as [number, number];
    expect(cutoffTime).toBe(now - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(limit).toBe(AUDIT_REAP_LIMIT);
  });

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
  it('records the admin operation in the audit log', async () => {
    const db = getMockDb();
    await writeAdminAuditLog(
      db as unknown as D1Database,
      getMockCtx(),
      'dlq_replay',
      { ids: [1, 2, 3] },
      'admin-hash-xyz',
    );
    expect(db._run).toHaveBeenCalledTimes(1);
  });

  it('passes "ADMIN" as the method value', async () => {
    const db = getMockDb();
    await writeAdminAuditLog(
      db as unknown as D1Database,
      getMockCtx(),
      'enrich_trigger',
      {},
      'admin-hash',
    );
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[2]).toBe('ADMIN');
  });

  it('passes the operation string as the path value', async () => {
    const db = getMockDb();
    await writeAdminAuditLog(
      db as unknown as D1Database,
      getMockCtx(),
      'dlq_acknowledge',
      {},
      'admin-hash',
    );
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[3]).toBe('dlq_acknowledge');
  });

  it('passes the adminSecretHash as the api_key_hash value', async () => {
    const db = getMockDb();
    await writeAdminAuditLog(
      db as unknown as D1Database,
      getMockCtx(),
      'dlq_replay',
      {},
      'admin-secret-hash-value',
    );
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[4]).toBe('admin-secret-hash-value');
  });

  it('passes JSON.stringify(details) as the error slot', async () => {
    const db = getMockDb();
    const details = { ids: [1, 2], action: 'replay' };
    await writeAdminAuditLog(
      db as unknown as D1Database,
      getMockCtx(),
      'dlq_replay',
      details,
      'admin-hash',
    );
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[9]).toBe(JSON.stringify(details));
  });

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
