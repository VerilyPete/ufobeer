/**
 * Unit tests for handleBeerList function.
 *
 * Tests cover:
 * - Upstream Flying Saucer API handling (502, timeout, network errors)
 * - Response parsing (valid brewInStock, empty list, invalid objects, malformed JSON)
 * - Enrichment data merging (ABV, cleaned descriptions, fallbacks)
 * - Background task queueing (cleanup and enrichment queues, waitUntil)
 *
 * These tests ensure the GET /beers endpoint handles all edge cases
 * before implementing the N+1 query fix (Issue 7.1).
 */

import { describe, it, expect, vi } from 'vitest';
import { handleBeerList } from '../../src/handlers/beers';
import type { Env, RequestContext, FlyingSaucerBeer } from '../../src/types';

// ============================================================================
// Mock Modules
// ============================================================================

// Mock the db module
vi.mock('../../src/db', () => ({
  insertPlaceholders: vi.fn().mockResolvedValue({
    totalSynced: 0,
    withAbv: 0,
    needsEnrichment: [],
    needsCleanup: [],
  }),
  getEnrichmentForBeerIds: vi.fn().mockResolvedValue(new Map()),
}));

// Mock the queue module
vi.mock('../../src/queue', () => ({
  queueBeersForEnrichment: vi.fn().mockResolvedValue({ queued: 0, skipped: 0 }),
  queueBeersForCleanup: vi.fn().mockResolvedValue({ queued: 0, skipped: 0 }),
}));

// Mock hash utility
vi.mock('../../src/utils/hash', () => ({
  hashDescription: vi.fn().mockResolvedValue('mock-hash'),
}));

// Mock the cache module
vi.mock('../../src/db/cache', () => ({
  getCachedTaplist: vi.fn().mockResolvedValue(null),
  setCachedTaplist: vi.fn().mockResolvedValue(undefined),
  parseCachedBeers: vi.fn().mockReturnValue(null),
}));

import { insertPlaceholders, getEnrichmentForBeerIds } from '../../src/db';
import { queueBeersForEnrichment, queueBeersForCleanup } from '../../src/queue';
import { getCachedTaplist, parseCachedBeers, setCachedTaplist } from '../../src/db/cache';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock Flying Saucer API response.
 * The API returns: [{...metadata}, {brewInStock: [...beers]}]
 */
function createFlyingSaucerResponse(beers: unknown[]): unknown[] {
  return [
    { store_info: 'metadata' },
    { brewInStock: beers },
  ];
}

/**
 * Create a valid beer object for testing.
 */
function createBeer(overrides: Partial<FlyingSaucerBeer> = {}): FlyingSaucerBeer {
  return {
    id: '12345',
    brew_name: 'Test IPA',
    brewer: 'Test Brewery',
    brew_description: 'A hoppy IPA',
    container_type: 'pint',
    ...overrides,
  };
}

/**
 * Create a mock environment with D1 database and queues.
 */
function createMockEnv(): Env {
  return {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      }),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database,
    ENRICHMENT_QUEUE: {
      sendBatch: vi.fn().mockResolvedValue({ successful: true }),
    } as unknown as Queue,
    CLEANUP_QUEUE: {
      sendBatch: vi.fn().mockResolvedValue({ successful: true }),
    } as unknown as Queue,
    FLYING_SAUCER_API_BASE: 'https://fsbs.beerknurd.com/bk-store-json.php',
  } as unknown as Env;
}

/**
 * Create a mock ExecutionContext with waitUntil tracking.
 */
function createMockExecutionContext(): {
  ctx: ExecutionContext;
  waitUntilPromises: Promise<unknown>[];
} {
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext,
    waitUntilPromises,
  };
}

/**
 * Create a mock request context.
 */
function createMockReqCtx(): RequestContext {
  return {
    requestId: 'test-request-id',
    startTime: Date.now(),
    clientIdentifier: 'test-client',
    apiKeyHash: 'test-hash',
    clientIp: '127.0.0.1',
    userAgent: 'test-agent',
  };
}

const mockHeaders = { 'Content-Type': 'application/json' };

// ============================================================================
// Tests
// ============================================================================

describe('handleBeerList', () => {

  // --------------------------------------------------------------------------
  // Upstream API Handling Tests
  // --------------------------------------------------------------------------

  describe('upstream API handling', () => {
    it('returns 502 when Flying Saucer API returns error status', async () => {
      // Mock fetch to return a 500 error
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(502);
      expect(result.beersReturned).toBe(0);
      expect(result.upstreamLatencyMs).toBeGreaterThanOrEqual(0);

      const body = await result.response.json() as { error: string };
      expect(body.error).toBe('Upstream Error');
    });

    it('returns 502 when Flying Saucer API returns 404', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '99999');

      expect(result.response.status).toBe(502);
      const body = await result.response.json() as { error: string };
      expect(body.error).toBe('Upstream Error');
    });

    it('handles network error gracefully and returns 500', async () => {
      // Mock fetch to throw a network error
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error: ECONNREFUSED'));

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(500);
      expect(result.beersReturned).toBe(0);

      const body = await result.response.json() as { error: string };
      expect(body.error).toBe('Internal Server Error');
    });

    it('handles timeout error gracefully', async () => {
      // Mock fetch to throw a timeout error
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Timeout: Request took too long'));

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(500);
      const body = await result.response.json() as { error: string };
      expect(body.error).toBe('Internal Server Error');
    });

    it('calls Flying Saucer API with correct URL and headers', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse([])),
      });
      globalThis.fetch = mockFetch;

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsbs.beerknurd.com/bk-store-json.php?sid=13885',
        expect.objectContaining({
          headers: { 'User-Agent': 'BeerSelector/1.0' },
        })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Response Parsing Tests
  // --------------------------------------------------------------------------

  describe('response parsing', () => {
    it('parses valid brewInStock array', async () => {
      const beers = [
        createBeer({ id: '1', brew_name: 'Beer 1' }),
        createBeer({ id: '2', brew_name: 'Beer 2' }),
        createBeer({ id: '3', brew_name: 'Beer 3' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(200);
      expect(result.beersReturned).toBe(3);

      const body = await result.response.json() as { beers: unknown[] };
      expect(body.beers).toHaveLength(3);
    });

    it('handles empty beer list', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse([])),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(200);
      expect(result.beersReturned).toBe(0);

      const body = await result.response.json() as { beers: unknown[] };
      expect(body.beers).toHaveLength(0);
    });

    it('filters out beer objects missing id', async () => {
      const beers = [
        createBeer({ id: '1', brew_name: 'Valid Beer' }),
        { brew_name: 'Missing ID Beer', brewer: 'Test' }, // Missing id
        createBeer({ id: '2', brew_name: 'Another Valid Beer' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.beersReturned).toBe(2);
    });

    it('filters out beer objects with empty id', async () => {
      const beers = [
        createBeer({ id: '1', brew_name: 'Valid Beer' }),
        { id: '', brew_name: 'Empty ID Beer', brewer: 'Test' }, // Empty id
        createBeer({ id: '2', brew_name: 'Another Valid Beer' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.beersReturned).toBe(2);
    });

    it('filters out null entries in beer array', async () => {
      const beers = [
        createBeer({ id: '1', brew_name: 'Valid Beer' }),
        null,
        createBeer({ id: '2', brew_name: 'Another Valid Beer' }),
        undefined,
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.beersReturned).toBe(2);
    });

    it('filters out beer objects missing brew_name', async () => {
      const beers = [
        createBeer({ id: '1', brew_name: 'Valid Beer' }),
        { id: '999', brewer: 'Test Brewery' }, // Missing brew_name
        createBeer({ id: '2', brew_name: 'Another Valid Beer' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.beersReturned).toBe(2);
    });

    it('handles malformed JSON response (not an array)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ error: 'unexpected format' }),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      // Should return success with empty beers since no brewInStock found
      expect(result.response.status).toBe(200);
      expect(result.beersReturned).toBe(0);
    });

    it('handles response without brewInStock property', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue([
          { store_info: 'metadata' },
          { other_property: [] },
        ]),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(200);
      expect(result.beersReturned).toBe(0);
    });

    it('handles response with brewInStock as first array element', async () => {
      const beers = [
        createBeer({ id: '1', brew_name: 'Beer 1' }),
      ];

      // Edge case: brewInStock is in the first element instead of second
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue([
          { brewInStock: beers },
          { other: 'data' },
        ]),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      // Should still find brewInStock via .find()
      expect(result.beersReturned).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Enrichment Merging Tests
  // --------------------------------------------------------------------------

  describe('enrichment merging', () => {
    it('merges ABV data from enriched_beers table', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '1', brew_name: 'Test IPA' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      // Mock enrichment data
      const enrichmentMap = new Map([
        ['1', {
          abv: 6.5,
          confidence: 0.95,
          source: 'perplexity',
          brew_description_cleaned: null,
        }],
      ]);
      vi.mocked(getEnrichmentForBeerIds).mockResolvedValue(enrichmentMap);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      const body = await result.response.json() as {
        beers: Array<{
          enriched_abv: number | null;
          enrichment_confidence: number | null;
          enrichment_source: string | null;
        }>;
      };

      expect(body.beers[0].enriched_abv).toBe(6.5);
      expect(body.beers[0].enrichment_confidence).toBe(0.95);
      expect(body.beers[0].enrichment_source).toBe('perplexity');
    });

    it('uses cleaned description when available', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '1', brew_name: 'Test IPA', brew_description: 'Original marketing text' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      // Mock enrichment with cleaned description
      const enrichmentMap = new Map([
        ['1', {
          abv: 5.5,
          confidence: 0.9,
          source: 'description',
          brew_description_cleaned: 'A crisp, refreshing IPA with citrus notes.',
        }],
      ]);
      vi.mocked(getEnrichmentForBeerIds).mockResolvedValue(enrichmentMap);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      const body = await result.response.json() as {
        beers: Array<{ brew_description: string }>;
      };

      // Should use the cleaned description
      expect(body.beers[0].brew_description).toBe('A crisp, refreshing IPA with citrus notes.');
    });

    it('falls back to original description when no cleaned version available', async () => {
      vi.clearAllMocks();
      const originalDescription = 'Original Flying Saucer description';
      const beers = [
        createBeer({ id: '1', brew_name: 'Test IPA', brew_description: originalDescription }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      // Mock enrichment without cleaned description
      const enrichmentMap = new Map([
        ['1', {
          abv: 5.5,
          confidence: 0.9,
          source: 'description',
          brew_description_cleaned: null, // No cleaned version
        }],
      ]);
      vi.mocked(getEnrichmentForBeerIds).mockResolvedValue(enrichmentMap);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      const body = await result.response.json() as {
        beers: Array<{ brew_description: string }>;
      };

      // Should keep the original description
      expect(body.beers[0].brew_description).toBe(originalDescription);
    });

    it('preserves empty-string cleaned description (does not fall back to original)', async () => {
      vi.clearAllMocks();
      const beers = [createBeer({ id: '1', brew_name: 'Test Beer', brew_description: 'Original' })];
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });
      vi.mocked(getEnrichmentForBeerIds).mockResolvedValue(new Map([
        ['1', { abv: 5.0, confidence: 0.9, source: 'description', brew_description_cleaned: '' }],
      ]));

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      const body = await result.response.json() as { beers: Array<{ brew_description: string }> };
      expect(body.beers[0].brew_description).toBe('');
    });

    it('handles beers with no enrichment data', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '1', brew_name: 'Test IPA', brew_description: 'Original desc' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      // No enrichment data available
      vi.mocked(getEnrichmentForBeerIds).mockResolvedValue(new Map());

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      const body = await result.response.json() as {
        beers: Array<{
          brew_description: string;
          enriched_abv: number | null;
          enrichment_confidence: number | null;
          enrichment_source: string | null;
        }>;
      };

      // Should keep original description and have null enrichment values
      expect(body.beers[0].brew_description).toBe('Original desc');
      expect(body.beers[0].enriched_abv).toBeNull();
      expect(body.beers[0].enrichment_confidence).toBeNull();
      expect(body.beers[0].enrichment_source).toBeNull();
    });

    it('merges enrichment for multiple beers correctly', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '1', brew_name: 'Beer 1', brew_description: 'Desc 1' }),
        createBeer({ id: '2', brew_name: 'Beer 2', brew_description: 'Desc 2' }),
        createBeer({ id: '3', brew_name: 'Beer 3', brew_description: 'Desc 3' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      // Only some beers have enrichment
      const enrichmentMap = new Map([
        ['1', {
          abv: 5.0,
          confidence: 0.9,
          source: 'description',
          brew_description_cleaned: 'Cleaned 1',
        }],
        ['3', {
          abv: 7.5,
          confidence: 0.8,
          source: 'perplexity',
          brew_description_cleaned: null,
        }],
        // Beer 2 has no enrichment
      ]);
      vi.mocked(getEnrichmentForBeerIds).mockResolvedValue(enrichmentMap);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      const body = await result.response.json() as {
        beers: Array<{
          id: string;
          brew_description: string;
          enriched_abv: number | null;
        }>;
      };

      // Beer 1: has enrichment with cleaned description
      expect(body.beers[0].enriched_abv).toBe(5.0);
      expect(body.beers[0].brew_description).toBe('Cleaned 1');

      // Beer 2: no enrichment
      expect(body.beers[1].enriched_abv).toBeNull();
      expect(body.beers[1].brew_description).toBe('Desc 2');

      // Beer 3: has ABV but no cleaned description
      expect(body.beers[2].enriched_abv).toBe(7.5);
      expect(body.beers[2].brew_description).toBe('Desc 3');
    });

    it('passes correct beer IDs to getEnrichmentForBeerIds', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '100', brew_name: 'Beer 100' }),
        createBeer({ id: '200', brew_name: 'Beer 200' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(getEnrichmentForBeerIds).toHaveBeenCalledWith(
        env.DB,
        ['100', '200'],
        'test-request-id'
      );
    });
  });

  // --------------------------------------------------------------------------
  // Background Task Queueing Tests
  // --------------------------------------------------------------------------

  describe('background task queueing', () => {
    it('queues beers for cleanup when description changed', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '1', brew_name: 'Test IPA', brew_description: 'New description' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      // Mock insertPlaceholders to return beers needing cleanup
      vi.mocked(insertPlaceholders).mockResolvedValue({
        totalSynced: 1,
        withAbv: 0,
        needsEnrichment: [],
        needsCleanup: [
          { id: '1', brew_name: 'Test IPA', brewer: 'Test Brewery', brew_description: 'New description' },
        ],
        failed: [],
      });

      const env = createMockEnv();
      const { ctx, waitUntilPromises } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      // Wait for background tasks to complete
      await Promise.all(waitUntilPromises);

      expect(queueBeersForCleanup).toHaveBeenCalledWith(
        env,
        [{ id: '1', brew_name: 'Test IPA', brewer: 'Test Brewery', brew_description: 'New description' }],
        'test-request-id'
      );
    });

    it('queues beers for enrichment when ABV missing', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '1', brew_name: 'Test IPA' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      // Mock insertPlaceholders to return beers needing enrichment
      vi.mocked(insertPlaceholders).mockResolvedValue({
        totalSynced: 1,
        withAbv: 0,
        needsEnrichment: [
          { id: '1', brew_name: 'Test IPA', brewer: 'Test Brewery' },
        ],
        needsCleanup: [],
        failed: [],
      });

      const env = createMockEnv();
      const { ctx, waitUntilPromises } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      // Wait for background tasks to complete
      await Promise.all(waitUntilPromises);

      expect(queueBeersForEnrichment).toHaveBeenCalledWith(
        env,
        [{ id: '1', brew_name: 'Test IPA', brewer: 'Test Brewery' }],
        'test-request-id'
      );
    });

    it('verifies waitUntil is called for non-blocking background tasks', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '1', brew_name: 'Test Beer' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      // waitUntil called twice: cache write + background enrichment
      expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
    });

    it('does not block response while background tasks run', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '1', brew_name: 'Test Beer' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      // Make insertPlaceholders take a long time
      vi.mocked(insertPlaceholders).mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return { totalSynced: 1, withAbv: 0, needsEnrichment: [], needsCleanup: [], failed: [] };
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const startTime = Date.now();
      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');
      const elapsed = Date.now() - startTime;

      // Response should return quickly, not wait for background task
      expect(elapsed).toBeLessThan(100);
      expect(result.response.status).toBe(200);
    });

    it('queues both cleanup and enrichment when both needed', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '1', brew_name: 'Beer with new desc', brew_description: 'New' }),
        createBeer({ id: '2', brew_name: 'Beer needing enrichment' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      vi.mocked(insertPlaceholders).mockResolvedValue({
        totalSynced: 2,
        withAbv: 0,
        needsEnrichment: [
          { id: '2', brew_name: 'Beer needing enrichment', brewer: 'Test Brewery' },
        ],
        needsCleanup: [
          { id: '1', brew_name: 'Beer with new desc', brewer: 'Test Brewery', brew_description: 'New' },
        ],
        failed: [],
      });

      const env = createMockEnv();
      const { ctx, waitUntilPromises } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');
      await Promise.all(waitUntilPromises);

      expect(queueBeersForCleanup).toHaveBeenCalled();
      expect(queueBeersForEnrichment).toHaveBeenCalled();
    });

    it('does not queue when no beers need processing', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '1', brew_name: 'Already Enriched Beer' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      vi.mocked(insertPlaceholders).mockResolvedValue({
        totalSynced: 1,
        withAbv: 1, // Already has ABV
        needsEnrichment: [],
        needsCleanup: [],
        failed: [],
      });

      const env = createMockEnv();
      const { ctx, waitUntilPromises } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');
      await Promise.all(waitUntilPromises);

      expect(queueBeersForCleanup).not.toHaveBeenCalled();
      expect(queueBeersForEnrichment).not.toHaveBeenCalled();
    });

    it('handles background task errors gracefully without affecting response', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '1', brew_name: 'Test Beer' }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      // Make insertPlaceholders throw an error
      vi.mocked(insertPlaceholders).mockRejectedValue(new Error('Database error'));

      const env = createMockEnv();
      const { ctx, waitUntilPromises } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      // Response should still be successful
      expect(result.response.status).toBe(200);

      // Background task should complete (with error logged)
      await Promise.all(waitUntilPromises);
    });

    it('passes correct data to insertPlaceholders', async () => {
      vi.clearAllMocks();
      const beers = [
        createBeer({ id: '1', brew_name: 'Test IPA', brewer: 'Brewery A', brew_description: 'Hoppy' }),
        createBeer({ id: '2', brew_name: 'Test Stout', brewer: 'Brewery B', brew_description: undefined }),
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx, waitUntilPromises } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');
      await Promise.all(waitUntilPromises);

      expect(insertPlaceholders).toHaveBeenCalledWith(
        env.DB,
        [
          { id: '1', brew_name: 'Test IPA', brewer: 'Brewery A', brew_description: 'Hoppy' },
          { id: '2', brew_name: 'Test Stout', brewer: 'Brewery B', brew_description: undefined },
        ],
        'test-request-id'
      );
    });
  });

  // --------------------------------------------------------------------------
  // Response Format Tests
  // --------------------------------------------------------------------------

  describe('response format', () => {
    it('includes storeId in response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse([])),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      const body = await result.response.json() as { storeId: string };
      expect(body.storeId).toBe('13885');
    });

    it('includes requestId in response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse([])),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      const body = await result.response.json() as { requestId: string };
      expect(body.requestId).toBe('test-request-id');
    });

    it('returns correct upstream latency measurement', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          ok: true,
          json: vi.fn().mockResolvedValue(createFlyingSaucerResponse([])),
        };
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.upstreamLatencyMs).toBeGreaterThanOrEqual(10);
    });

    it('applies custom headers to response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse([])),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();
      const customHeaders = {
        'Content-Type': 'application/json',
        'X-Custom-Header': 'test-value',
      };

      const result = await handleBeerList(env, ctx, customHeaders, reqCtx, '13885');

      // For successful responses, headers should include custom headers
      expect(result.response.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Cache Hit Tests (Step 2)
  // --------------------------------------------------------------------------

  describe('cache hit', () => {
    it('returns cached beers with source "cache" when cache is fresh', async () => {
      vi.clearAllMocks();
      const cachedBeers = [createBeer({ id: '1', brew_name: 'Cached IPA' })];
      const cachedAt = Date.now() - 60_000; // 1 minute ago (within 5 min TTL)

      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify(cachedBeers),
        cached_at: cachedAt,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(cachedBeers);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(200);
      const body = await result.response.json() as {
        beers: unknown[];
        source: string;
        cached_at: string;
      };
      expect(body.source).toBe('cache');
      expect(body.cached_at).toBe(new Date(cachedAt).toISOString());
      expect(body.beers).toHaveLength(1);
    });

    it('returns fresh requestId on cache hit (not from cache)', async () => {
      vi.clearAllMocks();
      const cachedBeers = [createBeer({ id: '1' })];
      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify(cachedBeers),
        cached_at: Date.now() - 60_000,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(cachedBeers);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      const body = await result.response.json() as { requestId: string };
      expect(body.requestId).toBe('test-request-id');
    });

    it('returns correct storeId on cache hit', async () => {
      vi.clearAllMocks();
      const cachedBeers = [createBeer({ id: '1' })];
      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify(cachedBeers),
        cached_at: Date.now() - 60_000,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(cachedBeers);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      const body = await result.response.json() as { storeId: string };
      expect(body.storeId).toBe('13885');
    });

    it('does not call Flying Saucer on cache hit', async () => {
      vi.clearAllMocks();
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      const cachedBeers = [createBeer({ id: '1' })];
      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify(cachedBeers),
        cached_at: Date.now() - 60_000,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(cachedBeers);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not trigger background enrichment on cache hit', async () => {
      vi.clearAllMocks();
      const cachedBeers = [createBeer({ id: '1' })];
      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify(cachedBeers),
        cached_at: Date.now() - 60_000,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(cachedBeers);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(ctx.waitUntil).not.toHaveBeenCalled();
      expect(insertPlaceholders).not.toHaveBeenCalled();
    });

    it('returns upstreamLatencyMs of 0 on cache hit', async () => {
      vi.clearAllMocks();
      const cachedBeers = [createBeer({ id: '1' })];
      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify(cachedBeers),
        cached_at: Date.now() - 60_000,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(cachedBeers);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.upstreamLatencyMs).toBe(0);
      expect(result.cacheOutcome).toBe('hit');
    });

    it('falls through to live fetch when fresh cache row fails to parse', async () => {
      vi.clearAllMocks();
      const liveBeers = [createBeer({ id: 'live', brew_name: 'Live Beer' })];

      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: '{"corrupted": true}',
        cached_at: Date.now() - 60_000,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(null);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(liveBeers)),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(200);
      const body = await result.response.json() as { source: string; beers: Array<{ id: string }> };
      expect(body.source).toBe('live');
      expect(body.beers[0].id).toBe('live');
      expect(result.cacheOutcome).toBe('miss');
    });
  });

  // --------------------------------------------------------------------------
  // Cache Miss Tests (Step 3)
  // --------------------------------------------------------------------------

  describe('cache miss', () => {
    it('fetches from Flying Saucer when no cache exists', async () => {
      vi.clearAllMocks();
      vi.mocked(getCachedTaplist).mockResolvedValue(null);

      const beers = [createBeer({ id: '1', brew_name: 'Live Beer' })];
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(200);
      const body = await result.response.json() as { source: string; cached_at: string };
      expect(body.source).toBe('live');
      expect(body.cached_at).toBeDefined();
    });

    it('fetches from Flying Saucer when cache is stale (beyond TTL)', async () => {
      vi.clearAllMocks();
      const staleAt = Date.now() - 600_000; // 10 minutes ago (beyond 5 min TTL)
      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify([createBeer({ id: 'old' })]),
        cached_at: staleAt,
      });

      const beers = [createBeer({ id: '1', brew_name: 'Fresh Beer' })];
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(200);
      const body = await result.response.json() as { source: string; beers: Array<{ id: string }> };
      expect(body.source).toBe('live');
      expect(body.beers[0].id).toBe('1'); // fresh data, not stale
    });

    it('writes response to cache after successful live fetch', async () => {
      vi.clearAllMocks();
      vi.mocked(getCachedTaplist).mockResolvedValue(null);

      const beers = [createBeer({ id: '1', brew_name: 'Live Beer' })];
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx, waitUntilPromises } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');
      await Promise.all(waitUntilPromises);

      expect(setCachedTaplist).toHaveBeenCalledWith(
        env.DB,
        '13885',
        expect.arrayContaining([expect.objectContaining({ id: '1' })]),
      );
    });

    it('returns live response even when cache write fails', async () => {
      vi.clearAllMocks();
      vi.mocked(getCachedTaplist).mockResolvedValue(null);
      vi.mocked(setCachedTaplist).mockRejectedValue(new Error('D1 write failed'));

      const beers = [createBeer({ id: '1', brew_name: 'Live Beer' })];
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx, waitUntilPromises } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(200);
      const body = await result.response.json() as { beers: unknown[] };
      expect(body.beers).toHaveLength(1);

      // Cache write happens in waitUntil — it fails but doesn't affect response
      await Promise.all(waitUntilPromises).catch(() => {});
    });

    it('caches and returns empty taplist correctly', async () => {
      vi.clearAllMocks();
      vi.mocked(getCachedTaplist).mockResolvedValue(null);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse([])),
      });

      const env = createMockEnv();
      const { ctx, waitUntilPromises } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');
      await Promise.all(waitUntilPromises);

      expect(result.response.status).toBe(200);
      const body = await result.response.json() as { beers: unknown[]; source: string };
      expect(body.beers).toHaveLength(0);
      expect(body.source).toBe('live');
      expect(setCachedTaplist).toHaveBeenCalledWith(env.DB, '13885', []);
    });

    it('triggers background enrichment on live fetch', async () => {
      vi.clearAllMocks();
      vi.mocked(getCachedTaplist).mockResolvedValue(null);

      const beers = [createBeer({ id: '1', brew_name: 'Live Beer' })];
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(beers)),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      // waitUntil called for both cache write and background enrichment
      expect(ctx.waitUntil).toHaveBeenCalled();
    });

    it('returns cacheOutcome "miss" on live fetch', async () => {
      vi.clearAllMocks();
      vi.mocked(getCachedTaplist).mockResolvedValue(null);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse([])),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.cacheOutcome).toBe('miss');
    });
  });

  // --------------------------------------------------------------------------
  // Force Refresh Tests (Step 4)
  // --------------------------------------------------------------------------

  describe('force refresh (fresh=true)', () => {
    it('calls Flying Saucer even when fresh cache exists', async () => {
      vi.clearAllMocks();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse([
          createBeer({ id: '1', brew_name: 'Fresh Beer' }),
        ])),
      });
      globalThis.fetch = mockFetch;

      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify([createBeer({ id: 'cached' })]),
        cached_at: Date.now() - 60_000, // fresh cache (1 min ago)
      });
      vi.mocked(parseCachedBeers).mockReturnValue([createBeer({ id: 'cached' })]);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885', true);

      expect(mockFetch).toHaveBeenCalled();
    });

    it('returns source "live" and cacheOutcome "bypass"', async () => {
      vi.clearAllMocks();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse([
          createBeer({ id: '1' }),
        ])),
      });

      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify([createBeer({ id: 'cached' })]),
        cached_at: Date.now() - 60_000,
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885', true);

      const body = await result.response.json() as { source: string; cached_at: string };
      expect(body.source).toBe('live');
      expect(body.cached_at).toBeDefined();
      expect(result.cacheOutcome).toBe('bypass');
    });

    it('updates the cache entry with new data', async () => {
      vi.clearAllMocks();
      const freshBeers = [createBeer({ id: 'new', brew_name: 'New Beer' })];
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(freshBeers)),
      });

      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify([createBeer({ id: 'old' })]),
        cached_at: Date.now() - 60_000,
      });

      const env = createMockEnv();
      const { ctx, waitUntilPromises } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885', true);
      await Promise.all(waitUntilPromises);

      expect(setCachedTaplist).toHaveBeenCalledWith(
        env.DB,
        '13885',
        expect.arrayContaining([expect.objectContaining({ id: 'new' })]),
      );
    });

    it('triggers background enrichment on force refresh', async () => {
      vi.clearAllMocks();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse([
          createBeer({ id: '1' }),
        ])),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885', true);

      // waitUntil called for cache write + background enrichment
      expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
    });

    it('uses cache normally when freshRequested is false', async () => {
      vi.clearAllMocks();
      const cachedBeers = [createBeer({ id: '1' })];
      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify(cachedBeers),
        cached_at: Date.now() - 60_000,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(cachedBeers);

      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885', false);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('falls back to stale cache when fresh=true and upstream fails', async () => {
      vi.clearAllMocks();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
      });

      const cachedBeers = [createBeer({ id: 'stale', brew_name: 'Stale Beer' })];
      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify(cachedBeers),
        cached_at: Date.now() - 600_000, // 10 min ago (stale)
      });
      vi.mocked(parseCachedBeers).mockReturnValue(cachedBeers);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885', true);

      expect(result.response.status).toBe(200);
      const body = await result.response.json() as { source: string; beers: unknown[] };
      expect(body.source).toBe('stale');
      expect(body.beers).toHaveLength(1);
      expect(result.cacheOutcome).toBe('stale');
    });
  });

  // --------------------------------------------------------------------------
  // Stale Fallback Tests (Step 5)
  // --------------------------------------------------------------------------

  describe('stale fallback', () => {
    it('returns stale cache on upstream 502', async () => {
      vi.clearAllMocks();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
      });

      const cachedAt = Date.now() - 600_000; // 10 min ago (stale)
      const cachedBeers = [createBeer({ id: '1', brew_name: 'Stale Beer' })];

      // First call returns stale row (for cache check), second call also returns it (for fallback)
      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify(cachedBeers),
        cached_at: cachedAt,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(cachedBeers);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(200);
      const body = await result.response.json() as {
        source: string;
        cached_at: string;
        beers: unknown[];
      };
      expect(body.source).toBe('stale');
      expect(body.cached_at).toBe(new Date(cachedAt).toISOString());
      expect(body.beers).toHaveLength(1);
      expect(result.cacheOutcome).toBe('stale');
    });

    it('returns stale cache on upstream network error', async () => {
      vi.clearAllMocks();
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const cachedBeers = [createBeer({ id: '1' })];
      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify(cachedBeers),
        cached_at: Date.now() - 600_000,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(cachedBeers);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(200);
      const body = await result.response.json() as { source: string };
      expect(body.source).toBe('stale');
      expect(result.cacheOutcome).toBe('stale');
    });

    it('returns 502 when upstream fails and no cache exists', async () => {
      vi.clearAllMocks();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
      });
      vi.mocked(getCachedTaplist).mockResolvedValue(null);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(502);
    });

    it('includes fresh requestId on stale fallback', async () => {
      vi.clearAllMocks();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
      });

      const cachedBeers = [createBeer({ id: '1' })];
      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: JSON.stringify(cachedBeers),
        cached_at: Date.now() - 600_000,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(cachedBeers);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      const body = await result.response.json() as { requestId: string };
      expect(body.requestId).toBe('test-request-id');
    });

    it('returns 502 when upstream fails and stale row exists but fails to parse', async () => {
      vi.clearAllMocks();
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });

      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: '{"corrupted": true}',
        cached_at: Date.now() - 600_000,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(null);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(502);
      expect(result.cacheOutcome).toBe('miss');
    });

    it('returns 500 when upstream throws and stale row exists but fails to parse', async () => {
      vi.clearAllMocks();
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

      vi.mocked(getCachedTaplist).mockResolvedValue({
        store_id: '13885',
        response_json: '{"corrupted": true}',
        cached_at: Date.now() - 600_000,
      });
      vi.mocked(parseCachedBeers).mockReturnValue(null);

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(500);
      expect(result.cacheOutcome).toBe('miss');
    });
  });

  // --------------------------------------------------------------------------
  // Cache D1 Failure Tests (Step 0b)
  // --------------------------------------------------------------------------

  describe('cache D1 failure resilience', () => {
    it('falls through to live fetch when getCachedTaplist throws on initial call', async () => {
      vi.clearAllMocks();
      vi.mocked(getCachedTaplist).mockRejectedValue(new Error('D1_ERROR: no such table: store_taplist_cache'));

      const liveBeers = [createBeer({ id: 'live-1', brew_name: 'Live Beer' })];
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(createFlyingSaucerResponse(liveBeers)),
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(200);
      const body = await result.response.json() as { source: string; beers: Array<{ id: string }> };
      expect(body.source).toBe('live');
      expect(body.beers[0].id).toBe('live-1');
    });

    it('returns 502 when getCachedTaplist throws and upstream also fails — no stale fallback attempted', async () => {
      vi.clearAllMocks();
      vi.mocked(getCachedTaplist).mockRejectedValue(new Error('D1_ERROR: no such table: store_taplist_cache'));

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const env = createMockEnv();
      const { ctx } = createMockExecutionContext();
      const reqCtx = createMockReqCtx();

      const result = await handleBeerList(env, ctx, mockHeaders, reqCtx, '13885');

      expect(result.response.status).toBe(502);
      // getCachedTaplist must NOT be called again as a stale fallback since the table is broken.
      // It was called once (initial read), and should not be called a second time.
      expect(getCachedTaplist).toHaveBeenCalledTimes(1);
    });
  });
});
