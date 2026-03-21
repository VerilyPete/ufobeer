---
title: Discriminated unions for AIResult and typed D1 query helpers
implemented: 2026-02-26
commit: 4b35434
tags: [typescript, discriminated-union, non-null-assertion, D1, type-safety, circuit-breaker]
---

## Problem

`AIResult` used optional fields (`cleaned?: string`, `usedOriginal?: boolean`) with a boolean `success` flag. TypeScript couldn't prove the fields were present in the success branch, forcing non-null assertions (`!`) at `cleanup.ts:443-444`. D1 batch results typed as `unknown` required `as Array<SpecificType>` casts.

## Decision

Replaced `AIResult` with a three-way discriminated union: `AIResultSuccess | AIResultFallback | AIResultFailure`. Each variant carries only the fields that exist for that branch. `buildBatchOperations` narrows on `result.success`, then on `result.useFallback` in the failure path — no assertions needed.

All three variants exported for test consumers.

`withTimeout` in `cleanupHelpers.ts` rewritten with `let timeoutId: ReturnType<typeof setTimeout> | undefined` and an `if (timeoutId !== undefined)` guard in `finally` — eliminates `clearTimeout(timeoutId!)`.

`asTypedRows<T>()` helper in `db/helpers.ts` centralizes D1 batch result casting with a JSDoc comment explaining why the cast is safe (D1 returns `unknown` by design; we control the SQL query shape). Exported so tests can verify it directly.

Validation result discriminated unions (originally planned here) dropped — Phase 3b's `safeParse()` return type is already a discriminated union natively.

## Trade-offs

- `AIResultFallback.latencyMs` uses `readonly latencyMs?: number | undefined` (explicit `| undefined`) per Phase 1's `exactOptionalPropertyTypes` requirement.
- `recordLatency` signature extended beyond the plan: `(latencyMs, currentIndex, totalMessages, beerId, maxConcurrent?)` to support log messages reporting batch position and estimated in-flight requests when the breaker opens.
- Queue routing casts (`batch as MessageBatch<T>`) — left with justifying comments. CF runtime guarantees type matches queue binding in `wrangler.jsonc`; no runtime way to validate the generic parameter.
- `withTimeout` + `Promise.race` resource leak: the underlying `ai.run()` continues executing after timeout. Fix when Cloudflare adds `AbortSignal` support to AI binding types — then replace with `AbortSignal.timeout(ms)` passed directly to `ai.run()`.
- No `test/queue/routing.test.ts` created — queue routing behavior is infrastructure-level (controlled by wrangler.jsonc) and covered by `test/index.spec.ts`.
