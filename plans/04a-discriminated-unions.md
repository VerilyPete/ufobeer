# Phase 4a: Discriminated Unions and D1 Type Safety

## Goal

Eliminate non-null assertions (`!`) and unsafe `as` casts by introducing
discriminated unions and typed D1 helpers. This is the first half of Phase 4;
Phase 4b covers remaining cast cleanup.

## Full Inventory of Issues

### Category A: Non-Null Assertions (`!`)

| # | File | Line | Expression | Risk |
|---|------|------|-----------|------|
| A1 | `src/queue/cleanupHelpers.ts` | 44 | `clearTimeout(timeoutId!)` | Low - assigned in promise executor but TS cannot prove it |
| A2 | `src/queue/cleanup.ts` | 443 | `result.cleaned!` | Medium - `success: true` branch but TS sees `cleaned?: string` |
| A3 | `src/queue/cleanup.ts` | 444 | `result.usedOriginal!` | Medium - same as A2 |
| A4 | `src/handlers/beers.ts` | 513 | `beer.brew_description!` | Medium - guarded by `shouldQueue` truthiness check |
| A5 | `src/handlers/cleanupTrigger.ts` | 330 | `validation.error!` | Low - inside `!validation.valid` branch |

### Category B: D1 Batch Result Casts (`as Array<...>`)

| # | File | Line | Expression |
|---|------|------|-----------|
| B1 | `src/db/helpers.ts` | 76 | `result.results as Array<{id, abv, ...}>` |
| B2 | `src/db/helpers.ts` | 252 | `result.results as Array<{id, description_hash, abv}>` |

### Category C: Queue Routing Casts (`as MessageBatch<T>`)

| # | File | Lines | Expression |
|---|------|-------|-----------|
| C1-C4 | `src/index.ts` | 414-420 | `batch as MessageBatch<EnrichmentMessage\|CleanupMessage>` |

### Category D: Admin Response Re-Parsing Casts

| # | File | Lines | Expression |
|---|------|-------|-----------|
| D1-D5 | `src/index.ts` | 264-344 | `result.clone().json() as { data?: ... }` |

### Category E: Trust Boundary Casts (deferred to Phase 3)

| # | File | Line | Expression |
|---|------|------|-----------|
| E1-E12 | various | various | `request.json() as T` -- handled by Zod in Phase 3 |

### Category F: Object Literal Casts

| # | File | Line | Expression |
|---|------|------|-----------|
| F1-F2 | `src/queue/helpers.ts` | 56, 123 | `{ ... } as EnrichmentMessage\|CleanupMessage` |

### Category G-I: Type shape issues

| # | File | Line | Issue |
|---|------|------|-------|
| G1 | `src/types.ts` | 85 | `[key: string]: unknown` index signature |
| H1 | `src/types.ts` | 231 | `applied_criteria?: object` |
| I1-I2 | `src/types.ts` | 323-339 | Type guard internal casts (deferred to Phase 3) |

---

## Step 1: AIResult Discriminated Union

**Finding**: A2, A3

The `AIResult` type uses optional fields with a boolean `success` flag. When
`success` is true, `cleaned` and `usedOriginal` are always present but TS
cannot prove it, forcing `!` at `cleanup.ts:443-444`.

### RED

Write tests in `test/queue/cleanup-airesult.test.ts`:

```typescript
// Test that buildBatchOperations handles success branch without assertions
// Test that buildBatchOperations handles failure branch correctly
// Test that buildBatchOperations handles useFallback branch
// Test that the discriminated union enforces mutual exclusivity at compile time
```

Test that `buildBatchOperations` correctly processes each variant without
runtime errors, using typed test fixtures that match the new discriminated union.

### GREEN

Replace the single `AIResult` interface in `src/queue/cleanup.ts:117-126` with:

```typescript
type AIResultSuccess = {
  readonly index: number;
  readonly success: true;
  readonly cleaned: string;
  readonly usedOriginal: boolean;
  readonly extractedABV: number | null;
  readonly latencyMs: number;
};

type AIResultFallback = {
  readonly index: number;
  readonly success: false;
  readonly useFallback: true;
  readonly error: string;
  readonly latencyMs?: number;
};

type AIResultFailure = {
  readonly index: number;
  readonly success: false;
  readonly useFallback?: false;
  readonly error: string;
  readonly latencyMs?: number;
};

type AIResult = AIResultSuccess | AIResultFallback | AIResultFailure;
```

Update `buildBatchOperations` (`cleanup.ts:363-507`) to narrow on
`result.success` first, then branch on `useFallback` inside the failure path:

```typescript
if (!result.success) {
  if (result.useFallback) { ... continue; }
  // TS now knows: result is AIResultFailure
  ... continue;
}
// TS now knows: result is AIResultSuccess
const { cleaned, usedOriginal, extractedABV } = result;
```

Update `processAIConcurrently` (`cleanup.ts:265-346`) return paths to produce
the correct variant type.

### REFACTOR

Remove the exported `AIResult` interface. Export the union type and both
variants for test consumers. Delete lines 443-444 non-null assertions.

---

## Step 2: Timeout Helper -- Eliminate `timeoutId!`

**Finding**: A1

`withTimeout` in `cleanupHelpers.ts:36-46` uses `let timeoutId` then accesses
it in `finally` with `!`. TypeScript cannot prove the promise executor runs
synchronously.

### RED

Write test in `test/queue/cleanupHelpers-timeout.test.ts`:

```typescript
// Test that withTimeout resolves when promise completes before timeout
// Test that withTimeout rejects with 'AI call timeout' when promise is slow
// Test that timer is properly cleaned up in both cases (no lingering timers)
```

### GREEN

Refactor `withTimeout` to initialize with `undefined`:

```typescript
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('AI call timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
```

### REFACTOR

The `| undefined` initializer plus `if` guard is clearer and avoids the `!`.

### Follow-up: Resource leak from `Promise.race`

Note: `Promise.race` resolves the timeout branch but the underlying `ai.run()`
call continues executing in the isolate, burning CPU time. The ideal fix would
be `AbortSignal.timeout(ms)` passed to `ai.run()`, but the current CF Workers
`AiOptions` type does not include a `signal` property (`worker-configuration.d.ts`).
When Cloudflare adds `signal` support to the AI binding types, replace
`withTimeout` + `Promise.race` with `AbortSignal.timeout(AI_TIMEOUT_MS)` passed
directly to `ai.run()` and remove `withTimeout` entirely.

---

## Step 3: Validation Result Discriminated Unions -- REMOVED

> **Note**: Validation result discriminated unions are handled by Phase 3's Zod
> migration -- `safeParse()` returns a discriminated union natively
> (`{success: true, data} | {success: false, error}`). Modifying these
> validators here would be throwaway work.

---

## Step 4: Typed D1 Query Results

**Finding**: B1, B2

`db.batch()` returns `D1Result<unknown>[]`. The code casts `result.results` to
specific row types.

### RED

Write tests in `test/db/helpers-typed.test.ts`:

```typescript
// Test getEnrichmentForBeerIds correctly maps row data to BeerEnrichmentData
// Test insertPlaceholders correctly reads existing record data
// Test behavior when result.results is undefined (empty result set)
```

### GREEN

Define row types and use a helper to narrow:

```typescript
// In src/db/helpers.ts
type EnrichmentRow = {
  readonly id: string;
  readonly abv: number | null;
  readonly confidence: number;
  readonly enrichment_source: string | null;
  readonly brew_description_cleaned: string | null;
};

type ExistingBeerRow = {
  readonly id: string;
  readonly description_hash: string | null;
  readonly abv: number | null;
};

/**
 * D1 batch results are untyped (D1Result<unknown>); this cast is safe because
 * the SQL query shape matches the target type.
 */
function asTypedRows<T>(results: unknown): readonly T[] {
  return (results ?? []) as T[];
}
```

Replace at `helpers.ts:76`:
```typescript
for (const row of asTypedRows<EnrichmentRow>(result.results)) {
```

Replace at `helpers.ts:252`:
```typescript
const rows = asTypedRows<ExistingBeerRow>(result.results);
```

### REFACTOR

The `asTypedRows` helper centralizes the single justified `as` cast (D1 results
are untyped by design) with documentation.

---

## Summary of Changes (Phase 4a)

| File | Changes |
|------|---------|
| `src/queue/cleanup.ts` | Three-way discriminated union for AIResult (Step 1), remove `!` at 443-444 |
| `src/queue/cleanupHelpers.ts` | `withTimeout` initialization fix (Step 2) |
| `src/db/helpers.ts` | `asTypedRows` helper for D1 results (Step 4) |

> Step 3 (validation results) removed -- handled by Phase 3's Zod migration.

## Next

Continue to **Phase 4b** for remaining cast cleanup (queue routing, admin
response parsing, FlyingSaucerBeer, `object` type, brew_description).
