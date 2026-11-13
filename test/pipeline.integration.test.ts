/**
 * Pipeline Integration Tests
 *
 * Enrichment reads (getEnrichmentForBeerIds) and ABV extraction. Sighting
 * writes run against real D1 in test/db/seenBeers.integration.test.ts.
 *
 * Uses mocked D1 for reliable, fast tests without external dependencies.
 *
 * @module test/pipeline.integration.test
 */

import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { getEnrichmentForBeerIds, extractABV } from '../src/db';
import type { BeerEnrichmentData } from '../src/db';

// Mock external dependencies
vi.mock('../src/config', () => ({
  shouldSkipEnrichment: vi.fn().mockImplementation(({ brewName: name }: { brewName: string }) => {
    return name.toLowerCase().includes('flight');
  }),
}));

vi.mock('../src/utils/hash', () => ({
  hashDescription: vi.fn().mockImplementation(async (desc: string) => {
    // Simple mock hash for testing
    return `hash-${desc.slice(0, 20).replace(/\s/g, '-')}`;
  }),
}));

import { shouldSkipEnrichment } from '../src/config';
import { hashDescription } from '../src/utils/hash';

// ============================================================================
// Test Helpers
// ============================================================================

interface MockD1PreparedStatement {
  bind: Mock;
  first: Mock;
  all: Mock;
  run: Mock;
}

interface MockD1Database {
  batch: Mock;
  prepare: Mock;
  exec: Mock;
}

/**
 * Create a mock D1 database with configurable existing beers.
 */
function createMockD1(existingBeers: Map<string, {
  description_hash: string | null;
  abv: number | null;
  brew_description_cleaned?: string | null;
  enrichment_source?: string | null;
  confidence?: number;
  enrichment_status?: string | null;
}> = new Map()): MockD1Database {
  const batchStatements: { sql: string; args: unknown[] }[] = [];

  const mockDb: MockD1Database = {
    batch: vi.fn().mockImplementation(async (statements: MockD1PreparedStatement[]) => {
      // Execute each statement and collect results
      const results = [];
      for (const stmt of statements) {
        if (stmt && typeof stmt.all === 'function') {
          // For SELECT queries, call .all() to get results
          const allResult = await stmt.all();
          results.push({ success: true, results: allResult?.results || [], meta: {} });
        } else if (stmt && typeof stmt.run === 'function') {
          // For INSERT/UPDATE queries, call .run()
          await stmt.run();
          results.push({ success: true, results: [], meta: {} });
        } else {
          results.push({ success: true, results: [], meta: {} });
        }
      }
      return results;
    }),
    prepare: vi.fn().mockImplementation((sql: string) => {
      const stmt: MockD1PreparedStatement = {
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          batchStatements.push({ sql, args });

          // Handle SELECT queries for existing records
          if (sql.includes('SELECT id, description_hash, abv, enrichment_status, brewer FROM enriched_beers')) {
            return {
              all: vi.fn().mockImplementation(async () => {
                // Extract IDs from the args (they're passed as individual params)
                const requestedIds = args.filter((a): a is string => typeof a === 'string');
                const results = requestedIds
                  .filter(id => existingBeers.has(id))
                  .map(id => ({
                    id,
                    description_hash: existingBeers.get(id)?.description_hash ?? null,
                    abv: existingBeers.get(id)?.abv ?? null,
                    // Rows without an explicit status are pre-status-era rows;
                    // categorizeBeer treats null as pending (queueable)
                    enrichment_status: existingBeers.get(id)?.enrichment_status ?? null,
                    brewer: null,
                  }));
                return { results };
              }),
              first: vi.fn().mockResolvedValue(null),
              run: vi.fn().mockResolvedValue({ success: true }),
            };
          }

          // Handle SELECT for enrichment data
          if (sql.includes('SELECT id, abv, confidence, enrichment_source')) {
            return {
              all: vi.fn().mockImplementation(async () => {
                const requestedIds = args.filter((a): a is string => typeof a === 'string');
                const results = requestedIds
                  .filter(id => existingBeers.has(id))
                  .map(id => {
                    const beer = existingBeers.get(id)!;
                    return {
                      id,
                      abv: beer.abv,
                      confidence: beer.confidence ?? 0.5,
                      enrichment_source: beer.enrichment_source ?? null,
                      brew_description_cleaned: beer.brew_description_cleaned ?? null,
                    };
                  });
                return { results };
              }),
              first: vi.fn().mockResolvedValue(null),
              run: vi.fn().mockResolvedValue({ success: true }),
            };
          }

          return {
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockResolvedValue({ success: true }),
          };
        }),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
      return stmt;
    }),
    exec: vi.fn().mockResolvedValue({ count: 0 }),
  };

  return mockDb;
}

/**
 * Create a test beer object.
 */
function createTestBeer(
  id: string,
  name: string,
  brewer: string,
  description?: string
): { id: string; brew_name: string; brewer: string; brew_description?: string } {
  return {
    id,
    brew_name: name,
    brewer,
    ...(description && { brew_description: description }),
  };
}

// ============================================================================
// Integration Tests
// ============================================================================

describe('Pipeline Integration', () => {

  // --------------------------------------------------------------------------
  // getEnrichmentForBeerIds Tests
  // --------------------------------------------------------------------------

  describe('getEnrichmentForBeerIds', () => {
    it('should fetch enrichment data for beer IDs', async () => {
      const existingBeers = new Map([
        ['enriched-1', {
          description_hash: null,
          abv: 6.5,
          confidence: 0.95,
          enrichment_source: 'perplexity',
          brew_description_cleaned: 'A clean description',
        }],
        ['enriched-2', {
          description_hash: null,
          abv: 5.0,
          confidence: 0.9,
          enrichment_source: 'description',
          brew_description_cleaned: null,
        }],
      ]);
      const mockDb = createMockD1(existingBeers);

      const result = await getEnrichmentForBeerIds(
        mockDb as unknown as D1Database,
        ['enriched-1', 'enriched-2', 'missing-beer'],
        'test-request-10'
      );

      expect(result.size).toBe(2);
      expect(result.get('enriched-1')?.abv).toBe(6.5);
      expect(result.get('enriched-1')?.source).toBe('perplexity');
      expect(result.get('enriched-1')?.brew_description_cleaned).toBe('A clean description');
      expect(result.get('enriched-2')?.abv).toBe(5.0);
      expect(result.has('missing-beer')).toBe(false);
    });

    it('should handle empty beer ID array', async () => {
      const mockDb = createMockD1();
      const result = await getEnrichmentForBeerIds(mockDb as unknown as D1Database, [], 'test-request-11');
      expect(result.size).toBe(0);
    });

    it('should handle large ID arrays with chunking', async () => {
      // Create 150 existing beers
      const existingBeers = new Map<string, {
        description_hash: string | null;
        abv: number | null;
        confidence?: number;
        enrichment_source?: string | null;
      }>();

      for (let i = 0; i < 150; i++) {
        existingBeers.set(`chunk-beer-${i}`, {
          description_hash: null,
          abv: 5.0 + (i % 10) * 0.1,
          confidence: 0.9,
          enrichment_source: 'description',
        });
      }

      const mockDb = createMockD1(existingBeers);

      const ids = Array.from({ length: 150 }, (_, i) => `chunk-beer-${i}`);
      const result = await getEnrichmentForBeerIds(mockDb as unknown as D1Database, ids, 'test-request-12');

      expect(result.size).toBe(150);
      expect(result.get('chunk-beer-0')?.abv).toBe(5.0);
      expect(result.get('chunk-beer-99')?.abv).toBe(5.9);
    });
  });

  // --------------------------------------------------------------------------
  // ABV Extraction Tests
  // --------------------------------------------------------------------------

  describe('extractABV', () => {
    it('should extract ABV from percentage notation', () => {
      expect(extractABV('A beer with 5.2% alcohol')).toBe(5.2);
      expect(extractABV('Strong IPA at 8%')).toBe(8);
      expect(extractABV('Light beer 3.5%')).toBe(3.5);
    });

    it('should extract ABV from ABV keyword notation', () => {
      expect(extractABV('ABV: 6.5')).toBe(6.5);
      expect(extractABV('5.0 ABV')).toBe(5.0);
      expect(extractABV('This beer has ABV 7')).toBe(7);
    });

    it('should reject ABV values above 20%', () => {
      expect(extractABV('100% satisfaction guaranteed')).toBeNull();
      expect(extractABV('25% off today')).toBeNull();
    });

    it('should handle HTML tags in description', () => {
      expect(extractABV('<p>A great beer with 5.5% ABV</p>')).toBe(5.5);
      expect(extractABV('<br/>Strong at 8%<br/>')).toBe(8);
    });

    it('should return null for descriptions without ABV', () => {
      expect(extractABV('A delicious craft beer')).toBeNull();
      expect(extractABV(undefined)).toBeNull();
      expect(extractABV('')).toBeNull();
    });

    it('should handle edge cases', () => {
      expect(extractABV('0% alcohol free beer')).toBe(0);
      expect(extractABV('20% imperial stout')).toBe(20);
      expect(extractABV('21% is too high')).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Error Handling Tests
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('should handle getEnrichmentForBeerIds errors gracefully', async () => {
      const mockDb = createMockD1();
      mockDb.batch.mockRejectedValueOnce(new Error('D1 error'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await getEnrichmentForBeerIds(
        mockDb as unknown as D1Database,
        ['beer-1', 'beer-2'],
        'error-request'
      );

      // Should return empty map on error (graceful degradation)
      expect(result.size).toBe(0);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});
