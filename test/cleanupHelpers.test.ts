/**
 * Unit tests for cleanup queue helper functions.
 *
 * @module test/cleanupHelpers.test
 */

import { describe, it, expect, vi } from 'vitest';
import { batchUpdateWithRetry } from '../src/queue/cleanupHelpers';

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
  });

  it('handles empty statement array', async () => {
    const mockBatch = vi.fn().mockResolvedValue([]);
    const mockDb = { batch: mockBatch } as unknown as D1Database;

    await batchUpdateWithRetry(mockDb, []);

    expect(mockBatch).toHaveBeenCalledWith([]);
  });
});
