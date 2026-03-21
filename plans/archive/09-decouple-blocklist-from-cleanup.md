---
title: Decouple enrichment blocklist from description cleanup pipeline
implemented: 2026-03-02
commit: fb4b2df
tags: [blocklist, cleanup, enrichment, pipeline, description-cleanup]
---

## Problem

`shouldSkipEnrichment()` (blocking flights, root beer, pairings, etc.) was applied to both the ABV enrichment pipeline AND the description cleanup pipeline. The intent was only to skip ABV lookup — blocklisted items still have grammar/spelling/formatting issues in their descriptions that benefit from Workers AI cleanup.

## Decision

Removed the blocklist filter from `queueBeersForCleanup()` and `cleanupTrigger.ts`. All beers now enter the description cleanup queue regardless of blocklist status.

Added `shouldSkipEnrichment()` guards at three Perplexity forwarding sites in the cleanup consumer (`src/queue/cleanup.ts`): two in `buildBatchOperations` (`success_no_abv` and `fallback_no_abv` cases) and one in `handleFallbackBatch`. The DB update (cleaned description) still happens for blocklisted beers; only the Perplexity ABV enrichment forwarding is blocked.

Removed `beers_skipped` from `TriggerCleanupData`, `CleanupTriggerMetrics`, and all response/analytics call sites — the field no longer has meaning since blocklisted beers are no longer skipped at the trigger level.

Blocklisted beers that enter cleanup may temporarily have `enrichment_status = 'pending'` (via `description_changed` sync). The cron self-corrects this to `'skipped'` within 12 hours — acceptable, avoids adding new category types.

## Trade-offs

- Cron/admin enrichment triggers and the enrichment consumer retain independent blocklist filters — no changes needed there.
- The 12-hour window of `pending` status for blocklisted beers entering cleanup is a known acceptable transient state.
- `beers_skipped` field removed from API response — callers relying on it will see the field absent (breaking if any client depended on it, but this is an internal admin API).
