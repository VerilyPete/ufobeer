/**
 * The cron schedule claim against real D1: a due schedule is claimed once
 * and advanced, and only one caller may claim it, even when another caller
 * claims it between this caller's read and its write.
 */

import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAndAdvanceCronSchedule } from '../../src/handlers/scheduled';
import { CRON_INTERVAL_MS, CRON_JITTER_MS, CRON_SCHEDULE_KEY } from '../../src/constants';

const NOW = new Date('2026-03-01T18:00:00Z').getTime();
const NO_JITTER = () => 0.5;
const EARLIEST = () => 0;
const LATEST = () => 1;

const storedNextRun = async (): Promise<number | null> =>
  env.DB.prepare('SELECT CAST(value AS INTEGER) AS next_run FROM system_state WHERE key = ?')
    .bind(CRON_SCHEDULE_KEY).first<number>('next_run');

const seedNextRun = async (nextRun: number): Promise<void> => {
  await env.DB.prepare('INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, 0)')
    .bind(CRON_SCHEDULE_KEY, String(nextRun)).run();
};

const dbThatLetsAnotherCallerClaimFirst = (otherCaller: () => Promise<unknown>): D1Database => {
  const prepare = (sql: string): D1PreparedStatement => {
    const statement = env.DB.prepare(sql);
    if (!sql.startsWith('INSERT OR IGNORE')) return statement;
    return {
      bind: (...values: unknown[]) => ({
        run: async () => {
          await otherCaller();
          return statement.bind(...values).run();
        },
      }),
    } as unknown as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
};

describe('checkAndAdvanceCronSchedule (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM system_state').run();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims a fresh schedule once and then reports not due', async () => {
    expect(await checkAndAdvanceCronSchedule(env.DB, NO_JITTER)).toBe(true);
    expect(await storedNextRun()).toBe(NOW + CRON_INTERVAL_MS);
    expect(await checkAndAdvanceCronSchedule(env.DB, NO_JITTER)).toBe(false);
  });

  it.each([
    ['overdue', NOW - 1],
    ['due this instant', NOW],
  ])('claims an existing schedule that is %s and advances it with jitter', async (_label, nextRun) => {
    await seedNextRun(nextRun);

    expect(await checkAndAdvanceCronSchedule(env.DB, LATEST)).toBe(true);
    expect(await storedNextRun()).toBe(NOW + CRON_INTERVAL_MS + CRON_JITTER_MS);
    expect(await checkAndAdvanceCronSchedule(env.DB, LATEST)).toBe(false);
  });

  it('leaves a schedule that is not yet due alone', async () => {
    await seedNextRun(NOW + 1);

    expect(await checkAndAdvanceCronSchedule(env.DB, NO_JITTER)).toBe(false);
    expect(await storedNextRun()).toBe(NOW + 1);
  });

  it.each([
    ['a fresh schedule', null],
    ['an existing due schedule', NOW - 1],
  ])('refuses the claim on %s when another caller claimed between the read and the write', async (_label, nextRun) => {
    if (nextRun !== null) await seedNextRun(nextRun);
    const other = { claimed: false, nextRun: null as number | null };
    const db = dbThatLetsAnotherCallerClaimFirst(async () => {
      other.claimed = await checkAndAdvanceCronSchedule(env.DB, EARLIEST);
      other.nextRun = await storedNextRun();
    });

    const claimed = await checkAndAdvanceCronSchedule(db, LATEST);

    expect(other).toEqual({ claimed: true, nextRun: NOW + CRON_INTERVAL_MS - CRON_JITTER_MS });
    expect(claimed).toBe(false);
    expect(await storedNextRun()).toBe(NOW + CRON_INTERVAL_MS - CRON_JITTER_MS);
  });
});
