-- NOT IDEMPOTENT: ALTER TABLE ADD COLUMN (documented exception, AGENTS.md).
ALTER TABLE store_taplist_cache ADD COLUMN enrichment_hash TEXT;
