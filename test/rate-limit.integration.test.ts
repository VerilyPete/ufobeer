/**
 * The per-client, per-minute rate limiter against real D1: each client gets
 * its own count, each clock minute starts a new count, a broken database
 * fails closed, and the reaper keeps only the last hour of buckets.
 */

import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRateLimit, reapOldRateLimits } from '../src/rate-limit';

const MINUTE_MS = 60_000;
const MINUTE_START = new Date('2026-03-01T12:00:00Z').getTime();
const MID_MINUTE = MINUTE_START + 30_000;
const LIMIT = 3;

const callTimes = async (times: number, client: string) => {
  const results = [];
  for (let i = 0; i < times; i += 1) {
    results.push(await checkRateLimit(env.DB, client, LIMIT));
  }
  return results;
};

const storedBuckets = async () =>
  (await env.DB.prepare('SELECT client_identifier, minute_bucket FROM rate_limits ORDER BY minute_bucket')
    .all<{ client_identifier: string; minute_bucket: number }>()).results;

describe('checkRateLimit (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM rate_limits').run();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MID_MINUTE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows a client up to the limit in one minute, then refuses until the next minute', async () => {
    const results = await callTimes(LIMIT + 1, 'client-a');

    expect(results).toEqual([
      { allowed: true, remaining: 2, resetAt: MINUTE_START + MINUTE_MS, degraded: false },
      { allowed: true, remaining: 1, resetAt: MINUTE_START + MINUTE_MS, degraded: false },
      { allowed: true, remaining: 0, resetAt: MINUTE_START + MINUTE_MS, degraded: false },
      { allowed: false, remaining: 0, resetAt: MINUTE_START + MINUTE_MS, degraded: false },
    ]);
  });

  it('counts each client separately', async () => {
    await callTimes(LIMIT + 1, 'client-a');

    expect(await checkRateLimit(env.DB, 'client-b', LIMIT)).toMatchObject({ allowed: true, remaining: 2 });
  });

  it('starts a new count when the clock minute changes, even seconds later', async () => {
    vi.setSystemTime(MINUTE_START + MINUTE_MS - 1);
    await callTimes(LIMIT + 1, 'client-a');

    vi.setSystemTime(MINUTE_START + MINUTE_MS);

    expect(await checkRateLimit(env.DB, 'client-a', LIMIT)).toEqual({
      allowed: true, remaining: 2, resetAt: MINUTE_START + 2 * MINUTE_MS, degraded: false,
    });
  });

  it('fails closed and reports itself degraded when the database errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { prepare: () => { throw new Error('D1 unavailable'); } } as unknown as D1Database;

    expect(await checkRateLimit(broken, 'client-a', LIMIT)).toEqual({
      allowed: false, remaining: 0, resetAt: MINUTE_START + MINUTE_MS, degraded: true,
    });
  });
});

describe('reapOldRateLimits (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM rate_limits').run();
  });

  it('deletes buckets older than the last hour and keeps the rest', async () => {
    const currentBucket = Math.floor(MID_MINUTE / MINUTE_MS);
    await env.DB.batch([61, 60, 0].map((minutesAgo) =>
      env.DB.prepare('INSERT INTO rate_limits (client_identifier, minute_bucket, request_count) VALUES (?, ?, 1)')
        .bind(`${minutesAgo}-minutes-ago`, currentBucket - minutesAgo)));

    expect(await reapOldRateLimits(env.DB, MID_MINUTE)).toBe(1);
    expect((await storedBuckets()).map((row) => row.client_identifier)).toEqual(['60-minutes-ago', '0-minutes-ago']);
  });
});
