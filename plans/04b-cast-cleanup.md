# Phase 4b: Remaining Cast Cleanup

## Goal

Eliminate or document remaining `as` casts and type issues not covered by
Phase 4a or Phase 3b. This includes queue routing, admin response parsing,
Flying Saucer API response cast (E3), `object` type, and the
brew_description non-null assertion.

## Prerequisites

Phase 4a complete (discriminated unions, timeout fix, D1 helper in place).

---

## Step 5: Queue Routing -- Document Batch Casts

**Finding**: C1-C4

The `queue()` handler receives `MessageBatch<EnrichmentMessage | CleanupMessage>`
and casts to specific message types based on `batch.queue`.

### RED

Write tests in `test/queue/routing.test.ts`:

```typescript
// Test that enrichment queue routes to handleEnrichmentBatch
// Test that cleanup queue routes to handleCleanupBatch
// Test that DLQ queues route correctly
// Test that unknown queue names ack all messages
```

### GREEN

Option A (type assertion with comment -- pragmatic): The Cloudflare Workers
runtime guarantees that `batch.queue` matches the message type configured in
`wrangler.jsonc`. There is no runtime way to validate the generic parameter.
Add justifying comments:

```typescript
if (batch.queue === 'beer-enrichment-dlq') {
  // Safe: wrangler.jsonc binds this queue to EnrichmentMessage producers
  await handleDlqBatch(batch as MessageBatch<EnrichmentMessage>, env, requestId);
}
```

**Recommendation**: Option A. These casts are at a trust boundary controlled by
our own infrastructure config. Document with comments.

### REFACTOR

Add a single block comment at the top of the `queue()` method explaining the
cast safety model.

---

## Step 6: Admin Response Re-Parsing

**Finding**: D1-D5

Admin routes clone the handler response and re-parse JSON to extract metrics
for analytics. Each `result.clone().json()` requires an `as` cast.

### RED

Write tests in `test/handlers/admin-analytics.test.ts`:

```typescript
// Test that analytics data is correctly extracted from DLQ list response
// Test that analytics data is correctly extracted from trigger response
// Test graceful degradation when response body doesn't match expected shape
```

### GREEN

Create a type-safe response parser helper:

```typescript
async function parseResponseAnalytics(
  response: Response
): Promise<Record<string, unknown>> {
  try {
    const body = await response.clone().json();
    if (typeof body === 'object' && body !== null) {
      // Safe: we produced this response; cast narrows from unknown to Record
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
```

Replace 5 inline `as` casts in `src/index.ts:264,287,301,318,344` with calls
to this helper, using optional chaining for field access:

```typescript
const analytics = await parseResponseAnalytics(result);
const messageCount = (analytics['data'] as Record<string, unknown> | undefined)
  ?.['messages'] as unknown[] | undefined;
```

### REFACTOR

Extract the repeated clone-parse-extract pattern into the shared helper.
Replace 5 inline `as` casts with one centralized, documented cast.

---

## Step 7: Trust Boundary Request Parsing -- E3 Only

**Finding**: E3

E1, E5, E7, E8 are handled by Phase 3b's Zod integration (E1 by step 3k,
E5 by step 3d, E7/E8 by step 3l). Only E3 remains for Phase 4b.

### RED

```typescript
// Test that Flying Saucer API response parsing handles non-array responses
// Test that Array.isArray guard rejects non-array JSON
```

### GREEN

**E3** (`fsResp.json() as unknown[]`): This cast to `unknown[]` is already
safe -- it narrows from `unknown` to `unknown[]`, and the code immediately
checks `Array.isArray()`. Add justifying comment:
```typescript
// Safe: narrowing to unknown[] before Array.isArray validation
```

**E2, E4, E6, E9, E10, E11, E12**: Deferred to Phase 3 (schema validation).

### REFACTOR

No further cleanup needed -- single justified cast with comment.

---

## ~~Step 8: Object Literal Satisfies~~ (removed)

F1-F2 (`satisfies` replacement for queue helpers) handled in Phase 3b Step 6a.

---

## ~~Step 9: FlyingSaucerBeer Index Signature~~ (removed)

G1 (index signature removal and `isValidBeer` rewrite) is handled by Phase 3b
Step 5b, which rewrites `isValidBeer` using `FlyingSaucerBeerSchema.safeParse()`.
The index signature on `FlyingSaucerBeer` can be removed once the schema-based
type guard is in place, since no code accesses arbitrary keys after validation.

---

## Step 10: Replace `object` with Concrete Type

**Finding**: H1

`ForceEnrichmentResponse.data.applied_criteria` is typed as `object`.

### RED

```typescript
// Test that applied_criteria matches the criteria fields from ForceEnrichmentRequest
```

### GREEN

Import `EnrichmentCriteria` from the schemas module (defined in Phase 3a as
`z.infer<typeof CriteriaSchema>`). Do NOT manually redefine it here -- Phase 3a
already exports both `CriteriaSchema` and the derived `EnrichmentCriteria` type
from `src/schemas/request.ts`.

```typescript
import type { EnrichmentCriteria } from '../schemas/request';
```

Use `EnrichmentCriteria` in `ForceEnrichmentResponse.data.applied_criteria` to
replace the `object` type. The request side (`ForceEnrichmentRequest.criteria`)
is already typed correctly via `z.infer<typeof ForceEnrichmentRequestSchema>` in
Phase 3a.

### REFACTOR

Verify that `applied_criteria` in the response uses the same
`EnrichmentCriteria` type as the request, ensuring consistency through a single
source of truth in `src/schemas/request.ts`.

---

## Step 11: Non-Null Assertion on `brew_description`

**Finding**: A4

`handlers/beers.ts:513` uses `beer.brew_description!` inside a block guarded by
`shouldQueue` which checks `beer.brew_description` for truthiness. TS cannot
trace the truthiness through the variable binding.

### RED

```typescript
// Test sync handler queues beers with descriptions for cleanup
// Test sync handler skips beers without descriptions
```

### GREEN

Inline the guard into the conditional so TS can narrow:

```typescript
if (beer.brew_description &&
    !existing?.description_cleaned_at &&
    (!existing?.queued_for_cleanup_at ||
     now - existing.queued_for_cleanup_at > SYNC_CONSTANTS.REQUEUE_COOLDOWN_MS)) {
  needsCleanup.push({
    id: beer.id,
    brew_name: beer.brew_name,
    brewer: beer.brewer || '',
    brew_description: beer.brew_description, // TS knows this is string here
  });
}
```

### REFACTOR

Remove the `shouldQueue` intermediate variable if it was only used once.

---

## Summary of Changes (Phase 4b)

| File | Changes |
|------|---------|
| `src/index.ts` | Queue routing comments (Step 5), response parsing helper (Step 6) |
| `src/handlers/beers.ts` | Inline narrowing for brew_description (Step 11), E3 comment (Step 7) |
| `src/types.ts` | Replace `object` with imported `EnrichmentCriteria` from `src/schemas/request.ts` (Step 10) |

## Remaining Justified Casts After Phase 4

These `as` casts will remain with justifying comments:

1. **D1 batch results** (`asTypedRows` helper) -- D1 returns `D1Result<unknown>`
   by design; we control the SQL query shape.
2. **Queue routing** (`batch as MessageBatch<T>`) -- Cloudflare runtime
   guarantees type matches queue binding in wrangler.jsonc.
3. **Admin response parser** (centralized `as Record<string, unknown>`) --
   internal response we produced, wrapped in try/catch.
4. **Flying Saucer API response** (E3: `fsResp.json() as unknown[]`) --
   narrows from `unknown` before `Array.isArray` guard.

## Dependencies

- Phase 3b (schema integration) eliminates trust boundary casts E1, E5, E7, E8, F1-F2.
- Phase 4a must be complete before starting Phase 4b.
- No dependency on Phase 1 (tsconfig) or Phase 2 (interface-to-type).
- Phase 5 (immutability) is independent.

## Estimated Scope (Phase 4 combined)

- 8 steps (4a: 3, 4b: 5), ~9 files touched
- ~6 new test files
- Net reduction: 5 `!` assertions removed, ~7 `as` casts removed or documented
- Remaining `as` casts: ~4, all with justifying comments
