# Phase 5a: Circuit Breaker Encapsulation

## Goal

Encapsulate the module-level mutable circuit breaker state in `cleanupHelpers.ts`
behind a clean, testable factory function. This is the only MUST-fix mutation in
the codebase -- it causes test fragility and allows unbounded array growth.

## Problem

The circuit breaker is a mutable singleton at module scope:

```ts
// src/queue/cleanupHelpers.ts:88-93
const breaker: CircuitBreakerState = {
  slowCallCount: 0,
  isOpen: false,
  lastOpenedAt: 0,
  slowBeerIds: [],
};
```

Functions `isCircuitBreakerOpen()` (line 101), `recordCallLatency()` (line 126),
`resetCircuitBreaker()` (line 160), and `getCircuitBreakerState()` (line 173)
all mutate or read this shared object directly. The `breaker.slowBeerIds.push(beerId)`
at line 135 grows unboundedly within a batch.

**Why this matters:**
- Tests must call `resetCircuitBreaker()` between runs -- fragile ordering dependency
- State is invisible to callers -- no way to inject or isolate
- `slowBeerIds` grows without bound during a batch

## Solution

Encapsulate in a `createCircuitBreaker()` factory with an immutable-style API.

### TDD Steps

**RED:** Write tests for a new `CircuitBreaker` factory:

```
test/queue/circuitBreaker.test.ts
```

- `createCircuitBreaker()` returns an object with `isOpen()`, `recordLatency()`, `getState()`, `reset()`
- `isOpen()` returns `false` on fresh instance
- `recordLatency()` with slow calls opens the breaker after `SLOW_CALL_LIMIT` calls
- `isOpen()` returns `true` after breaker opens
- `isOpen()` returns `false` after `BREAKER_RESET_MS` elapses (half-open)
- `getState()` returns a frozen copy (not a reference to internal state)
- `slowBeerIds` is capped (e.g., last 10) to prevent unbounded growth
- Two independent instances do not share state

**GREEN:** Implement `CircuitBreaker`:

```ts
// src/queue/circuitBreaker.ts

interface CircuitBreakerConfig {
  readonly slowThresholdMs: number;
  readonly slowCallLimit: number;
  readonly resetMs: number;
  readonly maxTrackedBeerIds: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  slowThresholdMs: SLOW_THRESHOLD_MS,
  slowCallLimit: SLOW_CALL_LIMIT,
  resetMs: BREAKER_RESET_MS,
  maxTrackedBeerIds: 10,
};

function createCircuitBreaker(config: CircuitBreakerConfig = DEFAULT_CONFIG) {
  // Internal mutable state, hidden from callers
  let state: CircuitBreakerState = { ... };

  return {
    isOpen(): boolean { ... },
    recordLatency(latencyMs: number, beerId: string, context: LogContext): void { ... },
    getState(): Readonly<CircuitBreakerState> { return Object.freeze({ ...state }); },
    reset(): void { state = { ... initial }; },
  };
}
```

**REFACTOR:**

- Update `src/queue/cleanupHelpers.ts` to export a default instance created via
  `createCircuitBreaker()` instead of bare functions + module state
- Update `src/queue/cleanup.ts` imports (`processAIConcurrently`, `buildBatchOperations`)
  to accept a circuit breaker instance parameter (dependency injection)
- Remove `resetCircuitBreaker()` and `getCircuitBreakerState()` exports
  (tests create their own instances)
- Update existing tests in `test/queue/` to create fresh instances per test

## Files Changed

| File | Change |
|------|--------|
| `src/queue/circuitBreaker.ts` | New file -- `createCircuitBreaker()` factory |
| `src/queue/cleanupHelpers.ts` | Remove breaker state + bare functions, export default instance |
| `src/queue/cleanup.ts` | Accept breaker as parameter in `processAIConcurrently` |
| `test/queue/circuitBreaker.test.ts` | New file -- unit tests |
| `test/queue/cleanup.test.ts` | Update to inject breaker instances |

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Circuit breaker behavior changes subtly | Pin current behavior in tests first |
| `readonly` breaks callers that mutate received arrays | Run full test suite; fix any callers that rely on mutation |

---

## Implementation Notes (post-implementation drift)

**Type declarations use `type` not `interface`**: The plan showed `interface CircuitBreakerConfig`
(using the `interface` keyword). Implementation correctly uses `type CircuitBreakerConfig`
per Phase 2's interface-to-type mandate. Same for `CircuitBreaker` and `CircuitBreakerState`.

**`recordLatency` signature extended**: The plan showed `recordLatency(latencyMs, beerId, context)`.
Implementation has `recordLatency(latencyMs, currentIndex, totalMessages, beerId, maxConcurrent?)`.
The extra parameters support the log message that reports position in the batch and estimated
in-flight requests when the breaker opens.

**Test file name**: The plan said `test/queue/cleanup.test.ts` would be updated.
Implementation created `test/queue/circuitBreaker.test.ts` as a new file (as also
listed in the Files Changed table). There is no `test/queue/cleanup.test.ts`; the
categorize-then-filter tests went into `test/queue/categorizeAIResult.test.ts`
(see Phase 5b notes) and `test/queue/cleanup-airesult.test.ts` (Phase 4a).

**`createInitialState` helper**: Implementation extracted a private `createInitialState()`
function to avoid duplicating the default state object literal in both `createCircuitBreaker`
and `reset()`. Not mentioned in plan; clean DRY improvement.

**`getState()` freezes a shallow copy with spread `slowBeerIds`**: Plan says
`Object.freeze({ ...state })`. Implementation is `Object.freeze({ ...state, slowBeerIds: [...state.slowBeerIds] })`
to also copy the array, preventing callers from mutating the frozen snapshot's internal array.
This matches the test expectation "getState() returns a frozen copy (not a reference)".
