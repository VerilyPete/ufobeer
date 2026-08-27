import { applyD1Migrations, createExecutionContext, env, fetchMock, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { hashDescription } from '../src/utils/hash';
import {
  batchEnrichmentResponseSchema,
  beersProxyResponseSchema,
  healthResponseSchema,
  syncBeersRequestSchema,
  syncBeersResponseSchema,
} from '../../BeerSelector/src/contracts/enrichment';
import { mapEnrichedBeerToAppBeer } from '../../BeerSelector/src/contracts/enrichmentAdapter';
import {
  GOLDEN_CACHED_AT,
  GOLDEN_CONTENT_HASH,
  GOLDEN_NOW,
  GOLDEN_STORE_ID,
  goldenTaproomBeers,
} from './fixtures';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const TEST_API_KEY = 'golden-taproom-test-key';
const TEST_ORIGIN = 'https://flying-saucer.golden-taproom.test';

const requiredTables = [
  'enriched_beers',
  'store_taplist_cache',
  'rate_limits',
  'audit_log',
  'enrichment_limits',
  'cleanup_limits',
] as const;

const goldenEnv: Env = {
  ...env,
  API_KEY: TEST_API_KEY,
  FLYING_SAUCER_API_BASE: TEST_ORIGIN,
};

const goldenLiveTaproomBeers = [
  goldenTaproomBeers[0],
  { ...goldenTaproomBeers[1], brew_name: 'Golden Root Beer' },
] as const;

async function clearGoldenRows(): Promise<void> {
  for (const table of requiredTables) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

async function seedGoldenCache(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO store_taplist_cache
      (store_id, response_json, cached_at, content_hash, enrichment_hash)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      GOLDEN_STORE_ID,
      JSON.stringify(goldenTaproomBeers),
      GOLDEN_CACHED_AT,
      GOLDEN_CONTENT_HASH,
      null,
    )
    .run();
}

async function seedExpiredGoldenCache(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO store_taplist_cache
      (store_id, response_json, cached_at, content_hash, enrichment_hash)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      GOLDEN_STORE_ID,
      JSON.stringify(goldenTaproomBeers),
      GOLDEN_CACHED_AT - 600_000,
      'expired-content-hash',
      null,
    )
    .run();
}

async function seedGoldenEnrichment(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO enriched_beers
      (id, brew_name, brewer, abv, confidence, enrichment_source,
       brew_description_original, brew_description_cleaned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      'golden-complete', 'Contract IPA', 'Schema Brewing', 6.5, 0.95, 'manual',
      'Original description', 'Cleaned contract description',
      'golden-nullable', 'Null Island Lager', 'Schema Brewing', null, null, null,
      null, null,
    )
    .run();
}

async function seedGoldenLiveEnrichment(): Promise<void> {
  const completeDescription = goldenLiveTaproomBeers[0].brew_description;
  if (completeDescription === undefined) {
    throw new Error('complete Golden Taproom beer must have a description');
  }
  const completeDescriptionHash = await hashDescription(completeDescription);

  await env.DB.prepare(
    `INSERT INTO enriched_beers
      (id, brew_name, brewer, abv, confidence, enrichment_source,
       brew_description_original, brew_description_cleaned, description_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      'golden-complete', 'Contract IPA', 'Schema Brewing', 6.5, 0.95, 'manual',
      completeDescription, 'Cleaned contract description', completeDescriptionHash,
      'golden-nullable', 'Golden Root Beer', 'Schema Brewing', null, null, null,
      null, null, null,
    )
    .run();
}

async function seedGoldenQuota(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO enrichment_limits (date, request_count, last_updated)
     VALUES (?, ?, ?), (?, ?, ?)`
  )
    .bind('2026-08-27', 7, GOLDEN_NOW, '2026-08-01', 5, GOLDEN_NOW)
    .run();
}

function interceptGoldenTaplist(statusCode: number, body: object): void {
  fetchMock
    .get(TEST_ORIGIN)
    .intercept({ path: `/?sid=${GOLDEN_STORE_ID}`, method: 'GET' })
    .reply(statusCode, body);
}

function goldenRequest(headers: Record<string, string> = {}): Request {
  return new IncomingRequest(`https://api.golden-taproom.test/beers?sid=${GOLDEN_STORE_ID}`, {
    headers: {
      'X-API-Key': TEST_API_KEY,
      'X-Client-ID': 'golden-taproom-client',
      ...headers,
    },
  });
}

function goldenBatchRequest(ids: readonly string[]): Request {
  return new IncomingRequest('https://api.golden-taproom.test/beers/batch', {
    method: 'POST',
    headers: {
      'X-API-Key': TEST_API_KEY,
      'X-Client-ID': 'golden-taproom-client',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids }),
  });
}

function goldenSyncRequest(beers: readonly object[]): Request {
  return new IncomingRequest('https://api.golden-taproom.test/beers/sync', {
    method: 'POST',
    headers: {
      'X-API-Key': TEST_API_KEY,
      'X-Client-ID': 'golden-taproom-client',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ beers }),
  });
}

function goldenHealthRequest(): Request {
  return new IncomingRequest('https://api.golden-taproom.test/health');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

async function invokeGoldenRequest(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, goldenEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(GOLDEN_NOW);
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await clearGoldenRows();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

afterAll(() => {
  vi.useRealTimers();
});

describe('Golden Taproom contract fixture', () => {
  it('applies a D1 fixture containing every public-route table', async () => {
    const result = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${requiredTables.map(() => '?').join(',')})`
    )
      .bind(...requiredTables)
      .all<{ name: string }>();
    const found = new Set(result.results.map(row => row.name));

    expect(requiredTables.every(table => found.has(table))).toBe(true);
  });

  it('serves a fresh cached 200 consumable by mobile schema and adapter', async () => {
    await seedGoldenCache();

    const response = await invokeGoldenRequest(goldenRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');

    const body: unknown = await response.json();
    expect(body).toMatchObject({
      storeId: GOLDEN_STORE_ID,
      source: 'cache',
    });
    const parsed = beersProxyResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.beers).toHaveLength(2);
    expect(response.headers.get('X-Request-ID')).toBeTruthy();
    const etag = response.headers.get('ETag');
    expect(etag).toMatch(/^".+"$/);

    const mapped = parsed.data.beers.map(mapEnrichedBeerToAppBeer);
    const complete = mapped.find(beer => beer.id === 'golden-complete');
    const nullable = mapped.find(beer => beer.id === 'golden-nullable');
    expect(complete).toMatchObject({
      id: 'golden-complete',
      brew_name: 'Contract IPA',
      brewer: 'Schema Brewing',
      abv: 6.5,
      enrichment_confidence: 0.95,
      enrichment_source: 'manual',
    });
    expect(nullable).toMatchObject({
      id: 'golden-nullable',
      brew_name: 'Null Island Lager',
      brewer: 'Schema Brewing',
      abv: null,
      enrichment_confidence: null,
      enrichment_source: null,
    });
  });

  it('returns an empty 304 body with the same ETag and does not parse JSON', async () => {
    await seedGoldenCache();

    const first = await invokeGoldenRequest(goldenRequest());
    const etag = first.headers.get('ETag');
    expect(etag).toMatch(/^".+"$/);
    if (etag === null) return;

    const second = await invokeGoldenRequest(goldenRequest({ 'If-None-Match': etag }));
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(second.headers.get('ETag')).toBe(etag);
  });

  it('serves a live taplist response through the mobile schema and adapter', async () => {
    await seedExpiredGoldenCache();
    await seedGoldenLiveEnrichment();
    interceptGoldenTaplist(200, [
      { store_info: 'Golden Taproom' },
      { brewInStock: goldenLiveTaproomBeers },
    ]);

    const response = await invokeGoldenRequest(goldenRequest());
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const parsed = beersProxyResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.source).toBe('live');
    expect(parsed.data.storeId).toBe(GOLDEN_STORE_ID);
    expect(response.headers.get('ETag')).toMatch(/^".+"$/);

    const mapped = parsed.data.beers.map(mapEnrichedBeerToAppBeer);
    expect(mapped.find(beer => beer.id === 'golden-complete')).toMatchObject({
      brewer_loc: 'Austin, TX',
      brew_style: 'IPA',
      brew_container: 'Draft',
      brew_description: 'Cleaned contract description',
      abv: 6.5,
      enrichment_source: 'manual',
    });
    expect(mapped.find(beer => beer.id === 'golden-nullable')).toMatchObject({
      brew_name: 'Golden Root Beer',
      abv: null,
      enrichment_confidence: null,
      enrichment_source: null,
    });
  });

  it('serves an expired cache as stale when the upstream taplist fails', async () => {
    await seedExpiredGoldenCache();
    interceptGoldenTaplist(503, { error: 'upstream unavailable' });

    const response = await invokeGoldenRequest(goldenRequest());
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const parsed = beersProxyResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.source).toBe('stale');
    expect(parsed.data.cached_at).toBe(new Date(GOLDEN_CACHED_AT - 600_000).toISOString());
    expect(response.headers.get('ETag')).toMatch(/^".+"$/);
  });

  it('returns batch enrichment through the mobile schema', async () => {
    await seedGoldenEnrichment();

    const response = await invokeGoldenRequest(goldenBatchRequest([
      'golden-complete',
      'golden-missing',
    ]));
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const parsed = batchEnrichmentResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const complete = parsed.data.enrichments['golden-complete'];
    expect(complete).toMatchObject({
      enriched_abv: 6.5,
      enrichment_confidence: 0.95,
      enrichment_source: 'manual',
      brew_description: 'Cleaned contract description',
      has_cleaned_description: true,
    });
    expect(parsed.data.missing).toEqual(['golden-missing']);

    const bodyRecord = requireRecord(body, 'batch response');
    const enrichments = requireRecord(bodyRecord['enrichments'], 'batch enrichments');
    const completeBody = enrichments['golden-complete'];
    expect(completeBody).toMatchObject({ is_verified: false });
  });

  it('syncs a mobile-valid request and returns the mobile response shape', async () => {
    const syncBeers = [
      { id: 'golden-sync-one', brew_name: 'Sync One', brewer: 'Schema Brewing' },
      { id: 'golden-sync-two', brew_name: 'Sync Two' },
    ];
    expect(syncBeersRequestSchema.safeParse({ beers: syncBeers }).success).toBe(true);

    const response = await invokeGoldenRequest(goldenSyncRequest(syncBeers));
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const parsed = syncBeersResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.synced).toBe(2);
    expect(parsed.data.queued_for_cleanup).toBe(0);
    expect(parsed.data.requestId).toBeTruthy();
    expect(parsed.data.errors).toBeUndefined();
  });

  it('returns deterministic health quota arithmetic through the mobile schema', async () => {
    await seedGoldenQuota();

    const response = await invokeGoldenRequest(goldenHealthRequest());
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const parsed = healthResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    if (parsed.data.enrichment === undefined) {
      throw new Error('health response omitted required enrichment quotas');
    }

    const { daily, monthly } = parsed.data.enrichment;
    expect(daily.used).toBe(7);
    expect(monthly.used).toBe(12);
    expect(daily.used + daily.remaining).toBe(daily.limit);
    expect(monthly.used + monthly.remaining).toBe(monthly.limit);
  });

  it('accepts additive server fields in a valid captured taplist body', async () => {
    await seedGoldenCache();

    const response = await invokeGoldenRequest(goldenRequest());
    const body: unknown = await response.json();
    expect(beersProxyResponseSchema.safeParse(body).success).toBe(true);
    const bodyRecord = requireRecord(body, 'taplist response');
    bodyRecord['future_server_metadata'] = { generation: 2 };
    const beers = requireArray(bodyRecord['beers'], 'taplist beers');
    const firstBeer = requireRecord(beers[0], 'first beer');
    firstBeer['future_beer_metadata'] = { source: 'edge' };

    expect(beersProxyResponseSchema.safeParse(bodyRecord).success).toBe(true);
  });

  it('rejects a captured taplist body missing required brew_name', async () => {
    await seedGoldenCache();

    const response = await invokeGoldenRequest(goldenRequest());
    const body: unknown = await response.json();
    expect(beersProxyResponseSchema.safeParse(body).success).toBe(true);
    const mutated = requireRecord(structuredClone(body), 'taplist response');
    const beers = requireArray(mutated['beers'], 'taplist beers');
    const firstBeer = requireRecord(beers[0], 'first beer');
    delete firstBeer['brew_name'];

    expect(beersProxyResponseSchema.safeParse(mutated).success).toBe(false);
  });

  it('rejects a captured taplist body with a numeric-string ABV', async () => {
    await seedGoldenCache();

    const response = await invokeGoldenRequest(goldenRequest());
    const body: unknown = await response.json();
    expect(beersProxyResponseSchema.safeParse(body).success).toBe(true);
    const mutated = requireRecord(structuredClone(body), 'taplist response');
    const beers = requireArray(mutated['beers'], 'taplist beers');
    const firstBeer = requireRecord(beers[0], 'first beer');
    firstBeer['enriched_abv'] = '6.5';

    expect(beersProxyResponseSchema.safeParse(mutated).success).toBe(false);
  });

  it('rejects a captured taplist body with an unknown source enum', async () => {
    await seedGoldenCache();

    const response = await invokeGoldenRequest(goldenRequest());
    const body: unknown = await response.json();
    expect(beersProxyResponseSchema.safeParse(body).success).toBe(true);
    const mutated = requireRecord(structuredClone(body), 'taplist response');
    mutated['source'] = 'edge-cache-v2';

    expect(beersProxyResponseSchema.safeParse(mutated).success).toBe(false);
  });

  it('rejects a captured batch body with the wrong top-level collection kind', async () => {
    await seedGoldenEnrichment();

    const response = await invokeGoldenRequest(goldenBatchRequest(['golden-complete']));
    const body: unknown = await response.json();
    expect(batchEnrichmentResponseSchema.safeParse(body).success).toBe(true);
    const mutated = requireRecord(structuredClone(body), 'batch response');
    mutated['enrichments'] = [];

    expect(batchEnrichmentResponseSchema.safeParse(mutated).success).toBe(false);
  });

  it('rejects a captured sync body with a malformed counter', async () => {
    const response = await invokeGoldenRequest(goldenSyncRequest([
      { id: 'golden-sync-counter', brew_name: 'Sync Counter' },
    ]));
    const body: unknown = await response.json();
    expect(syncBeersResponseSchema.safeParse(body).success).toBe(true);
    const mutated = requireRecord(structuredClone(body), 'sync response');
    mutated['synced'] = '1';

    expect(syncBeersResponseSchema.safeParse(mutated).success).toBe(false);
  });

  it('rejects a captured health body with a malformed quota value', async () => {
    await seedGoldenQuota();

    const response = await invokeGoldenRequest(goldenHealthRequest());
    const body: unknown = await response.json();
    expect(healthResponseSchema.safeParse(body).success).toBe(true);
    const mutated = requireRecord(structuredClone(body), 'health response');
    const enrichment = requireRecord(mutated['enrichment'], 'health enrichment');
    const daily = requireRecord(enrichment['daily'], 'health daily quota');
    daily['used'] = '7';

    expect(healthResponseSchema.safeParse(mutated).success).toBe(false);
  });
});
