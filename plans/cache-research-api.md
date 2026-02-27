# GET /beers API Research — Cache Proxy Feature

## 1. Current GET /beers Flow (Step by Step)

**Entry point**: `src/index.ts` — `fetch()` handler, path `GET /beers`

1. **CORS preflight** — OPTIONS → 204, no auth required
2. **Health check bypass** — `/health` skips auth
3. **CORS config check** — fails 500 if `ALLOWED_ORIGIN` missing
4. **API key auth** — `validateApiKey()` from `src/auth.ts`; 401 if missing/invalid
5. **Rate limit check** — `checkRateLimit()` against `rate_limits` D1 table (default 60 RPM)
6. **`sid` param extraction** — `url.searchParams.get('sid')`; 400 if missing
7. **Store ID whitelist check** — `VALID_STORE_IDS.has(storeId)` from `src/config.ts`; 400 if not in set
8. **Call `handleBeerList(env, ctx, headers, authedContext, storeId)`** — in `src/handlers/beers.ts`
9. Inside handler:
   a. Validate store ID format via `isValidStoreId()` (numeric, non-empty)
   b. `fetch(FLYING_SAUCER_API_BASE + '?sid=' + storeId, { headers: { 'User-Agent': 'BeerSelector/1.0' } })`
   c. If non-2xx → return 502 `{ error: 'Upstream Error' }`
   d. Parse JSON as `unknown[]`
   e. Find element with `brewInStock` array via `hasBeerStock()` type guard
   f. Filter each beer with `isValidBeer()` (Zod schema)
   g. `getEnrichmentForBeerIds(DB, beerIds, requestId)` — chunked D1 SELECT
   h. Merge: spread beer fields + `enriched_abv`, `enrichment_confidence`, `enrichment_source`, override `brew_description` with cleaned version if present
   i. `ctx.waitUntil(processBackgroundEnrichment(...))` — non-blocking: `insertPlaceholders()` then queue for cleanup/enrichment
   j. Return 200 `{ beers, storeId, requestId }`
10. **Analytics + audit log** — `trackRequest()` + `writeAuditLog()` via `ctx.waitUntil`
11. **Return response** directly (no second `respond()` call — analytics tracked inline for `/beers`)

## 2. Exact Response Shape

### Success (200)
```json
{
  "beers": [
    {
      "id": "string",
      "brew_name": "string",
      "brewer": "string (optional)",
      "brew_description": "string (optional, cleaned if available)",
      "container_type": "string (optional)",
      // ...any other passthrough fields from Flying Saucer
      "enriched_abv": 6.5,            // null if not enriched
      "enrichment_confidence": 0.95,  // null if not enriched
      "enrichment_source": "perplexity | description | manual | null"
    }
  ],
  "storeId": "13879",
  "requestId": "uuid"
}
```

### Error — missing sid (400)
```json
{ "error": "Missing required parameter: sid", "requestId": "uuid" }
```

### Error — invalid store ID (400, checked in index.ts whitelist)
```json
{ "error": "Invalid store ID", "requestId": "uuid" }
```

### Error — invalid store ID format (400, checked in handler)
```json
{ "error": "Invalid store ID format", "code": "INVALID_STORE_ID", "requestId": "uuid" }
```

### Error — upstream failure (502)
```json
{ "error": "Upstream Error" }
```

### Error — network/parse error (500)
```json
{ "error": "Internal Server Error" }
```

### Response Headers (all authenticated routes)
```
Access-Control-Allow-Origin: <ALLOWED_ORIGIN>
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-API-Key, X-Client-ID
X-RateLimit-Limit: 60
X-RateLimit-Remaining: N
X-RateLimit-Reset: <unix timestamp>
X-Request-ID: <uuid>
Content-Type: application/json
```

## 3. Flying Saucer API Details

- **URL pattern**: `${env.FLYING_SAUCER_API_BASE}?sid=<storeId>`
  - `FLYING_SAUCER_API_BASE` is a secret/env var (e.g. `https://fsbs.beerknurd.com/bk-store-json.php`)
- **Response format**: Outer array `[metadata_object, { brewInStock: [...beers] }]`
  - `brewInStock` may be in any position — handler uses `.find(hasBeerStock)`
  - Each beer: `{ id, brew_name, brewer?, brew_description?, container_type?, ...passthrough }`
  - Required fields for validity: `id` (non-empty string), `brew_name` (string)
- **Latency**: No explicit timeout set; measured via `Date.now()` delta. No SLA known.
- **Error modes**:
  - Non-2xx HTTP → 502 upstream error (logged with status code)
  - Network failure (DNS, TCP reset, timeout) → caught in try/catch → 500
  - Malformed JSON / unexpected structure → gracefully returns 200 with empty beers array

## 4. Current Error Handling

| Failure | Handler behavior |
|---------|-----------------|
| Flying Saucer non-2xx | 502 `{ error: 'Upstream Error' }` |
| Network error / timeout | 500 `{ error: 'Internal Server Error' }` (catch block) |
| Malformed JSON | Returns 200 with empty beers (no `brewInStock` found) |
| D1 enrichment query failure | Propagates to catch → 500 |
| Background task failure | Logged, does not affect response (try/catch in `processBackgroundEnrichment`) |

No retry logic. No explicit timeout on the Flying Saucer `fetch()` call.

## 5. Query Params Today

| Param | Required | Description |
|-------|----------|-------------|
| `sid` | Yes | Store ID — must be numeric, must be in `VALID_STORE_IDS` whitelist |

Two layers of validation:
1. `index.ts`: `VALID_STORE_IDS.has(storeId)` — strict whitelist (currently only `'13879'` in config.ts, more in validation/storeId.ts)
2. `handlers/beers.ts`: `isValidStoreId(storeId)` — format check (numeric, non-empty)

## 6. Response Contract Additions Needed

The current 200 response shape is:
```json
{ "beers": [...], "storeId": "...", "requestId": "..." }
```

Proposed additions fit cleanly as top-level fields alongside existing ones:
```json
{
  "beers": [...],
  "storeId": "13879",
  "requestId": "uuid",
  "cached_at": "2026-02-26T12:00:00.000Z",  // ISO 8601, null when source is "live"
  "source": "live" | "cache"                 // always present
}
```

- `storeId` is already present — no change needed
- `cached_at` is `null` for live responses, ISO timestamp for cached responses
- `source` distinguishes live vs cached to the app
- No existing fields need to change — purely additive
- The `beers` array shape stays identical — app can use beers the same way regardless of source

## 7. `fresh` Param Design

- `fresh=true` bypasses cache — hits Flying Saucer directly and refreshes the cache entry
- `fresh` is optional; default behavior (no param or `fresh=false`) uses cache if available
- Combined with required `sid`: `GET /beers?sid=13879&fresh=true`
- `fresh=true` response still returns `source: "live"` and a new `cached_at` timestamp (after writing to cache)
- Access to `fresh` bypass could be rate-limited separately or restricted to avoid cache stampedes

## 8. Existing Test Patterns

**File**: `test/handlers/beers.list.test.ts`

### Structure
- Top-level `describe('handleBeerList', ...)`
- Nested `describe` groups by concern: `upstream API handling`, `response parsing`, `enrichment merging`, `background task queueing`, `response format`
- Module-level `vi.mock()` calls for `../../src/db`, `../../src/queue`, `../../src/utils/hash`
- Re-import mocked modules after `vi.mock()` to access `vi.mocked()` typed versions

### Factory Functions (no `let`/`beforeEach`)
```typescript
function createMockEnv(): Env { ... }
function createMockExecutionContext(): { ctx, waitUntilPromises } { ... }
function createMockReqCtx(): RequestContext { ... }
function createBeer(overrides?): FlyingSaucerBeer { ... }
function createFlyingSaucerResponse(beers: unknown[]): unknown[] { ... }
```

### Test Pattern
```typescript
it('description of behavior', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(...) });
  const env = createMockEnv();
  const { ctx } = createMockExecutionContext();
  const reqCtx = createMockReqCtx();

  const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

  expect(result.response.status).toBe(200);
  const body = await result.response.json() as { ... };
  expect(body.field).toBe(expectedValue);
});
```

### Notable Conventions
- `vi.clearAllMocks()` at start of tests that override module-level mock defaults
- `await Promise.all(waitUntilPromises)` to drain background tasks before asserting on queues
- No `beforeEach` setup — all state created fresh per test via factories
- Type assertions on `response.json()` to narrow from `unknown` for field assertions
- Handler called directly (not via HTTP) — unit test, not integration test
- `globalThis.fetch` patched per-test for upstream call simulation

### Cache-layer tests should follow the same patterns:
- Factory functions for `KVNamespace` mock (or whatever cache store is used)
- `vi.mock()` for any new cache module
- Separate `describe` blocks for: cache hit, cache miss, `fresh=true` bypass, cache write-through, stale data, cache errors
