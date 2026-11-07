/**
 * Real-D1 tests for usage table retention.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { reapExpiredUsage } from '../../src/db/usage';

// The windows and limit plans/usage-telemetry.md specifies, written out
// rather than imported, so a changed constant fails here.
const USAGE_DAILY_RETENTION_DAYS = 180;
const USAGE_BATCH_RETENTION_DAYS = 8;
const USAGE_INGEST_RETENTION_DAYS = 30;
const USAGE_REAP_LIMIT = 5_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 7, 18, 0, 0);

const utcDay = (daysAgo: number): string => new Date(NOW - daysAgo * DAY_MS).toISOString().slice(0, 10);

const insertDaily = (day: string, installId = 'install') =>
  env.DB.prepare(
    "INSERT INTO usage_daily (day, install_id, event, app_version, ai_status, os_major, count) VALUES (?, ?, 'view_home', '2.4.0', 'other', 26, 1)",
  ).bind(day, installId);

const insertInstall = (installId: string, lastSeenDay: string) =>
  env.DB.prepare('INSERT INTO usage_installs (install_id, first_seen_day, last_seen_day) VALUES (?, ?, ?)')
    .bind(installId, lastSeenDay, lastSeenDay);

const insertBatch = (batchId: string, receivedAt: number) =>
  env.DB.prepare("INSERT INTO usage_batches (install_id, batch_id, request_id, received_at) VALUES ('install', ?, 'req', ?)")
    .bind(batchId, receivedAt);

const insertIngest = (day: string) =>
  env.DB.prepare('INSERT INTO usage_ingest_daily (day, posts) VALUES (?, 1)').bind(day);

const column = async (sql: string): Promise<readonly unknown[]> =>
  (await env.DB.prepare(sql).all<Record<string, unknown>>()).results.map((row) => Object.values(row)[0]);

describe('reapExpiredUsage (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM usage_daily'),
      env.DB.prepare('DELETE FROM usage_installs'),
      env.DB.prepare('DELETE FROM usage_batches'),
      env.DB.prepare('DELETE FROM usage_ingest_daily'),
    ]);
  });

  it('deletes usage_daily rows older than the retention window and keeps the boundary day', async () => {
    await env.DB.batch([
      insertDaily(utcDay(USAGE_DAILY_RETENTION_DAYS + 1)),
      insertDaily(utcDay(USAGE_DAILY_RETENTION_DAYS)),
      insertDaily(utcDay(0)),
    ]);

    const result = await reapExpiredUsage(env.DB, NOW);

    expect(result.usage_daily).toBe(1);
    expect(await column('SELECT day FROM usage_daily ORDER BY day')).toEqual([
      utcDay(USAGE_DAILY_RETENTION_DAYS),
      utcDay(0),
    ]);
  });

  it('deletes installs not seen within the retention window and keeps the boundary day', async () => {
    await env.DB.batch([
      insertInstall('old', utcDay(USAGE_DAILY_RETENTION_DAYS + 1)),
      insertInstall('boundary', utcDay(USAGE_DAILY_RETENTION_DAYS)),
      insertInstall('recent', utcDay(0)),
    ]);

    const result = await reapExpiredUsage(env.DB, NOW);

    expect(result.usage_installs).toBe(1);
    expect(await column('SELECT install_id FROM usage_installs ORDER BY install_id')).toEqual(['boundary', 'recent']);
  });

  it('keeps an install first seen long ago that is still active', async () => {
    await env.DB.prepare('INSERT INTO usage_installs (install_id, first_seen_day, last_seen_day) VALUES (?, ?, ?)')
      .bind('veteran', utcDay(USAGE_DAILY_RETENTION_DAYS + 30), utcDay(0)).run();

    const result = await reapExpiredUsage(env.DB, NOW);

    expect(result.usage_installs).toBe(0);
    expect(await column('SELECT install_id FROM usage_installs')).toEqual(['veteran']);
  });

  it('deletes batches received before the dedup window and keeps the boundary instant', async () => {
    const cutoff = NOW - USAGE_BATCH_RETENTION_DAYS * DAY_MS;
    await env.DB.batch([
      insertBatch('old', cutoff - 1),
      insertBatch('boundary', cutoff),
      insertBatch('recent', NOW),
    ]);

    const result = await reapExpiredUsage(env.DB, NOW);

    expect(result.usage_batches).toBe(1);
    expect(await column('SELECT batch_id FROM usage_batches ORDER BY batch_id')).toEqual(['boundary', 'recent']);
  });

  it('deletes ingest budget rows older than their window and keeps the boundary day', async () => {
    await env.DB.batch([
      insertIngest(utcDay(USAGE_INGEST_RETENTION_DAYS + 1)),
      insertIngest(utcDay(USAGE_INGEST_RETENTION_DAYS)),
      insertIngest(utcDay(0)),
    ]);

    const result = await reapExpiredUsage(env.DB, NOW);

    expect(result.usage_ingest_daily).toBe(1);
    expect(await column('SELECT day FROM usage_ingest_daily ORDER BY day')).toEqual([
      utcDay(USAGE_INGEST_RETENTION_DAYS),
      utcDay(0),
    ]);
  });

  it.each([
    ['usage_daily', (i: number) => insertDaily(utcDay(USAGE_DAILY_RETENTION_DAYS + 1), `install-${i}`)],
    ['usage_installs', (i: number) => insertInstall(`install-${i}`, utcDay(USAGE_DAILY_RETENTION_DAYS + 1))],
    ['usage_batches', (i: number) => insertBatch(`batch-${i}`, 0)],
    ['usage_ingest_daily', (i: number) => insertIngest(utcDay(USAGE_INGEST_RETENTION_DAYS + 1 + i))],
  ] as const)('deletes at most the reap limit from %s per call', async (table, insertExpired) => {
    const rows = Array.from({ length: USAGE_REAP_LIMIT + 3 }, (_, i) => insertExpired(i));
    const chunks = Array.from({ length: Math.ceil(rows.length / 100) }, (_, i) => rows.slice(i * 100, (i + 1) * 100));
    await chunks.reduce((previous, chunk) => previous.then(() => env.DB.batch(chunk)).then(() => undefined), Promise.resolve());

    expect((await reapExpiredUsage(env.DB, NOW))[table]).toBe(USAGE_REAP_LIMIT);
    expect((await reapExpiredUsage(env.DB, NOW))[table]).toBe(3);
  });

  it('keeps reaping the other tables when one delete fails', async () => {
    await env.DB.batch([
      insertDaily(utcDay(USAGE_DAILY_RETENTION_DAYS + 1)),
      insertInstall('old', utcDay(USAGE_DAILY_RETENTION_DAYS + 1)),
      insertBatch('old', 0),
      insertIngest(utcDay(USAGE_INGEST_RETENTION_DAYS + 1)),
      env.DB.prepare(
        "CREATE TRIGGER fail_daily_reap BEFORE DELETE ON usage_daily BEGIN SELECT RAISE(ABORT, 'reap failed'); END",
      ),
    ]);

    const result = await reapExpiredUsage(env.DB, NOW);
    await env.DB.prepare('DROP TRIGGER fail_daily_reap').run();

    expect(result).toEqual({
      usage_daily: 'failed',
      usage_installs: 1,
      usage_batches: 1,
      usage_ingest_daily: 1,
    });
  });
});
