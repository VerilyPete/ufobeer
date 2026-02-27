import { describe, it, expect } from 'vitest';
import { getCachedTaplist, setCachedTaplist, parseCachedBeers } from '../../src/db/cache';
import { CachedBeersArraySchema } from '../../src/schemas/cache';

// ============================================================================
// Test Helpers
// ============================================================================

function createEnrichedBeer(overrides: Record<string, unknown> = {}) {
  return {
    id: '12345',
    brew_name: 'Test IPA',
    brewer: 'Test Brewery',
    brew_description: 'A hoppy IPA',
    container_type: 'pint',
    enriched_abv: 6.5,
    enrichment_confidence: 0.9,
    enrichment_source: 'description',
    ...overrides,
  };
}

function createMockDb(rows: readonly Record<string, unknown>[] = []) {
  const firstResult = rows.length > 0 ? rows[0] : null;
  return {
    prepare: () => ({
      bind: () => ({
        first: () => Promise.resolve(firstResult),
        run: () => Promise.resolve({ success: true }),
      }),
    }),
  } as unknown as D1Database;
}

function createMapBackedDb() {
  const storage = new Map<string, Record<string, unknown>>();
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        first: () => {
          const row = storage.get(args[0] as string);
          return Promise.resolve(row ?? null);
        },
        run: () => {
          storage.set(args[0] as string, {
            store_id: args[0],
            response_json: args[1],
            cached_at: args[2],
          });
          return Promise.resolve({ success: true });
        },
      }),
    }),
  } as unknown as D1Database;
  return db;
}

// ============================================================================
// getCachedTaplist
// ============================================================================

describe('getCachedTaplist', () => {
  it('returns null when no row exists for the store', async () => {
    const db = createMockDb([]);

    const result = await getCachedTaplist(db, '13879');

    expect(result).toBeNull();
  });

  it('returns CachedTaplistRow when row exists', async () => {
    const cachedAt = Date.now();
    const db = createMockDb([{
      store_id: '13879',
      response_json: JSON.stringify([createEnrichedBeer()]),
      cached_at: cachedAt,
    }]);

    const result = await getCachedTaplist(db, '13879');

    expect(result).toEqual({
      store_id: '13879',
      response_json: JSON.stringify([createEnrichedBeer()]),
      cached_at: cachedAt,
    });
  });
});

// ============================================================================
// setCachedTaplist
// ============================================================================

describe('setCachedTaplist', () => {
  it('writes a row that getCachedTaplist can read back', async () => {
    const beers = [createEnrichedBeer()];
    const db = createMapBackedDb();

    await setCachedTaplist(db, '13879', beers);
    const result = await getCachedTaplist(db, '13879');

    expect(result).not.toBeNull();
    expect(result!.store_id).toBe('13879');
    expect(JSON.parse(result!.response_json)).toEqual(beers);
  });

  it('overwrites existing row (UPSERT behavior)', async () => {
    const db = createMapBackedDb();

    const oldBeers = [createEnrichedBeer({ brew_name: 'Old Beer' })];
    const newBeers = [createEnrichedBeer({ brew_name: 'New Beer' })];

    await setCachedTaplist(db, '13879', oldBeers);
    await setCachedTaplist(db, '13879', newBeers);
    const result = await getCachedTaplist(db, '13879');

    expect(JSON.parse(result!.response_json)).toEqual(newBeers);
  });
});

// ============================================================================
// CachedBeersArraySchema
// ============================================================================

describe('CachedBeersArraySchema', () => {
  it('parses a valid beers array', () => {
    const beers = [createEnrichedBeer()];

    const result = CachedBeersArraySchema.safeParse(beers);

    expect(result.success).toBe(true);
  });

  it('preserves passthrough fields from Flying Saucer', () => {
    const beers = [createEnrichedBeer({ style: 'IPA', extra_field: 42 })];

    const result = CachedBeersArraySchema.safeParse(beers);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0]).toHaveProperty('style', 'IPA');
      expect(result.data[0]).toHaveProperty('extra_field', 42);
    }
  });

  it('rejects malformed data (missing required fields)', () => {
    const beers = [{ brewer: 'Test Brewery' }]; // missing id and brew_name

    const result = CachedBeersArraySchema.safeParse(beers);

    expect(result.success).toBe(false);
  });

  it('accepts beers with null enrichment fields', () => {
    const beers = [createEnrichedBeer({
      enriched_abv: null,
      enrichment_confidence: null,
      enrichment_source: null,
    })];

    const result = CachedBeersArraySchema.safeParse(beers);

    expect(result.success).toBe(true);
  });
});

// ============================================================================
// parseCachedBeers
// ============================================================================

describe('parseCachedBeers', () => {
  it('parses valid JSON and returns beers array', () => {
    const beers = [createEnrichedBeer()];
    const json = JSON.stringify(beers);

    const result = parseCachedBeers(json);

    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].id).toBe('12345');
  });

  it('returns null for corrupted JSON', () => {
    const result = parseCachedBeers('not valid json{{{');

    expect(result).toBeNull();
  });

  it('returns null for valid JSON that fails schema validation', () => {
    const result = parseCachedBeers(JSON.stringify([{ brewer: 'only' }]));

    expect(result).toBeNull();
  });

  it('returns null for non-array JSON', () => {
    const result = parseCachedBeers(JSON.stringify({ not: 'an array' }));

    expect(result).toBeNull();
  });
});
