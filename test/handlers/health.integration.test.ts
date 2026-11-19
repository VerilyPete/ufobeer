/**
 * /health quota windows against real D1: the daily figure counts only
 * today's enrichment_limits row, and the monthly figure sums this calendar
 * month's rows (UTC) and nothing from the month before.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleHealthCheck } from '../../src/handlers/health';

const MID_MONTH = new Date('2026-03-17T15:20:00Z').getTime();

const seedDailyCounts = async (counts: Readonly<Record<string, number>>): Promise<void> => {
  await env.DB.batch(Object.entries(counts).map(([date, count]) =>
    env.DB.prepare('INSERT INTO enrichment_limits (date, request_count) VALUES (?, ?)').bind(date, count)));
};

describe('handleHealthCheck quota windows (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enrichment_limits').run();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MID_MONTH);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports today alone as daily use and this month alone as monthly use', async () => {
    await seedDailyCounts({
      '2026-02-28': 307,
      '2026-03-01': 11,
      '2026-03-04': 41,
      '2026-03-17': 23,
      '2026-04-01': 509,
    });

    const response = await handleHealthCheck({
      ...env,
      DAILY_ENRICHMENT_LIMIT: '700',
      MONTHLY_ENRICHMENT_LIMIT: '2300',
      ENRICHMENT_ENABLED: 'true',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      database: 'connected',
      enrichment: {
        enabled: true,
        daily: { used: 23, limit: 700, remaining: 677 },
        monthly: { used: 75, limit: 2300, remaining: 2225 },
      },
    });
  });
});
