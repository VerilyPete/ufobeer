/**
 * Unit tests for audit logging functions.
 *
 * @module test/audit.test
 */

import { describe, it, expect, vi } from 'vitest';
import { writeAuditLog, writeAdminAuditLog } from '../src/audit';
import type { RequestContext } from '../src/types';
import { AUDIT_CLEANUP_PROBABILITY, AUDIT_RETENTION_DAYS } from '../src/constants';

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
  it('calls db.prepare().bind().run() once on a normal request', async () => {
    const db = getMockDb();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 200);
    expect(db._run).toHaveBeenCalledTimes(1);
    randomSpy.mockRestore();
  });

  it('uses SQL containing INSERT INTO audit_log', async () => {
    const db = getMockDb();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 200);
    const sql = db.prepare.mock.calls[0]![0] as string;
    expect(sql).toContain('INSERT INTO audit_log');
    randomSpy.mockRestore();
  });

  it('passes ctx.requestId in the bound values', async () => {
    const db = getMockDb();
    const ctx = getMockCtx({ requestId: 'req-unique-id' });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    await writeAuditLog(db as unknown as D1Database, ctx, 'GET', '/beers', 200);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[0]).toBe('req-unique-id');
    randomSpy.mockRestore();
  });

  it('passes ctx.startTime in the bound values', async () => {
    const db = getMockDb();
    const ctx = getMockCtx({ startTime: 1700000000000 });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    await writeAuditLog(db as unknown as D1Database, ctx, 'GET', '/beers', 200);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[1]).toBe(1700000000000);
    randomSpy.mockRestore();
  });

  it('passes the provided method in the bound values', async () => {
    const db = getMockDb();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'POST', '/beers/sync', 200);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[2]).toBe('POST');
    randomSpy.mockRestore();
  });

  it('passes the provided path in the bound values', async () => {
    const db = getMockDb();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/health', 200);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[3]).toBe('/health');
    randomSpy.mockRestore();
  });

  it('passes the provided statusCode in the bound values', async () => {
    const db = getMockDb();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 404);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[7]).toBe(404);
    randomSpy.mockRestore();
  });

  it('passes null for error when no error is provided', async () => {
    const db = getMockDb();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 200);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[9]).toBeNull();
    randomSpy.mockRestore();
  });

  it('passes the error string when provided', async () => {
    const db = getMockDb();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 500, 'Something broke');
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    expect(boundArgs[9]).toBe('Something broke');
    randomSpy.mockRestore();
  });

  it('passes a non-negative responseTimeMs in the bound values', async () => {
    const db = getMockDb();
    const ctx = getMockCtx({ startTime: Date.now() - 50 });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    await writeAuditLog(db as unknown as D1Database, ctx, 'GET', '/beers', 200);
    const boundArgs = db._bind.mock.calls[0] as unknown[];
    const responseTimeMs = boundArgs[8] as number;
    expect(responseTimeMs).toBeGreaterThanOrEqual(0);
    randomSpy.mockRestore();
  });

  it('does not throw when db.prepare().bind().run() rejects', async () => {
    const db = getMockDb();
    db._run.mockRejectedValue(new Error('D1 write failed'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    await expect(writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 200)).resolves.toBeUndefined();
    consoleSpy.mockRestore();
    randomSpy.mockRestore();
  });

  it('calls prepare a second time with DELETE when Math.random < AUDIT_CLEANUP_PROBABILITY', async () => {
    const deleteRun = vi.fn().mockResolvedValue(undefined);
    const deleteBind = vi.fn().mockReturnValue({ run: deleteRun });

    const insertRun = vi.fn().mockResolvedValue(undefined);
    const insertBind = vi.fn().mockReturnValue({ run: insertRun });

    const mockPrepare = vi.fn()
      .mockReturnValueOnce({ bind: insertBind })
      .mockReturnValueOnce({ bind: deleteBind });

    const db = { prepare: mockPrepare };

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(AUDIT_CLEANUP_PROBABILITY - 0.0001);
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 200);

    expect(mockPrepare).toHaveBeenCalledTimes(2);
    const deleteSql = mockPrepare.mock.calls[1]![0] as string;
    expect(deleteSql).toContain('DELETE FROM audit_log');
    randomSpy.mockRestore();
  });

  it('does not call prepare a second time when Math.random >= AUDIT_CLEANUP_PROBABILITY', async () => {
    const db = getMockDb();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(AUDIT_CLEANUP_PROBABILITY);
    await writeAuditLog(db as unknown as D1Database, getMockCtx(), 'GET', '/beers', 200);
    expect(db.prepare).toHaveBeenCalledTimes(1);
    randomSpy.mockRestore();
  });
});

// ============================================================================
// writeAdminAuditLog Tests
// ============================================================================

describe('writeAdminAuditLog', () => {
  it('calls db.prepare().bind().run() once', async () => {
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

  it('uses SQL containing INSERT INTO audit_log', async () => {
    const db = getMockDb();
    await writeAdminAuditLog(
      db as unknown as D1Database,
      getMockCtx(),
      'dlq_replay',
      { ids: [1] },
      'admin-hash',
    );
    const sql = db.prepare.mock.calls[0]![0] as string;
    expect(sql).toContain('INSERT INTO audit_log');
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
});
