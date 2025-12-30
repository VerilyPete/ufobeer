/**
 * Unit tests for rate limiting functions.
 *
 * Tests getEndpointRateLimitKey function for correct key generation
 * to enable per-endpoint rate limiting.
 */

import { describe, it, expect } from 'vitest';
import { getEndpointRateLimitKey } from '../src/rate-limit';

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
