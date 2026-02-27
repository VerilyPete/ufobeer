# Phase 2: Interface-to-Type Conversion

## Goal

Convert all data-shape `interface` declarations to `type` aliases. Reserve `interface` for behavior contracts only (things with methods that could be implemented by multiple concrete types). Add `readonly` to all properties as part of the conversion (addresses finding #10: immutability).

## Rationale

- `type` aliases are more appropriate for data shapes: they cannot be accidentally merged via declaration merging, they support union/intersection/mapped types natively, and they signal "this is data" vs "this is a contract"
- `interface` should be reserved for behavior contracts: types with methods that define a capability a class or object must implement
- Adding `readonly` at conversion time is efficient since every declaration is already being touched

## Classification Criteria

**Keep as `interface`** when:
- It defines method signatures (behavior contract)
- It is used with `implements` or `extends`
- It is part of an external API contract that consumers may need to augment

**Convert to `type`** when:
- It is a pure data shape (only property declarations, no methods)
- It describes request/response bodies, database rows, configuration, results, metrics

## Interface Inventory

### `src/types.ts` (27 interfaces — all convert to `type`)

All interfaces in this file are pure data shapes (request bodies, response bodies, database rows, configuration objects, validation results). None have methods.

| Line | Name | Visibility | Decision | Notes |
|------|------|-----------|----------|-------|
| 9 | `Env` | export | **CONVERT** | Environment bindings — pure data shape with property declarations |
| 53 | `EnrichmentMessage` | export | **CONVERT** | Queue message body |
| 64 | `CleanupMessage` | export | **CONVERT** | Queue message body |
| 79 | `FlyingSaucerBeer` | export | **CONVERT** | API response data; has index signature `[key: string]: unknown` |
| 96 | `RequestContext` | export | **CONVERT** | Request metadata |
| 113 | `DlqMessageRow` | export | **CONVERT** | Database row shape |
| 134 | `PaginationCursor` | export | **CONVERT** | Cursor data |
| 143 | `DlqReplayRequest` | export | **CONVERT** | Request body |
| 152 | `DlqAcknowledgeRequest` | export | **CONVERT** | Request body |
| 164 | `TriggerEnrichmentRequest` | export | **CONVERT** | Request body |
| 176 | `QuotaStatus` | export | **CONVERT** | Status data |
| 185 | `TriggerEnrichmentData` | export | **CONVERT** | Response data |
| 206 | `ForceEnrichmentRequest` | export | **CONVERT** | Request body |
| 221 | `ForceEnrichmentResponse` | export | **CONVERT** | Response body |
| 243 | `BeerToReEnrich` | export | **CONVERT** | Database row shape |
| 256 | `ForceEnrichmentValidationResult` | export | **CONVERT** | Validation result |
| 265 | `ClearResult` | export | **CONVERT** | Operation result |
| 280 | `EnrichmentQuotaStatus` | export | **CONVERT** | Quota status data |
| 294 | `ErrorResponseOptions` | export | **CONVERT** | Options object |
| 305 | `GetBeersResult` | export | **CONVERT** | Handler result |
| 351 | `SyncBeersRequest` | export | **CONVERT** | Request body |
| 364 | `SyncBeersResponse` | export | **CONVERT** | Response body |
| 376 | `BatchLookupResponse` | export | **CONVERT** | Response body |
| 410 | `TriggerCleanupRequest` | export | **CONVERT** | Request body |
| 424 | `CleanupPreview` | export | **CONVERT** | Preview data |
| 436 | `TriggerCleanupData` | export | **CONVERT** | Response data |
| 483 | `CleanupTriggerValidationResult` | export | **CONVERT** | Validation result |

### `src/analytics.ts` (7 interfaces — 6 convert, 1 keeps)

| Line | Name | Visibility | Decision | Notes |
|------|------|-----------|----------|-------|
| 34 | `AnalyticsEngineDataset` | export | **KEEP** | Behavior contract: has `writeDataPoint()` method. Defines a capability that the Cloudflare runtime implements. |
| 45 | `RequestMetrics` | export | **CONVERT** | Metrics data shape |
| 61 | `EnrichmentMetrics` | export | **CONVERT** | Metrics data shape |
| 74 | `CronMetrics` | export | **CONVERT** | Metrics data shape |
| 303 | `AdminDlqMetrics` | export | **CONVERT** | Metrics data shape |
| 314 | `DlqConsumerMetrics` | export | **CONVERT** | Metrics data shape |
| 394 | `AdminTriggerMetrics` | export | **CONVERT** | Metrics data shape |
| 409 | `CleanupTriggerMetrics` | export | **CONVERT** | Metrics data shape |

### `src/context.ts` (1 interface — converts)

| Line | Name | Visibility | Decision | Notes |
|------|------|-----------|----------|-------|
| 44 | `RespondOptions` | export | **CONVERT** | Options object. Note: has a `writeAuditLog` property that is a function type, but this is a callback property not a method — it is data (a function value passed in), not a behavioral contract. |

### `src/rate-limit.ts` (1 interface — converts)

| Line | Name | Visibility | Decision | Notes |
|------|------|-----------|----------|-------|
| 36 | `RateLimitResult` | export | **CONVERT** | Result data shape |

### `src/db/helpers.ts` (2 interfaces — both convert)

| Line | Name | Visibility | Decision | Notes |
|------|------|-----------|----------|-------|
| 17 | `BeerEnrichmentData` | export | **CONVERT** | Database row shape |
| 120 | `InsertPlaceholdersResult` | export | **CONVERT** | Operation result |

### `src/handlers/beers.ts` (2 interfaces — both convert)

| Line | Name | Visibility | Decision | Notes |
|------|------|-----------|----------|-------|
| 306 | `BeerValidationResult` | export | **CONVERT** | Validation result |
| 348 | `SyncBatchResult` | export | **CONVERT** | Batch operation result |

### `src/queue/cleanup.ts` (4 interfaces — all convert)

| Line | Name | Visibility | Decision | Notes |
|------|------|-----------|----------|-------|
| 82 | `CleanupResult` | export | **CONVERT** | Operation result |
| 92 | `BatchMetrics` | private | **CONVERT** | Internal metrics data |
| 106 | `BatchOperations` | private | **CONVERT** | Internal batch data |
| 117 | `AIResult` | export | **CONVERT** | Processing result |
| 640 | `QuotaReservationResult` | private | **CONVERT** | Internal result data |

### `src/queue/cleanupHelpers.ts` (1 interface — converts)

| Line | Name | Visibility | Decision | Notes |
|------|------|-----------|----------|-------|
| 76 | `CircuitBreakerState` | private | **CONVERT** | Internal state shape |

### `src/handlers/cleanupTrigger.ts` (2 interfaces — both convert)

| Line | Name | Visibility | Decision | Notes |
|------|------|-----------|----------|-------|
| 30 | `BeerRow` | private | **CONVERT** | Database row shape |
| 241 | `BeerWithHash` | private | **CONVERT** | Internal data shape |

### `src/utils/log.ts` (1 interface — converts)

| Line | Name | Visibility | Decision | Notes |
|------|------|-----------|----------|-------|
| 7 | `LogData` | export | **CONVERT** | Data shape with index signature |

### Files NOT in scope (auto-generated / external)

| File | Reason |
|------|--------|
| `worker-configuration.d.ts` | Auto-generated by `wrangler types`. Do not edit. |
| `test/env.d.ts` | Cloudflare test env declaration merging — `interface ProvidedEnv extends Env {}` requires `interface` for declaration merging. Do not touch. |

## Summary

| Decision | Count |
|----------|-------|
| **Convert to `type`** | 50 |
| **Keep as `interface`** | 1 (`AnalyticsEngineDataset`) |
| **Out of scope** | 2 files (auto-generated) |

## TDD Approach

### RED: Compile-check test

Before converting anything, write a compile-time verification test that imports every exported type and uses them in type-level assertions. This ensures conversions do not break any consumers.

```typescript
// test/type-checks/interface-to-type.test.ts
import { describe, it, expectTypeOf } from 'vitest';

// Import every exported type that will be converted
import type {
  Env,
  EnrichmentMessage,
  CleanupMessage,
  FlyingSaucerBeer,
  RequestContext,
  DlqMessageRow,
  PaginationCursor,
  DlqReplayRequest,
  DlqAcknowledgeRequest,
  TriggerEnrichmentRequest,
  QuotaStatus,
  TriggerEnrichmentData,
  ForceEnrichmentRequest,
  ForceEnrichmentResponse,
  BeerToReEnrich,
  ForceEnrichmentValidationResult,
  ClearResult,
  EnrichmentQuotaStatus,
  ErrorResponseOptions,
  GetBeersResult,
  SyncBeersRequest,
  SyncBeersResponse,
  BatchLookupResponse,
  TriggerCleanupRequest,
  CleanupPreview,
  TriggerCleanupData,
  CleanupTriggerValidationResult,
} from '../../src/types';
import type { RequestMetrics, EnrichmentMetrics, CronMetrics, AdminDlqMetrics, DlqConsumerMetrics, AdminTriggerMetrics, CleanupTriggerMetrics, AnalyticsEngineDataset } from '../../src/analytics';
import type { RespondOptions } from '../../src/context';
import type { RateLimitResult } from '../../src/rate-limit';
import type { BeerEnrichmentData, InsertPlaceholdersResult } from '../../src/db/helpers';
import type { BeerValidationResult, SyncBatchResult } from '../../src/handlers/beers';
import type { CleanupResult, AIResult } from '../../src/queue/cleanup';
import type { LogData } from '../../src/utils/log';

describe('interface-to-type conversion compile checks', () => {
  // Verify key structural properties survive conversion.
  // These will fail to compile if the type shape changes.

  it('EnrichmentMessage has expected fields', () => {
    expectTypeOf<EnrichmentMessage>().toHaveProperty('beerId');
    expectTypeOf<EnrichmentMessage>().toHaveProperty('beerName');
    expectTypeOf<EnrichmentMessage>().toHaveProperty('brewer');
  });

  it('Env has DB binding', () => {
    expectTypeOf<Env>().toHaveProperty('DB');
    expectTypeOf<Env>().toHaveProperty('API_KEY');
  });

  it('FlyingSaucerBeer allows index access', () => {
    expectTypeOf<FlyingSaucerBeer>().toHaveProperty('id');
    expectTypeOf<FlyingSaucerBeer>().toHaveProperty('brew_name');
  });

  it('AnalyticsEngineDataset remains an interface with method', () => {
    expectTypeOf<AnalyticsEngineDataset>().toHaveProperty('writeDataPoint');
  });

  it('RateLimitResult has expected fields', () => {
    expectTypeOf<RateLimitResult>().toHaveProperty('allowed');
    expectTypeOf<RateLimitResult>().toHaveProperty('remaining');
    expectTypeOf<RateLimitResult>().toHaveProperty('resetAt');
  });

  it('RespondOptions has writeAuditLog callback', () => {
    expectTypeOf<RespondOptions>().toHaveProperty('writeAuditLog');
  });

  it('GetBeersResult has response field', () => {
    expectTypeOf<GetBeersResult>().toHaveProperty('response');
  });

  it('LogData supports index signature', () => {
    expectTypeOf<LogData>().toBeObject();
  });
});
```

This test should **pass** before any conversion (verifying the baseline), **continue passing** after conversion (verifying no breakage), and **fail** if any type is accidentally removed or its shape changes.

After adding `readonly`, extend the test with `// @ts-expect-error` mutation tests to verify that `readonly` is enforced:

```typescript
it('readonly prevents mutation of EnrichmentMessage', () => {
  const msg: EnrichmentMessage = { beerId: '1', beerName: 'IPA', brewer: 'Test' };
  // @ts-expect-error — readonly property cannot be assigned
  msg.beerId = '2';
});

it('readonly prevents mutation of RateLimitResult', () => {
  const result: RateLimitResult = { allowed: true, remaining: 5, resetAt: 100 };
  // @ts-expect-error — readonly property cannot be assigned
  result.allowed = false;
});
```

These compile-time tests confirm that `readonly` is actually present on converted types. If `readonly` was accidentally omitted, the `@ts-expect-error` directive would itself cause a compile error (since the assignment would be valid).

### GREEN: Convert interfaces to types

Process each file, converting `interface Foo { ... }` to `type Foo = { ... }`. Add `readonly` to every property at the same time.

#### Conversion pattern

Before:
```typescript
export interface EnrichmentMessage {
  beerId: string;
  beerName: string;
  brewer: string;
}
```

After:
```typescript
export type EnrichmentMessage = {
  readonly beerId: string;
  readonly beerName: string;
  readonly brewer: string;
};
```

#### Special cases

1. **Index signatures** (`LogData`, `FlyingSaucerBeer`): The index signature itself gets `readonly`:
   ```typescript
   export type LogData = {
     readonly [key: string]: unknown;
   };
   ```

2. **Nested object literals** (e.g. `TriggerEnrichmentData.quota`): Add `readonly` to nested properties too:
   ```typescript
   export type TriggerEnrichmentData = {
     readonly beers_queued: number;
     readonly quota: {
       readonly daily: QuotaStatus;
       readonly monthly: QuotaStatus;
     };
   };
   ```

3. **Array properties** (e.g. `InsertPlaceholdersResult.needsEnrichment`): Use `readonly` on the array type:
   ```typescript
   readonly needsEnrichment: readonly Array<{...}>;
   ```
   Or equivalently: `readonly needsEnrichment: ReadonlyArray<{...}>;`

4. **`AnalyticsEngineDataset`** stays as `interface` (behavior contract with a method).

5. **Types that will break with `readonly`** — these three types have properties mutated after construction:

   - **`CircuitBreakerState`** (`cleanupHelpers.ts:88-93`): Properties mutated at lines 108-110, 135, 137-138, 161-164. **Exclude from `readonly`** — Phase 5 handles encapsulation of this mutable state.

   - **`TriggerCleanupData`** (`cleanupTrigger.ts`): `data.beers_reset` assigned after construction at lines 400, 429, 472, 544. **Fix**: include `beers_reset` in the initial object literal so the property is set at construction, not mutated afterward.

   - **`TriggerEnrichmentData`** (`enrichment.ts:199-200`): `delete data.skip_reason` after construction. **Already fixed in Phase 1 Section 5** (conditional spread replaces `delete data.skip_reason`). No action needed in Phase 2 — just verify the property can be `readonly` after Phase 1's change.

### REFACTOR: Verify and clean up

1. Run `npx tsc --noEmit` to verify zero compile errors
2. Run full test suite to verify zero regressions
3. Verify the compile-check test still passes
4. Remove any now-unnecessary JSDoc `@interface` tags if present

## Execution Order

Process files in dependency order (types.ts first since others import from it):

1. `src/types.ts` (27 interfaces) — highest impact, most consumers
2. `src/analytics.ts` (7 interfaces, skip `AnalyticsEngineDataset`)
3. `src/context.ts` (1 interface)
4. `src/rate-limit.ts` (1 interface)
5. `src/db/helpers.ts` (2 interfaces)
6. `src/handlers/beers.ts` (2 interfaces)
7. `src/queue/cleanup.ts` (5 interfaces)
8. `src/queue/cleanupHelpers.ts` (1 interface)
9. `src/handlers/cleanupTrigger.ts` (2 interfaces)
10. `src/utils/log.ts` (1 interface)

After each file, run `npx tsc --noEmit` to catch any breakage immediately.

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Declaration merging breaks | Only `AnalyticsEngineDataset` is kept as `interface`; `test/env.d.ts` is out of scope |
| `readonly` causes assignment errors in production code | Expected — fix by using spread/copy patterns instead of mutation. This is intentional and aligns with Phase 5 (immutability). See special case #5 for 3 known types that will break. |
| `readonly` cascades into 20+ assignment errors | If `readonly` produces more than ~20 assignment errors beyond the 3 known types, split `readonly` into a separate sub-phase: first do interface-to-type conversion only (no `readonly`), land it, then add `readonly` in a follow-up. This keeps each change reviewable. |
| Index signature on `FlyingSaucerBeer` with `readonly` | `readonly [key: string]: unknown` works fine with `type`; verified in TS 5.x |
| `Env` interface used by Cloudflare runtime | `type` works identically for object shapes passed to CF Workers; no declaration merging needed in our code since `worker-configuration.d.ts` defines its own `Env` via `interface Env extends Cloudflare.Env {}` which is out of scope |
| `readonly` breaks test assignments | Test files that construct or mutate objects of converted types (e.g., partial mocks, test fixtures) may get assignment errors. The test tsconfig disables `exactOptionalPropertyTypes` but `readonly` assignment errors will still surface. Fix with object spread (`{...obj, prop: newVal}`) or `as` casts in test-only code where mutation is intentional. |

## Estimated Scope

- **50 conversions** across 10 files
- **1 new test file** (`test/type-checks/interface-to-type.test.ts`)
- **0 behavior changes** — purely structural refactor
- Mechanical transformation; each conversion is a search-and-replace with `readonly` addition

---

## Implementation Notes (post-implementation drift)

**157 `readonly` modifiers in `types.ts` alone**: The actual implementation applied `readonly`
very broadly, including nested object shapes inside types, `ReadonlyArray<>` for array properties,
and all optional `| undefined` properties. Total across all files was significantly more than
the ~50 conversions implied.

**2 false-positive `@ts-expect-error` directives in compile-check test**: Caught during review
(commit `e63fab2`). Two `@ts-expect-error` annotations in `test/type-checks/interface-to-type.test.ts`
were targeting properties that did NOT have `readonly` — so the assignment was valid and the
`@ts-expect-error` itself caused a compile error (error on an error-free line). Fixed by removing
those two directives. The remaining `@ts-expect-error` annotations correctly verify `readonly`
enforcement.

**`FlyingSaucerBeer` index signature retained**: The plan noted the index signature
`[key: string]: unknown` in `FlyingSaucerBeer`. In `src/types.ts` this was retained
(line 85: `readonly [key: string]: unknown`) because `hasBeerStock` accesses the object
with a key (`brewInStock`) not known at compile time. Phase 3b's `FlyingSaucerBeerSchema`
with `.passthrough()` handles the external trust boundary; the type retains the index
signature for internal type safety.
