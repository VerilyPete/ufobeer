# Phase 1: tsconfig Strictness

Enable missing strict compiler flags and fix the test directory type-checking gap.

## Current State

`tsconfig.json` has `"strict": true` but is missing 6 additional flags.
`"exclude": ["test"]` means tests are never type-checked.
`allowJs: true` + `checkJs: false` is dead weight (no `.js` files in src/).

## Section 1: Zero-Error Flags

Add `noImplicitReturns` and `noFallthroughCasesInSwitch`. No source changes needed -- no switch statements exist and all functions have explicit returns. Just enable and verify.

## Section 2: noUnusedLocals (3 errors)

Remove unused imports:
- `src/handlers/beers.ts:16` -- remove `FlyingSaucerBeer` from import
- `src/handlers/beers.ts:25` -- remove `log` from import
- `src/handlers/enrichment.ts:19` -- remove `QuotaStatus` from import

## Section 3: noUnusedParameters (3 errors)

Prefix unused params with underscore:
- `src/auth.ts:106` -- `reqCtx` -> `_reqCtx` in `authorizeAdmin()`
- `src/handlers/scheduled.ts:41` -- `ctx` -> `_ctx` in `handleScheduledEnrichment()`
- `src/index.ts:408` -- `ctx` -> `_ctx` in `queue()` handler

## Section 4: noUncheckedIndexedAccess (~33 errors)

This is the largest section. Every array index/Record lookup now returns `T | undefined`.

### Pattern A: `.split('T')[0]` (8 errors)

Files: `enrichment.ts:159,162`, `health.ts:32,33`, `scheduled.ts:60,61`, `analytics.ts:223`, `cleanupTrigger.ts:177`, `cleanupHelpers.ts:195`

**Fix:** Replace inline `new Date().toISOString().split('T')[0]` with `getToday()` from `src/utils/date.ts`. Fix `getToday()` itself (line 16):

```typescript
export function getToday(date: Date = new Date()): string {
  const parts = date.toISOString().split('T');
  return parts[0] ?? '';
}
```

Then `health.ts`, `enrichment.ts`, `analytics.ts`, `cleanupTrigger.ts`, and `cleanupHelpers.ts` import `getToday`/`getMonthStart`/`getMonthEnd` instead of inlining.

### Pattern B: Array index in for-loops (11 errors)

Files: `queue/enrichment.ts:85-174`, `queue/cleanup.ts:385,430,437,487`

**Fix:** Add undefined guard after array access:
```typescript
const message = batch.messages[i];
if (!message) continue;
```

Same for `messages[result.index]` in `cleanup.ts:buildBatchOperations`.

### Pattern C: Regex match groups (3 errors)

Files: `services/perplexity.ts:93`, `db/helpers.ts:160`, `db/helpers.ts:174`

**Fix:** Use optional chaining + narrowing:
```typescript
const matched = abvMatch?.[1];
if (matched) { const abv = parseFloat(matched); ... }
// db/helpers.ts:174 -- similar pattern: abvMatch[1] || abvMatch[2]
const group = abvMatch?.[1] ?? abvMatch?.[2];
if (group) { ... }
```

### Pattern D: Array access in beers handler (6 errors)

Files: `handlers/beers.ts:372,376,441-444`

**Fix:** Add `if (!result) continue;` and `if (!beer) continue;` guards.

### Pattern E: Last-element access in DLQ pagination (2 errors)

File: `handlers/dlq.ts:97-98`

**Fix:** Wrap in `if (lastItem)` guard:
```typescript
const lastItem = pageResults[pageResults.length - 1];
if (lastItem) { /* build cursor */ }
```

## Section 5: exactOptionalPropertyTypes (6 errors)

When `prop?: T`, you cannot assign `undefined` explicitly -- must omit or provide `T`.

**Preferred fix:** Add `| undefined` to optional properties in internal types:

```typescript
// src/analytics.ts -- RequestMetrics
storeId?: string | undefined;
errorType?: string | undefined;
beersReturned?: number | undefined;
cacheHit?: boolean | undefined;
upstreamLatencyMs?: number | undefined;

// src/analytics.ts -- AdminTriggerMetrics, CronMetrics
skipReason?: '...' | undefined;
errorType?: string | undefined;
```

**Remaining fixes:**
- `handlers/enrichment.ts:177` -- use conditional spread for `skip_reason`: `...(skipReason && { skip_reason: skipReason })`. Remove the `delete data.skip_reason` block.
- `handlers/dlq.ts:338` -- conditionally include `delaySeconds`: `delay_seconds > 0 ? { delaySeconds: delay_seconds } : {}`
- `handlers/beers.ts:179` -- add `| undefined` to `brew_description` in `insertPlaceholders` param type

## Section 6: Remove Dead Config

Delete `allowJs: true` and `checkJs: false` from `tsconfig.json`. No `.js` files exist in `src/`.

## Section 7: Fix Test Directory Type-Checking

### Add npm script
```json
"typecheck:test": "tsc --project test/tsconfig.json --noEmit"
```

### Fix pre-existing test errors

1. `test/handlers/beers.list.test.ts` (4 errors) -- add `failed: []` to mock `InsertPlaceholdersResult` objects at lines 700, 736, 821, 853
2. `test/index.spec.ts:14` -- `ProvidedEnv` missing required Env fields; fix `test/env.d.ts` or cast in test

### Override noisy flags for test files

`exactOptionalPropertyTypes` should be `false` in the test tsconfig since test mocks frequently assign `undefined` to optional properties (e.g., partial mock objects). Enforcing this in tests adds noise without improving safety.

```jsonc
// test/tsconfig.json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": ["@cloudflare/vitest-pool-workers"],
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "exactOptionalPropertyTypes": false
  },
  "include": ["./**/*.ts", "../worker-configuration.d.ts"],
  "exclude": []
}
```

## Final tsconfig.json compilerOptions

```jsonc
"strict": true,
"noUncheckedIndexedAccess": true,
"noImplicitReturns": true,
"noUnusedLocals": true,
"noUnusedParameters": true,
"noFallthroughCasesInSwitch": true,
"exactOptionalPropertyTypes": true,
```

Removed: `allowJs`, `checkJs`.

## Verification

1. `npx tsc --noEmit` -- zero errors (src)
2. `npx tsc --project test/tsconfig.json --noEmit` -- zero errors (test)
3. `npm run test` -- all tests pass
4. No runtime behavior changes -- all fixes are type-level

## Files Modified

| File | Changes |
|------|---------|
| `tsconfig.json` | +6 flags, -2 dead flags |
| `test/tsconfig.json` | Override unused-*, exactOptionalPropertyTypes flags |
| `src/utils/date.ts` | Fix indexed access in `getToday()` |
| `src/handlers/health.ts` | Import `getToday()` instead of inline split |
| `src/handlers/enrichment.ts` | Import `getToday()`, remove unused import, fix skip_reason |
| `src/handlers/scheduled.ts` | Import `getToday()`, prefix `_ctx` |
| `src/handlers/beers.ts` | Remove unused imports, add undefined guards |
| `src/handlers/dlq.ts` | Add undefined guard, fix delaySeconds |
| `src/queue/enrichment.ts` | Add undefined guard for message access |
| `src/queue/cleanup.ts` | Add undefined guard for message access |
| `src/services/perplexity.ts` | Fix regex match narrowing |
| `src/db/helpers.ts` | Fix regex match narrowing |
| `src/auth.ts` | Prefix `_reqCtx` |
| `src/index.ts` | Prefix `_ctx`, fix optional property |
| `src/context.ts` | Fix optional property in trackRequest |
| `src/analytics.ts` | Add `\| undefined` to optional properties, import `getToday()` |
| `src/queue/cleanupTrigger.ts` | Import `getToday()` instead of inline split |
| `src/queue/cleanupHelpers.ts` | Import `getToday()` instead of inline split |
| `test/handlers/beers.list.test.ts` | Add `failed: []` to mocks |
| `test/index.spec.ts` | Fix ProvidedEnv type |

## Follow-up (post-migration)

Re-enable `exactOptionalPropertyTypes` in `test/tsconfig.json` after cleaning up test mocks. The flag is disabled in Phase 1 as a pragmatic unblock, but tests that assign `undefined` to optional properties can mask real bugs (e.g., `'prop' in obj` behaves differently when `prop` is explicitly `undefined` vs omitted).

**Fix pattern**: Replace `{ prop: undefined }` assignments in test mocks with `Partial<T>`, `Pick<T, K>`, conditional spread (`...(condition && { prop: value })`), or test factory functions that construct compliant objects. Once all test mocks are cleaned up, remove the `exactOptionalPropertyTypes: false` override from `test/tsconfig.json`.

This is not blocking for the strictness migration but should be tracked as a follow-up task.
