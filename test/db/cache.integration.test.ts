/**
 * The store taplist cache against real D1: what is written is what is read
 * back, column for column, and a second write replaces the first.
 */

import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCachedTaplist, setCachedTaplist, updateCacheTimestamp } from '../../src/db/cache';

const STORE_ID = '13879';
const OTHER_STORE_ID = '13885';
const BEERS = [{ id: 'beer-1', brew_name: 'Pecan Porter', brewer: '(512) Brewing Co.' }];
const T0 = new Date('2026-03-01T12:00:00Z');
const T1 = new Date('2026-03-01T12:05:00Z');

describe('store taplist cache (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM store_taplist_cache').run();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads back exactly what was written', async () => {
    await setCachedTaplist(env.DB, STORE_ID, BEERS, 'content-1', 'enrichment-1');

    expect(await getCachedTaplist(env.DB, STORE_ID)).toEqual({
      store_id: STORE_ID,
      response_json: JSON.stringify(BEERS),
      cached_at: T0.getTime(),
      content_hash: 'content-1',
      enrichment_hash: 'enrichment-1',
    });
  });

  it('replaces an earlier entry for the same store, clearing an omitted enrichment hash', async () => {
    await setCachedTaplist(env.DB, STORE_ID, BEERS, 'content-1', 'enrichment-1');
    vi.setSystemTime(T1);

    await setCachedTaplist(env.DB, STORE_ID, [], 'content-2');

    expect(await getCachedTaplist(env.DB, STORE_ID)).toEqual({
      store_id: STORE_ID,
      response_json: '[]',
      cached_at: T1.getTime(),
      content_hash: 'content-2',
      enrichment_hash: null,
    });
  });

  it('refreshes only the timestamp when touched', async () => {
    await setCachedTaplist(env.DB, STORE_ID, BEERS, 'content-1', 'enrichment-1');
    vi.setSystemTime(T1);

    await updateCacheTimestamp(env.DB, STORE_ID);

    expect(await getCachedTaplist(env.DB, STORE_ID)).toEqual({
      store_id: STORE_ID,
      response_json: JSON.stringify(BEERS),
      cached_at: T1.getTime(),
      content_hash: 'content-1',
      enrichment_hash: 'enrichment-1',
    });
  });

  it('keeps each store separate when one is read, replaced or touched', async () => {
    await setCachedTaplist(env.DB, STORE_ID, BEERS, 'content-1', 'enrichment-1');
    await setCachedTaplist(env.DB, OTHER_STORE_ID, [], 'other-content', 'other-enrichment');
    const other = await getCachedTaplist(env.DB, OTHER_STORE_ID);
    vi.setSystemTime(T1);

    await setCachedTaplist(env.DB, STORE_ID, [], 'content-2');
    await updateCacheTimestamp(env.DB, STORE_ID);

    expect(await getCachedTaplist(env.DB, OTHER_STORE_ID)).toEqual(other);
    expect(other).toMatchObject({ store_id: OTHER_STORE_ID, content_hash: 'other-content', cached_at: T0.getTime() });
    expect(await getCachedTaplist(env.DB, STORE_ID)).toMatchObject({ content_hash: 'content-2' });
    expect(await getCachedTaplist(env.DB, 'no-such-store')).toBeNull();
  });
});
