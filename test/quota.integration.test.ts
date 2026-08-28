/**
 * Real-D1 integration tests for enrichment quota reservation.
 *
 * Exercises reserveEnrichmentSlot against actual SQLite semantics via the
 * workers-pool D1 binding (REAL_MIGRATIONS = full ./migrations chain). The
 * boundary rows below are the exact cases the SQL-level bugs lived in:
 *
 *   - original bug:  RETURNING `request_count <= limit` kept approving
 *     reservations once the counter parked exactly at the limit
 *   - over-correction: `request_count < limit` rejects the limit-th call
 *
 * Mocked-D1 unit tests cannot catch either; only real RETURNING behavior can.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { reserveEnrichmentSlot } from '../src/db/quota';

const TODAY = '2026-08-28';

async function seedCount(count: number): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO enrichment_limits (date, request_count, last_updated)
    VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET request_count = excluded.request_count
  `).bind(TODAY, count, Date.now()).run();
}

async function readCount(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT request_count FROM enrichment_limits WHERE date = ?`
  ).bind(TODAY).first<{ request_count: number }>();
  return row?.request_count ?? 0;
}

describe('reserveEnrichmentSlot — boundary semantics (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enrichment_limits').run();
  });

  it('reserves the first slot on a fresh day', async () => {
    const result = await reserveEnrichmentSlot(env.DB, TODAY, 500);
    expect(result.reserved).toBe(true);
    expect(result.requestCount).toBe(1);
    expect(await readCount()).toBe(1);
  });

  it('reserves the limit-th slot when the counter is at limit - 1', async () => {
    await seedCount(499);
    const result = await reserveEnrichmentSlot(env.DB, TODAY, 500);
    expect(result.reserved).toBe(true);
    expect(result.requestCount).toBe(500);
    expect(await readCount()).toBe(500);
  });

  it('rejects when the counter is parked exactly at the limit', async () => {
    await seedCount(500);
    const result = await reserveEnrichmentSlot(env.DB, TODAY, 500);
    expect(result.reserved).toBe(false);
    expect(result.requestCount).toBe(500);
    expect(await readCount()).toBe(500);
  });

  it('never lets the counter exceed the limit across repeated attempts', async () => {
    await seedCount(498);
    for (let i = 0; i < 5; i++) {
      await reserveEnrichmentSlot(env.DB, TODAY, 500);
    }
    expect(await readCount()).toBe(500);
  });

  it('fails closed when the daily limit is 0', async () => {
    const result = await reserveEnrichmentSlot(env.DB, TODAY, 0);
    expect(result.reserved).toBe(false);
    expect(await readCount()).toBe(0);
  });
});
