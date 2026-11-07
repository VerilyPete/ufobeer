/**
 * Real-D1 tests for the daily usage health check (plan slice 6): a
 * usage_daily row-count alert and how far each usage table's oldest expired
 * row is overdue for cleanup. Alerts go out through console.error, which
 * the error-alerts tail worker emails.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { runUsageHealthCheck } from '../../src/db/usage';

const DAY_MS = 24 * 60 * 60 * 1000;
// The daily check runs on the first cron tick of 17:00 UTC.
const CHECK_TICK = Date.UTC(2026, 10, 7, 17, 0, 30);

// Retention windows plans/usage-telemetry.md specifies.
const DAILY_RETENTION_DAYS = 180;
const BATCH_RETENTION_DAYS = 8;
const INGEST_RETENTION_DAYS = 30;

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const START_OF_TODAY = Date.UTC(2026, 10, 7);

/**
 * A day-keyed row expires at the UTC midnight after its retention window
 * ends. Returns the day whose rows expired `daysAgo` midnights before today.
 */
const dayExpiredMidnightsAgo = (retentionDays: number, daysAgo: number): string =>
  utcDay(START_OF_TODAY - daysAgo * DAY_MS - (retentionDays + 1) * DAY_MS);

const insertDaily = (day: string, installId = 'install') =>
  env.DB.prepare(
    "INSERT INTO usage_daily (day, install_id, event, app_version, ai_status, os_major, count) VALUES (?, ?, 'view_home', '2.4.0', 'other', 26, 1)",
  ).bind(day, installId);

const captureErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('runUsageHealthCheck (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM usage_daily'),
      env.DB.prepare('DELETE FROM usage_installs'),
      env.DB.prepare('DELETE FROM usage_batches'),
      env.DB.prepare('DELETE FROM usage_ingest_daily'),
    ]);
  });

  it.each([
    ['16:59:59.999', Date.UTC(2026, 10, 7, 16, 59, 59, 999), false],
    ['17:00:00', Date.UTC(2026, 10, 7, 17, 0, 0), true],
    ['17:19:59.999', Date.UTC(2026, 10, 7, 17, 19, 59, 999), true],
    ['17:20:00 (the next cron tick)', Date.UTC(2026, 10, 7, 17, 20, 0), false],
    ['17:40:00', Date.UTC(2026, 10, 7, 17, 40, 0), false],
    ['05:00:00', Date.UTC(2026, 10, 7, 5, 0, 0), false],
  ] as const)('runs only on the first cron tick of 17:00 UTC (%s)', async (_label, now, checked) => {
    expect((await runUsageHealthCheck(env.DB, now)).checked).toBe(checked);
  });

  it('reports row counts and raises no alert for a healthy, empty or current dataset', async () => {
    await env.DB.batch([insertDaily(utcDay(CHECK_TICK)), insertDaily(utcDay(CHECK_TICK), 'other')]);
    const errors = captureErrors();

    const result = await runUsageHealthCheck(env.DB, CHECK_TICK);

    expect(result).toMatchObject({
      checked: true,
      usageDailyRows: 2,
      overdueMs: { usage_daily: 0, usage_installs: 0, usage_batches: 0, usage_ingest_daily: 0 },
      alerts: [],
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('alerts when usage_daily exceeds the row-count threshold', async () => {
    const errors = captureErrors();

    await insertDaily(utcDay(CHECK_TICK)).run();
    const atThreshold = await runUsageHealthCheck(env.DB, CHECK_TICK, { usageDailyRowAlert: 1 });
    expect(atThreshold.checked && atThreshold.alerts).toEqual([]);

    await insertDaily(utcDay(CHECK_TICK), 'other').run();
    const over = await runUsageHealthCheck(env.DB, CHECK_TICK, { usageDailyRowAlert: 1 });

    expect(over.checked && over.alerts).toEqual([expect.stringContaining('usage_daily has 2 rows')]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('usage_daily has 2 rows'));
    errors.mockRestore();
  });

  it('does not alert when cleanup is behind by a day or less', async () => {
    await env.DB.batch([
      insertDaily(dayExpiredMidnightsAgo(DAILY_RETENTION_DAYS, 0)),
      env.DB.prepare("INSERT INTO usage_batches (install_id, batch_id, request_id, received_at) VALUES ('i', 'b', 'r', ?)")
        .bind(CHECK_TICK - BATCH_RETENTION_DAYS * DAY_MS - DAY_MS),
    ]);
    const errors = captureErrors();

    const result = await runUsageHealthCheck(env.DB, CHECK_TICK);

    expect(result.checked && result.alerts).toEqual([]);
    expect(result.checked && result.overdueMs.usage_batches).toBe(DAY_MS);
    expect(result.checked && result.overdueMs.usage_daily).toBe(CHECK_TICK - START_OF_TODAY);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('alerts for every table whose oldest expired row is more than a day overdue', async () => {
    const overdueDay = (retention: number) => dayExpiredMidnightsAgo(retention, 1);
    await env.DB.batch([
      insertDaily(overdueDay(DAILY_RETENTION_DAYS)),
      env.DB.prepare("INSERT INTO usage_installs (install_id, first_seen_day, last_seen_day) VALUES ('old', ?, ?)")
        .bind(overdueDay(DAILY_RETENTION_DAYS), overdueDay(DAILY_RETENTION_DAYS)),
      env.DB.prepare("INSERT INTO usage_batches (install_id, batch_id, request_id, received_at) VALUES ('i', 'b', 'r', ?)")
        .bind(CHECK_TICK - BATCH_RETENTION_DAYS * DAY_MS - DAY_MS - 1),
      env.DB.prepare('INSERT INTO usage_ingest_daily (day, posts) VALUES (?, 1)').bind(overdueDay(INGEST_RETENTION_DAYS)),
    ]);
    const errors = captureErrors();

    const result = await runUsageHealthCheck(env.DB, CHECK_TICK);

    expect(result.checked && result.alerts).toEqual([
      expect.stringContaining('usage_daily cleanup is behind'),
      expect.stringContaining('usage_installs cleanup is behind'),
      expect.stringContaining('usage_batches cleanup is behind'),
      expect.stringContaining('usage_ingest_daily cleanup is behind'),
    ]);
    expect(errors).toHaveBeenCalledTimes(4);
    errors.mockRestore();
  });

  it('measures the backlog from the oldest expired row when current rows are present too', async () => {
    const today = utcDay(CHECK_TICK);
    const twoMidnightsAgo = (retention: number) => dayExpiredMidnightsAgo(retention, 2);
    await env.DB.batch([
      insertDaily(twoMidnightsAgo(DAILY_RETENTION_DAYS), 'expired'),
      insertDaily(today, 'current'),
      env.DB.prepare('INSERT INTO usage_installs (install_id, first_seen_day, last_seen_day) VALUES (?, ?, ?), (?, ?, ?)')
        .bind('expired', today, twoMidnightsAgo(DAILY_RETENTION_DAYS), 'current', today, today),
      env.DB.prepare("INSERT INTO usage_batches (install_id, batch_id, request_id, received_at) VALUES ('i', 'old', 'r', ?), ('i', 'new', 'r', ?)")
        .bind(CHECK_TICK - BATCH_RETENTION_DAYS * DAY_MS - 3 * DAY_MS, CHECK_TICK),
      env.DB.prepare('INSERT INTO usage_ingest_daily (day, posts) VALUES (?, 1), (?, 1)')
        .bind(twoMidnightsAgo(INGEST_RETENTION_DAYS), today),
    ]);
    const errors = captureErrors();

    const result = await runUsageHealthCheck(env.DB, CHECK_TICK);

    const sinceTwoMidnightsAgo = CHECK_TICK - (START_OF_TODAY - 2 * DAY_MS);
    expect(result.checked && result.overdueMs).toEqual({
      usage_daily: sinceTwoMidnightsAgo,
      usage_installs: sinceTwoMidnightsAgo,
      usage_batches: 3 * DAY_MS,
      usage_ingest_daily: sinceTwoMidnightsAgo,
    });
    expect(result.checked && result.alerts).toHaveLength(4);
    errors.mockRestore();
  });

  it('ignores rows that are old but not yet past their window', async () => {
    await env.DB.prepare("INSERT INTO usage_installs (install_id, first_seen_day, last_seen_day) VALUES ('veteran', ?, ?)")
      .bind(utcDay(CHECK_TICK - 400 * DAY_MS), utcDay(CHECK_TICK)).run();

    const result = await runUsageHealthCheck(env.DB, CHECK_TICK);

    expect(result.checked && result.overdueMs.usage_installs).toBe(0);
  });
});
