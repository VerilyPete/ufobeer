import { CachedBeersArraySchema } from '../schemas/cache';
import type { CachedBeer } from '../schemas/cache';

export type CachedTaplistRow = {
  readonly store_id: string;
  readonly response_json: string;
  readonly cached_at: number;
};

export async function getCachedTaplist(
  db: D1Database,
  storeId: string,
): Promise<CachedTaplistRow | null> {
  return db
    .prepare('SELECT store_id, response_json, cached_at FROM store_taplist_cache WHERE store_id = ?')
    .bind(storeId)
    .first<CachedTaplistRow>();
}

export async function setCachedTaplist(
  db: D1Database,
  storeId: string,
  beers: readonly Record<string, unknown>[],
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO store_taplist_cache (store_id, response_json, cached_at) VALUES (?, ?, ?) ON CONFLICT(store_id) DO UPDATE SET response_json = excluded.response_json, cached_at = excluded.cached_at'
    )
    .bind(storeId, JSON.stringify(beers), Date.now())
    .run();
}

export function parseCachedBeers(responseJson: string): readonly CachedBeer[] | null {
  try {
    const parsed: unknown = JSON.parse(responseJson);
    const result = CachedBeersArraySchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}
