/**
 * Unit tests for rate limiting functions.
 *
 * Tests getEndpointRateLimitKey function for correct key generation
 * to enable per-endpoint rate limiting.
 *
 * Tests checkRateLimit function for rate limit enforcement including
 * edge cases, database error handling, and cleanup logic.
 */

import { describe, it, expect, vi } from 'vitest';
import { getEndpointRateLimitKey, checkRateLimit } from '../src/rate-limit';

describe('getEndpointRateLimitKey', () => {
  it('should create endpoint-specific key', () => {
    const key = getEndpointRateLimitKey('client-abc-123', 'sync');
    expect(key).toBe('client-abc-123:sync');
  });

  it('should create different keys for different endpoints', () => {
    const syncKey = getEndpointRateLimitKey('client-abc', 'sync');
    const batchKey = getEndpointRateLimitKey('client-abc', 'batch');

    expect(syncKey).not.toBe(batchKey);
    expect(syncKey).toBe('client-abc:sync');
    expect(batchKey).toBe('client-abc:batch');
  });

  it('should handle empty endpoint gracefully', () => {
    const key = getEndpointRateLimitKey('client-abc', '');
    expect(key).toBe('client-abc:');
  });

  it('should handle empty client identifier gracefully', () => {
    const key = getEndpointRateLimitKey('', 'sync');
    expect(key).toBe(':sync');
  });

  it('should handle special characters in client identifier', () => {
    const key = getEndpointRateLimitKey('client:with:colons', 'sync');
    expect(key).toBe('client:with:colons:sync');
  });

  it('should create consistent keys for same inputs', () => {
    const key1 = getEndpointRateLimitKey('client-123', 'beers');
    const key2 = getEndpointRateLimitKey('client-123', 'beers');
    expect(key1).toBe(key2);
  });

  it('should differentiate between similar but different endpoints', () => {
    const key1 = getEndpointRateLimitKey('client', 'sync-batch');
    const key2 = getEndpointRateLimitKey('client', 'sync');
    const key3 = getEndpointRateLimitKey('client-sync', 'batch');

    expect(key1).toBe('client:sync-batch');
    expect(key2).toBe('client:sync');
    expect(key3).toBe('client-sync:batch');

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key2).not.toBe(key3);
  });

  it('should handle long client identifiers', () => {
    const longId = 'x'.repeat(1000);
    const key = getEndpointRateLimitKey(longId, 'sync');
    expect(key).toBe(`${longId}:sync`);
  });

  it('should handle long endpoint names', () => {
    const longEndpoint = 'y'.repeat(500);
    const key = getEndpointRateLimitKey('client', longEndpoint);
    expect(key).toBe(`client:${longEndpoint}`);
  });

  describe('endpoint isolation', () => {
    it('should ensure sync endpoint key is independent of batch endpoint key', () => {
      const clientId = 'api-key-hash-abc123';

      const syncKey = getEndpointRateLimitKey(clientId, 'sync');
      const batchKey = getEndpointRateLimitKey(clientId, 'batch');
      const beersKey = getEndpointRateLimitKey(clientId, 'beers');

      expect(syncKey).toBe('api-key-hash-abc123:sync');
      expect(batchKey).toBe('api-key-hash-abc123:batch');
      expect(beersKey).toBe('api-key-hash-abc123:beers');

      expect(new Set([syncKey, batchKey, beersKey]).size).toBe(3);
    });

    it('should allow same endpoint for different clients', () => {
      const client1SyncKey = getEndpointRateLimitKey('client-1', 'sync');
      const client2SyncKey = getEndpointRateLimitKey('client-2', 'sync');

      expect(client1SyncKey).not.toBe(client2SyncKey);
      expect(client1SyncKey).toBe('client-1:sync');
      expect(client2SyncKey).toBe('client-2:sync');
    });
  });
});

/**
 * Create a mock D1 database for testing checkRateLimit.
 * The mock supports chained method calls like db.prepare().bind().first()
 */
const createMockDb = () => {
  const mock = {
    prepare: vi.fn(),
    bind: vi.fn(),
    first: vi.fn(),
    run: vi.fn(),
  };
  mock.prepare.mockReturnValue(mock);
  mock.bind.mockReturnValue(mock);
  return mock;
};

describe('checkRateLimit', () => {
  describe('basic functionality', () => {
    it('should allow requests under limit', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 5 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(95);
    });

    it('should reject requests over limit', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 101 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should track remaining count correctly', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 75 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.remaining).toBe(25);
    });

    it('should use a different rate limit bucket when the minute changes', async () => {
      const mockDb = createMockDb();
      const time1 = new Date('2025-01-15T10:00:30.000Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(time1);
      mockDb.first.mockResolvedValueOnce({ request_count: 50 });

      const result1 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      expect(result1.remaining).toBe(50);

      const time2 = new Date('2025-01-15T10:01:30.000Z').getTime();
      dateNowSpy.mockReturnValue(time2);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result2 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      expect(result2.remaining).toBe(99);

      dateNowSpy.mockRestore();
    });
  });

  describe('edge cases', () => {
    it('should allow request exactly at limit (count === limit)', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 100 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('should reject request one over limit (count === limit + 1)', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 101 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should handle first request (count = 1)', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
    });

    it('should handle null result from database (default to count = 1)', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce(null);

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
    });

    it('should handle undefined request_count in result', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({});

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
    });

    it('should handle limit of 1', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 1);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('should reject second request when limit is 1', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 2 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 1);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should handle very high request count (far over limit)', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 10000 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should handle very high limit', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 500 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 10000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9500);
    });

    it('should ensure remaining never goes negative', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 200 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.remaining).toBe(0);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });
  });

  describe('minute boundary transitions', () => {
    it('should use different minute buckets across minute boundary', async () => {
      const mockDb = createMockDb();
      const time1 = new Date('2025-01-15T10:00:59.000Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(time1);
      mockDb.first.mockResolvedValueOnce({ request_count: 99 });

      const result1 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      expect(result1.remaining).toBe(1);

      const firstMinuteBucket = Math.floor(time1 / 60000);

      const time2 = new Date('2025-01-15T10:01:01.000Z').getTime();
      dateNowSpy.mockReturnValue(time2);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result2 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      expect(result2.remaining).toBe(99);

      const secondMinuteBucket = Math.floor(time2 / 60000);

      expect(secondMinuteBucket).toBe(firstMinuteBucket + 1);

      dateNowSpy.mockRestore();
    });

    it('should maintain same minute bucket within same minute', async () => {
      const mockDb = createMockDb();
      const time1 = new Date('2025-01-15T10:00:00.000Z').getTime();
      const time2 = new Date('2025-01-15T10:00:59.999Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(time1);

      mockDb.first.mockResolvedValueOnce({ request_count: 1 });
      const result1 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      dateNowSpy.mockReturnValue(time2);
      mockDb.first.mockResolvedValueOnce({ request_count: 2 });
      const result2 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result1.resetAt).toBe(result2.resetAt);

      dateNowSpy.mockRestore();
    });
  });

  describe('database error handling (graceful degradation)', () => {
    it('should allow request on database error', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockRejectedValueOnce(new Error('DB connection failed'));

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(true);
    });

    it('should return full remaining count on database error', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockRejectedValueOnce(new Error('DB timeout'));

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.remaining).toBe(100);
    });

    it('should log error on database failure', async () => {
      const mockDb = createMockDb();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dbError = new Error('DB error');
      mockDb.first.mockRejectedValueOnce(dbError);

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(consoleSpy).toHaveBeenCalledWith('Rate limit check failed:', dbError);
      consoleSpy.mockRestore();
    });

    it('should still return valid resetAt on database error', async () => {
      const mockDb = createMockDb();
      const testTime = new Date('2025-01-15T10:00:30.000Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockRejectedValueOnce(new Error('DB error'));

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      const expectedResetAt = (Math.floor(testTime / 60000) + 1) * 60000;
      expect(result.resetAt).toBe(expectedResetAt);

      dateNowSpy.mockRestore();
    });

    it('should handle different error types gracefully', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockRejectedValueOnce(new TypeError('Cannot read property'));
      const result1 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      expect(result1.allowed).toBe(true);

      mockDb.first.mockRejectedValueOnce('Network error');
      const result2 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      expect(result2.allowed).toBe(true);
    });
  });

  describe('per-endpoint isolation', () => {
    it('should maintain separate limits for different endpoints', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 101 });
      const result1 = await checkRateLimit(
        mockDb as unknown as D1Database,
        getEndpointRateLimitKey('client-1', '/beers'),
        100
      );
      expect(result1.allowed).toBe(false);

      mockDb.first.mockResolvedValueOnce({ request_count: 1 });
      const result2 = await checkRateLimit(
        mockDb as unknown as D1Database,
        getEndpointRateLimitKey('client-1', '/sync'),
        100
      );
      expect(result2.allowed).toBe(true);
    });

    it('should track each endpoint independently', async () => {
      const mockDb = createMockDb();
      const client = 'client-abc';

      mockDb.first.mockResolvedValueOnce({ request_count: 50 });
      const beersResult = await checkRateLimit(
        mockDb as unknown as D1Database,
        getEndpointRateLimitKey(client, 'beers'),
        100
      );
      expect(beersResult.remaining).toBe(50);

      mockDb.first.mockResolvedValueOnce({ request_count: 5 });
      const syncResult = await checkRateLimit(
        mockDb as unknown as D1Database,
        getEndpointRateLimitKey(client, 'sync'),
        10
      );
      expect(syncResult.remaining).toBe(5);
    });
  });

  describe('cleanup logic', () => {
    it('should trigger cleanup when random value is below 0.01', async () => {
      const mockDb = createMockDb();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.005);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });
      mockDb.run.mockResolvedValueOnce({});

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(mockDb.prepare).toHaveBeenCalledTimes(2);

      randomSpy.mockRestore();
    });

    it('should not trigger cleanup when random value is 0.01 or above', async () => {
      const mockDb = createMockDb();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.01);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(mockDb.prepare).toHaveBeenCalledTimes(1);

      randomSpy.mockRestore();
    });

    it('should not trigger cleanup when random value is high', async () => {
      const mockDb = createMockDb();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(mockDb.prepare).toHaveBeenCalledTimes(1);

      randomSpy.mockRestore();
    });

    it('should clean up records from more than 60 minutes ago', async () => {
      const mockDb = createMockDb();
      const testTime = new Date('2025-06-01T14:30:00.000Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(testTime);
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.001);
      mockDb.first.mockResolvedValueOnce({ request_count: 3 });
      mockDb.run.mockResolvedValueOnce({});

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(mockDb.prepare).toHaveBeenCalledTimes(2);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(97);

      dateNowSpy.mockRestore();
      randomSpy.mockRestore();
    });

    it('should not trigger cleanup when request is rejected', async () => {
      const mockDb = createMockDb();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.001);
      mockDb.first.mockResolvedValueOnce({ request_count: 101 });

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(mockDb.prepare).toHaveBeenCalledTimes(1);

      randomSpy.mockRestore();
    });
  });

  describe('resetAt calculation', () => {
    it('should return resetAt at the start of the next minute', async () => {
      const mockDb = createMockDb();
      const testTime = new Date('2025-01-15T10:00:30.000Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      const resetDate = new Date(result.resetAt);
      expect(resetDate.getUTCHours()).toBe(10);
      expect(resetDate.getUTCMinutes()).toBe(1);
      expect(resetDate.getUTCSeconds()).toBe(0);
      expect(resetDate.getUTCMilliseconds()).toBe(0);

      dateNowSpy.mockRestore();
    });

    it('should calculate correct resetAt at beginning of minute', async () => {
      const mockDb = createMockDb();
      const testTime = new Date('2025-01-15T10:00:00.000Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      const resetDate = new Date(result.resetAt);
      expect(resetDate.toISOString()).toBe('2025-01-15T10:01:00.000Z');

      dateNowSpy.mockRestore();
    });

    it('should calculate correct resetAt at end of minute', async () => {
      const mockDb = createMockDb();
      const testTime = new Date('2025-01-15T10:00:59.999Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      const resetDate = new Date(result.resetAt);
      expect(resetDate.toISOString()).toBe('2025-01-15T10:01:00.000Z');

      dateNowSpy.mockRestore();
    });

    it('should handle hour boundary correctly', async () => {
      const mockDb = createMockDb();
      const testTime = new Date('2025-01-15T10:59:30.000Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      const resetDate = new Date(result.resetAt);
      expect(resetDate.getUTCHours()).toBe(11);
      expect(resetDate.getUTCMinutes()).toBe(0);

      dateNowSpy.mockRestore();
    });

    it('should handle day boundary correctly', async () => {
      const mockDb = createMockDb();
      const testTime = new Date('2025-01-15T23:59:30.000Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      const resetDate = new Date(result.resetAt);
      expect(resetDate.getUTCDate()).toBe(16);
      expect(resetDate.getUTCHours()).toBe(0);
      expect(resetDate.getUTCMinutes()).toBe(0);

      dateNowSpy.mockRestore();
    });

    it('should return consistent resetAt regardless of request count', async () => {
      const mockDb = createMockDb();
      const testTime = new Date('2025-01-15T10:30:00.000Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(testTime);

      mockDb.first.mockResolvedValueOnce({ request_count: 1 });
      const result1 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      mockDb.first.mockResolvedValueOnce({ request_count: 100 });
      const result2 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      mockDb.first.mockResolvedValueOnce({ request_count: 101 });
      const result3 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result1.resetAt).toBe(result2.resetAt);
      expect(result2.resetAt).toBe(result3.resetAt);

      dateNowSpy.mockRestore();
    });
  });

  describe('special client identifiers', () => {
    it('should handle client identifiers with special characters', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(
        mockDb as unknown as D1Database,
        'client:with:colons:and/slashes',
        100
      );

      expect(result.allowed).toBe(true);
    });

    it('should handle very long client identifiers', async () => {
      const mockDb = createMockDb();
      const longId = 'x'.repeat(500);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, longId, 100);

      expect(result.allowed).toBe(true);
    });

    it('should handle empty client identifier', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, '', 100);

      expect(result.allowed).toBe(true);
    });
  });
});
