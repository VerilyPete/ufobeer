/**
 * Real-D1 tests for the budgeted, deduplicated usage write.
 *
 * The admission rules live in SQL inside one db.batch() transaction, so only
 * real SQLite semantics can show that duplicates, caps and the final outcome
 * classification agree with each other.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { recordUsageReport } from '../../src/db/usage';
import { parseUsageReport, type UsageReport } from '../../src/schemas/request';

const DAY = '2026-11-07';
const NEXT_DAY = '2026-11-08';
const NOW = Date.UTC(2026, 10, 7, 18, 0, 0);

const installId = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const batchId = (n: number): string => `11111111-1111-4111-8111-${n.toString().padStart(12, '0')}`;

type WireOverrides = Readonly<Record<string, unknown>>;

const buildReport = (overrides: WireOverrides = {}): UsageReport => {
  const parsed = parseUsageReport({
    install_id: installId(1),
    batch_id: batchId(1),
    app_version: '2.4.0',
    ai_status: 'apple_intelligence',
    os_major: 26,
    events: [{ name: 'view_home', count: 2 }],
    ...overrides,
  });
  if (!parsed.success) {
    throw new Error(`invalid test report: ${parsed.error.message}`);
  }
  return parsed.report;
};

type RecordOptions = {
  report?: UsageReport;
  day?: string;
  requestId?: string;
  installCap?: number;
  postCap?: number;
};

const record = ({
  report = buildReport(),
  day = DAY,
  requestId = crypto.randomUUID(),
  installCap = 500,
  postCap = 2000,
}: RecordOptions = {}) =>
  recordUsageReport(env.DB, { report, day, requestId, now: NOW, installCap, postCap });

type DailyRow = {
  day: string;
  install_id: string;
  event: string;
  app_version: string;
  ai_status: string;
  os_major: number;
  count: number;
};

const dailyRows = async (): Promise<readonly DailyRow[]> =>
  (await env.DB.prepare(
    'SELECT day, install_id, event, app_version, ai_status, os_major, count FROM usage_daily ORDER BY day, install_id, event, app_version',
  ).all<DailyRow>()).results;

const postsCharged = async (day: string = DAY): Promise<number> =>
  (await env.DB.prepare('SELECT posts FROM usage_ingest_daily WHERE day = ?')
    .bind(day).first<{ posts: number }>())?.posts ?? 0;

const batchCount = async (): Promise<number> =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_batches').first<{ n: number }>())?.n ?? 0;

const installRow = async (id: string) =>
  env.DB.prepare('SELECT first_seen_day, last_seen_day FROM usage_installs WHERE install_id = ?')
    .bind(id).first<{ first_seen_day: string; last_seen_day: string }>();

const seedPosts = async (posts: number, day: string = DAY): Promise<void> => {
  await env.DB.prepare('INSERT INTO usage_ingest_daily (day, posts) VALUES (?, ?)').bind(day, posts).run();
};

const seedNewInstalls = async (count: number, day: string = DAY): Promise<void> => {
  await env.DB.batch(Array.from({ length: count }, (_, i) =>
    env.DB.prepare('INSERT INTO usage_installs (install_id, first_seen_day, last_seen_day) VALUES (?, ?, ?)')
      .bind(installId(1000 + i), day, day)));
};

describe('recordUsageReport (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM usage_daily'),
      env.DB.prepare('DELETE FROM usage_installs'),
      env.DB.prepare('DELETE FROM usage_batches'),
      env.DB.prepare('DELETE FROM usage_ingest_daily'),
    ]);
  });

  describe('admitted posts', () => {
    it('counts a new batch from a new install and charges the budget once', async () => {
      const outcome = await record({
        report: buildReport({
          events: [{ name: 'view_home', count: 2 }, { name: 'suggestions_opened', count: 3 }],
        }),
      });

      expect(outcome).toBe('admitted');
      expect(await dailyRows()).toEqual([
        { day: DAY, install_id: installId(1), event: 'suggestions_opened', app_version: '2.4.0', ai_status: 'apple_intelligence', os_major: 26, count: 3 },
        { day: DAY, install_id: installId(1), event: 'view_home', app_version: '2.4.0', ai_status: 'apple_intelligence', os_major: 26, count: 2 },
      ]);
      expect(await postsCharged()).toBe(1);
      expect(await installRow(installId(1))).toEqual({ first_seen_day: DAY, last_seen_day: DAY });
    });

    it('accumulates counts across batches from the same install', async () => {
      await record({ report: buildReport({ batch_id: batchId(1) }) });
      await record({ report: buildReport({ batch_id: batchId(2), events: [{ name: 'view_home', count: 5 }] }) });

      expect((await dailyRows()).map((row) => row.count)).toEqual([7]);
      expect(await postsCharged()).toBe(2);
    });

    it('keeps separate rows per install and per dimension tuple', async () => {
      await record({ report: buildReport({ install_id: installId(1), batch_id: batchId(1) }) });
      await record({ report: buildReport({ install_id: installId(2), batch_id: batchId(2) }) });
      await record({ report: buildReport({ install_id: installId(1), batch_id: batchId(3), app_version: '2.5.0' }) });
      await record({ report: buildReport({ install_id: installId(1), batch_id: batchId(4), ai_status: 'brand_new_status' }) });
      await record({ report: buildReport({ install_id: installId(1), batch_id: batchId(5), os_major: 27 }) });

      expect(await dailyRows()).toHaveLength(5);
    });

    it('counts the same batch_id from a different install separately', async () => {
      expect(await record({ report: buildReport({ install_id: installId(1) }) })).toBe('admitted');
      expect(await record({ report: buildReport({ install_id: installId(2) }) })).toBe('admitted');

      expect(await dailyRows()).toHaveLength(2);
      expect(await postsCharged()).toBe(2);
    });

    it('charges each post to the day it is given, so budgets reset per day', async () => {
      await seedPosts(2000, DAY);

      expect(await record({ day: NEXT_DAY })).toBe('admitted');
      expect((await dailyRows()).map((row) => row.day)).toEqual([NEXT_DAY]);
      expect(await postsCharged(NEXT_DAY)).toBe(1);
    });

    it('updates last_seen_day without moving first_seen_day for a returning install', async () => {
      await record({ report: buildReport({ batch_id: batchId(1) }), day: DAY });
      await record({ report: buildReport({ batch_id: batchId(2) }), day: NEXT_DAY });

      expect(await installRow(installId(1))).toEqual({ first_seen_day: DAY, last_seen_day: NEXT_DAY });
    });
  });

  describe('duplicate batches', () => {
    it('writes nothing and charges nothing for a resent batch', async () => {
      await record();
      const outcome = await record();

      expect(outcome).toBe('duplicate');
      expect((await dailyRows()).map((row) => row.count)).toEqual([2]);
      expect(await postsCharged()).toBe(1);
      expect(await batchCount()).toBe(1);
    });

    it('does not refresh last_seen_day when a batch is resent on a later day', async () => {
      await record({ day: DAY });

      expect(await record({ day: NEXT_DAY })).toBe('duplicate');
      expect(await installRow(installId(1))).toEqual({ first_seen_day: DAY, last_seen_day: DAY });
    });

    it('reports a duplicate, not the cap, when the batch is replayed at the post cap', async () => {
      await record();
      await env.DB.prepare('UPDATE usage_ingest_daily SET posts = ? WHERE day = ?').bind(2000, DAY).run();

      expect(await record()).toBe('duplicate');
      expect(await postsCharged()).toBe(2000);
    });
  });

  describe('daily post cap', () => {
    it('admits the post that brings the day to the cap', async () => {
      await seedPosts(1999);

      expect(await record()).toBe('admitted');
      expect(await postsCharged()).toBe(2000);
    });

    it('drops a new batch once the cap is reached, without recording it', async () => {
      await seedPosts(2000);

      expect(await record()).toBe('daily_post_cap');
      expect(await dailyRows()).toEqual([]);
      expect(await batchCount()).toBe(0);
      expect(await postsCharged()).toBe(2000);
    });

    it('drops a new batch from a known install once the cap is reached', async () => {
      await record({ report: buildReport({ batch_id: batchId(1) }) });
      await env.DB.prepare('UPDATE usage_ingest_daily SET posts = ? WHERE day = ?').bind(2000, DAY).run();

      expect(await record({ report: buildReport({ batch_id: batchId(2) }) })).toBe('daily_post_cap');
      expect((await dailyRows()).map((row) => row.count)).toEqual([2]);
      expect(await batchCount()).toBe(1);
      expect(await postsCharged()).toBe(2000);
    });

    it('does not admit a new install while the post cap is spent', async () => {
      await seedPosts(2000);

      await record();

      expect(await installRow(installId(1))).toBeNull();
    });
  });

  describe('new install cap', () => {
    it('admits the install that brings the day to the cap', async () => {
      await seedNewInstalls(2);

      expect(await record({ installCap: 3 })).toBe('admitted');
    });

    it('drops a post from an unknown install once the cap is reached', async () => {
      await seedNewInstalls(3);

      expect(await record({ installCap: 3 })).toBe('new_install_cap');
      expect(await dailyRows()).toEqual([]);
      expect(await installRow(installId(1))).toBeNull();
      expect(await batchCount()).toBe(0);
      expect(await postsCharged()).toBe(0);
    });

    it('keeps counting installs already known after the cap is reached', async () => {
      await record({ report: buildReport({ batch_id: batchId(1) }) });
      await seedNewInstalls(3);

      expect(await record({ report: buildReport({ batch_id: batchId(2) }), installCap: 3 })).toBe('admitted');
    });

    it('only counts installs first seen today towards the cap', async () => {
      await seedNewInstalls(3, '2026-11-06');

      expect(await record({ installCap: 3 })).toBe('admitted');
    });

    it('reports the post cap first when both caps are spent', async () => {
      await seedNewInstalls(3);
      await seedPosts(2000);

      expect(await record({ installCap: 3 })).toBe('daily_post_cap');
    });
  });

  describe('failures', () => {
    it('rolls back every write when a late statement fails, so a resend still counts', async () => {
      await env.DB.prepare(
        "CREATE TRIGGER fail_budget_charge BEFORE INSERT ON usage_ingest_daily BEGIN SELECT RAISE(ABORT, 'charge failed'); END",
      ).run();

      await expect(record()).rejects.toThrow(/charge failed/);

      await env.DB.prepare('DROP TRIGGER fail_budget_charge').run();
      expect(await dailyRows()).toEqual([]);
      expect(await batchCount()).toBe(0);
      expect(await installRow(installId(1))).toBeNull();

      expect(await record()).toBe('admitted');
    });
  });
});
