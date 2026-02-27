# Phase 3b: Schema Integration into Handlers

## Goal

Replace all `as` casts in handler files with Zod schema `.safeParse()` calls
using the schemas created in Phase 3a. Remove manual validators. Fix type
guard casts in `types.ts`.

## Prerequisites

Phase 3a must be complete (all schemas in `src/schemas/request.ts` and
`src/schemas/external.ts`).

---

## Step 3: Replace `as` casts in handlers with schema.parse()

### 3a. RED: Test `handleBatchLookup` rejects invalid payloads with 400

```typescript
// test/handlers/beers.batch.test.ts (extend existing)
it('returns 400 for request body with ids as numbers', ...);
it('returns 400 for request body without ids field', ...);
it('returns 400 for malformed JSON', ...);
```

These tests send actual HTTP requests (using the existing Cloudflare Workers
test harness) with invalid payloads and verify 400 responses.

### 3b. GREEN: Replace cast in `handleBatchLookup`

`src/handlers/beers.ts:225` -- Replace:
```typescript
const body = await request.json() as { ids?: string[] };
const ids = body.ids;
if (!Array.isArray(ids) || ids.length === 0) { ... }
```

With:
```typescript
const parseResult = BatchLookupRequestSchema.safeParse(await request.json());
if (!parseResult.success) {
  return Response.json(
    { error: 'ids array required', requestId: reqCtx.requestId },
    { status: 400, headers }
  );
}
const { ids } = parseResult.data;
```

This eliminates both the `as` cast AND the manual `Array.isArray` check.

### 3c. RED: Test `handleBeerSync` rejects invalid beer payloads with 400

```typescript
// test/handlers/beers.sync.test.ts (extend existing)
it('returns 400 when beers array contains invalid items', ...);
it('returns 400 when beer id exceeds max length', ...);
```

### 3d. GREEN: Replace cast in `handleBeerSync`

`src/handlers/beers.ts:406` -- Replace:
```typescript
const body = await request.json() as SyncBeersRequest;
if (!body.beers || !Array.isArray(body.beers)) { ... }
```

With:
```typescript
const parseResult = SyncBeersRequestSchema.safeParse(await request.json());
if (!parseResult.success) {
  return Response.json(
    { error: 'beers array required', requestId: reqCtx.requestId },
    { status: 400, headers }
  );
}
const body = parseResult.data;
```

Also remove `validateBeerInput` function (`src/handlers/beers.ts:315-343`).

**Preserving per-beer partial success**: The current flow validates each beer
individually -- valid beers sync successfully while invalid ones collect error
messages. Whole-request Zod validation would reject the entire request if any
single beer is invalid, losing this partial success behavior. To preserve it:

1. Use `SyncBeersRequestSchema` to validate the outer request structure only
   (presence of `beers` array, correct top-level shape).
2. Keep per-beer validation via `SyncBeerItemSchema.safeParse()` on each item
   inside the loop, replacing the manual `validateBeerInput` call:

```typescript
const results: SyncResult[] = [];
for (const beer of body.beers) {
  const beerParse = SyncBeerItemSchema.safeParse(beer);
  if (!beerParse.success) {
    results.push({ id: beer?.id ?? 'unknown', error: beerParse.error.issues[0].message });
    continue;
  }
  // proceed with beerParse.data (fully typed, no cast needed)
}
```

This eliminates the `as` cast on the outer body AND the manual
`validateBeerInput`, while preserving the per-beer partial success contract.

### 3e. RED: Test `handleDlqReplay` rejects invalid payloads

```typescript
// test/handlers/dlq.test.ts (new or extend)
it('returns 400 when ids are strings instead of numbers', ...);
it('returns 400 when ids array is empty', ...);
```

### 3f. GREEN: Replace cast in `handleDlqReplay`

`src/handlers/dlq.ts:286` -- Replace:
```typescript
const body = await request.json() as DlqReplayRequest;
const { ids, delay_seconds = 0 } = body;
if (!Array.isArray(ids) || ids.length === 0) { ... }
```

With:
```typescript
const parseResult = DlqReplayRequestSchema.safeParse(await request.json());
if (!parseResult.success) {
  return errorResponse('ids array required', 'INVALID_REQUEST', ...);
}
const { ids, delay_seconds } = parseResult.data;
```

### 3g. RED: Test `handleDlqAcknowledge` rejects invalid payloads

### 3h. GREEN: Replace cast in `handleDlqAcknowledge`

`src/handlers/dlq.ts:410` -- same pattern as 3f.

### 3h-ii. Note: `dlq.ts:336` -- `JSON.parse(row.raw_message) as EnrichmentMessage`

This parses a DLQ row's `raw_message` back into a typed message. The data was
written by our own queue error handler, so it is trusted internal data. However,
corrupted rows or schema drift could cause issues. Add a safeParse:

```typescript
const parsed = EnrichmentMessageSchema.safeParse(JSON.parse(row.raw_message));
if (!parsed.success) {
  logger.warn('Skipping corrupt DLQ row', { id: row.id });
  continue;
}
const message = parsed.data;
```

Add `EnrichmentMessageSchema` to Phase 3a's schema definitions if not already
present (it should mirror the `EnrichmentMessage` type).

### 3h-iii. Note: `dlq.ts:49` -- `JSON.parse(atob(cursorParam))`

This decodes a base64 cursor from the query string into a pagination object.
There is no `as` cast, but the parsed result is used without type validation.
Add a small inline schema or safeParse to validate the cursor shape:

```typescript
const CursorSchema = z.object({
  id: z.number(),
  created_at: z.string(),
});
const cursorParse = CursorSchema.safeParse(JSON.parse(atob(cursorParam)));
if (!cursorParse.success) {
  return errorResponse('Invalid cursor', 'INVALID_CURSOR', 400, ...);
}
const cursor = cursorParse.data;
```

This is low priority but hardens a trust boundary (user-supplied query param).

### 3i. RED: Test `handleEnrichmentTrigger` handles invalid body

### 3j. GREEN: Replace cast in `handleEnrichmentTrigger`

`src/handlers/enrichment.ts:166` -- Replace:
```typescript
const body = await request.json().catch(() => ({})) as TriggerEnrichmentRequest;
```

With:
```typescript
const raw = await request.json().catch(() => ({}));
// Empty body is valid -- all fields are optional with defaults.
// But a non-empty body with invalid fields (e.g. limit: -5, dry_run: "pizza")
// should be rejected with 400, not silently fall through to defaults.
const isEmpty = typeof raw === 'object' && raw !== null && Object.keys(raw).length === 0;
if (!isEmpty) {
  const parseResult = TriggerEnrichmentRequestSchema.safeParse(raw);
  if (!parseResult.success) {
    return Response.json(
      { error: 'Invalid request body', requestId: reqCtx.requestId },
      { status: 400, headers }
    );
  }
}
const body = TriggerEnrichmentRequestSchema.parse(raw);
```

Note: This endpoint currently treats an unparseable or empty body as `{}` and
falls through to defaults (all fields are optional). The `.catch(() => ({}))`
preserves this for malformed JSON. The `isEmpty` check preserves it for
empty-body requests (e.g. `curl -X POST` with no payload). However, a non-empty
body with explicitly invalid fields (e.g. `{"limit": -5}`) is now rejected with
400 instead of silently falling through to defaults.

### 3k. GREEN: Replace `validateForceEnrichmentRequest` with schema

`src/handlers/enrichment.ts:34-135` -- Replace the entire 101-line manual validator.

**Error code mapping**: The current validator returns ~15 specific error codes
(e.g. `INVALID_BEER_IDS`, `INVALID_BEER_IDS_EMPTY`, `INVALID_LIMIT`).
Clients may depend on these codes. Use Zod `.message()` overrides on each
schema constraint to embed the correct error code, then extract it:

```typescript
// In request.ts schema definition, each constraint carries its error code:
//   beer_ids: z.array(z.string()).optional()
//     .refine(ids => !ids || ids.length > 0, {
//       message: 'INVALID_BEER_IDS:beer_ids array must not be empty',
//     }),

function mapZodIssueToErrorCode(issue: z.ZodIssue): string {
  // Error codes are embedded as "CODE:message" in Zod .message() overrides
  const colonIdx = issue.message.indexOf(':');
  if (colonIdx > 0 && issue.message.slice(0, colonIdx).match(/^[A-Z_]+$/)) {
    return issue.message.slice(0, colonIdx);
  }
  // Fallback for structural errors (wrong type, missing field)
  return 'INVALID_REQUEST';
}

export function validateForceEnrichmentRequest(body: unknown): ForceEnrichmentValidationResult {
  const result = ForceEnrichmentRequestSchema.safeParse(body);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const errorCode = mapZodIssueToErrorCode(firstIssue);
    const errorMessage = firstIssue.message.includes(':')
      ? firstIssue.message.slice(firstIssue.message.indexOf(':') + 1).trim()
      : firstIssue.message;
    return {
      valid: false,
      error: errorMessage,
      errorCode,
    };
  }
  return { valid: true };
}
```

Phase 3a must add `.message('CODE:human text')` overrides to every constraint
in `ForceEnrichmentRequestSchema` matching the existing error codes. Write tests
in 3a that verify `safeParse` failures produce the expected code prefix.

### 3l. GREEN: Replace `validateCleanupTriggerRequest` with schema

`src/handlers/cleanupTrigger.ts:45-96` -- Same error-code-mapping pattern as 3k.
The current validator returns specific codes like `INVALID_MODE`, `INVALID_LIMIT`,
`INVALID_DRY_RUN`, `INVALID_CONFIRM`. Phase 3a must add `.message('CODE:text')`
overrides to `TriggerCleanupRequestSchema` for each constraint.

```typescript
export function validateCleanupTriggerRequest(body: unknown): CleanupTriggerValidationResult {
  const result = TriggerCleanupRequestSchema.safeParse(body);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const errorCode = mapZodIssueToErrorCode(firstIssue);
    const errorMessage = firstIssue.message.includes(':')
      ? firstIssue.message.slice(firstIssue.message.indexOf(':') + 1).trim()
      : firstIssue.message;
    return {
      valid: false,
      error: errorMessage,
      errorCode,
    };
  }
  return { valid: true };
}
```

Extract the shared `mapZodIssueToErrorCode` helper to `src/schemas/errors.ts`
(used by both 3k and 3l).

Also remove the `body as TriggerCleanupRequest` cast at
`src/handlers/cleanupTrigger.ts:337` -- after validation passes, use the parsed
data from the schema instead:

```typescript
const validation = validateCleanupTriggerRequest(body);
if (!validation.valid) { ... }
// Instead of: const request_ = body as TriggerCleanupRequest;
// Use the schema to get typed data:
const request_ = TriggerCleanupRequestSchema.parse(body);
```

---

## Step 4: Replace Perplexity API response cast

### 4a. RED: Test Perplexity response parsing with malformed responses

```typescript
// test/services/perplexity.test.ts (extend existing)
it('returns null when API response has unexpected shape', ...);
```

### 4b. GREEN: Replace cast in `fetchAbvFromPerplexity`

`src/services/perplexity.ts:81` -- Replace:
```typescript
const data = await response.json() as {
  choices?: Array<{ message?: { content?: string } }>;
};
const content = data.choices?.[0]?.message?.content?.trim();
```

With:
```typescript
const raw = await response.json();
const parsed = PerplexityResponseSchema.safeParse(raw);
const content = parsed.success
  ? parsed.data.choices[0]?.message?.content?.trim()
  : undefined;
```

---

## Step 5: Fix type guard casts in `types.ts`

### 5a. RED: Tests for `isValidBeer` and `hasBeerStock` behavior

The existing type guards work correctly but use unsafe intermediate casts.
Write tests confirming:
- `isValidBeer` rejects null, undefined, non-objects, objects missing `id`,
  objects with empty `id`
- `hasBeerStock` rejects null, non-objects, objects without `brewInStock`,
  objects with non-array `brewInStock`

### 5b. GREEN: Rewrite type guards without intermediate `as` casts

`src/types.ts:318-341` -- Replace with schema-based approach:
```typescript
export function isValidBeer(beer: unknown): beer is FlyingSaucerBeer {
  return FlyingSaucerBeerSchema.safeParse(beer).success;
}
```

Replace `hasBeerStock`:
```typescript
const BeerStockSchema = z.object({
  brewInStock: z.array(z.unknown()),
}).passthrough();

export function hasBeerStock(item: unknown): item is { brewInStock: unknown[] } {
  return BeerStockSchema.safeParse(item).success;
}
```

---

## Step 6: Address lower-priority `as` casts

### 6a. Queue message construction (`src/queue/helpers.ts:56,123`)

These cast object literals to `EnrichmentMessage`/`CleanupMessage`. They are
safe because the object is being constructed, not received. Replace with
`satisfies` for type checking without runtime overhead:

```typescript
// Before:
{ beerId: beer.id, beerName: beer.brew_name, brewer: beer.brewer } as EnrichmentMessage

// After:
{ beerId: beer.id, beerName: beer.brew_name, brewer: beer.brewer } satisfies EnrichmentMessage
```

> **Cross-phase note**: This step also covers Phase 4b items F1-F2 (the same
> `as`-to-`satisfies` replacements in queue helpers). No further work is needed
> in Phase 4b for these two locations.

### 6b. Queue routing in `index.ts:414-420`

These cast `batch` to typed `MessageBatch<T>` based on queue name. This is a
Cloudflare Workers limitation -- the `queue()` handler receives a union type.
These casts are acceptable as-is because the queue name provides the
discriminant. Leave unchanged -- they are internal routing, not trust boundaries.

### 6c. Response parsing in `index.ts:264,287,301,318,344`

These parse the handler's own response for analytics logging. They are internal
(we produced the response), wrapped in try/catch, and failures are silently
ignored. Leave unchanged -- they are not trust boundaries.

---

## Files Changed Summary

### New files (from Phase 3a)
- `src/schemas/request.ts` -- All request body schemas
- `src/schemas/external.ts` -- External API response schemas
- `src/schemas/errors.ts` -- Shared `mapZodIssueToErrorCode` helper (used by 3k, 3l)
- `test/schemas/request.test.ts` -- Schema unit tests

### Modified files
- `src/handlers/beers.ts` -- Replace `as` casts at lines 225, 320, 406;
  remove `validateBeerInput` (lines 305-343) and its per-beer loop
- `src/handlers/dlq.ts` -- Replace `as` casts at lines 286, 336, 410; add
  cursor validation at line 49
- `src/handlers/enrichment.ts` -- Replace `as` cast at line 166; rewrite
  `validateForceEnrichmentRequest` (lines 34-135)
- `src/handlers/cleanupTrigger.ts` -- Replace `as` casts at lines 55, 58, 337;
  rewrite `validateCleanupTriggerRequest` (lines 45-96)
- `src/services/perplexity.ts` -- Replace `as` cast at line 81
- `src/types.ts` -- Rewrite `isValidBeer` (lines 318-328) and `hasBeerStock`
  (lines 334-341); remove replaced interfaces (import from schemas instead)
- `src/queue/helpers.ts` -- Replace `as` with `satisfies` at lines 56, 123
- `package.json` -- Add `zod` dependency

### Unchanged (by design)
- `src/index.ts` -- Queue routing casts (lines 414-420) and response parsing
  casts (lines 264-344) are not trust boundaries
- `src/handlers/beers.ts:123` -- `fsResp.json() as unknown[]` is already safe

---

## Validation Error Format

Zod provides rich error information via `safeParse().error.issues`. To maintain
backwards compatibility with existing error responses, each handler wraps the
Zod error into the format the clients expect:

```typescript
// Pattern used in all handlers:
const parseResult = SomeSchema.safeParse(body);
if (!parseResult.success) {
  return Response.json(
    { error: 'human-readable message', requestId: reqCtx.requestId },
    { status: 400, headers }
  );
}
const typedBody = parseResult.data;
```

For the manual validators that are kept as wrapper functions
(`validateForceEnrichmentRequest`, `validateCleanupTriggerRequest`), the wrapper
converts Zod's error format to the existing `{ valid, error, errorCode }` return
type, so callers do not need to change.

---

## Estimated Scope

- ~180 lines of manual validation code removed
- ~120 lines of Zod schemas added (much denser than manual validation)
- ~16 `as` casts eliminated from trust boundaries (including DLQ `raw_message`)
- ~1 untyped `JSON.parse` hardened (DLQ cursor)
- ~2 `as` casts replaced with `satisfies`
- ~5 `as` casts left unchanged (internal, not trust boundaries)
- Net: ~60 fewer lines, much stronger runtime guarantees

---

## Implementation Notes (post-implementation drift)

**`mapZodIssueToErrorCode` lives in `src/schemas/errors.ts`**: As planned. But the file
also exports a companion helper `extractZodErrorMessage(issue)` that returns the
human-readable portion after the `CODE:` prefix with `.trim()`. This was added to fix
Review Finding #25 (the `mapZodIssueToErrorCode` callers had inline `.slice(colonIdx + 1).trim()`
patterns — `extractZodErrorMessage` is the DRY version of that logic).

**Step 3h-iii (DLQ cursor validation)**: The `CursorSchema` inline validation for the
base64 cursor parameter was implemented. However, the cursor fields in the actual code
differ slightly from the plan's example — the plan showed `{ id: z.number(), created_at: z.string() }`
but the actual `PaginationCursor` type uses `{ id: number, failed_at: number }`. The
implementation used the correct field names from the actual schema.

**`SyncBeersRequestOuterSchema` naming**: Step 3d described a two-stage approach for
`handleBeerSync` (outer schema validates `{ beers: unknown[] }`, per-item schema validates
each beer). The outer schema is named `SyncBeersRequestOuterSchema` in the implementation
— this name is not in the plan but accurately describes its role.

**`isValidBeer` moved to `types.ts`**: Plan Step 5b showed `isValidBeer` being rewritten
in `src/types.ts`. Implementation kept it there, importing `FlyingSaucerBeerSchema` from
`src/schemas/external`. The `BeerStockSchema` for `hasBeerStock` is defined inline in
`types.ts` (not in a schema file), consistent with its localized use.

**`EnrichmentMessageSchema` added to `src/schemas/request.ts`**: For Step 3h-ii
(DLQ `raw_message` parsing). The plan said "Add to Phase 3a's schema definitions if not
already present." It was added at the end of `request.ts` rather than in the original
7-schema group, interleaved with the type exports.
