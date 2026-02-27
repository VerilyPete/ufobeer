-- NOT IDEMPOTENT: relies on migration tracking to prevent re-runs
ALTER TABLE enriched_beers ADD COLUMN enrichment_status TEXT NOT NULL DEFAULT 'pending';

-- Backfill: beers with ABV are already enriched
UPDATE enriched_beers SET enrichment_status = 'enriched' WHERE abv IS NOT NULL;

-- Replace partial index: old heuristic (abv IS NULL) -> explicit status
DROP INDEX IF EXISTS idx_needs_enrichment;
CREATE INDEX idx_needs_enrichment ON enriched_beers(id) WHERE enrichment_status = 'pending';
