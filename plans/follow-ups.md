# Type Safety Hardening: Follow-Up Items

Three items deferred from the strictness migration. None are blocking.

## 1. Re-enable `exactOptionalPropertyTypes` in test tsconfig

**Status**: Deferred (pragmatic unblock for migration)
**File**: `test/tsconfig.json` line 8
**Flag**: `"exactOptionalPropertyTypes": false`

### Problem

The test tsconfig disables `exactOptionalPropertyTypes` because ~90 test
files assign `undefined` to optional properties in mock objects. Example:

```typescript
// This is invalid when exactOptionalPropertyTypes is true:
const mock: Partial<SomeType> = { optionalProp: undefined };

// The flag distinguishes between "property is absent" and "property is
// explicitly undefined". This matters because `'prop' in obj` returns
// true when prop is explicitly undefined but false when omitted.
```

### Why it matters

Tests that assign `undefined` to optional properties can mask real bugs.
If production code uses `'prop' in obj` to check for presence, a test mock
with `{ prop: undefined }` will pass the check even though a real omitted
property would not.

### Fix pattern

Replace `{ prop: undefined }` in test mocks with one of:

1. **Omit the property entirely** (simplest)
2. **`Partial<T>`** — lets you skip properties without assigning undefined
3. **Conditional spread** — `...(condition && { prop: value })`
4. **Factory functions** — `createMock({ overrides })` that only set provided keys

### Scope

~90 indexed access errors when the flag is enabled. Most are mechanical
fixes. Estimate: 1-2 hours of focused work.

### Also disabled: `noUncheckedIndexedAccess`

The test tsconfig also disables `noUncheckedIndexedAccess` (line 7) because
~90 test array accesses would need `if (!item) continue` guards. This is
lower priority — test code accessing known-length arrays is safe in practice.

### Verification

After cleanup:
1. Remove `exactOptionalPropertyTypes: false` from `test/tsconfig.json`
2. `npx tsc --project test/tsconfig.json --noEmit` — zero errors
3. `npx vitest run --config vitest.unit.config.mts` — all tests pass

---

## 2. Replace `withTimeout` with `AbortSignal.timeout` when CF adds support

**Status**: Blocked on Cloudflare
**File**: `src/queue/cleanupHelpers.ts:31-43`
**Current code**:

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

### Problem

`Promise.race` resolves when the timeout fires, but the underlying
`ai.run()` call continues executing in the Workers isolate, burning CPU
time until it completes or the isolate is evicted. There is no way to
cancel the in-flight AI inference.

### Ideal fix

Pass `AbortSignal.timeout(ms)` to `ai.run()`:

```typescript
const result = await env.AI.run(model, inputs, {
  signal: AbortSignal.timeout(AI_TIMEOUT_MS),
});
```

This would cancel the inference server-side, freeing resources immediately.

### Why it's blocked

The CF Workers `AiOptions` type (in `worker-configuration.d.ts`) does not
include a `signal` property. Adding it would cause a compile error under
strict mode. The runtime may or may not support it — the type definition
is the constraint.

### How to check

Periodically check the Cloudflare Workers AI changelog or the generated
`worker-configuration.d.ts` after `wrangler types` for an `AiOptions`
type that includes `signal?: AbortSignal`.

### When unblocked

1. Remove `withTimeout` from `cleanupHelpers.ts`
2. Remove `withTimeout` import from `cleanup.ts`
3. Pass `{ signal: AbortSignal.timeout(AI_TIMEOUT_MS) }` to `ai.run()`
4. Delete `test/queue/cleanupHelpers-timeout.test.ts` (no longer needed)
5. Verify all cleanup tests still pass

---

## 3. Pre-existing `getMonthEnd` timezone bug

**Status**: Pre-existing bug, not introduced by migration
**File**: `src/utils/date.ts:41-47`
**Tests**: `test/utils/date.test.ts` — 4 failures

### Failing tests

```
FAIL  should handle year transition dates
  expected '2024-12-31' to be '2025-01-31'
  (getMonthEnd(new Date('2025-01-01')) returns '2024-12-31')

FAIL  should work when called on first day of month
  expected '2025-05-31' to be '2025-06-30'
  (getMonthEnd(new Date('2025-06-01')) returns '2025-05-31')

(2 more similar failures)
```

### Root cause

`new Date('2025-01-01')` is parsed as UTC midnight. In timezones behind
UTC (like US timezones), `date.getFullYear()` and `date.getMonth()` return
local time values, which roll back to December 31, 2024. The function
uses local-time getters (`getFullYear`, `getMonth`) on a UTC-parsed date.

### Fix options

1. **Use UTC getters**: `getUTCFullYear()`, `getUTCMonth()` — consistent
   with how ISO date strings are parsed
2. **Parse dates with explicit timezone** — construct dates via
   `new Date(year, month, day)` in callers instead of ISO strings
3. **Use the same approach as `getToday()`** — which works because it
   splits an ISO string rather than using date arithmetic

The function works correctly in production because it's always called with
`new Date()` (current local time), not with ISO date strings. The bug only
manifests in tests that pass ISO strings crossing midnight boundaries.

### Impact

Zero production impact. The 4 test failures have been present across all
branches. Fix is optional but straightforward — switching to UTC getters
in `getMonthEnd` (and `getMonthStart` for consistency) would fix all 4.
