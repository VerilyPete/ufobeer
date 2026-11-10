import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { reserveAbvFallbackSlot } from '../../src/db/quota';

async function countFor(date: string): Promise<unknown> {
  return env.DB.prepare('SELECT request_count FROM abv_fallback_limits WHERE date = ?').bind(date).first('request_count');
}

describe('reserveAbvFallbackSlot (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM abv_fallback_limits').run();
  });

  it('grants slots up to the daily limit, then refuses without counting', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await reserveAbvFallbackSlot(env.DB, { date: '2026-11-10', limit: 3 }));
    expect(results).toEqual([true, true, true, false]);
    expect(await countFor('2026-11-10')).toBe(3);
  });

  it('gives exactly one of several concurrent callers the last slot', async () => {
    await env.DB.prepare('INSERT INTO abv_fallback_limits (date, request_count, last_updated) VALUES (?, ?, ?)')
      .bind('2026-11-10', 49, 0).run();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => reserveAbvFallbackSlot(env.DB, { date: '2026-11-10', limit: 50 }))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await countFor('2026-11-10')).toBe(50);
  });

  it('counts each UTC day separately', async () => {
    expect(await reserveAbvFallbackSlot(env.DB, { date: '2026-11-10', limit: 1 })).toBe(true);
    expect(await reserveAbvFallbackSlot(env.DB, { date: '2026-11-10', limit: 1 })).toBe(false);
    expect(await reserveAbvFallbackSlot(env.DB, { date: '2026-11-11', limit: 1 })).toBe(true);
  });

  it('refuses every call when the limit is zero', async () => {
    expect(await reserveAbvFallbackSlot(env.DB, { date: '2026-11-10', limit: 0 })).toBe(false);
  });
});
