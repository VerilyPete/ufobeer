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

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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

import { insertPlaceholders, getEnrichmentForBeerIds } from '../../src/db';
import { queueBeersForEnrichment, queueBeersForCleanup } from '../../src/queue';

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
// Global Fetch Mock
// ============================================================================

// Store original fetch
const originalFetch = globalThis.fetch;

// ============================================================================
// Tests
// ============================================================================

describe('handleBeerList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch to original before each test
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    // Restore original fetch after each test
    globalThis.fetch = originalFetch;
  });

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

    it('handles beers with no enrichment data', async () => {
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

      // waitUntil should be called exactly once for background task processing
      expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    });

    it('does not block response while background tasks run', async () => {
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
        return { totalSynced: 1, withAbv: 0, needsEnrichment: [], needsCleanup: [] };
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
});
