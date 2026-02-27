-- Remove speculative index — no production code queries by cached_at.
-- The table has ~15 rows (bounded by VALID_STORE_IDS), so the index
-- adds only negligible overhead, but keeping unused indexes violates
-- YAGNI. Re-add when a query actually needs it.

DROP INDEX IF EXISTS idx_store_taplist_cache_cached_at;
