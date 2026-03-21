---
title: Extract pure categorization functions and add readonly parameter annotations
implemented: 2026-02-26
commit: 6353ec6
tags: [functional, refactoring, pure-functions, discriminated-union, readonly, immutability]
---

## Problem

`buildBatchOperations` in `cleanup.ts` conflated categorization with side-effect accumulation (6 mutable arrays + 5 counters in one loop). `insertPlaceholders` in `db/helpers.ts` had similarly complex imperative branching (~237 lines). Both were hard to test at the categorization level.

## Decision

**`buildBatchOperations`**: Extracted `categorizeAIResult()` as a pure function returning a `CategorizedResult` discriminated union (`success_with_abv | success_no_abv | fallback_with_abv | fallback_no_abv | failure`). `buildBatchOperations` now uses `.map(categorizeAIResult)` then `.filter()` + `.map()` to build the final batch arrays. Tests in `test/queue/categorizeAIResult.test.ts` cover each variant.

**`insertPlaceholders`**: Extracted `categorizeBeer()` as a pure function returning an 8-variant `BeerCategory` discriminated union. The plan listed 6 variants; implementation split blocklisted beers into `blocklisted_new` and `blocklisted_existing` for clearer filtering logic in `insertPlaceholders`. Tests in `test/db/categorizeBeer.test.ts`.

**`readonly` annotations**: Added to function parameters accepting arrays or objects across `cleanup.ts`, `helpers.ts`, `queue/helpers.ts`, and `handlers/beers.ts`.

## Trade-offs

- `queueBeersForEnrichment/Cleanup` counter derivation via `Promise.allSettled` (step 2f) not implemented — imperative counter is idiomatic and correct; too low ROI.
- Many patterns explicitly left imperative (WON'T fix): batching loops with per-batch error handling, dynamic SQL param building, pagination accumulators, `reduce` patterns that would create O(n²) allocations. These are idiomatic and their sequential nature is often load-bearing.
- Dedicated test files (`categorizeAIResult.test.ts`, `categorizeBeer.test.ts`) rather than adding to a non-existent `cleanup.test.ts` — cleaner isolation of pure function tests.
