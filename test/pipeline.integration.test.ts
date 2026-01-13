/**
 * Pipeline Integration Tests
 *
 * Tests the full enrichment pipeline from beer sync through D1 updates,
 * covering the key data flows:
 * 1. Beer sync flow: API response -> insertPlaceholders -> D1 update
 * 2. Handling beers with existing enrichment data
 * 3. Queue message processing for cleanup and enrichment
 *
 * Uses mocked D1 for reliable, fast tests without external dependencies.
 *
 * @module test/pipeline.integration.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { insertPlaceholders, getEnrichmentForBeerIds, extractABV } from '../src/db';
import type { InsertPlaceholdersResult, BeerEnrichmentData } from '../src/db';

// Mock external dependencies
vi.mock('../src/config', () => ({
  shouldSkipEnrichment: vi.fn().mockImplementation((name: string) => {
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
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

interface MockD1Database {
  batch: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
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
          if (sql.includes('SELECT id, description_hash, abv FROM enriched_beers')) {
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
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations
    vi.mocked(shouldSkipEnrichment).mockImplementation((name: string) => {
      return name.toLowerCase().includes('flight');
    });
  });

  // --------------------------------------------------------------------------
  // insertPlaceholders Flow Tests
  // --------------------------------------------------------------------------

  describe('insertPlaceholders flow', () => {
    it('should insert new beers and return correct counts', async () => {
      const mockDb = createMockD1();
      const beers = [
        createTestBeer('beer-1', 'Test IPA', 'Test Brewery', 'A hoppy IPA'),
        createTestBeer('beer-2', 'Test Stout', 'Test Brewery', 'A dark stout'),
      ];

      const result = await insertPlaceholders(mockDb as unknown as D1Database, beers, 'test-request-1');

      expect(result.totalSynced).toBe(2);
      // Both beers are new and have descriptions, so they should need cleanup
      expect(result.needsCleanup).toHaveLength(2);
      expect(mockDb.batch).toHaveBeenCalled();
    });

    it('should queue new beer with description for cleanup (ABV extracted during cleanup)', async () => {
      // Note: Even if ABV is in description, new beers go to cleanup queue first.
      // The cleanup consumer is responsible for ABV extraction from cleaned description.
      // This ensures consistent description cleaning before ABV extraction.
      const mockDb = createMockD1();
      const beers = [
        createTestBeer('beer-abv', 'High ABV IPA', 'Brewery', 'A strong 8.5% ABV IPA with citrus notes'),
      ];

      const result = await insertPlaceholders(mockDb as unknown as D1Database, beers, 'test-request-2');

      // New beer with description goes to cleanup, not withAbv
      expect(result.withAbv).toBe(0);
      expect(result.needsEnrichment).toHaveLength(0);
      expect(result.needsCleanup).toHaveLength(1);
      expect(result.needsCleanup[0].id).toBe('beer-abv');
    });

    it('should queue beers without ABV for cleanup when description exists', async () => {
      const mockDb = createMockD1();
      const beers = [
        createTestBeer('beer-no-abv', 'Mystery Beer', 'Unknown Brewery', 'A mysterious beer with no alcohol info'),
      ];

      const result = await insertPlaceholders(mockDb as unknown as D1Database, beers, 'test-request-3');

      // Beer should be queued for cleanup (has description but no ABV)
      expect(result.needsCleanup).toHaveLength(1);
      expect(result.needsCleanup[0].id).toBe('beer-no-abv');
      expect(result.needsEnrichment).toHaveLength(0);
    });

    it('should queue beers without description for Perplexity enrichment', async () => {
      const mockDb = createMockD1();
      const beers = [
        createTestBeer('beer-no-desc', 'Plain Beer', 'Basic Brewery'),
      ];

      const result = await insertPlaceholders(mockDb as unknown as D1Database, beers, 'test-request-4');

      // Beer should be queued for Perplexity (no description)
      expect(result.needsEnrichment).toHaveLength(1);
      expect(result.needsEnrichment[0].id).toBe('beer-no-desc');
      expect(result.needsCleanup).toHaveLength(0);
    });

    it('should update existing beers when description changes', async () => {
      // Set up existing beer with a description hash
      const existingBeers = new Map([
        ['beer-update', {
          description_hash: 'hash-Original-descriptio',
          abv: null,
        }],
      ]);
      const mockDb = createMockD1(existingBeers);

      // Sync with new description (different hash)
      const beers = [
        createTestBeer('beer-update', 'Updatable Beer', 'Brewery', 'Updated description with changes'),
      ];

      const result = await insertPlaceholders(mockDb as unknown as D1Database, beers, 'test-request-5');

      // Should queue for cleanup due to description change
      expect(result.needsCleanup).toHaveLength(1);
      expect(result.needsCleanup[0].id).toBe('beer-update');
    });

    it('should not queue for cleanup when description is unchanged and ABV exists', async () => {
      const description = 'A great beer with 7% ABV';
      const descHash = `hash-${description.slice(0, 20).replace(/\s/g, '-')}`;

      const existingBeers = new Map([
        ['beer-preserve', {
          description_hash: descHash,
          abv: 7.0,
          enrichment_source: 'description',
        }],
      ]);
      const mockDb = createMockD1(existingBeers);

      // Sync with same description
      const beers = [
        createTestBeer('beer-preserve', 'Preserved Beer', 'Brewery', description),
      ];

      const result = await insertPlaceholders(mockDb as unknown as D1Database, beers, 'test-request-6');

      // Should not need enrichment or cleanup
      expect(result.needsEnrichment).toHaveLength(0);
      expect(result.needsCleanup).toHaveLength(0);
    });

    it('should handle large batches correctly', async () => {
      const mockDb = createMockD1();

      // Create 150 beers to test D1's 100 parameter limit handling
      const beers = Array.from({ length: 150 }, (_, i) =>
        createTestBeer(`beer-batch-${i}`, `Batch Beer ${i}`, 'Batch Brewery', `Description ${i} with ${5 + i * 0.1}% ABV`)
      );

      const result = await insertPlaceholders(mockDb as unknown as D1Database, beers, 'test-request-8');

      expect(result.totalSynced).toBe(150);
      // Batch should be called multiple times due to chunking
      expect(mockDb.batch).toHaveBeenCalled();
    });

    it('should skip blocklisted beers (flights) for enrichment', async () => {
      const mockDb = createMockD1();
      const beers = [
        createTestBeer('flight-1', 'Texas Flight Sampler', 'Various'),
        createTestBeer('beer-normal', 'Normal Beer', 'Brewery'),
      ];

      const result = await insertPlaceholders(mockDb as unknown as D1Database, beers, 'test-request-9');

      // Flight should be skipped for enrichment, normal beer should be queued
      expect(result.needsEnrichment).toHaveLength(1);
      expect(result.needsEnrichment[0].id).toBe('beer-normal');
    });
  });

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
  // Description Hash Change Detection Tests
  // --------------------------------------------------------------------------

  describe('description change detection', () => {
    it('should detect description changes via hash mismatch', async () => {
      const originalHash = 'hash-Original-descriptio';

      const existingBeers = new Map([
        ['hash-test', {
          description_hash: originalHash,
          abv: null,
        }],
      ]);
      const mockDb = createMockD1(existingBeers);

      // Sync with different description (different hash)
      const beers = [createTestBeer('hash-test', 'Hash Test Beer', 'Brewery', 'Updated beer description with more info')];

      const result = await insertPlaceholders(mockDb as unknown as D1Database, beers, 'test-request-13');

      // Should detect change and queue for cleanup
      expect(result.needsCleanup).toHaveLength(1);
    });

    it('should not queue for cleanup when description hash matches', async () => {
      const description = 'Consistent beer description';
      const descHash = `hash-${description.slice(0, 20).replace(/\s/g, '-')}`;

      const existingBeers = new Map([
        ['unchanged-test', {
          description_hash: descHash,
          abv: 5.5,
          enrichment_source: 'description',
        }],
      ]);
      const mockDb = createMockD1(existingBeers);

      // Sync with same description
      const beers = [createTestBeer('unchanged-test', 'Unchanged Beer', 'Brewery', description)];

      const result = await insertPlaceholders(mockDb as unknown as D1Database, beers, 'test-request-14');

      // Should not need cleanup (description unchanged, ABV exists)
      expect(result.needsCleanup).toHaveLength(0);
      expect(result.needsEnrichment).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // End-to-End Data Flow Tests
  // --------------------------------------------------------------------------

  describe('end-to-end data flow', () => {
    it('should correctly categorize mixed beer batch', async () => {
      // Setup: one existing beer with ABV
      const existingDesc = 'Existing description';
      const existingHash = `hash-${existingDesc.slice(0, 20).replace(/\s/g, '-')}`;

      const existingBeers = new Map([
        ['existing-with-abv', {
          description_hash: existingHash,
          abv: 5.5,
          enrichment_source: 'description',
        }],
      ]);
      const mockDb = createMockD1(existingBeers);

      // Sync batch with:
      // 1. Existing beer (unchanged) - should not queue (description unchanged, ABV exists)
      // 2. New beer with description (even with ABV) - goes to cleanup queue first
      // 3. New beer with description (no ABV) - goes to cleanup queue
      // 4. New beer without description - goes to Perplexity enrichment queue
      // 5. Flight (blocklisted) - skipped for enrichment
      const beers = [
        createTestBeer('existing-with-abv', 'Existing Beer', 'Brewery', existingDesc),
        createTestBeer('new-with-desc-abv', 'New ABV Beer', 'Brewery', 'A beer with 7.5% alcohol'),
        createTestBeer('new-with-desc-no-abv', 'New Cleanup Beer', 'Brewery', 'No ABV info here'),
        createTestBeer('new-needs-enrichment', 'New Enrichment Beer', 'Brewery'),
        createTestBeer('texas-flight', 'Texas Flight', 'Various'),
      ];

      const result = await insertPlaceholders(mockDb as unknown as D1Database, beers, 'mixed-batch');

      expect(result.totalSynced).toBe(5);
      // All new beers with descriptions go to cleanup (ABV extraction happens during cleanup)
      expect(result.withAbv).toBe(0);
      // Both new beers with descriptions go to cleanup
      expect(result.needsCleanup).toHaveLength(2);
      // Only the beer without description goes to enrichment (flight is skipped)
      expect(result.needsEnrichment).toHaveLength(1);

      // Verify categorization
      const cleanupIds = result.needsCleanup.map(b => b.id).sort();
      expect(cleanupIds).toEqual(['new-with-desc-abv', 'new-with-desc-no-abv']);
      expect(result.needsEnrichment[0].id).toBe('new-needs-enrichment');
    });

    it('should handle empty beer array', async () => {
      const mockDb = createMockD1();
      const result = await insertPlaceholders(mockDb as unknown as D1Database, [], 'empty-test');

      expect(result.totalSynced).toBe(0);
      expect(result.withAbv).toBe(0);
      expect(result.needsCleanup).toHaveLength(0);
      expect(result.needsEnrichment).toHaveLength(0);
    });

    it('should queue existing beer without ABV for Perplexity when description unchanged', async () => {
      const description = 'No ABV in this description';
      const descHash = `hash-${description.slice(0, 20).replace(/\s/g, '-')}`;

      const existingBeers = new Map([
        ['needs-enrichment', {
          description_hash: descHash,
          abv: null, // No ABV yet
          enrichment_source: null,
        }],
      ]);
      const mockDb = createMockD1(existingBeers);

      const beers = [createTestBeer('needs-enrichment', 'Beer Without ABV', 'Brewery', description)];

      const result = await insertPlaceholders(mockDb as unknown as D1Database, beers, 'enrichment-test');

      // Should queue for Perplexity since description unchanged but ABV missing
      expect(result.needsEnrichment).toHaveLength(1);
      expect(result.needsEnrichment[0].id).toBe('needs-enrichment');
      expect(result.needsCleanup).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Error Handling Tests
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('should propagate database errors from batch operations', async () => {
      const mockDb = createMockD1();
      mockDb.batch.mockRejectedValueOnce(new Error('D1 batch failed'));

      const beers = [createTestBeer('error-test', 'Error Beer', 'Brewery', 'Test description')];

      await expect(
        insertPlaceholders(mockDb as unknown as D1Database, beers, 'error-request')
      ).rejects.toThrow('D1 batch failed');
    });

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
