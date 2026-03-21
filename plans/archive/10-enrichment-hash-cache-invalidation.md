---
title: Enrichment Hash Cache Invalidation
implemented: 2026-03-21
commit: f57bb91
tags: [cache, etag, enrichment, d1, store_taplist_cache]
---

## Problem

`store_taplist_cache` only tracked `content_hash` (raw FS taplist). When enrichment data (ABV, cleaned descriptions) was added to `enriched_beers` after cache creation, the cache served stale null-ABV data because the raw taplist hadn't changed.

## Decision

Added `enrichment_hash` column to `store_taplist_cache`. Cache rewrites when either `content_hash` OR `enrichment_hash` changes. All three ETag construction points (cache-hit, live-fetch, stale fallback) use `buildCombinedEtag(contentHash, enrichmentHash)` so clients get correct 304s reflecting both dimensions.

Intentionally reversed the "enrichment changes don't bust ETags" decision from `1d5aecf` — that was the root cause. One-time forced revalidation for all clients on deploy.

## Trade-offs

- **Enrichment fetch failure safety**: When D1 returns an empty enrichment map but beers exist, `enrichmentHash` is set to `null`, skipping enrichment comparison entirely. Prevents the inverse bug (stripping cached ABV on transient D1 failure).
- **Zero-enrichment stores**: If a store has no enriched beers, enrichment hash is permanently suppressed — ETag reflects only `content_hash`. Self-resolves when the first beer gets enrichment.
- **`computeEnrichmentHash` serialization is explicit**: Fields are enumerated in fixed order (`abv`, `confidence`, `source`, `brew_description_cleaned`). Future enrichment fields must be added here and to the corresponding test.
- **Not done**: Extracting `writeCacheIfChanged` helper (cache write decision block is duplicated between `refreshTaplistForStore` and `handleBeerList` — pre-existing, out of scope).
