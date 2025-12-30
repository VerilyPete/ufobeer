-- Migration: Add queued_for_cleanup_at column to enriched_beers
-- Purpose: Track when beers were queued for description cleanup to prevent re-queueing
-- This reduces redundant queue messages for beers that are already being processed
--
-- Run with: npx wrangler d1 execute ufobeer-db --remote --file=migrations/0004_add_queued_for_cleanup_at.sql

-- Add queued_for_cleanup_at column (nullable - null means never queued)
ALTER TABLE enriched_beers ADD COLUMN queued_for_cleanup_at INTEGER;

-- Create partial index for efficient lookups of recently queued beers
-- Only indexes rows where queued_for_cleanup_at is not null (partial index)
CREATE INDEX IF NOT EXISTS idx_enriched_beers_queued_cleanup
ON enriched_beers(queued_for_cleanup_at) WHERE queued_for_cleanup_at IS NOT NULL;
