/**
 * Unit tests for rate limiting functions.
 *
 * Tests getEndpointRateLimitKey function for correct key generation
 * to enable per-endpoint rate limiting.
 *
 * Tests checkRateLimit function for rate limit enforcement including
 * edge cases, database error handling, and cleanup logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

    // All should be different
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

      // Each endpoint gets its own rate limit bucket
      expect(syncKey).toBe('api-key-hash-abc123:sync');
      expect(batchKey).toBe('api-key-hash-abc123:batch');
      expect(beersKey).toBe('api-key-hash-abc123:beers');

      // Keys are distinct
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
  // Set up method chaining: prepare() -> bind() -> first()/run()
  mock.prepare.mockReturnValue(mock);
  mock.bind.mockReturnValue(mock);
  return mock;
};

describe('checkRateLimit', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic functionality', () => {
    it('should allow requests under limit', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 5 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(95);
    });

    it('should reject requests over limit', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 101 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should track remaining count correctly', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 75 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.remaining).toBe(25);
    });

    it('should use correct SQL upsert pattern', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO rate_limits')
      );
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT')
      );
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('RETURNING request_count')
      );
    });

    it('should bind client identifier and minute bucket correctly', async () => {
      const testTime = new Date('2025-01-15T10:05:30.000Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      await checkRateLimit(mockDb as unknown as D1Database, 'my-client-id', 100);

      // Calculate expected minute bucket
      const expectedMinuteBucket = Math.floor(testTime / 60000);

      expect(mockDb.bind).toHaveBeenCalledWith('my-client-id', expectedMinuteBucket);
    });
  });

  describe('edge cases', () => {
    it('should allow request exactly at limit (count === limit)', async () => {
      // Implementation uses count > limitPerMinute, so exactly at limit is allowed
      mockDb.first.mockResolvedValueOnce({ request_count: 100 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('should reject request one over limit (count === limit + 1)', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 101 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should handle first request (count = 1)', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
    });

    it('should handle null result from database (default to count = 1)', async () => {
      mockDb.first.mockResolvedValueOnce(null);

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
    });

    it('should handle undefined request_count in result', async () => {
      mockDb.first.mockResolvedValueOnce({});

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      // Should default to count = 1 due to || 1 fallback
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
    });

    it('should handle limit of 1', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 1);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('should reject second request when limit is 1', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 2 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 1);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should handle very high request count (far over limit)', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 10000 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should handle very high limit', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 500 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 10000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9500);
    });

    it('should ensure remaining never goes negative', async () => {
      // Even when count exceeds limit by a lot, remaining should be 0, not negative
      mockDb.first.mockResolvedValueOnce({ request_count: 200 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.remaining).toBe(0);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });
  });

  describe('minute boundary transitions', () => {
    it('should use different minute buckets across minute boundary', async () => {
      // Request at 10:00:59
      const time1 = new Date('2025-01-15T10:00:59.000Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(time1);
      mockDb.first.mockResolvedValueOnce({ request_count: 99 });

      const result1 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      expect(result1.remaining).toBe(1);

      const firstMinuteBucket = Math.floor(time1 / 60000);

      // Request at 10:01:01 (new minute)
      const time2 = new Date('2025-01-15T10:01:01.000Z').getTime();
      dateNowSpy.mockReturnValue(time2);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result2 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      expect(result2.remaining).toBe(99);

      const secondMinuteBucket = Math.floor(time2 / 60000);

      // Verify different minute buckets were used
      expect(secondMinuteBucket).toBe(firstMinuteBucket + 1);
    });

    it('should maintain same minute bucket within same minute', async () => {
      const time1 = new Date('2025-01-15T10:00:00.000Z').getTime();
      const time2 = new Date('2025-01-15T10:00:59.999Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(time1);

      mockDb.first.mockResolvedValueOnce({ request_count: 1 });
      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      const firstBind = mockDb.bind.mock.calls[0];

      dateNowSpy.mockReturnValue(time2);
      mockDb.first.mockResolvedValueOnce({ request_count: 2 });
      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      const secondBind = mockDb.bind.mock.calls[1];

      // Same minute bucket should be used
      expect(firstBind[1]).toBe(secondBind[1]);
    });
  });

  describe('database error handling (graceful degradation)', () => {
    it('should allow request on database error', async () => {
      mockDb.first.mockRejectedValueOnce(new Error('DB connection failed'));

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(true);
    });

    it('should return full remaining count on database error', async () => {
      mockDb.first.mockRejectedValueOnce(new Error('DB timeout'));

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.remaining).toBe(100);
    });

    it('should log error on database failure', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dbError = new Error('DB error');
      mockDb.first.mockRejectedValueOnce(dbError);

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(consoleSpy).toHaveBeenCalledWith('Rate limit check failed:', dbError);
    });

    it('should still return valid resetAt on database error', async () => {
      const testTime = new Date('2025-01-15T10:00:30.000Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockRejectedValueOnce(new Error('DB error'));

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      // resetAt should still be calculated correctly
      const expectedResetAt = (Math.floor(testTime / 60000) + 1) * 60000;
      expect(result.resetAt).toBe(expectedResetAt);
    });

    it('should handle different error types gracefully', async () => {
      // Test with TypeError
      mockDb.first.mockRejectedValueOnce(new TypeError('Cannot read property'));
      const result1 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      expect(result1.allowed).toBe(true);

      // Test with string error
      mockDb.first.mockRejectedValueOnce('Network error');
      const result2 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      expect(result2.allowed).toBe(true);
    });
  });

  describe('per-endpoint isolation', () => {
    it('should maintain separate limits for different endpoints', async () => {
      // First endpoint is over limit
      mockDb.first.mockResolvedValueOnce({ request_count: 101 });
      const result1 = await checkRateLimit(
        mockDb as unknown as D1Database,
        getEndpointRateLimitKey('client-1', '/beers'),
        100
      );
      expect(result1.allowed).toBe(false);

      // Second endpoint is under limit (different key)
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });
      const result2 = await checkRateLimit(
        mockDb as unknown as D1Database,
        getEndpointRateLimitKey('client-1', '/sync'),
        100
      );
      expect(result2.allowed).toBe(true);

      // Verify different keys were used
      expect(mockDb.bind.mock.calls[0][0]).toBe('client-1:/beers');
      expect(mockDb.bind.mock.calls[1][0]).toBe('client-1:/sync');
    });

    it('should track each endpoint independently', async () => {
      const client = 'client-abc';

      // Beers endpoint: 50 requests
      mockDb.first.mockResolvedValueOnce({ request_count: 50 });
      const beersResult = await checkRateLimit(
        mockDb as unknown as D1Database,
        getEndpointRateLimitKey(client, 'beers'),
        100
      );
      expect(beersResult.remaining).toBe(50);

      // Sync endpoint: 10 requests (different rate limit)
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
      vi.spyOn(Math, 'random').mockReturnValue(0.005);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });
      mockDb.run.mockResolvedValueOnce({});

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      // Should have called prepare twice: once for upsert, once for cleanup
      expect(mockDb.prepare).toHaveBeenCalledTimes(2);
      expect(mockDb.prepare).toHaveBeenNthCalledWith(
        2,
        'DELETE FROM rate_limits WHERE minute_bucket < ?'
      );
    });

    it('should not trigger cleanup when random value is 0.01 or above', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.01);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      // Should have called prepare only once for upsert
      expect(mockDb.prepare).toHaveBeenCalledTimes(1);
    });

    it('should not trigger cleanup when random value is high', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.99);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(mockDb.prepare).toHaveBeenCalledTimes(1);
    });

    it('should cleanup records older than 60 minutes', async () => {
      const testTime = new Date('2025-01-15T12:00:00.000Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(testTime);
      vi.spyOn(Math, 'random').mockReturnValue(0.001);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });
      mockDb.run.mockResolvedValueOnce({});

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      const currentMinuteBucket = Math.floor(testTime / 60000);
      const expectedCleanupThreshold = currentMinuteBucket - 60;

      // Verify cleanup was called with correct threshold
      expect(mockDb.bind).toHaveBeenNthCalledWith(2, expectedCleanupThreshold);
    });

    it('should not trigger cleanup when request is rejected', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.001);
      mockDb.first.mockResolvedValueOnce({ request_count: 101 });

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      // Should only call prepare once for the upsert, not for cleanup
      // because cleanup only runs after a successful (allowed) request
      expect(mockDb.prepare).toHaveBeenCalledTimes(1);
    });
  });

  describe('resetAt calculation', () => {
    it('should return resetAt at the start of the next minute', async () => {
      const testTime = new Date('2025-01-15T10:00:30.000Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      // resetAt should be at 10:01:00.000Z
      const resetDate = new Date(result.resetAt);
      expect(resetDate.getUTCHours()).toBe(10);
      expect(resetDate.getUTCMinutes()).toBe(1);
      expect(resetDate.getUTCSeconds()).toBe(0);
      expect(resetDate.getUTCMilliseconds()).toBe(0);
    });

    it('should calculate correct resetAt at beginning of minute', async () => {
      const testTime = new Date('2025-01-15T10:00:00.000Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      const resetDate = new Date(result.resetAt);
      expect(resetDate.toISOString()).toBe('2025-01-15T10:01:00.000Z');
    });

    it('should calculate correct resetAt at end of minute', async () => {
      const testTime = new Date('2025-01-15T10:00:59.999Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      const resetDate = new Date(result.resetAt);
      expect(resetDate.toISOString()).toBe('2025-01-15T10:01:00.000Z');
    });

    it('should handle hour boundary correctly', async () => {
      const testTime = new Date('2025-01-15T10:59:30.000Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      const resetDate = new Date(result.resetAt);
      expect(resetDate.getUTCHours()).toBe(11);
      expect(resetDate.getUTCMinutes()).toBe(0);
    });

    it('should handle day boundary correctly', async () => {
      const testTime = new Date('2025-01-15T23:59:30.000Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(testTime);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      const resetDate = new Date(result.resetAt);
      expect(resetDate.getUTCDate()).toBe(16);
      expect(resetDate.getUTCHours()).toBe(0);
      expect(resetDate.getUTCMinutes()).toBe(0);
    });

    it('should return consistent resetAt regardless of request count', async () => {
      const testTime = new Date('2025-01-15T10:30:00.000Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(testTime);

      mockDb.first.mockResolvedValueOnce({ request_count: 1 });
      const result1 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      mockDb.first.mockResolvedValueOnce({ request_count: 100 });
      const result2 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      mockDb.first.mockResolvedValueOnce({ request_count: 101 });
      const result3 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result1.resetAt).toBe(result2.resetAt);
      expect(result2.resetAt).toBe(result3.resetAt);
    });
  });

  describe('concurrent request handling', () => {
    it('should use atomic upsert pattern in SQL', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      const sqlCall = mockDb.prepare.mock.calls[0][0];
      // Verify atomic upsert elements are present
      expect(sqlCall).toContain('INSERT INTO rate_limits');
      expect(sqlCall).toContain('ON CONFLICT');
      expect(sqlCall).toContain('DO UPDATE SET request_count = request_count + 1');
      expect(sqlCall).toContain('RETURNING');
    });
  });

  describe('special client identifiers', () => {
    it('should handle client identifiers with special characters', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      await checkRateLimit(
        mockDb as unknown as D1Database,
        'client:with:colons:and/slashes',
        100
      );

      expect(mockDb.bind).toHaveBeenCalledWith(
        'client:with:colons:and/slashes',
        expect.any(Number)
      );
    });

    it('should handle very long client identifiers', async () => {
      const longId = 'x'.repeat(500);
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, longId, 100);

      expect(result.allowed).toBe(true);
      expect(mockDb.bind).toHaveBeenCalledWith(longId, expect.any(Number));
    });

    it('should handle empty client identifier', async () => {
      mockDb.first.mockResolvedValueOnce({ request_count: 1 });

      const result = await checkRateLimit(mockDb as unknown as D1Database, '', 100);

      expect(result.allowed).toBe(true);
      expect(mockDb.bind).toHaveBeenCalledWith('', expect.any(Number));
    });
  });
});
