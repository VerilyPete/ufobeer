---
title: Store-level taplist cache proxy for GET /beers
implemented: 2026-02-27
commit: b635e7a
tags: [cache, d1, taplist, proxy, stale-fallback, analytics]
---

## Problem

GET `/beers` called Flying Saucer on every request — no caching, full latency on each app open, hard failure when upstream was down. The app needed a "proxy first" architecture: fast cached responses normally, live data on pull-to-refresh, graceful degradation when upstream fails.

## Decision

Added a store-level D1 cache (`store_taplist_cache` table, one row per store) storing the merged beers array as JSON. TTL is 5 minutes (configurable via `CACHE_TTL_MS`).

**Cache outcomes** are a discriminated union (`CacheOutcome = 'hit' | 'miss' | 'stale' | 'bypass'`) tracked in Analytics Engine as `blob9` — one string dimension instead of multiple booleans.

**Response contract** gained `source: 'live' | 'cache' | 'stale'` and `cached_at` (ISO 8601, always present, never null). `cached_at` on live responses is the current request time so the app can always show "Updated X min ago" without special-casing.

**Cache write** uses `ctx.waitUntil()` so D1 write latency doesn't block the HTTP response. A write failure is logged and dropped — cache is an optimization, not a gate.

**Stale fallback** intercepts both non-2xx and network error paths before returning 4xx/5xx, serving the cached array with `source: 'stale'` if any cache row exists.

**`fresh=true`** query param bypasses cache read but still writes through after a live fetch.

**`response_json` trust boundary**: parsed via `CachedBeersArraySchema` (Zod `safeParse`). Corrupt or schema-mismatched data gracefully degrades to a cache miss rather than a 500. `requestId` is never stored in cache — it's generated per-request.

D1 cache lookup uses `.first<CachedTaplistRow>()` (not array index access) to avoid `undefined` from `noUncheckedIndexedAccess`.

Migration: `migrations/0005_add_store_taplist_cache.sql`. A speculative `cached_at` index was dropped in a follow-up migration (0006) — the table is bounded at ~15 rows and only ever queried by PK.

## Trade-offs

- **Enrichment staleness on cache hit**: ABV/cleaned descriptions reflect when the cache was written, not the current enrichment state. Acceptable at 5 min TTL.
- **New beers delayed in enrichment pipeline**: Cache hits skip `insertPlaceholders()`, so new beers wait at most 1 TTL before entering enrichment. Acceptable.
- **`fresh=true` stampede risk**: Existing 60 RPM rate limiter applies. No per-fresh throttle added — closed API key model makes coordinated abuse low risk.
- **Race on concurrent cache misses**: Both requests write; last write wins via UPSERT. D1 serializes writes; both values are equally fresh.
- App-side changes (reading `source`/`cached_at`, mapping pull-to-refresh to `?fresh=true`) are out of scope.
