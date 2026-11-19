/**
 * Unit tests for cleanup queue helper functions.
 *
 * @module test/cleanupHelpers.test
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { batchUpdateWithRetry } from '../src/queue/cleanupHelpers';

const writeResult = (changes: number): D1Result => ({
  success: true,
  results: [],
  meta: {
    duration: 1,
    size_after: 0,
    rows_read: 1,
    rows_written: changes,
    last_row_id: 0,
    changed_db: changes > 0,
    changes,
  },
});

type Batch = (statements: D1PreparedStatement[]) => Promise<D1Result[]>;

// The helper only calls `batch`; the rest of D1Database is never touched.
const dbWith = (batch: Batch): D1Database => ({ batch }) as unknown as D1Database;

describe('batchUpdateWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the batch's per-statement results, so callers can see a guarded write that changed nothing", async () => {
    const results = [writeResult(1), writeResult(0)];
    const statements: D1PreparedStatement[] = [];
    const batch = vi.fn<Batch>().mockResolvedValue(results);

    await expect(batchUpdateWithRetry(dbWith(batch), statements)).resolves.toBe(results);
    expect(batch.mock.calls).toEqual([[statements]]);
    expect(batch.mock.calls[0]?.[0]).toBe(statements);
  });

  it('waits 100 ms after the first failure and 200 ms more after the second', async () => {
    const results = [writeResult(1)];
    const batch = vi.fn<Batch>()
      .mockRejectedValueOnce(new Error('D1 transient error 1'))
      .mockRejectedValueOnce(new Error('D1 transient error 2'))
      .mockResolvedValueOnce(results);

    const outcome = batchUpdateWithRetry(dbWith(batch), []);

    await vi.advanceTimersByTimeAsync(0);
    expect(batch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(batch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(batch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(batch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(batch).toHaveBeenCalledTimes(3);
    await expect(outcome).resolves.toBe(results);
  });

  it('throws the last error after maxRetries attempts, without waiting after the last', async () => {
    const batch = vi.fn<Batch>().mockRejectedValue(new Error('D1 persistent error'));

    const outcome = batchUpdateWithRetry(dbWith(batch), [], 3).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300);

    expect(batch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(await outcome).toEqual(new Error('D1 persistent error'));
  });
});
