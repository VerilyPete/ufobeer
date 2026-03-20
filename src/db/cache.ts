import { CachedBeersArraySchema } from '../schemas/cache';
import type { CachedBeer } from '../schemas/cache';

export type CachedTaplistRow = {
  readonly store_id: string;
  readonly response_json: string;
  readonly cached_at: number;
  readonly content_hash: string | null;
  readonly enrichment_hash: string | null;
};

export async function getCachedTaplist(
  db: D1Database,
  storeId: string,
): Promise<CachedTaplistRow | null> {
  return db
    .prepare('SELECT store_id, response_json, cached_at, content_hash, enrichment_hash FROM store_taplist_cache WHERE store_id = ?')
    .bind(storeId)
    .first<CachedTaplistRow>();
}

export async function setCachedTaplist(
  db: D1Database,
  storeId: string,
  beers: readonly Record<string, unknown>[],
  contentHash: string,
  enrichmentHash?: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO store_taplist_cache (store_id, response_json, cached_at, content_hash, enrichment_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store_id) DO UPDATE SET response_json = excluded.response_json, cached_at = excluded.cached_at, content_hash = excluded.content_hash, enrichment_hash = excluded.enrichment_hash'
    )
    .bind(storeId, JSON.stringify(beers), Date.now(), contentHash, enrichmentHash ?? null)
    .run();
}

export async function updateCacheTimestamp(
  db: D1Database,
  storeId: string,
): Promise<void> {
  await db
    .prepare('UPDATE store_taplist_cache SET cached_at = ? WHERE store_id = ?')
    .bind(Date.now(), storeId)
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
