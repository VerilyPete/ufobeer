-- Migration: Add last_seen_at column to enriched_beers
-- Purpose: Track when beers are last seen on Flying Saucer taplists
-- This enables cleanup of stale description-parsed beers while preserving Perplexity data
--
-- Run with: npx wrangler d1 execute ufobeer-db --remote --file=migrations/0002_add_last_seen_at.sql

-- Add last_seen_at column (nullable to avoid breaking existing data)
ALTER TABLE enriched_beers ADD COLUMN last_seen_at INTEGER;

-- Backfill existing records with updated_at value as initial estimate
UPDATE enriched_beers SET last_seen_at = updated_at WHERE last_seen_at IS NULL;

-- Create composite index for efficient cleanup queries
-- enrichment_source FIRST (equality filter), then last_seen_at (range scan)
CREATE INDEX IF NOT EXISTS idx_source_last_seen
ON enriched_beers(enrichment_source, last_seen_at);
