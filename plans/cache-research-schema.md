# Cache Research: Schema & Migration Findings

## 1. Current `enriched_beers` Columns

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Flying Saucer beer ID (global across locations) |
| `brew_name` | TEXT NOT NULL | Beer name |
| `brewer` | TEXT | Brewery name |
| `abv` | REAL | Enriched ABV (nullable — null = not yet enriched) |
| `confidence` | REAL DEFAULT 0.5 | Enrichment confidence score |
| `enrichment_source` | TEXT | `'description'` \| `'perplexity'` \| NULL |
| `updated_at` | INTEGER | Last write timestamp (ms) |
| `last_seen_at` | INTEGER | When beer was last on any taplist (ms) |
| `last_verified_at` | INTEGER | NULL in practice; not actively written |
| `is_verified` | INTEGER DEFAULT 0 | Manual verification flag |
| `brew_description_original` | TEXT | Raw description from Flying Saucer |
| `brew_description_cleaned` | TEXT | LLM-cleaned version |
| `description_hash` | TEXT | SHA-256 (truncated) for change detection |
| `description_cleaned_at` | INTEGER | When LLM cleanup ran |
| `cleanup_source` | TEXT | `'workers-ai'` \| `'groq'` \| NULL |
| `queued_for_cleanup_at` | INTEGER | Prevents re-queueing (nullable) |

**No `store_id` column.** Beers are global (same beer ID across all stores). `last_seen_at` is per-beer, not per-store.

## 2. Flying Saucer Fields NOT in `enriched_beers`

From `FlyingSaucerBeerSchema` (src/schemas/external.ts) and the `FlyingSaucerBeer` type:

| FS Field | In `enriched_beers`? | Notes |
|---|---|---|
| `id` | Yes (PK) | |
| `brew_name` | Yes | |
| `brewer` | Yes | |
| `brew_description` | Yes (as `brew_description_original`) | |
| `container_type` | **No** | e.g. "draft", "bottle" — comes from FS only |
| `[key: string]: unknown` | **No** | Schema uses `.passthrough()` — additional fields pass through at runtime but are not stored |

The schema uses `.passthrough()`, meaning Flying Saucer may return fields beyond the four named ones (id, brew_name, brewer, brew_description, container_type). These extra fields are currently passed through to the API response via `{ ...beer, enriched_abv, ... }` spread in the GET handler but are never persisted to D1.

**Key implication for a full-response cache:** To serve a complete cached response, we'd need to store the full FS response per beer per store (including `container_type` and any passthrough fields), not just the enrichment overlay. The current `enriched_beers` table only holds enrichment data, not the raw FS beer shape.

## 3. New Table vs. Expand Existing

**Recommendation: New table — `store_beer_cache`**

Rationale:
- `enriched_beers` is a global beer index (one row per beer ID, shared across stores). Adding store-level cache data would denormalize it badly — each beer could appear at multiple stores.
- Cache data (raw FS fields like `container_type`, passthrough fields, store context) is structurally different from enrichment data (ABV, confidence, cleanup). Mixing them violates single-responsibility.
- A separate table lets the cache TTL/invalidation logic be independent of enrichment pipeline logic.
- Schema: `(store_id, beer_id)` composite PK with a `cached_at` timestamp and a `raw_json` blob storing the full FS beer object per store.

## 4. Store-Level Cache Tracking

Proposed `store_beer_cache` table:

```sql
CREATE TABLE store_beer_cache (
    store_id TEXT NOT NULL,
    beer_id  TEXT NOT NULL,
    raw_json TEXT NOT NULL,       -- Full FS beer object as JSON
    cached_at INTEGER NOT NULL,   -- ms epoch, used for TTL checks
    PRIMARY KEY (store_id, beer_id)
);

CREATE INDEX idx_store_cache_store_id ON store_beer_cache(store_id, cached_at);
```

For full-list freshness (did the whole taplist change?), a separate `store_taplist_cache` table may be simpler:

```sql
CREATE TABLE store_taplist_cache (
    store_id    TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,  -- Full merged response JSON
    cached_at   INTEGER NOT NULL
);
```

This avoids per-beer complexity when the invalidation unit is the whole store response. Simpler to invalidate, simpler to write (single upsert per request), no JOIN needed on read.

## 5. Migration Pattern

All three existing migrations follow this pattern:

1. **Filename:** `NNNN_descriptive_name.sql` (zero-padded 4-digit sequence)
2. **Header comment:** Purpose, run command (`npx wrangler d1 execute ufobeer-db --remote --file=...`)
3. **`ALTER TABLE ... ADD COLUMN`** with nullable columns to avoid breaking existing data
4. **Backfill `UPDATE`** where needed for data consistency
5. **`CREATE INDEX IF NOT EXISTS`** with a comment on query pattern it supports

Next migration would be `0005_add_store_taplist_cache.sql` (or `_store_beer_cache` depending on design choice).

Example skeleton:
```sql
-- Migration: Add store taplist cache table
-- Purpose: Cache full GET /beers responses per store to reduce Flying Saucer upstream calls
--
-- Run with: npx wrangler d1 execute ufobeer-db --remote --file=migrations/0005_add_store_taplist_cache.sql

CREATE TABLE IF NOT EXISTS store_taplist_cache (
    store_id      TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    cached_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_store_taplist_cache_cached_at
ON store_taplist_cache(cached_at);
```

## 6. `last_seen_at` Usage and Cache Relevance

**Current usage:**
- Updated on every beer upsert in `insertPlaceholders` (background task fired by GET /beers and POST /beers/sync)
- Used by `idx_source_last_seen` index — intended for cleanup queries (finding stale beers)
- Not currently used by any cache invalidation logic

**Cache invalidation relevance:** `last_seen_at` is per-beer and tracks when a beer was last present on *any* store's taplist. It is **not** per-store, so it cannot tell you whether a specific store's taplist is stale.

For store-level cache invalidation, `cached_at` in the new cache table is the right field. A TTL comparison (`now - cached_at > TTL_MS`) is sufficient — no dependency on `last_seen_at` needed.

`last_seen_at` could indirectly help detect beers that have rotated off a taplist (if `last_seen_at` is old and the beer no longer appears in FS response), but the simpler approach is to replace the cached response wholesale on cache miss or TTL expiry.
