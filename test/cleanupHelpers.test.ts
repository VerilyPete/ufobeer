/**
 * Unit tests for cleanup queue helper functions.
 *
 * @module test/cleanupHelpers.test
 */

import { describe, it, expect, vi } from 'vitest';
import {
  withTimeout,
  reserveCleanupQuotaBatch,
  batchUpdateWithRetry,
  AI_TIMEOUT_MS,
  SLOW_THRESHOLD_MS,
  SLOW_CALL_LIMIT,
  BREAKER_RESET_MS,
} from '../src/queue/cleanupHelpers';
import { createCircuitBreaker } from '../src/queue/circuitBreaker';

// ============================================================================
// withTimeout Tests
// ============================================================================

describe('withTimeout', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve('success'), 1000);
    expect(result).toBe('success');
  });

  it('rejects when promise takes longer than timeout', async () => {
    const slowPromise = new Promise(resolve => setTimeout(() => resolve('late'), 500));
    await expect(withTimeout(slowPromise, 100)).rejects.toThrow('AI call timeout');
  });

  it('clears timeout on success (no memory leak)', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    await withTimeout(Promise.resolve('success'), 1000);
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    clearTimeoutSpy.mockRestore();
  });

  it('clears timeout on rejection (no memory leak)', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    await expect(withTimeout(Promise.reject(new Error('original error')), 1000))
      .rejects.toThrow('original error');
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    clearTimeoutSpy.mockRestore();
  });

  it('propagates the original error when promise rejects before timeout', async () => {
    const error = new Error('custom error');
    await expect(withTimeout(Promise.reject(error), 1000)).rejects.toThrow('custom error');
  });

  it('preserves the resolved value type', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });
});

// ============================================================================
// Circuit Breaker Tests
// ============================================================================

describe('circuit breaker (via createCircuitBreaker)', () => {
  it('exports expected constants', () => {
    expect(AI_TIMEOUT_MS).toBe(10_000);
    expect(SLOW_THRESHOLD_MS).toBe(5000);
    expect(SLOW_CALL_LIMIT).toBe(3);
    expect(BREAKER_RESET_MS).toBe(60_000);
  });

  it('starts in closed state', () => {
    const breaker = createCircuitBreaker();
    expect(breaker.isOpen()).toBe(false);
    const state = breaker.getState();
    expect(state.isOpen).toBe(false);
    expect(state.slowCallCount).toBe(0);
  });

  it('does not open for fast calls', () => {
    const breaker = createCircuitBreaker();
    for (let i = 0; i < 10; i++) {
      breaker.recordLatency(SLOW_THRESHOLD_MS - 1, i, 10, `beer-${i}`);
    }
    expect(breaker.isOpen()).toBe(false);
  });

  it('does not open for fewer than SLOW_CALL_LIMIT slow calls', () => {
    const breaker = createCircuitBreaker();
    for (let i = 0; i < SLOW_CALL_LIMIT - 1; i++) {
      breaker.recordLatency(SLOW_THRESHOLD_MS + 1, i, 10, `beer-${i}`);
    }
    expect(breaker.isOpen()).toBe(false);
  });

  it('opens after exactly SLOW_CALL_LIMIT slow calls', () => {
    const breaker = createCircuitBreaker();
    for (let i = 0; i < SLOW_CALL_LIMIT; i++) {
      breaker.recordLatency(SLOW_THRESHOLD_MS + 1, i, 10, `beer-${i}`);
    }
    expect(breaker.isOpen()).toBe(true);
  });

  it('tracks beer IDs that triggered slow calls', () => {
    const breaker = createCircuitBreaker();
    for (let i = 0; i < SLOW_CALL_LIMIT; i++) {
      breaker.recordLatency(SLOW_THRESHOLD_MS + 1, i, 10, `beer-${i}`);
    }
    const state = breaker.getState();
    expect(state.slowBeerIds).toEqual(['beer-0', 'beer-1', 'beer-2']);
  });

  it('remains open immediately after opening', () => {
    const breaker = createCircuitBreaker();
    for (let i = 0; i < SLOW_CALL_LIMIT; i++) {
      breaker.recordLatency(SLOW_THRESHOLD_MS + 1, i, 10, `beer-${i}`);
    }
    expect(breaker.isOpen()).toBe(true);
    expect(breaker.isOpen()).toBe(true);
  });

  it('resets to half-open after BREAKER_RESET_MS', () => {
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

  it('reset() clears all state', () => {
    const breaker = createCircuitBreaker();
    for (let i = 0; i < SLOW_CALL_LIMIT; i++) {
      breaker.recordLatency(SLOW_THRESHOLD_MS + 1, i, 10, `beer-${i}`);
    }
    expect(breaker.isOpen()).toBe(true);

    breaker.reset();

    expect(breaker.isOpen()).toBe(false);
    const state = breaker.getState();
    expect(state.isOpen).toBe(false);
    expect(state.slowCallCount).toBe(0);
    expect(state.lastOpenedAt).toBe(0);
    expect(state.slowBeerIds).toEqual([]);
  });
});

// ============================================================================
// reserveCleanupQuotaBatch Tests
// ============================================================================

describe('reserveCleanupQuotaBatch', () => {
  // Create a mock D1 database
  // The fix reads oldCount before update, then compares with new_count after update
  function createMockDb(currentCount: number) {
    let storedCount = currentCount;

    const mockPrepare = vi.fn().mockImplementation((sql: string) => {
      // Handle INSERT (upsert for row existence)
      if (sql.includes('INSERT INTO cleanup_limits')) {
        return { bind: vi.fn().mockReturnValue({ run: vi.fn() }) };
      }
      // Handle SELECT to get current count before update
      if (sql.includes('SELECT request_count FROM cleanup_limits')) {
        return {
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({ request_count: storedCount }),
          }),
        };
      }
      // Handle UPDATE with RETURNING - only returns new_count
      if (sql.includes('UPDATE cleanup_limits')) {
        return {
          bind: vi.fn().mockImplementation((...args: number[]) => {
            const requested = args[0];
            const dailyLimit = args[1];
            // Simulate atomic update: increment only if within limit
            if (storedCount + requested <= dailyLimit) {
              storedCount += requested;
            }
            // Only return new_count - reserved is calculated in TypeScript
            return {
              first: vi.fn().mockResolvedValue({
                new_count: storedCount,
              }),
            };
          }),
        };
      }
      return { bind: vi.fn().mockReturnValue({ run: vi.fn(), first: vi.fn() }) };
    });

    return { prepare: mockPrepare } as unknown as D1Database;
  }

  it('reserves requested amount when quota available', async () => {
    const mockDb = createMockDb(0);
    const result = await reserveCleanupQuotaBatch(mockDb, 10, 1000);

    expect(result.reserved).toBe(10);
    expect(result.remaining).toBe(990);
  });

  it('reserves full amount when exactly at limit', async () => {
    const mockDb = createMockDb(990);
    const result = await reserveCleanupQuotaBatch(mockDb, 10, 1000);

    expect(result.reserved).toBe(10);
    expect(result.remaining).toBe(0);
  });

  it('reserves 0 when quota exhausted', async () => {
    const mockDb = createMockDb(1000);
    const result = await reserveCleanupQuotaBatch(mockDb, 10, 1000);

    expect(result.reserved).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it('reserves 0 when request would exceed limit', async () => {
    const mockDb = createMockDb(995);
    const result = await reserveCleanupQuotaBatch(mockDb, 10, 1000);

    expect(result.reserved).toBe(0);
    // Remaining is calculated from current count
    expect(result.remaining).toBe(5);
  });

  it('returns zeros when database returns null', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn(),
          first: vi.fn().mockResolvedValue(null),
        }),
      }),
    } as unknown as D1Database;

    const result = await reserveCleanupQuotaBatch(mockDb, 10, 1000);

    expect(result.reserved).toBe(0);
    expect(result.remaining).toBe(0);
  });
});

// ============================================================================
// batchUpdateWithRetry Tests
// ============================================================================

describe('batchUpdateWithRetry', () => {
  it('succeeds on first attempt', async () => {
    const mockBatch = vi.fn().mockResolvedValue([]);
    const mockDb = { batch: mockBatch } as unknown as D1Database;
    const mockStatements = [{ sql: 'UPDATE test' }] as unknown as D1PreparedStatement[];

    await batchUpdateWithRetry(mockDb, mockStatements);

    expect(mockBatch).toHaveBeenCalledTimes(1);
    expect(mockBatch).toHaveBeenCalledWith(mockStatements);
  });

  it('retries on failure and succeeds on second attempt', async () => {
    const mockBatch = vi.fn()
      .mockRejectedValueOnce(new Error('D1 transient error'))
      .mockResolvedValueOnce([]);
    const mockDb = { batch: mockBatch } as unknown as D1Database;
    const mockStatements = [{ sql: 'UPDATE test' }] as unknown as D1PreparedStatement[];

    await batchUpdateWithRetry(mockDb, mockStatements);

    expect(mockBatch).toHaveBeenCalledTimes(2);
  });

  it('retries up to maxRetries times before throwing', async () => {
    const error = new Error('D1 persistent error');
    const mockBatch = vi.fn().mockRejectedValue(error);
    const mockDb = { batch: mockBatch } as unknown as D1Database;
    const mockStatements = [{ sql: 'UPDATE test' }] as unknown as D1PreparedStatement[];

    await expect(batchUpdateWithRetry(mockDb, mockStatements, 3))
      .rejects.toThrow('D1 persistent error');

    expect(mockBatch).toHaveBeenCalledTimes(3);
  });

  it('uses exponential backoff between retries', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const mockBatch = vi.fn()
      .mockRejectedValueOnce(new Error('error 1'))
      .mockRejectedValueOnce(new Error('error 2'))
      .mockResolvedValueOnce([]);
    const mockDb = { batch: mockBatch } as unknown as D1Database;
    const mockStatements = [{ sql: 'UPDATE test' }] as unknown as D1PreparedStatement[];

    const promise = batchUpdateWithRetry(mockDb, mockStatements);

    // First attempt fails immediately
    await vi.advanceTimersByTimeAsync(0);

    // First retry after 100ms
    await vi.advanceTimersByTimeAsync(100);

    // Second retry after 200ms
    await vi.advanceTimersByTimeAsync(200);

    await promise;

    expect(mockBatch).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
    setTimeoutSpy.mockRestore();
  });

  it('handles empty statement array', async () => {
    const mockBatch = vi.fn().mockResolvedValue([]);
    const mockDb = { batch: mockBatch } as unknown as D1Database;

    await batchUpdateWithRetry(mockDb, []);

    expect(mockBatch).toHaveBeenCalledWith([]);
  });
});
