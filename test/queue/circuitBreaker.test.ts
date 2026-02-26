import { describe, it, expect, vi } from 'vitest';
import {
  createCircuitBreaker,
  DEFAULT_CONFIG,
} from '../../src/queue/circuitBreaker';
import {
  SLOW_THRESHOLD_MS,
  SLOW_CALL_LIMIT,
  BREAKER_RESET_MS,
} from '../../src/queue/cleanupHelpers';

describe('createCircuitBreaker', () => {
  it('returns object with isOpen, recordLatency, getState, reset', () => {
    const breaker = createCircuitBreaker();
    expect(typeof breaker.isOpen).toBe('function');
    expect(typeof breaker.recordLatency).toBe('function');
    expect(typeof breaker.getState).toBe('function');
    expect(typeof breaker.reset).toBe('function');
  });

  it('DEFAULT_CONFIG uses existing constants', () => {
    expect(DEFAULT_CONFIG.slowThresholdMs).toBe(SLOW_THRESHOLD_MS);
    expect(DEFAULT_CONFIG.slowCallLimit).toBe(SLOW_CALL_LIMIT);
    expect(DEFAULT_CONFIG.resetMs).toBe(BREAKER_RESET_MS);
    expect(DEFAULT_CONFIG.maxTrackedBeerIds).toBe(10);
  });

  it('isOpen() returns false on fresh instance', () => {
    const breaker = createCircuitBreaker();
    expect(breaker.isOpen()).toBe(false);
  });

  it('does not open for fast calls', () => {
    const breaker = createCircuitBreaker();
    for (let i = 0; i < 10; i++) {
      breaker.recordLatency(SLOW_THRESHOLD_MS - 1, i, 10, `beer-${i}`);
    }
    expect(breaker.isOpen()).toBe(false);
  });

  it('does not open for fewer than slowCallLimit slow calls', () => {
    const breaker = createCircuitBreaker();
    for (let i = 0; i < SLOW_CALL_LIMIT - 1; i++) {
      breaker.recordLatency(SLOW_THRESHOLD_MS + 1, i, 10, `beer-${i}`);
    }
    expect(breaker.isOpen()).toBe(false);
  });

  it('opens after exactly slowCallLimit slow calls', () => {
    const breaker = createCircuitBreaker();
    for (let i = 0; i < SLOW_CALL_LIMIT; i++) {
      breaker.recordLatency(SLOW_THRESHOLD_MS + 1, i, 10, `beer-${i}`);
    }
    expect(breaker.isOpen()).toBe(true);
  });

  it('isOpen() returns false after resetMs elapses (half-open)', () => {
    const breaker = createCircuitBreaker();
    for (let i = 0; i < SLOW_CALL_LIMIT; i++) {
      breaker.recordLatency(SLOW_THRESHOLD_MS + 1, i, 10, `beer-${i}`);
    }
    expect(breaker.isOpen()).toBe(true);

    const originalNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(originalNow + BREAKER_RESET_MS + 1);

    expect(breaker.isOpen()).toBe(false);

    const state = breaker.getState();
    expect(state.isOpen).toBe(false);
    expect(state.slowCallCount).toBe(0);
    expect(state.slowBeerIds).toEqual([]);

    vi.restoreAllMocks();
  });

  it('getState() returns a frozen copy (not reference to internal state)', () => {
    const breaker = createCircuitBreaker();
    const state1 = breaker.getState();
    expect(Object.isFrozen(state1)).toBe(true);

    breaker.recordLatency(SLOW_THRESHOLD_MS + 1, 0, 10, 'beer-0');
    const state2 = breaker.getState();

    // state1 should not have been mutated
    expect(state1.slowCallCount).toBe(0);
    expect(state2.slowCallCount).toBe(1);
  });

  it('slowBeerIds is capped at maxTrackedBeerIds', () => {
    const breaker = createCircuitBreaker({
      ...DEFAULT_CONFIG,
      slowCallLimit: 100, // high limit so breaker doesn't open
      maxTrackedBeerIds: 5,
    });

    for (let i = 0; i < 8; i++) {
      breaker.recordLatency(SLOW_THRESHOLD_MS + 1, i, 10, `beer-${i}`);
    }

    const state = breaker.getState();
    expect(state.slowBeerIds).toHaveLength(5);
    // Should keep the last 5
    expect(state.slowBeerIds).toEqual([
      'beer-3', 'beer-4', 'beer-5', 'beer-6', 'beer-7',
    ]);
  });

  it('two independent instances do not share state', () => {
    const breaker1 = createCircuitBreaker();
    const breaker2 = createCircuitBreaker();

    for (let i = 0; i < SLOW_CALL_LIMIT; i++) {
      breaker1.recordLatency(SLOW_THRESHOLD_MS + 1, i, 10, `beer-${i}`);
    }

    expect(breaker1.isOpen()).toBe(true);
    expect(breaker2.isOpen()).toBe(false);
  });

  it('reset() restores initial state', () => {
    const breaker = createCircuitBreaker();
    for (let i = 0; i < SLOW_CALL_LIMIT; i++) {
      breaker.recordLatency(SLOW_THRESHOLD_MS + 1, i, 10, `beer-${i}`);
    }
    expect(breaker.isOpen()).toBe(true);

    breaker.reset();

    expect(breaker.isOpen()).toBe(false);
    const state = breaker.getState();
    expect(state.slowCallCount).toBe(0);
    expect(state.isOpen).toBe(false);
    expect(state.lastOpenedAt).toBe(0);
    expect(state.slowBeerIds).toEqual([]);
  });

  it('accepts custom config', () => {
    const breaker = createCircuitBreaker({
      slowThresholdMs: 100,
      slowCallLimit: 2,
      resetMs: 1000,
      maxTrackedBeerIds: 3,
    });

    // Should open after 2 slow calls at 100ms threshold
    breaker.recordLatency(101, 0, 10, 'beer-0');
    expect(breaker.isOpen()).toBe(false);
    breaker.recordLatency(101, 1, 10, 'beer-1');
    expect(breaker.isOpen()).toBe(true);
  });
});
