/**
 * Real-D1 tests for the GET /reports/usage views (plans/usage-dashboards.md,
 * slice 4). The seed is chosen so each metric definition gives a different
 * answer from its plausible wrong versions: an install with two app versions
 * on one day, an event user with no session_started, and installs active on
 * different days, so range counts differ from sums of daily counts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { readUsageReport, type UsageReportView } from '../../src/handlers/reports';
import { USAGE_REPORT_FIELDS } from '../../src/db/usage-report';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

const DAY_1 = '2026-11-12';
const DAY_2 = '2026-11-13';

type DailyRowSeed = readonly [day: string, installId: string, event: string, appVersion: string, aiStatus: string, osMajor: number, count: number];

const USAGE: readonly DailyRowSeed[] = [
  [DAY_1, A, 'session_started', '2.4.0', 'apple_intelligence', 26, 2],
  [DAY_1, A, 'view_home', '2.4.0', 'apple_intelligence', 26, 3],
  [DAY_1, A, 'view_home', '2.5.0', 'apple_intelligence', 26, 1],
  [DAY_1, B, 'suggestions_opened', '2.4.0', 'other', 18, 1],
  [DAY_1, B, 'untappd_opened', '2.4.0', 'other', 18, 1],
  [DAY_2, A, 'session_started', '2.5.0', 'apple_intelligence', 26, 1],
  [DAY_2, A, 'suggestions_opened', '2.5.0', 'apple_intelligence', 26, 2],
  [DAY_2, C, 'session_started', '2.5.0', 'apple_intelligence', 26, 4],
  [DAY_2, C, 'view_home', '2.5.0', 'apple_intelligence', 26, 1],
];

const seed = async (): Promise<void> => {
  await env.DB.batch([
    ...USAGE.map((row) => env.DB.prepare(
      'INSERT INTO usage_daily (day, install_id, event, app_version, ai_status, os_major, count) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(...row)),
    env.DB.prepare('INSERT INTO usage_installs (install_id, first_seen_day, last_seen_day) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)')
      .bind(A, DAY_1, DAY_2, B, DAY_1, DAY_1, C, DAY_2, DAY_2),
    env.DB.prepare(`INSERT INTO usage_ingest_daily (day, posts, duplicates, dropped_post_cap, dropped_new_install, dropped_all_events, dropped_events)
                    VALUES (?, 3, 1, 3, 4, 5, 2), (?, 2, 0, 0, 0, 0, 0)`).bind(DAY_1, DAY_2),
  ]);
};

const read = (view: UsageReportView, from: string = DAY_1, to: string = DAY_2) =>
  readUsageReport(env.DB, { ok: true, view, from, to });

const DAY_1_DAILY = {
  day: DAY_1, active_installs: 2, new_installs: 2, sessions: 2, posts: 3,
  duplicates: 1, dropped_post_cap: 3, dropped_new_install: 4, dropped_all_events: 5, dropped_events: 2,
};

const ZERO_COUNTERS = {
  duplicates: 0, dropped_post_cap: 0, dropped_new_install: 0, dropped_all_events: 0, dropped_events: 0,
};

describe('readUsageReport (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.batch(['usage_daily', 'usage_installs', 'usage_batches', 'usage_ingest_daily']
      .map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  });

  describe('daily view', () => {
    it('gives each day its active and new installs, sessions, posts and drop counters', async () => {
      await seed();

      expect(await read('daily')).toEqual([
        DAY_1_DAILY,
        { day: DAY_2, active_installs: 2, new_installs: 1, sessions: 5, posts: 2, ...ZERO_COUNTERS },
      ]);
    });

    it('returns a row for every day in the range, with zeros where nothing arrived', async () => {
      await seed();

      expect(await read('daily', DAY_2, '2026-11-15')).toEqual([
        { day: DAY_2, active_installs: 2, new_installs: 1, sessions: 5, posts: 2, ...ZERO_COUNTERS },
        { day: '2026-11-14', active_installs: 0, new_installs: 0, sessions: 0, posts: 0, ...ZERO_COUNTERS },
        { day: '2026-11-15', active_installs: 0, new_installs: 0, sessions: 0, posts: 0, ...ZERO_COUNTERS },
      ]);
    });

    it('reports posts as null before 2026-11-10 and drop counters as null before 2026-11-12', async () => {
      await env.DB.prepare('INSERT INTO usage_ingest_daily (day, posts) VALUES (?, 5), (?, 4)').bind('2026-11-09', '2026-11-11').run();

      const rows = await read('daily', '2026-11-09', '2026-11-12');

      const nullCounters = {
        duplicates: null, dropped_post_cap: null, dropped_new_install: null, dropped_all_events: null, dropped_events: null,
      };
      expect(rows).toEqual([
        { day: '2026-11-09', active_installs: 0, new_installs: 0, sessions: 0, posts: null, ...nullCounters },
        { day: '2026-11-10', active_installs: 0, new_installs: 0, sessions: 0, posts: 0, ...nullCounters },
        { day: '2026-11-11', active_installs: 0, new_installs: 0, sessions: 0, posts: 4, ...nullCounters },
        { day: '2026-11-12', active_installs: 0, new_installs: 0, sessions: 0, posts: 0, ...ZERO_COUNTERS },
      ]);
    });
  });

  describe('events view', () => {
    it('sums each event per day and counts the distinct installs that used it', async () => {
      await seed();

      expect(await read('events')).toEqual([
        { day: DAY_1, event: 'session_started', count: 2, installs: 1 },
        { day: DAY_1, event: 'suggestions_opened', count: 1, installs: 1 },
        { day: DAY_1, event: 'untappd_opened', count: 1, installs: 1 },
        { day: DAY_1, event: 'view_home', count: 4, installs: 1 },
        { day: DAY_2, event: 'session_started', count: 5, installs: 2 },
        { day: DAY_2, event: 'suggestions_opened', count: 2, installs: 1 },
        { day: DAY_2, event: 'view_home', count: 1, installs: 1 },
      ]);
    });
  });

  describe('adoption view', () => {
    it('counts installs over the whole range, not as a sum of daily counts', async () => {
      await seed();

      const rows = await read('adoption');

      expect(rows.map((row) => row['active_installs'])).toEqual([3, 3, 3, 3]);
    });

    it('gives each event its users, share, and count per session of the installs that used it', async () => {
      await seed();

      expect(await read('adoption')).toEqual([
        { event: 'session_started', installs_using: 2, active_installs: 3, share: expect.closeTo(2 / 3, 10), avg_per_session: 1 },
        { event: 'suggestions_opened', installs_using: 2, active_installs: 3, share: expect.closeTo(2 / 3, 10), avg_per_session: 1 },
        { event: 'untappd_opened', installs_using: 1, active_installs: 3, share: expect.closeTo(1 / 3, 10), avg_per_session: null },
        { event: 'view_home', installs_using: 2, active_installs: 3, share: expect.closeTo(2 / 3, 10), avg_per_session: expect.closeTo(5 / 7, 10) },
      ]);
    });
  });

  describe('breakdown view', () => {
    it('counts distinct installs per day for each app version, AI status and OS major', async () => {
      await seed();

      expect(await read('breakdown')).toEqual([
        { day: DAY_1, dimension: 'ai_status', value: 'apple_intelligence', active_installs: 1 },
        { day: DAY_1, dimension: 'ai_status', value: 'other', active_installs: 1 },
        { day: DAY_1, dimension: 'app_version', value: '2.4.0', active_installs: 2 },
        { day: DAY_1, dimension: 'app_version', value: '2.5.0', active_installs: 1 },
        { day: DAY_1, dimension: 'os_major', value: '18', active_installs: 1 },
        { day: DAY_1, dimension: 'os_major', value: '26', active_installs: 1 },
        { day: DAY_2, dimension: 'ai_status', value: 'apple_intelligence', active_installs: 2 },
        { day: DAY_2, dimension: 'app_version', value: '2.5.0', active_installs: 2 },
        { day: DAY_2, dimension: 'os_major', value: '26', active_installs: 2 },
      ]);
    });
  });

  describe('every view', () => {
    const VIEWS: readonly UsageReportView[] = ['daily', 'events', 'adoption', 'breakdown'];

    it.each(VIEWS)('returns exactly the fields USAGE_REPORT_FIELDS lists (%s)', async (view) => {
      await seed();

      const rows = await read(view);

      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => expect(Object.keys(row).sort()).toEqual([...USAGE_REPORT_FIELDS[view]].sort()));
    });

    it.each(VIEWS)('never returns an install ID (%s)', async (view) => {
      await seed();

      const body = JSON.stringify(await read(view));

      expect(body).not.toContain(A);
      expect(body).not.toContain(B);
      expect(body).not.toContain(C);
      expect(body).not.toMatch(/install_id/);
    });

    it.each(VIEWS)('only reads days inside the range (%s)', async (view) => {
      await seed();

      const rows = await read(view, DAY_2, DAY_2);

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => !('day' in row) || row['day'] === DAY_2)).toBe(true);
    });

    it.each([
      ['events', []],
      ['adoption', []],
      ['breakdown', []],
    ] as const)('returns an empty array for a range with no usage (%s)', async (view, expected) => {
      await seed();

      expect(await read(view, '2026-11-20', '2026-11-21')).toEqual(expected);
    });
  });

  describe('a range that ends before later usage', () => {
    it('leaves later days out of the daily view', async () => {
      await seed();

      expect(await read('daily', DAY_1, DAY_1)).toEqual([DAY_1_DAILY]);
    });

    it('leaves later days out of the events view', async () => {
      await seed();

      expect(await read('events', DAY_1, DAY_1)).toEqual([
        { day: DAY_1, event: 'session_started', count: 2, installs: 1 },
        { day: DAY_1, event: 'suggestions_opened', count: 1, installs: 1 },
        { day: DAY_1, event: 'untappd_opened', count: 1, installs: 1 },
        { day: DAY_1, event: 'view_home', count: 4, installs: 1 },
      ]);
    });

    it('leaves later installs, counts and sessions out of adoption', async () => {
      await seed();

      expect(await read('adoption', DAY_1, DAY_1)).toEqual([
        { event: 'session_started', installs_using: 1, active_installs: 2, share: 0.5, avg_per_session: 1 },
        { event: 'suggestions_opened', installs_using: 1, active_installs: 2, share: 0.5, avg_per_session: null },
        { event: 'untappd_opened', installs_using: 1, active_installs: 2, share: 0.5, avg_per_session: null },
        { event: 'view_home', installs_using: 1, active_installs: 2, share: 0.5, avg_per_session: 2 },
      ]);
    });

    it('leaves later days out of the breakdown view', async () => {
      await seed();

      expect((await read('breakdown', DAY_1, DAY_1)).map((row) => row['day'])).toEqual(Array(6).fill(DAY_1));
    });
  });

  it('scopes adoption to the range: an install active only outside it does not count', async () => {
    await seed();

    expect(await read('adoption', DAY_2, DAY_2)).toEqual([
      { event: 'session_started', installs_using: 2, active_installs: 2, share: 1, avg_per_session: 1 },
      { event: 'suggestions_opened', installs_using: 1, active_installs: 2, share: expect.closeTo(1 / 2, 10), avg_per_session: 2 },
      { event: 'view_home', installs_using: 1, active_installs: 2, share: expect.closeTo(1 / 2, 10), avg_per_session: expect.closeTo(1 / 4, 10) },
    ]);
  });
});
