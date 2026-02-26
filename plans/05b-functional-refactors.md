# Phase 5b: Functional Refactors and Readonly Annotations

## Goal

Replace imperative array-building patterns with functional alternatives where it
improves clarity. Add `readonly` annotations to prevent accidental mutation.

## Scope

Two tiers of remaining mutation, ordered by priority:

1. **SHOULD fix** -- Imperative array building that would be clearer as functional pipelines
2. **WON'T fix** -- Local accumulator patterns that are idiomatic and readable as-is

---

## Tier 2: Imperative Array Building (SHOULD fix)

### 2a. `src/queue/cleanup.ts` -- `buildBatchOperations()` (lines 363-507)

**Current pattern:** Six separate mutable arrays (`dbStatements`, `perplexityMessages`,
`ackMessages`, `retryMessages`) plus five mutable counter variables, built in a
single `for` loop with `push()` calls.

**Problem:** The function conflates categorization (which bucket does this result go in?)
with side-effect accumulation (push into arrays, increment counters). Hard to test
individual categorization logic.

**Solution:** Extract a pure `categorizeAIResult()` function that returns a
discriminated union, then use `.map()` + `.filter()` to build the final structure.

#### TDD Steps

**RED:** Write tests that verify `buildBatchOperations` returns correct output
for representative inputs:

- All AI successes with ABV found
- All AI successes without ABV (queued for Perplexity)
- Mix of success, failure, and circuit-breaker fallback
- Empty input array
- Verify metrics are computed correctly

These tests should already exist; if not, add them. They pin current behavior
before refactoring.

**GREEN:** Skip directly to the categorize-then-filter approach. Extract a pure
`categorizeAIResult()` function that returns a discriminated union, then build
arrays with `.map()` + `.filter()`:

```ts
const categorized = aiResults.map((result, i) =>
  categorizeAIResult(result, messages[result.index], breakerOpen)
);

const dbStatements = categorized
  .filter(c => c.type === 'success' || c.type === 'fallback')
  .map(c => c.statement);
// etc.
```

**REFACTOR:** Simplify the discriminated union if any categories can be merged.

#### Files Changed

| File | Change |
|------|--------|
| `src/queue/cleanup.ts` | Extract `categorizeAIResult()`, refactor `buildBatchOperations` |
| `test/queue/cleanup.test.ts` | Add/verify behavioral tests for build operations |

### 2c. `src/db/helpers.ts` -- `insertPlaceholders()` (lines 205-441)

**Current pattern:** Four mutable arrays (`needsEnrichment`, `needsCleanup`,
`failed`, `writeStatements`) plus `statementToBeerIdMap` and a `withAbv` counter,
built incrementally in a complex loop with multiple branches.

**Assessment:** This function is the most complex in the codebase. The branching
logic (description changed? new beer? has ABV? blocklisted?) makes a pure
`.reduce()` harder to read than the current imperative version. However, the
branching logic itself can be extracted.

**Solution:** Extract the per-beer decision into a pure function
`categorizeBeer()` that returns a discriminated union:

```ts
type BeerCategory =
  | { type: 'description_changed'; beer: ...; statement: ... }
  | { type: 'needs_enrichment'; beer: ...; statement: ... }
  | { type: 'new_with_abv'; abv: number; statement: ... }
  | { type: 'new_needs_cleanup'; beer: ...; statement: ... }
  | { type: 'new_needs_enrichment'; beer: ...; statement: ... }
  | { type: 'unchanged'; statement: ... };
```

Then the main function becomes:

```ts
const categories = beers.map(beer => categorizeBeer(beer, hashMap, existingMap, db, now));
const needsEnrichment = categories.filter(c => c.type === 'needs_enrichment' || c.type === 'new_needs_enrichment').map(...);
const needsCleanup = categories.filter(c => c.type === 'description_changed' || c.type === 'new_needs_cleanup').map(...);
// etc.
```

**Note:** `categorizeBeer()` cannot fully encapsulate the SQL building step.
The main function still needs a switch/map over the returned categories to
select the correct SQL statement for each case, since different categories
require different INSERT/UPDATE statements.

#### TDD Steps

**RED:** Write tests for `categorizeBeer()` (a new pure function):
- Beer with changed description -> `description_changed`
- Existing beer, no ABV, not blocklisted -> `needs_enrichment`
- New beer with extractable ABV -> `new_with_abv`
- New beer with description, no ABV -> `new_needs_cleanup`
- New beer without description, not blocklisted -> `new_needs_enrichment`
- Existing beer with ABV -> `unchanged`
- Blocklisted beer -> filtered from enrichment/cleanup arrays

**GREEN:** Implement `categorizeBeer()` as a pure function.

**REFACTOR:** Update `insertPlaceholders` to use the categorized results.

#### Files Changed

| File | Change |
|------|--------|
| `src/db/helpers.ts` | Extract `categorizeBeer()`, refactor `insertPlaceholders` |
| `test/db/helpers.test.ts` | Add tests for `categorizeBeer()` |

### 2f. `src/queue/helpers.ts` -- `queueBeersForEnrichment/Cleanup` (lines 30-150)

**Current pattern:** `let queued = 0` counter incremented in a batching loop.

**Assessment:** The batching loop with error handling per batch is inherently
imperative (partial success semantics). Converting to `.reduce()` would obscure
the error handling. The loop itself is WON'T fix.

**However:** The `queued` counter can be derived:

```ts
const batchResults = await Promise.allSettled(
  chunks.map(chunk => env.ENRICHMENT_QUEUE.sendBatch(chunk.messages))
);
const queued = batchResults
  .filter(r => r.status === 'fulfilled')
  .reduce((sum, _, i) => sum + chunks[i].length, 0);
```

This is a minor improvement. Low priority.

---

## WON'T Fix (Acceptable Patterns)

These mutations are local, bounded, and idiomatic. Refactoring them would not
improve readability or would actively degrade it.

| File | Line(s) | Pattern | Reason to Keep |
|------|---------|---------|----------------|
| `src/db/helpers.ts` | 55-68 | `statements.push()` in chunking loop | Loop builds D1 batch; `.map()` on index ranges is less clear |
| `src/db/helpers.ts` | 74-89 | Nested `for` populating `enrichmentMap` | Iterating D1 batch results; `.flatMap()` possible but no clearer |
| `src/handlers/dlq.ts` | 62, 104-105 | `bindings.push()` for SQL params | Building dynamic SQL; alternatives are more complex |
| `src/handlers/dlq.ts` | 228-229 | `stats` object built with `for...of` | `Object.fromEntries` possible but less readable |
| `src/handlers/scheduled.ts` | entire file | No push patterns | Already clean |
| `src/handlers/health.ts` | 37-38 | `let dailyUsed = 0` | Assigned once in try/catch; destructuring from nullable is awkward |
| `src/rate-limit.ts` | entire file | No push patterns | Already clean |
| `src/handlers/enrichment.ts` | entire file | No push patterns (uses `.map()`) | Already functional |
| `src/queue/enrichment.ts` | 84-177 | Sequential processing loop with `continue` | Sequential by design (rate limiting between API calls) |
| `src/queue/cleanup.ts` | 562-631 | `handleFallbackBatch()` -- two arrays + counter with `push()` | Only ~70 lines, 2 arrays; low ROI for functional rewrite |
| `src/handlers/dlq.ts` | 279-394 | `handleDlqReplay()` -- `replayedIds`/`failedIds` with `push()` | Sequential sending provides backpressure; admin-only operation; current code is correct |
| `src/handlers/beers.ts` | 434-447 | `handleBeerSync()` validation -- `validBeers`/`validationErrors` with `push()` | Current loop is clear; `reduce` with spread creates O(n^2) allocations |
| `src/handlers/beers.ts` | 145-149 | Side-effect counter (`cleanedCount++`) inside `.map()` callback | Mutation is local to function scope; extracting would add complexity for no clarity gain |
| `src/handlers/dlq.ts` | 468-481 | Do-while accumulator pattern in `cleanupOldDlqMessages()` | Pagination loop with mutable counter is idiomatic for cursor-based deletion |

---

## `readonly` Annotations

After the functional refactors above, add `readonly` to function parameters
that accept arrays or objects to prevent accidental mutation.

### Targets

| File | Function | Parameter |
|------|----------|-----------|
| `src/queue/cleanup.ts` | `processAIConcurrently` | `messages` -- already `readonly` |
| `src/queue/cleanup.ts` | `buildBatchOperations` | `messages` -- already `readonly` |
| `src/queue/cleanup.ts` | `handleFallbackBatch` | `messages` -- already `readonly` |
| `src/queue/helpers.ts` | `queueBeersForEnrichment` | `beers` parameter |
| `src/queue/helpers.ts` | `queueBeersForCleanup` | `beers` parameter |
| `src/db/helpers.ts` | `getEnrichmentForBeerIds` | `beerIds` parameter |
| `src/db/helpers.ts` | `insertPlaceholders` | `beers` parameter |
| `src/handlers/beers.ts` | `processBackgroundEnrichment` | `beers` parameter |
| `src/queue/dlq.ts` | batch message arrays | Already use CF's `MessageBatch` type |

These are simple type annotation changes. Do them in a single pass after all
functional refactors are green.

---

## Implementation Order

1. **`buildBatchOperations` refactor** (2a) -- second-most complex function
2. **`insertPlaceholders` categorization** (2c) -- most complex, do after warm-up
3. **`readonly` annotations** -- mechanical pass, no behavior change
4. **Queue helpers** (2f) -- lowest priority, skip if time-boxed

Each step follows RED-GREEN-REFACTOR. Tests must pass after each step before
proceeding to the next.

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `reduce()` on complex objects is less readable than loops | Use discriminated unions + `.filter()` instead of nested reduces |
| `readonly` breaks callers that mutate received arrays | Run full test suite; fix any callers that rely on mutation |
| `insertPlaceholders` refactor introduces categorization bugs | Test every branch of the categorization function individually |
| `categorizeBeer()` can't encapsulate SQL building | Document that main function still needs category-to-SQL mapping |
