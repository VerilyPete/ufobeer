/**
 * Unit tests for beer batch lookup endpoint handler.
 *
 * Tests handleBatchLookup function for proper response format,
 * missing IDs tracking, and field naming alignment with mobile app.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleBatchLookup } from '../../src/handlers/beers';
import type { Env, RequestContext } from '../../src/types';

/**
 * Helper to create a mock Request object for batch lookup.
 */
function createBatchRequest(ids: string[]): Request {
  return new Request('http://test/beers/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  });
}

/**
 * Helper to create a mock environment with D1 database.
 * Note: Query now fetches both brew_description_original and brew_description_cleaned
 * for merging (consistent with GET /beers behavior).
 */
function createMockEnv(dbResults: Array<{
  id: string;
  abv: number | null;
  confidence: number;
  enrichment_source: string | null;
  is_verified: number;
  brew_description_original: string | null;
  brew_description_cleaned: string | null;
}>): Partial<Env> {
  return {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({
            results: dbResults
          })
        })
      })
    } as unknown as D1Database
  };
}

/**
 * Default request context for tests.
 */
const mockReqCtx: RequestContext = {
  requestId: 'test-request-id',
  startTime: Date.now(),
  clientIdentifier: 'test-client',
  apiKeyHash: null,
  clientIp: '127.0.0.1',
  userAgent: 'test-agent'
};

describe('handleBatchLookup', () => {
  describe('missing IDs', () => {
    it('should return missing array for unknown IDs', async () => {
      const mockEnv = createMockEnv([
        {
          id: '123',
          abv: 5.5,
          confidence: 0.9,
          enrichment_source: 'description',
          is_verified: 0,
          brew_description_original: 'Original desc',
          brew_description_cleaned: 'Clean desc'
        }
      ]);

      const request = createBatchRequest(['123', '456', '789']);

      const response = await handleBatchLookup(
        request,
        mockEnv as Env,
        {},
        mockReqCtx
      );
      const data = await response.json() as {
        enrichments: Record<string, unknown>;
        missing: string[];
        requestId: string;
      };

      // ID 123 should be found
      expect(data.enrichments['123']).toBeDefined();
      // IDs 456 and 789 should be missing
      expect(data.missing).toContain('456');
      expect(data.missing).toContain('789');
      // ID 123 should not be in missing
      expect(data.missing).not.toContain('123');
      expect(data.missing).toHaveLength(2);
    });

    it('should return empty missing array when all IDs found', async () => {
      const mockEnv = createMockEnv([
        { id: '123', abv: 5.5, confidence: 0.9, enrichment_source: 'description', is_verified: 0, brew_description_original: 'Original', brew_description_cleaned: null },
        { id: '456', abv: 6.0, confidence: 0.8, enrichment_source: 'perplexity', is_verified: 1, brew_description_original: 'Original', brew_description_cleaned: 'Cleaned' }
      ]);

      const request = createBatchRequest(['123', '456']);

      const response = await handleBatchLookup(
        request,
        mockEnv as Env,
        {},
        mockReqCtx
      );
      const data = await response.json() as {
        enrichments: Record<string, unknown>;
        missing: string[];
      };

      expect(data.missing).toHaveLength(0);
      expect(Object.keys(data.enrichments)).toHaveLength(2);
    });

    it('should return all IDs as missing when none found', async () => {
      const mockEnv = createMockEnv([]);

      const request = createBatchRequest(['123', '456', '789']);

      const response = await handleBatchLookup(
        request,
        mockEnv as Env,
        {},
        mockReqCtx
      );
      const data = await response.json() as {
        enrichments: Record<string, unknown>;
        missing: string[];
      };

      expect(data.missing).toEqual(['123', '456', '789']);
      expect(Object.keys(data.enrichments)).toHaveLength(0);
    });
  });

  describe('merged brew_description in response', () => {
    it('should return cleaned description when available (has_cleaned_description=true)', async () => {
      const mockEnv = createMockEnv([
        {
          id: '123',
          abv: 6.0,
          confidence: 0.95,
          enrichment_source: 'perplexity',
          is_verified: 1,
          brew_description_original: 'Original marketing text...',
          brew_description_cleaned: 'A crisp, refreshing IPA with citrus notes.'
        }
      ]);

      const request = createBatchRequest(['123']);

      const response = await handleBatchLookup(
        request,
        mockEnv as Env,
        {},
        mockReqCtx
      );
      const data = await response.json() as {
        enrichments: Record<string, { brew_description: string | null; has_cleaned_description: boolean }>;
      };

      // Should return cleaned description
      expect(data.enrichments['123'].brew_description).toBe(
        'A crisp, refreshing IPA with citrus notes.'
      );
      expect(data.enrichments['123'].has_cleaned_description).toBe(true);
    });

    it('should fall back to original description when cleaned is null', async () => {
      const mockEnv = createMockEnv([
        {
          id: '123',
          abv: 5.0,
          confidence: 0.7,
          enrichment_source: 'description',
          is_verified: 0,
          brew_description_original: 'Original description from Flying Saucer',
          brew_description_cleaned: null
        }
      ]);

      const request = createBatchRequest(['123']);

      const response = await handleBatchLookup(
        request,
        mockEnv as Env,
        {},
        mockReqCtx
      );
      const data = await response.json() as {
        enrichments: Record<string, { brew_description: string | null; has_cleaned_description: boolean }>;
      };

      // Should return original description as fallback
      expect(data.enrichments['123'].brew_description).toBe('Original description from Flying Saucer');
      expect(data.enrichments['123'].has_cleaned_description).toBe(false);
    });

    it('should return null brew_description when both are null', async () => {
      const mockEnv = createMockEnv([
        {
          id: '123',
          abv: 5.0,
          confidence: 0.7,
          enrichment_source: 'description',
          is_verified: 0,
          brew_description_original: null,
          brew_description_cleaned: null
        }
      ]);

      const request = createBatchRequest(['123']);

      const response = await handleBatchLookup(
        request,
        mockEnv as Env,
        {},
        mockReqCtx
      );
      const data = await response.json() as {
        enrichments: Record<string, { brew_description: string | null; has_cleaned_description: boolean }>;
      };

      expect(data.enrichments['123'].brew_description).toBeNull();
      expect(data.enrichments['123'].has_cleaned_description).toBe(false);
    });
  });

  describe('field names alignment with mobile app', () => {
    it('should use enriched_abv and enrichment_confidence field names', async () => {
      const mockEnv = createMockEnv([
        {
          id: '123',
          abv: 7.2,
          confidence: 0.88,
          enrichment_source: 'perplexity',
          is_verified: 1,
          brew_description_original: 'Original description',
          brew_description_cleaned: 'Test description'
        }
      ]);

      const request = createBatchRequest(['123']);

      const response = await handleBatchLookup(
        request,
        mockEnv as Env,
        {},
        mockReqCtx
      );
      const data = await response.json() as {
        enrichments: Record<string, {
          enriched_abv: number | null;
          enrichment_confidence: number;
          enrichment_source: string | null;
          is_verified: boolean;
          brew_description: string | null;
          has_cleaned_description: boolean;
        }>;
      };

      // Verify field names are correct for mobile app compatibility
      expect(data.enrichments['123']).toHaveProperty('enriched_abv');
      expect(data.enrichments['123']).toHaveProperty('enrichment_confidence');
      expect(data.enrichments['123']).toHaveProperty('enrichment_source');
      expect(data.enrichments['123']).toHaveProperty('is_verified');
      expect(data.enrichments['123']).toHaveProperty('brew_description');
      expect(data.enrichments['123']).toHaveProperty('has_cleaned_description');

      // Verify old field names are NOT used
      expect(data.enrichments['123']).not.toHaveProperty('abv');
      expect(data.enrichments['123']).not.toHaveProperty('confidence');
      expect(data.enrichments['123']).not.toHaveProperty('source');
      expect(data.enrichments['123']).not.toHaveProperty('brew_description_cleaned');

      // Verify values are correct
      expect(data.enrichments['123'].enriched_abv).toBe(7.2);
      expect(data.enrichments['123'].enrichment_confidence).toBe(0.88);
      expect(data.enrichments['123'].enrichment_source).toBe('perplexity');
      expect(data.enrichments['123'].is_verified).toBe(true);
      expect(data.enrichments['123'].brew_description).toBe('Test description');
      expect(data.enrichments['123'].has_cleaned_description).toBe(true);
    });

    it('should handle null ABV correctly', async () => {
      const mockEnv = createMockEnv([
        {
          id: '123',
          abv: null,
          confidence: 0.0,
          enrichment_source: null,
          is_verified: 0,
          brew_description_original: null,
          brew_description_cleaned: null
        }
      ]);

      const request = createBatchRequest(['123']);

      const response = await handleBatchLookup(
        request,
        mockEnv as Env,
        {},
        mockReqCtx
      );
      const data = await response.json() as {
        enrichments: Record<string, {
          enriched_abv: number | null;
          enrichment_confidence: number;
          enrichment_source: string | null;
          is_verified: boolean;
        }>;
      };

      expect(data.enrichments['123'].enriched_abv).toBeNull();
      expect(data.enrichments['123'].enrichment_source).toBeNull();
      expect(data.enrichments['123'].is_verified).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should return 400 for missing ids array', async () => {
      const mockEnv = createMockEnv([]);

      const request = new Request('http://test/beers/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const response = await handleBatchLookup(
        request,
        mockEnv as Env,
        {},
        mockReqCtx
      );

      expect(response.status).toBe(400);
      const data = await response.json() as { error: string };
      expect(data.error).toContain('ids');
    });

    it('should return 400 for empty ids array', async () => {
      const mockEnv = createMockEnv([]);

      const request = createBatchRequest([]);

      const response = await handleBatchLookup(
        request,
        mockEnv as Env,
        {},
        mockReqCtx
      );

      expect(response.status).toBe(400);
    });

    it('should limit batch size to 100', async () => {
      // Create 150 IDs
      const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
      // Only first 100 will be queried
      const first100 = ids.slice(0, 100);

      const mockEnv = {
        DB: {
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockImplementation((...args: string[]) => {
              // Verify only 100 IDs are passed
              expect(args.length).toBe(100);
              expect(args).toEqual(first100);
              return {
                all: vi.fn().mockResolvedValue({ results: [] })
              };
            })
          })
        } as unknown as D1Database
      };

      const request = createBatchRequest(ids);

      await handleBatchLookup(
        request,
        mockEnv as Env,
        {},
        mockReqCtx
      );

      // Verify prepare was called
      expect(mockEnv.DB.prepare).toHaveBeenCalled();
    });
  });

  describe('requestId in response', () => {
    it('should include requestId in response', async () => {
      const mockEnv = createMockEnv([]);
      const request = createBatchRequest(['123']);

      const response = await handleBatchLookup(
        request,
        mockEnv as Env,
        {},
        mockReqCtx
      );
      const data = await response.json() as { requestId: string };

      expect(data.requestId).toBe('test-request-id');
    });
  });
});
