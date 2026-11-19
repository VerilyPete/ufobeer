/**
 * Unit tests for rate limiting functions.
 *
 * Tests getEndpointRateLimitKey function for correct key generation
 * to enable per-endpoint rate limiting.
 *
 * Tests checkRateLimit's missing-count fallback, database error handling
 * and resetAt calculation. Limit enforcement, client and minute isolation
 * and reaping against real D1 live in rate-limit.integration.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { getEndpointRateLimitKey, getPreAuthRateLimitKey, checkRateLimit, reapOldRateLimits } from '../src/rate-limit';
import { RATE_LIMIT_REAP_LIMIT } from '../src/constants';

describe('getPreAuthRateLimitKey', () => {
  it('should create a preauth-prefixed key', () => {
    expect(getPreAuthRateLimitKey('203.0.113.7')).toBe('preauth:203.0.113.7');
  });

  it('should bucket unknown-IP requests together', () => {
    expect(getPreAuthRateLimitKey('unknown')).toBe('preauth:unknown');
  });

  it('should not collide with post-auth or endpoint keys for the same client', () => {
    const preAuthKey = getPreAuthRateLimitKey('client-1');
    const endpointKey = getEndpointRateLimitKey('client-1', 'sync');

    expect(preAuthKey).not.toBe(endpointKey);
    expect(new Set([preAuthKey, endpointKey, 'client-1']).size).toBe(3);
  });

  it('should handle IPv6 addresses', () => {
    expect(getPreAuthRateLimitKey('2001:db8::1')).toBe('preauth:2001:db8::1');
  });
});

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
  describe('edge cases', () => {
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
  });

  describe('minute boundary transitions', () => {
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

  describe('database error handling (fail closed)', () => {
    it('should reject request on database error', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockRejectedValueOnce(new Error('DB connection failed'));

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.allowed).toBe(false);
    });

    it('returns degraded: true on database error', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockRejectedValueOnce(new Error('DB connection failed'));

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.degraded).toBe(true);
    });

    it('should return zero remaining on database error', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockRejectedValueOnce(new Error('DB timeout'));

      const result = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);

      expect(result.remaining).toBe(0);
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

    it('should reject for different error types (fail closed for all)', async () => {
      const mockDb = createMockDb();
      mockDb.first.mockRejectedValueOnce(new TypeError('Cannot read property'));
      const result1 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      expect(result1.allowed).toBe(false);
      expect(result1.degraded).toBe(true);

      mockDb.first.mockRejectedValueOnce('Network error');
      const result2 = await checkRateLimit(mockDb as unknown as D1Database, 'client-1', 100);
      expect(result2.allowed).toBe(false);
      expect(result2.degraded).toBe(true);
    });
  });

  describe('reapOldRateLimits', () => {
    it('deletes rows outside the rolling 60-minute window, bounded by RATE_LIMIT_REAP_LIMIT', async () => {
      const run = vi.fn().mockResolvedValue({ meta: { changes: 17 } });
      const bind = vi.fn().mockReturnValue({ run });
      const prepare = vi.fn().mockReturnValue({ bind });
      const db = { prepare };

      const now = new Date('2025-06-01T14:30:00.000Z').getTime();
      const deleted = await reapOldRateLimits(db as unknown as D1Database, now);

      expect(deleted).toBe(17);
      const sql = prepare.mock.calls[0]![0] as string;
      expect(sql).toContain('DELETE FROM rate_limits');
      expect(sql).toContain('LIMIT');
      const [cutoffBucket, limit] = bind.mock.calls[0] as [number, number];
      expect(cutoffBucket).toBe(Math.floor(now / 60000) - 60);
      expect(limit).toBe(RATE_LIMIT_REAP_LIMIT);
    });

    it('propagates a rejection when the delete fails', async () => {
      const run = vi.fn().mockRejectedValue(new Error('D1 unavailable'));
      const bind = vi.fn().mockReturnValue({ run });
      const db = { prepare: vi.fn().mockReturnValue({ bind }) };

      await expect(reapOldRateLimits(db as unknown as D1Database)).rejects.toThrow('D1 unavailable');
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
});
