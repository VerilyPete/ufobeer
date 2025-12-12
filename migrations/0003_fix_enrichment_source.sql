-- Migration: Fix incorrect enrichment_source values
-- Purpose: Records with confidence=0.9 were parsed from description but got
-- 'perplexity' from the old schema DEFAULT. Fix them to show 'description'.
--
-- Run with: npx wrangler d1 execute ufobeer-db --remote --file=migrations/0003_fix_enrichment_source.sql

-- Fix records that have description-parsed ABV (confidence=0.9) but wrong source
UPDATE enriched_beers
SET enrichment_source = 'description'
WHERE confidence = 0.9
  AND enrichment_source = 'perplexity';

-- Records with confidence=0.7 are legitimately from Perplexity (no change needed)
-- Records with confidence IS NULL have not been enriched yet (no change needed)
