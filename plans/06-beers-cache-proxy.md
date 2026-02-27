# Phase 6: GET /beers Cache + Proxy

## Goal

Make GET `/beers` a caching proxy so the mobile app can use the Worker as its
primary data source. Cached responses are served instantly; users can
force-refresh (pull-to-refresh) to get live data when rare/limited beers drop.

## Problem

Today GET `/beers` calls Flying Saucer on every request, merges enrichment data,
and returns the result. There is no caching — every app open hits the upstream
API, adding latency and creating a hard failure when Flying Saucer is down.

The new app flow ("proxy first") needs:
- Fast cached responses for normal browsing
- A `fresh=true` bypass for pull-to-refresh
- Stale fallback when Flying Saucer is unreachable
- Cache metadata (`cached_at`, `source`) so the app can show freshness

## Design Decisions

### Store-level cache table (not per-beer)

The cache invalidation unit is the whole store taplist — when one beer changes,
the list changed. A single row per store storing the full merged response JSON
is simpler than per-beer rows with JOINs.

`enriched_beers` stays untouched — it's a global enrichment index. The cache
table is a separate concern.

The table is bounded by `VALID_STORE_IDS` (currently ~1 store, at most ~15).
No eviction strategy needed — the table will never exceed ~15 rows.

### TTL-based invalidation

`cached_at` timestamp compared against a configurable TTL (default 5 minutes).
No ETag/conditional logic — Flying Saucer doesn't support it, and TTL is
sufficient for a taplist that changes a few times per day.

**Known trade-off — enrichment staleness on cache hits:** The cached response
contains enrichment data (ABV, cleaned descriptions) as of when the cache was
written. If a queue consumer updates `enriched_beers` after the cache write,
the cache will serve stale enrichment data until TTL expires. This is acceptable
at a 5-min TTL — ABV rarely changes, and pull-to-refresh gets fresh data.

**Known trade-off — enrichment pipeline delay on cache hits:** Cache hits skip
`insertPlaceholders()`, so new beers that appeared on the taplist between cache
writes will not enter the enrichment pipeline until the next live fetch (at most
1 TTL). At 5 minutes this is acceptable.

### Response contract (additive only)

```json
{
  "beers": [...],
  "storeId": "13879",
  "requestId": "uuid",
  "source": "live" | "cache" | "stale",
  "cached_at": "2026-02-26T12:00:00.000Z"
}
```

`source` and `cached_at` are new top-level fields. No existing fields change —
purely additive.

**`source` has three values:**
- `"live"` — fetched from Flying Saucer this request
- `"cache"` — served from cache, within TTL (normal fast path)
- `"stale"` — served from cache because upstream failed (degraded; TTL expired)

**`cached_at` is always an ISO 8601 string, never null or optional.** On live
responses it's the current request time. On cache/stale responses it's when the
cache was written. This lets the app always show "Updated X min ago" without
special-casing null.

## Type Definitions

### New types in `src/types.ts`

```typescript
type TaplistSource = 'live' | 'cache' | 'stale';
```

Named literal union — never bare `string`. Exported and used in both the
response construction and `src/db/cache.ts`.

### D1 row type in `src/db/cache.ts`

```typescript
type CachedTaplistRow = {
  readonly store_id: string;
  readonly response_json: string;
  readonly cached_at: number;  // ms epoch, consistent with rest of codebase
};
```

This is the D1 shape. `cached_at` is `number` (ms epoch) in storage, converted
to ISO 8601 `string` in the handler when building the response. The conversion
happens in the handler, not in the cache helper — the helper returns the raw
D1 row.

### Cache read uses `.first<CachedTaplistRow>()`

`getCachedTaplist` returns `CachedTaplistRow | null` using D1's `.first()`
method, not array index access. This avoids `T | undefined` from
`noUncheckedIndexedAccess` and is consistent with how other D1 queries work
in this codebase.

### `response_json` parsing — Zod schema at trust boundary

`response_json` is a `TEXT` column read from D1. `JSON.parse()` returns `any`,
which silently propagates under `noImplicitAny`. This data crosses a trust
boundary (D1 storage → handler) and the schema could evolve, so it must be
validated.

Add a `CachedBeersArraySchema` in `src/schemas/` that validates the parsed
array. Use `safeParse` (not `parse`) so that corrupted or schema-mismatched
data returns `null` (graceful cache miss with warning log) instead of throwing
a ZodError that propagates as a 500:

```typescript
const result = CachedBeersArraySchema.safeParse(JSON.parse(row.response_json));
if (!result.success) {
  log.warn('Cache parse failed, treating as miss', { error: result.error });
  return null;
}
return result.data;
```

The `JSON.parse` call is also wrapped in try/catch — if the stored JSON is
corrupted (truncated write, encoding issue), it throws before Zod even runs.
Both failure modes gracefully degrade to a cache miss.

This schema can reuse/compose the existing merged beer shape rather than
redefining fields from scratch.

### `setCachedTaplist` stores the beers array only

`setCachedTaplist` calls `JSON.stringify(enrichedBeers)` — the merged beers
array only, NOT the full response object. `requestId` is per-request and must
not be cached. `storeId` and `source` are derived at response time. The cache
stores only the data that is stable across requests.

### `GetBeersResult` extension — required fields, not optional

Today:
```typescript
type GetBeersResult = {
  readonly response: Response;
  readonly beersReturned: number;
  readonly upstreamLatencyMs: number;
};
```

Extended to:
```typescript
type GetBeersResult = {
  readonly response: Response;
  readonly beersReturned: number;
  readonly upstreamLatencyMs: number;
  readonly cacheOutcome: CacheOutcome;
};
```

Where `CacheOutcome` captures the full cache state in a single field:

```typescript
type CacheOutcome = 'hit' | 'miss' | 'stale' | 'bypass';
```

- `"hit"` — served from cache within TTL
- `"miss"` — no cache or TTL expired, fetched live
- `"stale"` — TTL expired and upstream failed, served stale cache
- `"bypass"` — `fresh=true` requested, fetched live regardless of cache

This replaces the three separate booleans (`cacheHit`, `staleFallback`,
`freshRequested`) with a single discriminated value. The states are mutually
exclusive — a request is exactly one of these.

On cache hits where there is no upstream call, `upstreamLatencyMs` is `0`.
Do not use `undefined` — the field is not optional.

## Schema Change

### New table: `store_taplist_cache`

```sql
CREATE TABLE IF NOT EXISTS store_taplist_cache (
    store_id      TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    cached_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_store_taplist_cache_cached_at
ON store_taplist_cache(cached_at);
```

One row per store. `response_json` holds the full `beers` array (already merged
with enrichment data, typically 20-80 KB). `cached_at` is ms epoch for TTL
comparison, consistent with other timestamps in the codebase.

The `cached_at` index is not needed for normal lookups (always by PK) but
supports potential future eviction queries.

### Migration file

`migrations/0005_add_store_taplist_cache.sql`

## Implementation Steps (TDD)

### Handler test setup

Add `vi.mock('../../src/db/cache')` at the module level in
`test/handlers/beers.list.test.ts`, following the existing pattern for `db`
and `queue` mocks. Cache helper tests in `test/db/cache.test.ts` test against
D1 directly; handler tests mock the cache module to avoid coupling to D1
internals.

### Step 1: Cache helpers + schema

**RED:** Test the cache read/write helpers and Zod schema in isolation.

Tests (`test/db/cache.test.ts`):
- `getCachedTaplist` returns `null` when no row exists for the store
- `getCachedTaplist` returns `CachedTaplistRow` when row exists
- `setCachedTaplist` writes a row that `getCachedTaplist` can read back
- `setCachedTaplist` overwrites existing row (UPSERT behavior)
- `CachedBeersArraySchema` parses a valid beers array
- `CachedBeersArraySchema` rejects malformed data (missing required fields)

**GREEN:**
- Create `src/db/cache.ts` with `getCachedTaplist(db, storeId)` using
  `.first<CachedTaplistRow>()` and `setCachedTaplist(db, storeId, beers)`
  using `INSERT ... ON CONFLICT ... DO UPDATE`
- Create `CachedBeersArraySchema` in `src/schemas/` (compose from existing
  beer schema)
- Add `TaplistSource` type and `CachedTaplistRow` type

### Step 2: Cache read — serve from cache on hit

**RED:** Test that when the cache has a fresh entry, the handler returns it
without calling Flying Saucer.

Tests (`test/handlers/beers.list.test.ts`):
- Cache hit within TTL returns cached beers with `source: "cache"` and
  `cached_at` as ISO timestamp string
- Cache hit returns fresh `requestId` (generated per-request, not from cache)
- Cache hit returns correct `storeId`
- Cache hit does not trigger upstream fetch
- Cache hit does NOT trigger background enrichment
- Response shape matches existing contract plus new `source` and `cached_at`

**GREEN:** Add cache lookup at the top of `handleBeerList`. If a row exists
and `now - cached_at < CACHE_TTL_MS`, parse `response_json` through
`CachedBeersArraySchema`, convert `cached_at` from ms epoch to ISO string,
and return with `source: "cache"`. Early return skips both upstream fetch and
`ctx.waitUntil` enrichment.

### Step 3: Cache miss — fetch live, write through, fire enrichment

**RED:** Test that when no cache entry exists (or entry is stale), the handler
calls Flying Saucer, merges enrichment, writes to cache, and returns with
`source: "live"`.

Tests:
- Cache miss triggers upstream fetch
- Response is written to `store_taplist_cache` after successful fetch
- Stale cache (beyond TTL) triggers upstream fetch and refreshes cache
- Response includes `source: "live"` and `cached_at` as current time ISO string
- Cache write failure does not prevent live response from returning
- Empty taplist (`beers: []`) is cached and returned correctly
- Live fetch triggers `ctx.waitUntil(processBackgroundEnrichment(...))`

**GREEN:** After the existing fetch-and-merge logic, write the cache via
`ctx.waitUntil(setCachedTaplist(...).catch(err => log.error(...)))`. This
prevents D1 write latency from blocking the HTTP response — the response is
already assembled and the cache is an optimization, not a gate. This follows
the same pattern as `ctx.waitUntil(processBackgroundEnrichment(...))`.

Return with `source: "live"` and `cached_at` as `new Date().toISOString()`.
`upstreamLatencyMs` populated as today; on cache hits (Step 2) it is `0`.

### Step 4: Force refresh — `fresh=true` bypass

**RED:** Test that `fresh=true` query param bypasses cache even when a fresh
cache entry exists.

Tests:
- `fresh=true` calls Flying Saucer even with fresh cache
- `fresh=true` updates the cache entry with new data
- `fresh=true` returns `source: "live"` and current `cached_at`
- `fresh=true` triggers background enrichment
- `fresh=false` and absent `fresh` param use cache normally
- `fresh=true` with upstream failure falls back to stale cache
  (returns `source: "stale"`)

**GREEN:** Check `url.searchParams.get('fresh') === 'true'` before cache
lookup. If true, skip cache read and go straight to upstream fetch. Still
write through to cache after. On upstream failure, fall through to Step 5's
stale fallback logic.

Note: `searchParams.get()` returns `string | null`. The `=== 'true'` comparison
handles the null case implicitly — no `.has()` needed.

### Step 5: Stale fallback — serve cache when upstream fails

**RED:** Test that when Flying Saucer returns non-2xx or network error, the
handler falls back to cached data (even if stale).

Tests:
- Upstream 502 with stale cache returns cached beers with `source: "stale"`
  and original `cached_at` timestamp (from when cache was written)
- Upstream network error with stale cache returns `source: "stale"`
- Upstream failure with NO cache returns 502 (existing behavior preserved)
- Stale fallback includes fresh `requestId` (per-request, not from cache)

**GREEN:** The stale fallback must intercept **both** failure paths in the
current handler:

1. **`!fsResp.ok` branch** (non-2xx response) — currently returns 502 immediately.
   Change this to attempt a stale cache lookup before returning 502.
2. **`catch` block** (network error, DNS failure, timeout) — currently returns 500.
   Change this to attempt a stale cache lookup before returning 500.

Both paths need `env.DB` and `storeId` to call `getCachedTaplist`. These are
already accessible: `storeId` is a function parameter and `env.DB` is available
from the outer scope. The key structural change is that the `!fsResp.ok` branch
must not early-return a 502 — it must fall through to (or call) the same stale
fallback logic as the catch block.

If cache exists, parse through `CachedBeersArraySchema` (safeParse — returns
null on failure) and return with `source: "stale"`. If no cache or parse
fails, return the existing error response (502/500).

### Step 6: Analytics — track cache outcome

**RED:** Test that cache outcomes are tracked in analytics.

Tests:
- Cache hit tracks `cacheOutcome: "hit"` → `blob9: "hit"` in Analytics Engine
- Cache miss tracks `cacheOutcome: "miss"` → `blob9: "miss"`
- Stale fallback tracks `cacheOutcome: "stale"` → `blob9: "stale"`
- `fresh=true` bypass tracks `cacheOutcome: "bypass"` → `blob9: "bypass"`

**GREEN:** Replace the existing `double5` (cache_hit, currently hardcoded/unused)
with `blob9` as a string dimension in Analytics Engine. The `CacheOutcome` type
(`"hit"|"miss"|"stale"|"bypass"`) maps directly to `blob9` values.

Update `RequestMetrics` in `src/analytics.ts`:
- Remove `cacheHit?: boolean | undefined` (the old double5 field)
- Add `cacheOutcome: CacheOutcome` (required, maps to blob9)

This is more queryable than multiple boolean doubles — `WHERE blob9 = 'stale'`
is clearer than correlating three separate columns, and the states are mutually
exclusive so a single dimension is the correct representation.

### Step 7: Migration

Write `migrations/0005_add_store_taplist_cache.sql` and test locally with
`wrangler d1 execute`.

## Files Changed

| File | Change |
|------|--------|
| `migrations/0005_add_store_taplist_cache.sql` | New — CREATE TABLE + index |
| `src/schemas/cache.ts` | New — `CachedBeersArraySchema` (Zod, composes existing beer schema) |
| `src/db/cache.ts` | New — `getCachedTaplist()`, `setCachedTaplist()`, `CachedTaplistRow` type |
| `src/handlers/beers.ts` | Modify `handleBeerList` — cache check, write-through, stale fallback |
| `src/constants.ts` | Add `CACHE_TTL_MS` (default 5 minutes) |
| `src/types.ts` | Add `TaplistSource` and `CacheOutcome` literal unions, extend `GetBeersResult` with `cacheOutcome` |
| `src/analytics.ts` | Replace `double5` (cache_hit) with `blob9` string dimension; update `RequestMetrics` to use `CacheOutcome` |
| `test/db/cache.test.ts` | New — cache helper + schema unit tests |
| `test/handlers/beers.list.test.ts` | Add `vi.mock` for cache module; cache hit, miss, fresh, stale fallback, analytics tests |

## Configuration

| Constant | Default | Location |
|----------|---------|----------|
| `CACHE_TTL_MS` | `300_000` (5 min) | `src/constants.ts` |

Could later be promoted to an env var if we want to tune without deploy.

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Stale cache serves removed beers | 5-min TTL limits staleness; pull-to-refresh gets live data |
| `response_json` grows large | Typical taplist is 50-100 beers — 20-80 KB of JSON. D1 TEXT columns handle this fine |
| Cache write fails | Executed via `ctx.waitUntil` with `.catch()` — logged, does not block response. Cache is an optimization, not a gate |
| Race condition: two concurrent requests both miss cache | Both write — last write wins via UPSERT. D1 serializes writes. Both values are equally fresh |
| `fresh=true` abuse (cache stampede) | Existing rate limiter (60 RPM per client) applies. Multiple coordinated API keys is residual risk — acceptable given closed key model. Could add separate fresh-request throttle later if needed |
| Enrichment data stale on cache hit | Enrichment updates between cache writes not reflected until TTL expires. Acceptable at 5 min |
| New beers delayed entering enrichment pipeline | Cache hits skip `insertPlaceholders()`. New beers wait at most 1 TTL. Acceptable at 5 min |
| `JSON.parse` of cached data returns `any` | `safeParse` through `CachedBeersArraySchema` — returns null on failure (graceful cache miss), never a bare type assertion |
| Corrupted `response_json` in D1 | Both `JSON.parse` failure and Zod validation failure gracefully degrade to cache miss with warning log, not 500 |
| Cached `requestId` leaks into responses | `setCachedTaplist` stores beers array only; `requestId` generated per-request |

## App-Side Changes (out of scope, noted for reference)

The app needs to:
1. Read `source` and `cached_at` from response
2. Show "Updated X min ago" based on `cached_at` (always present, always ISO string)
3. Map pull-to-refresh to `GET /beers?sid=X&fresh=true`
4. Handle `source: "cache"` gracefully (data is fresh, served from cache)
5. Handle `source: "stale"` with a subtle indicator ("Live data unavailable")
6. Fall back to direct Flying Saucer fetch if Worker is unreachable
