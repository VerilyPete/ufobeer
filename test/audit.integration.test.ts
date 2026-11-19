/**
 * Audit log rows against real D1: request and admin entries read back column
 * for column, and the reaper deletes only rows past the retention window,
 * at most 10,000 per call. The 30-day window and the 10,000 limit are
 * written as literals so a change to either constant fails here.
 */

import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reapOldAuditLog, writeAdminAuditLog, writeAuditLog } from '../src/audit';
import type { RequestContext } from '../src/types';

const NOW = new Date('2026-04-14T15:20:00Z').getTime();
const ELAPSED_MS = 37;
const RETENTION_CUTOFF = NOW - 30 * 24 * 60 * 60 * 1000;

type AuditRow = {
  readonly request_id: string;
  readonly timestamp: number;
  readonly method: string;
  readonly path: string;
  readonly api_key_hash: string | null;
  readonly client_ip: string | null;
  readonly user_agent: string | null;
  readonly status_code: number | null;
  readonly response_time_ms: number | null;
  readonly error: string | null;
};

const createRequestContext = (overrides?: Partial<RequestContext>): RequestContext => ({
  requestId: 'req-audit-7f3a',
  startTime: NOW - ELAPSED_MS,
  clientIdentifier: 'client-audit-ignored',
  apiKeyHash: 'key-hash-c41d',
  clientIp: '203.0.113.42',
  userAgent: 'BeerSelector/4.2 (audit)',
  ...overrides,
});

const storedRows = async (): Promise<readonly AuditRow[]> =>
  (await env.DB.prepare(
    `SELECT request_id, timestamp, method, path, api_key_hash, client_ip, user_agent,
            status_code, response_time_ms, error
     FROM audit_log ORDER BY id`,
  ).all<AuditRow>()).results;

const seedAtTimestamps = async (timestamps: readonly number[]): Promise<void> => {
  await env.DB.batch(timestamps.map((timestamp, index) =>
    env.DB.prepare(
      `INSERT INTO audit_log (request_id, timestamp, method, path) VALUES (?, ?, 'GET', '/beers')`,
    ).bind(`seed-${index}`, timestamp),
  ));
};

const seedOldRows = async (count: number): Promise<void> => {
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO audit_log (request_id, timestamp, method, path)
     SELECT 'old-' || i, ?, 'GET', '/beers' FROM n`,
  ).bind(count, RETENTION_CUTOFF - 1).run();
};

describe('audit log (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM audit_log').run();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('writeAuditLog', () => {
    it('stores every request field in its own column', async () => {
      await writeAuditLog(env.DB, createRequestContext(), 'POST', '/beers/sync', 418, 'teapot refused');

      expect(await storedRows()).toEqual([{
        request_id: 'req-audit-7f3a',
        timestamp: NOW - ELAPSED_MS,
        method: 'POST',
        path: '/beers/sync',
        api_key_hash: 'key-hash-c41d',
        client_ip: '203.0.113.42',
        user_agent: 'BeerSelector/4.2 (audit)',
        status_code: 418,
        response_time_ms: ELAPSED_MS,
        error: 'teapot refused',
      }]);
    });

    it('stores a request without an error, key, IP or user agent as nulls', async () => {
      await writeAuditLog(
        env.DB,
        createRequestContext({ apiKeyHash: null, clientIp: null, userAgent: null }),
        'GET',
        '/health',
        204,
      );

      expect(await storedRows()).toEqual([{
        request_id: 'req-audit-7f3a',
        timestamp: NOW - ELAPSED_MS,
        method: 'GET',
        path: '/health',
        api_key_hash: null,
        client_ip: null,
        user_agent: null,
        status_code: 204,
        response_time_ms: ELAPSED_MS,
        error: null,
      }]);
    });
  });

  describe('writeAdminAuditLog', () => {
    it('stores an admin entry with the operation as path, the admin hash as key, and every option in the details', async () => {
      await writeAdminAuditLog(
        env.DB,
        createRequestContext(),
        'dlq_replay',
        { replayed_count: 7 },
        'admin-hash-9e2b',
        {
          statusCode: 207,
          outcome: 'partial',
          targetIds: [31, 32, 33],
          requestedCount: 3,
          succeededCount: 2,
          failedCount: 5,
          failureReason: 'queue send failed',
        },
      );

      const rows = await storedRows();
      expect(rows.map((row) => ({ ...row, error: JSON.parse(row.error ?? 'null') }))).toEqual([{
        request_id: 'req-audit-7f3a',
        timestamp: NOW - ELAPSED_MS,
        method: 'ADMIN',
        path: 'dlq_replay',
        api_key_hash: 'admin-hash-9e2b',
        client_ip: '203.0.113.42',
        user_agent: 'BeerSelector/4.2 (audit)',
        status_code: 207,
        response_time_ms: ELAPSED_MS,
        error: {
          replayed_count: 7,
          outcome: 'partial',
          target_ids: [31, 32, 33],
          requested_count: 3,
          succeeded_count: 2,
          failed_count: 5,
          failure_reason: 'queue send failed',
        },
      }]);
    });
  });

  describe('reapOldAuditLog', () => {
    it('deletes only rows older than the retention window', async () => {
      await seedAtTimestamps([RETENTION_CUTOFF - 1, RETENTION_CUTOFF, RETENTION_CUTOFF + 1, NOW]);

      const deleted = await reapOldAuditLog(env.DB);

      expect(deleted).toBe(1);
      expect((await storedRows()).map((row) => row.request_id)).toEqual(['seed-1', 'seed-2', 'seed-3']);
    });

    it('deletes at most 10,000 rows per call', async () => {
      await seedOldRows(10_002);

      const deleted = await reapOldAuditLog(env.DB);

      const remaining = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>();
      expect({ deleted, remaining: remaining?.n }).toEqual({ deleted: 10_000, remaining: 2 });
    });
  });
});
