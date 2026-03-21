---
title: Cache proxy review fixes — missing tests, refactoring, index cleanup
implemented: 2026-03-20
commit: f57bb91
tags: [cache, refactoring, etag, tests, migration]
---

## Problem

Three code review findings on the cache proxy (06):

1. **Missing test coverage** for corrupt-cache-during-hit and corrupt-cache-during-stale-fallback paths (both branches were correctly implemented but untested).
2. **Duplicated stale fallback response construction** in two handler branches (`!fsResp.ok` and `catch`).
3. **Speculative `cached_at` index** on a table bounded at ~15 rows with no queries by that column.
4. **`||` instead of `??`** for description fallback — `||` drops empty-string cleaned descriptions, falling back to original. Behavior bug.

Additionally, commits 1d5aecf and edaaaeb (between b635e7a and f57bb91) added ETag/If-None-Match support and fixed Cloudflare's weak ETag conversion.

## Decision

**Tests first (Group A)**: Added 3 tests for corrupt-cache paths before any refactoring — these established coverage protecting subsequent changes.

**Refactoring (Group B)**:
- Extracted `serveStaleFallback()` pure function, eliminating duplication between the `!fsResp.ok` and `catch` stale fallback paths.
- Simplified `cachedRow` type annotation from `Awaited<ReturnType<typeof getCachedTaplist>>` to `CachedTaplistRow | null`.
- Removed redundant `useCleanedDesc` boolean (replaced with direct truthiness check).
- Fixed `||` to `??` for description fallback (empty-string cleaned descriptions now preserved).

**Migration (Group C)**: Added `migrations/0006_drop_cached_at_index.sql` to drop the speculative index. The existing migration 0005 was already applied in production and cannot be edited.

**ETag support** (1d5aecf): Added `ETag` header to GET /beers responses and `If-None-Match` conditional request handling for 304 responses.

**Weak ETag fix** (edaaaeb): Cloudflare automatically converts strong ETags (`"hash"`) to weak ETags (`W/"hash"`) when applying compression. The `If-None-Match` comparison now strips `W/` prefix before matching, per RFC 7232 weak comparison.

## Trade-offs

- Group D (pre-existing issues) documented but not fixed: dual `FlyingSaucerBeer` definition, `as unknown[]` assertion on `fsResp.json()`, mutable arrays in `AnalyticsEngineDataset` interface.
- Empty-string `??` fix is a behavior change but correct — empty string cleaned description means "we cleaned it to empty" and should be preserved.
- New migration for index drop rather than editing 0005 (which is already in production).
