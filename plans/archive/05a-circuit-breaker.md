---
title: Encapsulate mutable circuit breaker state behind a factory function
implemented: 2026-02-26
commit: 4b35434
tags: [circuit-breaker, encapsulation, singleton, mutation, testability, dependency-injection]
---

## Problem

The circuit breaker was a mutable singleton at module scope in `cleanupHelpers.ts`. Tests required `resetCircuitBreaker()` between runs (fragile ordering dependency). `slowBeerIds.push(beerId)` grew unboundedly within a batch. State was invisible to callers — no injection or isolation possible.

## Decision

Extracted `createCircuitBreaker()` factory in `src/queue/circuitBreaker.ts`. Internal mutable state is hidden; callers get a `{ isOpen(), recordLatency(), getState(), reset() }` interface.

`getState()` returns `Object.freeze({ ...state, slowBeerIds: [...state.slowBeerIds] })` — the array is also copied to prevent callers from mutating the frozen snapshot's internal array.

`slowBeerIds` capped at 10 entries to prevent unbounded growth.

`cleanupHelpers.ts` exports a default instance via `createCircuitBreaker()` for production use. Tests create independent instances per test — no shared state, no `resetCircuitBreaker()` calls needed.

`createInitialState()` private helper extracted to avoid duplicating the default state literal in both `createCircuitBreaker` and `reset()`.

## Trade-offs

- `recordLatency` signature extended beyond the plan: `(latencyMs, currentIndex, totalMessages, beerId, maxConcurrent?)` — extra params needed for the log message that reports batch position and estimated in-flight count when the breaker opens.
- All three type declarations (`CircuitBreakerConfig`, `CircuitBreaker`, `CircuitBreakerState`) use `type` not `interface` — consistent with Phase 2.
- Test file for categorization logic went to `test/queue/categorizeAIResult.test.ts` (Phase 5b creates this) rather than updating a `test/queue/cleanup.test.ts` that doesn't exist.
