# Type Safety Hardening: Master Plan

## Background

A TypeScript strictness audit of the ufobeer codebase identified 14 findings across five categories. This plan addresses all of them in five phases, ordered so each phase produces a compilable, fully-tested codebase before the next begins.

## Findings Summary

| # | Finding | Severity | Phase |
|---|---------|----------|-------|
| 1 | Missing `noUncheckedIndexedAccess` (~33 errors) | High | 1 |
| 2 | Missing `noUnusedLocals` (3 errors) | Low | 1 |
| 3 | Missing `noUnusedParameters` (3 errors) | Low | 1 |
| 4 | Missing `noImplicitReturns`, `noFallthroughCasesInSwitch` (0 errors) | Low | 1 |
| 5 | Missing `exactOptionalPropertyTypes` (6 errors) | Medium | 1 |
| 6 | `allowJs`/`checkJs` dead config, test dir excluded from type-checking | Medium | 1 |
| 7 | `interface` used for pure data shapes (50 types) | Medium | 2 |
| 8 | `as` casts on `request.json()` at trust boundaries (15+ casts) | High | 3 |
| 9 | Manual validators replaceable by schemas (~180 lines) | Medium | 3 |
| 10 | `!` non-null assertions (5 instances) | Medium | 4 |
| 11 | `as` casts on internal data (D1 results, queue routing, analytics) | Medium | 4 |
| 12 | `object` type and index signatures used where concrete types exist | Low | 4 |
| 13 | Module-level mutable state (circuit breaker singleton) | High | 5 |
| 14 | Imperative array-building where functional pipelines are clearer | Low | 5 |

## Phase Overview

### Phase 1: tsconfig Strictness (`01-tsconfig-strictness.md`)

Enable 6 missing strict compiler flags and fix the test directory type-checking gap. Remove dead `allowJs`/`checkJs` config. ~45 source errors to fix, plus ~8 pre-existing test errors.

- 7 sections, each independently verifiable with `npx tsc --noEmit`
- 17 files modified, 0 behavior changes
- Findings addressed: 1-6

### Phase 2: Interface-to-Type Conversion (`02-interface-to-type.md`)

Convert 50 `interface` declarations to `type` aliases. Reserve `interface` for behavior contracts only (1 kept: `AnalyticsEngineDataset`). Add `readonly` to all properties during conversion.

- 10 files, purely mechanical transformation
- Compile-check test verifies no type shapes break
- Findings addressed: 7 (plus partial 14 via `readonly`)

### Phase 3: Schema Validation at Trust Boundaries (`03a-schema-definitions.md`, `03b-schema-integration.md`)

Add Zod schemas for all request bodies and external API responses. Replace ~180 lines of manual validation with ~120 lines of schemas. Eliminate 15+ `as` casts at trust boundaries. Preserves backwards-compatible error codes (e.g. `INVALID_BEER_IDS`) via Zod `.message()` overrides and per-beer partial success behavior in `handleBeerSync`.

- **3a**: Create all Zod schemas (7 request + 2 external) with TDD tests
- **3b**: Integrate schemas into handlers, replace manual validators
- Adds `zod` dependency (~13KB, zero transitive deps)
- New `src/schemas/` directory with request and external schemas
- Types derived from schemas via `z.infer<>`, re-exported from `src/types.ts`
- Findings addressed: 8, 9

### Phase 4: Type Assertion and Non-Null Cleanup (`04a-discriminated-unions.md`, `04b-cast-cleanup.md`)

Eliminate 5 `!` assertions and ~10 internal `as` casts via discriminated unions, type narrowing, and proper type guards. Remaining casts (~10) get justifying comments.

- **4a**: Discriminated unions (AIResult, timeout fix, D1 typed helper). Step 3 (validation results) removed -- handled by Phase 3's Zod migration.
- **4b**: Queue routing docs, admin response parser, E3 trust boundary comment, FlyingSaucerBeer cleanup, `object` type fix, brew_description narrowing. Step 8 (`satisfies` for queue helpers) removed -- handled in Phase 3b.
- 8 active steps across ~15 files
- Findings addressed: 10, 11, 12

### Phase 5: Immutability and Mutation Cleanup (`05a-circuit-breaker.md`, `05b-functional-refactors.md`)

Encapsulate the circuit breaker singleton behind a testable factory. Refactor imperative array-building to functional pipelines where it improves clarity. Add `readonly` parameter annotations.

- **5a**: Circuit breaker encapsulation (MUST fix) -- standalone, can start after Phase 2
- **5b**: Functional refactors (2 SHOULD fix: `buildBatchOperations`, `insertPlaceholders`), WON'T fix (14 patterns documented), `readonly` annotations
- 2 new files, ~5 files changed significantly
- Findings addressed: 13, 14

## Phase Dependencies

```
Phase 1 (tsconfig)
  |
  v
Phase 2 (interface-to-type)
  |
  |---> Phase 3a (schema definitions) --> Phase 3b (schema integration) --> Phase 4b (cast cleanup)
  |                                                                    \
  |---> Phase 4a (discriminated unions) --------------------------------+--> Phase 5b (functional refactors)
  |
  |---> Phase 5a (circuit breaker) -- no downstream dependencies
```

Phase 2 enables three parallel tracks:
- **Track A**: Phase 3a -> 3b -> 4b (schemas, then integration, then remaining casts)
- **Track B**: Phase 4a (discriminated unions) -- can run in parallel with Track A
- **Track C**: Phase 5a (circuit breaker encapsulation) -- can start immediately after Phase 2

Phase 5b requires both Phase 4a (discriminated unions) and Phase 3b (schema integration) to be complete.

Each phase leaves `npx tsc --noEmit` and `npm run test` green before dependent phases begin.

## TDD Methodology

Every phase follows RED-GREEN-REFACTOR:

1. **RED**: Enable a flag / write a failing type-check test / write a behavioral test that exposes the gap
2. **GREEN**: Make the minimum change to pass -- fix the error, add the schema, narrow the type
3. **REFACTOR**: Clean up only if it adds value -- extract helpers, remove dead code, simplify

Each section within a phase is designed to be independently verifiable. An implementing agent can complete one section, run `npx tsc --noEmit` + `npm run test`, and confirm green before moving to the next.

## Implementation Status: COMPLETE

All phases implemented and reviewed. 8 commits total.

### Commits

| Commit | Scope |
|--------|-------|
| `4b35434` | Phases 1-5a (main implementation) |
| `4c957e5` | Phase 3b (schema integration) |
| `6353ec6` | Phases 4b+5b (cast cleanup, functional refactors) |
| `e63fab2` | Review nits: analytics.ts consistency, false-positive `@ts-expect-error`, missing edge case tests |
| `366a362` | Pre-existing timezone bug fix (getMonthStart/getMonthEnd used local time, not UTC) |
| `3ff4712` | Remove resolved getMonthEnd follow-up item |
| `f4011ab` | Enable `exactOptionalPropertyTypes` in test tsconfig (1 violation, not ~90) |
| `9e793c7` | Mark follow-up as done |

### Final Metrics

| Metric | Planned | Actual |
|--------|---------|--------|
| Phases | 5 (8 plan files) | 5 (8 plan files) |
| Files modified | ~30 | ~45 |
| New files | ~8 | ~8 |
| `as` casts eliminated | ~25 | ~25 |
| `!` assertions eliminated | 5 | 5 |
| Manual validation lines removed | ~180 | ~180 |
| Interfaces converted to types | 50 | 50 |
| Compiler flags enabled | 6 | 6 |
| New tests added | — | ~120 |
| Behavior changes | 0 | 0 |

### Plan-vs-Implementation Drift

1. **Commit granularity**: Plan implied one commit per phase. Implementation bundled phases into 3 major commits + 5 follow-ups. All green-to-green transitions maintained, just at coarser granularity.
2. **`exactOptionalPropertyTypes` test scope**: Follow-ups estimated ~90 test violations. Actual: 1 error in 1 file. The ~90 was `noUncheckedIndexedAccess` errors, conflated during planning.
3. **`categorizeBeer()` variants**: Plan said 6, implementation produced 8 (blocklisted split into its own variant).
4. **Unplanned fixes**: `global` → `globalThis` in tests, `analytics.ts:trackCron` date inconsistency, 2 false-positive `@ts-expect-error` directives, 5 missing schema edge case tests — all caught during review.
5. **Pre-existing timezone bug**: `getMonthStart`/`getMonthEnd` used local time getters on UTC dates. Discovered during migration, fixed in dedicated commit.

### Remaining Follow-Ups

See `follow-ups.md`. One item remains:
- `withTimeout` → `AbortSignal.timeout`: Blocked on Cloudflare `AiOptions` type lacking `signal`. Research (Feb 2026) confirms `env.AI.run()` still doesn't support it. AI Gateway `cf-aig-request-timeout` header is a viable workaround. Current `Promise.race` approach is acceptable — Worker I/O wait doesn't burn CPU.

### TDD Remediation (subsequent work)

After the 8-commit type safety migration, TDD remediation was completed in 2 additional commits (`402414e`, `6f32cf0`). See `TDD-REMEDIATION-PLAN.md` for the full plan and its implementation notes. Summary:
- 11 new test files covering auth, analytics, audit, context, config, hash, constants, health, DLQ consumer, DLQ handler, enrichment handler
- 8 existing test files refactored (let/beforeEach → factories, SQL assertions removed)
- 748 total tests across 30 files
- `test/queue/routing.test.ts` and `test/handlers/admin-analytics.test.ts` (planned in 04b) were NOT created — skipped as low-value given coverage by integration tests

### Cache Proxy + CI/CD Deployment (subsequent work)

After TDD remediation, two more features were implemented:
- **Cache proxy** (`06-beers-cache-proxy.md`): GET /beers caching proxy with D1 store_taplist_cache table, stale fallback, and `fresh=true` bypass. Commit `e6c4472` and others.
- **CI/CD deployment** (`ufobeer-deployment.md`): GitHub Actions pipeline (typecheck → test → migrate → deploy), top-level try/catch in fetch handler, cache D1 failure resilience with `resolveStaleRow` helper.

### Tail Worker Error Alerting (subsequent work)

Separate Cloudflare Worker (`ufobeer-error-alerts`) with a `tail()` handler that monitors main worker invocations and emails `pete@verily.org` when errors occur. See `07-tail-worker-error-alerts.md`.

- Allowlist-based error detection (unknown outcomes default to alerting)
- 5-minute in-memory cooldown to prevent email floods
- Hand-built RFC 5322 email (no runtime deps)
- Fallback alerting when the processing pipeline itself fails
- 47 tests across 4 files in `workers/error-alerts/`

Current totals: **869 tests across 38 files** (main worker), plus **47 tests across 4 files** (tail worker).

## Verification Checklist (per phase)

1. `npx tsc --noEmit` -- zero errors (src)
2. `npx tsc --project test/tsconfig.json --noEmit` -- zero errors (test)
3. `npm run test` -- all tests pass
4. No runtime behavior changes confirmed by existing test suite

## Design Decisions

- **Zod over manual validation**: Schemas are denser, composable, and produce types automatically. ~13KB cost is acceptable for a Workers API.
- **`type` over `interface`**: Data shapes should not be accidentally merged. `interface` reserved for `AnalyticsEngineDataset` (behavior contract with `writeDataPoint()` method).
- **Discriminated unions over optional fields**: `AIResult` and validation results use `success: true | false` discriminant so TypeScript can narrow without assertions.
- **Circuit breaker factory over singleton**: Dependency injection enables isolated tests without shared module state.
- **Justified casts over zero casts**: D1 batch results and queue routing casts are inherent to Cloudflare's untyped APIs. Document with comments rather than adding runtime overhead.
- **WON'T fix tier**: Some imperative patterns (batched queue sends, D1 chunking loops, sequential rate-limited processing) are clearer as loops. No dogmatic conversion.

## Agent Context Window Sizing

Each phase plan file is self-contained and under 300 lines. Phases 3, 4, and 5 are split into sub-files (a/b) for manageability. An implementing agent needs:
- The phase plan file
- Access to the source files listed in that plan
- Ability to run `npx tsc --noEmit` and `npm run test`

No phase requires reading other phase plans to implement. Cross-phase references (e.g., "Phase 3 will handle these casts") are informational only.

## Review Findings Applied

20 issues were identified during expert review and addressed across all plan files (2 hallucinated findings removed):

| # | Severity | Summary | Resolution |
|---|----------|---------|------------|
| 1 | HIGH | 3b: `handleBeerSync` validation loop uses per-beer `safeParse`, not whole-request | Documented partial success pattern with per-beer Zod validation |
| 2 | HIGH | 3b: `ForceEnrichmentRequest` has ~15 error codes clients depend on | Added Zod `.message('CODE:text')` strategy to preserve error codes |
| 3 | MEDIUM | 4a: Step 3 validation unions duplicate Phase 3 Zod migration | Step 3 removed from 4a, marked as handled by Phase 3 |
| 4 | MEDIUM | 4b: Steps 7-8 overlap with Phase 3b schema integration | Step 7 reduced to E3 only; Step 8 removed (handled in 3b Step 6a) |
| 5 | MEDIUM | 4a/4b: `brew_description!` assertion (A4) not covered | Added Step 11 to 4b with inline narrowing pattern |
| 6 | LOW | 1: `noUncheckedIndexedAccess` error count was 27, actual is ~33 | Updated to ~33 with categorized fix locations |
| 7 | LOW | 1: Missing `--project test/tsconfig.json` for test type-checking | Added separate `npx tsc --project test/tsconfig.json --noEmit` verification |
| 8 | LOW | 3a: `PerplexityResponseSchema` missing `model` field | Not needed — code never reads `model` from Perplexity response. No change to schema. |
| 9 | LOW | 3a: `FlyingSaucerBeerSchema` missing `.passthrough()` for extra fields | Added `.passthrough()` to preserve unknown keys |
| 11 | LOW | 2: `AnalyticsEngineDataset` rationale unclear | Clarified: CF runtime provides the object, `writeDataPoint()` is the behavior contract |
| 12 | LOW | 3b: Flying Saucer response (E3) is external trust boundary, not internal | Moved E3 to Phase 4b Step 7 with trust boundary comment |
| 13 | STRUCTURAL | Phase 5 too large as single file | Split into 05a (circuit breaker) and 05b (functional refactors) |
| 14 | LOW | 1: Section 4 error count stale after Section 7 changes | Updated cross-references between sections |
| 15 | LOW | 1: Test tsconfig inherits flags but some may need overrides | Documented test-specific flag considerations |
| 16 | LOW | 2: Readonly conversion may break spread patterns in tests | Added row to Phase 2 Risks table about test assignment errors and spread/cast fixes |
| 17 | LOW | 5b: `reduce()` GREEN step for `buildBatchOperations` is a detour | Skipped to categorize-then-filter approach directly |
| 18 | LOW | 5b: Three SHOULD-fix items have low ROI | Reclassified `handleFallbackBatch`, `handleDlqReplay`, `handleBeerSync` validation to WON'T-fix |
| 19 | LOW | 5b: Two mutation patterns missed from audit | Added `cleanedCount++` in `.map()` and do-while accumulator to WON'T-fix table |
| 20 | MEDIUM | Dependency graph was strictly sequential, missed parallelism | Updated to show three parallel tracks after Phase 2 |
| 22 | LOW | 3b: Zod error format differs from manual validator format | Added error format mapping strategy for backwards compatibility |

### Round 3 Review Findings

5 additional issues identified during external review:

| # | Severity | Summary | Resolution |
|---|----------|---------|------------|
| 23 | HIGH | 4b Step 9 overwrites 3b Step 5b's Zod-based `isValidBeer` rewrite | Deleted 4b Step 9; 3b's `FlyingSaucerBeerSchema.safeParse()` is authoritative. Added `.passthrough()` note to 3a. |
| 24 | HIGH | 3b Step 3j swallows invalid input (e.g. `{"limit": -5}`) by falling through to defaults | Fixed: empty body → defaults (preserved), invalid fields → 400 response |
| 25 | MEDIUM | Error message extraction leaves leading space (`" human text"`) due to `"CODE: text"` format | Added `.trim()` to `.slice()` in both 3k and 3l `mapZodIssueToErrorCode` callers |
| 26 | LOW | Phase 1 §5 and Phase 2 Case #5 both fix `delete data.skip_reason` in enrichment.ts | Removed duplicate from Phase 2; defers to Phase 1, Phase 2 only verifies `readonly` |
| 27 | MEDIUM | 4b Step 10 manually defines `EnrichmentCriteria` that duplicates 3a's `CriteriaSchema` | Exported `CriteriaSchema` + `EnrichmentCriteria = z.infer<>` from 3a; 4b imports it |
