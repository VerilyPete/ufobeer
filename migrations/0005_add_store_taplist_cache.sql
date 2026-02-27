-- Store-level taplist cache for GET /beers proxy
-- One row per store, storing the full merged beers array as JSON.
-- Bounded by VALID_STORE_IDS (~15 stores max). No eviction needed.

CREATE TABLE IF NOT EXISTS store_taplist_cache (
    store_id      TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    cached_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_store_taplist_cache_cached_at
ON store_taplist_cache(cached_at);
