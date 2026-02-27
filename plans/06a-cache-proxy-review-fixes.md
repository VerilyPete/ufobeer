# Phase 6a: Cache Proxy Review Fixes

## Goal

Address all findings from three code reviews of the cache proxy feature
(`06-beers-cache-proxy.md`). Starting state: 809 tests passing, zero type
errors. Every step must leave the test suite green and `npx tsc --noEmit`
clean before proceeding to the next.

---

## Group A: Missing Tests (TDD gaps)

These two branches are already implemented correctly. The tests are missing,
so they go in first — before any refactoring — to establish coverage that
protects the subsequent Group B changes.

### A1: Corrupt cache during fresh cache hit

**Location:** `src/handlers/beers.ts` lines 109–125

**Gap:** When `getCachedTaplist` returns a fresh row (within TTL) but
`parseCachedBeers` returns `null`, the handler falls through to a live fetch.
This path is correct but untested.

**Note:** `vi.clearAllMocks()` resets call counts only (`mock.calls`,
`mock.results`), not implementations. Implementations set via
`.mockResolvedValue()` persist. The module-level `vi.mock` factory default
for `getEnrichmentForBeerIds` (resolving to `new Map()`) remains in effect,
so it does not need re-mocking. `getCachedTaplist` and `parseCachedBeers` are
re-mocked explicitly for this test to set up the corrupt-cache scenario.

**Test to add** in `test/handlers/beers.list.test.ts`, inside the existing
`describe('cache hit', ...)` block:

```typescript
it('falls through to live fetch when fresh cache row fails to parse', async () => {
  vi.clearAllMocks();
  const liveBeers = [createBeer({ id: 'live', brew_name: 'Live Beer' })];

  vi.mocked(getCachedTaplist).mockResolvedValue({
    store_id: '13885',
    response_json: '{"corrupted": true}',
    cached_at: Date.now() - 60_000,        // within TTL
  });
  vi.mocked(parseCachedBeers).mockReturnValue(null);

  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(liveBeers)),
  });

  const env = createMockEnv();
  const { ctx } = createMockExecutionContext();
  const reqCtx = createMockReqCtx();

  const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

  expect(result.response.status).toBe(200);
  const body = await result.response.json() as { source: string; beers: Array<{ id: string }> };
  expect(body.source).toBe('live');
  expect(body.beers[0].id).toBe('live');
  expect(result.cacheOutcome).toBe('miss');
});
```

### A2: Corrupt cache during stale fallback

**Location:** `src/handlers/beers.ts` — both `!fsResp.ok` and `catch` blocks.

**Two tests to add** in `describe('stale fallback', ...)`:

```typescript
it('returns 502 when upstream fails and stale row exists but fails to parse', async () => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });

  vi.mocked(getCachedTaplist).mockResolvedValue({
    store_id: '13885',
    response_json: '{"corrupted": true}',
    cached_at: Date.now() - 600_000,
  });
  vi.mocked(parseCachedBeers).mockReturnValue(null);

  const env = createMockEnv();
  const { ctx } = createMockExecutionContext();
  const reqCtx = createMockReqCtx();

  const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

  expect(result.response.status).toBe(502);
  expect(result.cacheOutcome).toBe('miss');
});

it('returns 500 when upstream throws and stale row exists but fails to parse', async () => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

  vi.mocked(getCachedTaplist).mockResolvedValue({
    store_id: '13885',
    response_json: '{"corrupted": true}',
    cached_at: Date.now() - 600_000,
  });
  vi.mocked(parseCachedBeers).mockReturnValue(null);

  const env = createMockEnv();
  const { ctx } = createMockExecutionContext();
  const reqCtx = createMockReqCtx();

  const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

  expect(result.response.status).toBe(500);
  expect(result.cacheOutcome).toBe('miss');
});
```

**Verification:** All three A1/A2 tests should pass immediately — no production
code changes needed. Count goes from 809 → 812.

---

## Group B: Refactoring

All refactoring with full test coverage from Group A in place.

### B3: Extract `serveStaleFallback` helper

**Problem:** Stale fallback response construction duplicated in `!fsResp.ok`
and `catch` blocks. Only difference: how `upstreamLatencyMs` is computed.

**Extract a pure function above `handleBeerList`:**

```typescript
function serveStaleFallback(
  fallbackRow: CachedTaplistRow,
  staleBeers: readonly CachedBeer[],
  storeId: string,
  reqCtx: RequestContext,
  headers: Record<string, string>,
  upstreamLatencyMs: number,
): GetBeersResult {
  return {
    response: Response.json({
      beers: staleBeers,
      storeId,
      requestId: reqCtx.requestId,
      source: 'stale',
      cached_at: new Date(fallbackRow.cached_at).toISOString(),
    }, { headers }),
    beersReturned: staleBeers.length,
    upstreamLatencyMs,
    cacheOutcome: 'stale',
  };
}
```

**Call site 1 — `!fsResp.ok` block** (where `upstreamLatencyMs` is already computed):
```typescript
const fallbackRow = cachedRow ?? await getCachedTaplist(env.DB, storeId);
if (fallbackRow) {
  const staleBeers = parseCachedBeers(fallbackRow.response_json);
  if (staleBeers) return serveStaleFallback(fallbackRow, staleBeers, storeId, reqCtx, headers, upstreamLatencyMs);
}
```

**Call site 2 — `catch` block** (where `upstreamLatencyMs` is not in scope,
so we compute it inline from `upstreamStartTime`):
```typescript
const fallbackRow = cachedRow ?? await getCachedTaplist(env.DB, storeId);
if (fallbackRow) {
  const staleBeers = parseCachedBeers(fallbackRow.response_json);
  if (staleBeers) return serveStaleFallback(fallbackRow, staleBeers, storeId, reqCtx, headers, Date.now() - upstreamStartTime);
}
```

### B4: Simplify `cachedRow` type annotation

Replace `Awaited<ReturnType<typeof getCachedTaplist>>` with
`CachedTaplistRow | null`. Add two imports to `src/handlers/beers.ts`:

```typescript
import type { CachedTaplistRow } from '../db/cache';
import type { CachedBeer } from '../schemas/cache';
```

`CachedTaplistRow` is needed for B4's type annotation. `CachedBeer` is needed
for B3's `serveStaleFallback` parameter type (`readonly CachedBeer[]`).

### B5: Remove redundant `useCleanedDesc` boolean

```typescript
// Before:
const useCleanedDesc = enrichment?.brew_description_cleaned ? true : false;
if (useCleanedDesc) cleanedCount++;

// After:
if (enrichment?.brew_description_cleaned) cleanedCount++;
```

### B6: Fix `||` to `??` for description fallback

This is a behavior change (empty string handling). TDD approach:

1. **RED:** Write test that empty-string cleaned description is preserved
   (not falling back to original). This test FAILS with current `||` code.
2. **GREEN:** Change `||` to `??`. Test passes.

```typescript
// In describe('enrichment merging'):
it('preserves empty-string cleaned description (does not fall back to original)', async () => {
  vi.clearAllMocks();
  const beers = [createBeer({ id: '1', brew_name: 'Test Beer', brew_description: 'Original' })];
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
  });
  vi.mocked(getEnrichmentForBeerIds).mockResolvedValue(new Map([
    ['1', { abv: 5.0, confidence: 0.9, source: 'description', brew_description_cleaned: '' }],
  ]));

  const env = createMockEnv();
  const { ctx } = createMockExecutionContext();
  const reqCtx = createMockReqCtx();

  const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

  const body = await result.response.json() as { beers: Array<{ brew_description: string }> };
  expect(body.beers[0].brew_description).toBe('');
});
```

### B7: Extract `createMapBackedDb()` factory in cache tests

Duplicated Map-backed D1 mock in `test/db/cache.test.ts` → extract to factory.

---

## Group C: Migration cleanup

### C8: Remove speculative `cached_at` index

**Important:** `migrations/0005_add_store_taplist_cache.sql` has already been
executed in production. It must not be edited. Instead, create a new migration
`migrations/0006_drop_cached_at_index.sql`:

```sql
-- Remove speculative index — no production code queries by cached_at.
-- The table has ~15 rows (bounded by VALID_STORE_IDS), so the index
-- adds only negligible overhead, but keeping unused indexes violates
-- YAGNI. Re-add when a query actually needs it.

DROP INDEX IF EXISTS idx_store_taplist_cache_cached_at;
```

No production code queries by `cached_at`. Add the index back only when a
test demands it.

---

## Group D: Follow-ups (document only, do not fix)

Pre-existing issues not introduced by this PR:

- **D1:** Dual `FlyingSaucerBeer` definition — manual type in `types.ts`
  vs schema-derived in `schemas/external.ts`
- **D2:** `as unknown[]` assertion on `fsResp.json()` — should be `as unknown`
  with `Array.isArray` narrowing
- **D3:** `AnalyticsEngineDataset` interface uses mutable arrays (`string[]`)
  instead of `readonly string[]`

---

## Implementation Order

| Step | Group | What | Tests after |
|------|-------|------|-------------|
| 1 | A1 | Add corrupt-cache-hit test | 810 |
| 2 | A2 | Add two corrupt-stale-fallback tests | 812 |
| 3 | A commit | `test: cover corrupt cache parse paths` | 812 |
| 4 | B3+B4 | Extract `serveStaleFallback`, simplify `cachedRow` type | 812 |
| 5 | B5 | Remove redundant `useCleanedDesc` boolean | 812 |
| 6 | B6 | Write `??` test (RED), then fix `||` → `??` (GREEN) | 813 |
| 7 | B7 | Extract `createMapBackedDb()` in cache tests | 813 |
| 8 | B commit | `refactor: extract stale fallback helper, simplify types` | 813 |
| 9 | C8 | Add migration 0006 to drop speculative index | 813 |
| 10 | C commit | `chore: drop speculative cached_at index via new migration` | 813 |

## Constraints

- No `any` types introduced at any step
- No type assertions introduced at any step
- `npx tsc --noEmit` must be clean after every commit
- All 809+ tests must pass after every commit
- No behavior changes to the public API contract (except B6 empty-string fix)
