import { describe, it, expect } from 'vitest';
import { getCachedTaplist, setCachedTaplist, updateCacheTimestamp, parseCachedBeers } from '../../src/db/cache';
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
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: () => {
          const row = storage.get(args[0] as string);
          return Promise.resolve(row ?? null);
        },
        run: () => {
          if (sql.startsWith('INSERT')) {
            storage.set(args[0] as string, {
              store_id: args[0],
              response_json: args[1],
              cached_at: args[2],
              content_hash: args[3] ?? null,
              enrichment_hash: args[4] ?? null,
            });
          } else if (sql.startsWith('UPDATE')) {
            const existing = storage.get(args[1] as string);
            if (existing) {
              storage.set(args[1] as string, {
                ...existing,
                cached_at: args[0],
              });
            }
          }
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

    await setCachedTaplist(db, '13879', beers, 'abc123hash');
    const result = await getCachedTaplist(db, '13879');

    expect(result).not.toBeNull();
    expect(result!.store_id).toBe('13879');
    expect(JSON.parse(result!.response_json)).toEqual(beers);
  });

  it('overwrites existing row (UPSERT behavior)', async () => {
    const db = createMapBackedDb();

    const oldBeers = [createEnrichedBeer({ brew_name: 'Old Beer' })];
    const newBeers = [createEnrichedBeer({ brew_name: 'New Beer' })];

    await setCachedTaplist(db, '13879', oldBeers, 'hash1');
    await setCachedTaplist(db, '13879', newBeers, 'hash2');
    const result = await getCachedTaplist(db, '13879');

    expect(JSON.parse(result!.response_json)).toEqual(newBeers);
  });

  it('writes content_hash alongside response_json', async () => {
    const db = createMapBackedDb();
    const beers = [createEnrichedBeer()];

    await setCachedTaplist(db, '13879', beers, 'myhash123');
    const result = await getCachedTaplist(db, '13879');

    expect(result!.content_hash).toBe('myhash123');
  });
});

// ============================================================================
// getCachedTaplist — content_hash
// ============================================================================

describe('getCachedTaplist — content_hash', () => {
  it('returns content_hash when present', async () => {
    const cachedAt = Date.now();
    const db = createMockDb([{
      store_id: '13879',
      response_json: JSON.stringify([createEnrichedBeer()]),
      cached_at: cachedAt,
      content_hash: 'somehash',
    }]);

    const result = await getCachedTaplist(db, '13879');

    expect(result!.content_hash).toBe('somehash');
  });

  it('returns null content_hash for pre-migration rows', async () => {
    const cachedAt = Date.now();
    const db = createMockDb([{
      store_id: '13879',
      response_json: JSON.stringify([createEnrichedBeer()]),
      cached_at: cachedAt,
      content_hash: null,
    }]);

    const result = await getCachedTaplist(db, '13879');

    expect(result!.content_hash).toBeNull();
  });
});

// ============================================================================
// updateCacheTimestamp
// ============================================================================

describe('updateCacheTimestamp', () => {
  it('updates only cached_at without changing response_json or content_hash', async () => {
    const db = createMapBackedDb();
    const beers = [createEnrichedBeer()];

    await setCachedTaplist(db, '13879', beers, 'originalhash');
    const before = await getCachedTaplist(db, '13879');

    await updateCacheTimestamp(db, '13879');
    const after = await getCachedTaplist(db, '13879');

    expect(after!.content_hash).toBe('originalhash');
    expect(after!.response_json).toBe(before!.response_json);
    expect(after!.cached_at).toBeGreaterThanOrEqual(before!.cached_at);
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
// CachedBeersArraySchema — is_description_cleaned field
// ============================================================================

describe('CachedBeersArraySchema — is_description_cleaned', () => {
  it('accepts is_description_cleaned: true', () => {
    const beers = [createEnrichedBeer({ is_description_cleaned: true })];

    const result = CachedBeersArraySchema.safeParse(beers);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0].is_description_cleaned).toBe(true);
    }
  });

  it('accepts is_description_cleaned: false', () => {
    const beers = [createEnrichedBeer({ is_description_cleaned: false })];

    const result = CachedBeersArraySchema.safeParse(beers);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0].is_description_cleaned).toBe(false);
    }
  });

  it('defaults is_description_cleaned to false when field is missing (old cached entries)', () => {
    const beers = [createEnrichedBeer()]; // no is_description_cleaned field

    const result = CachedBeersArraySchema.safeParse(beers);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0].is_description_cleaned).toBe(false);
    }
  });
});

// ============================================================================
// getCachedTaplist — enrichment_hash
// ============================================================================

describe('getCachedTaplist — enrichment_hash', () => {
  it('returns enrichment_hash when present', async () => {
    const cachedAt = Date.now();
    const db = createMockDb([{
      store_id: '13879',
      response_json: JSON.stringify([createEnrichedBeer()]),
      cached_at: cachedAt,
      content_hash: 'somehash',
      enrichment_hash: 'enrich123',
    }]);

    const result = await getCachedTaplist(db, '13879');

    expect(result!.enrichment_hash).toBe('enrich123');
  });

  it('returns null enrichment_hash for pre-migration rows', async () => {
    const cachedAt = Date.now();
    const db = createMockDb([{
      store_id: '13879',
      response_json: JSON.stringify([createEnrichedBeer()]),
      cached_at: cachedAt,
      content_hash: 'somehash',
      enrichment_hash: null,
    }]);

    const result = await getCachedTaplist(db, '13879');

    expect(result!.enrichment_hash).toBeNull();
  });
});

// ============================================================================
// setCachedTaplist — enrichment_hash
// ============================================================================

describe('setCachedTaplist — enrichment_hash', () => {
  it('writes and persists enrichment_hash', async () => {
    const db = createMapBackedDb();
    const beers = [createEnrichedBeer()];

    await setCachedTaplist(db, '13879', beers, 'abc123hash', 'enrich456');
    const result = await getCachedTaplist(db, '13879');

    expect(result!.enrichment_hash).toBe('enrich456');
  });
});

// ============================================================================
// updateCacheTimestamp — enrichment_hash preservation
// ============================================================================

describe('updateCacheTimestamp — enrichment_hash preservation', () => {
  it('preserves enrichment_hash alongside content_hash and response_json', async () => {
    const db = createMapBackedDb();
    const beers = [createEnrichedBeer()];

    await setCachedTaplist(db, '13879', beers, 'originalhash', 'enrichhash');
    const before = await getCachedTaplist(db, '13879');

    await updateCacheTimestamp(db, '13879');
    const after = await getCachedTaplist(db, '13879');

    expect(after!.enrichment_hash).toBe('enrichhash');
    expect(after!.content_hash).toBe('originalhash');
    expect(after!.response_json).toBe(before!.response_json);
    expect(after!.cached_at).toBeGreaterThanOrEqual(before!.cached_at);
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
