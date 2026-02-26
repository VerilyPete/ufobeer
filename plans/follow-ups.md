# Type Safety Hardening: Follow-Up Items

One item remains from the strictness migration.

## ~~1. Re-enable `exactOptionalPropertyTypes` in test tsconfig~~

**Status**: Done (f4011ab)

Only 1 violation existed (not ~90 as estimated — that count was
`noUncheckedIndexedAccess` errors). Fixed by omitting
`queued_for_cleanup_at` instead of assigning `undefined` in
`test/handlers/cleanupTrigger.test.ts`. Flag now enabled in
`test/tsconfig.json`, aligned with production config.

`noUncheckedIndexedAccess` remains disabled in test tsconfig (line 7).
Low priority — test code accessing known-length arrays is safe in practice.

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

