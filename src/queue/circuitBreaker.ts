/** Threshold above which an AI call is considered "slow" */
export const SLOW_THRESHOLD_MS = 5000;

/** Number of slow calls before circuit breaker opens */
export const SLOW_CALL_LIMIT = 3;

/** Time before circuit breaker resets to half-open state */
export const BREAKER_RESET_MS = 60_000;

type CircuitBreakerState = {
  slowCallCount: number;
  isOpen: boolean;
  lastOpenedAt: number;
  slowBeerIds: string[];
};

type CircuitBreakerConfig = {
  readonly slowThresholdMs: number;
  readonly slowCallLimit: number;
  readonly resetMs: number;
  readonly maxTrackedBeerIds: number;
};

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  slowThresholdMs: SLOW_THRESHOLD_MS,
  slowCallLimit: SLOW_CALL_LIMIT,
  resetMs: BREAKER_RESET_MS,
  maxTrackedBeerIds: 10,
};

type CircuitBreaker = {
  isOpen(): boolean;
  recordLatency(latencyMs: number, currentIndex: number, totalMessages: number, beerId: string, maxConcurrent?: number): void;
  getState(): Readonly<CircuitBreakerState>;
  reset(): void;
};

function createInitialState(): CircuitBreakerState {
  return {
    slowCallCount: 0,
    isOpen: false,
    lastOpenedAt: 0,
    slowBeerIds: [],
  };
}

function createCircuitBreaker(config: CircuitBreakerConfig = DEFAULT_CONFIG): CircuitBreaker {
  let state = createInitialState();

  return {
    isOpen(): boolean {
      if (!state.isOpen) return false;

      const now = Date.now();
      if (now - state.lastOpenedAt > config.resetMs) {
        console.log('[cleanup] Circuit breaker half-open, allowing retry');
        state.isOpen = false;
        state.slowCallCount = 0;
        state.slowBeerIds = [];
        return false;
      }

      return true;
    },

    recordLatency(
      latencyMs: number,
      currentIndex: number,
      totalMessages: number,
      beerId: string,
      maxConcurrent: number = 10
    ): void {
      if (latencyMs > config.slowThresholdMs) {
        state.slowCallCount++;
        state.slowBeerIds.push(beerId);

        if (state.slowBeerIds.length > config.maxTrackedBeerIds) {
          state.slowBeerIds = state.slowBeerIds.slice(-config.maxTrackedBeerIds);
        }

        if (state.slowCallCount >= config.slowCallLimit && !state.isOpen) {
          state.isOpen = true;
          state.lastOpenedAt = Date.now();
          const estimatedInFlight = maxConcurrent - 1;
          console.warn('[cleanup] Circuit breaker opened', {
            slow_call_count: state.slowCallCount,
            threshold_ms: config.slowThresholdMs,
            triggered_by_beer_ids: state.slowBeerIds,
            opened_at_index: currentIndex,
            total_messages: totalMessages,
            remaining_messages: totalMessages - currentIndex - 1,
            estimated_in_flight: estimatedInFlight,
            will_reset_after_ms: config.resetMs,
          });
        }
      }
    },

    getState(): Readonly<CircuitBreakerState> {
      return Object.freeze({
        ...state,
        slowBeerIds: [...state.slowBeerIds],
      });
    },

    reset(): void {
      state = createInitialState();
    },
  };
}

export { createCircuitBreaker, DEFAULT_CONFIG };
export type { CircuitBreakerConfig, CircuitBreaker, CircuitBreakerState };
