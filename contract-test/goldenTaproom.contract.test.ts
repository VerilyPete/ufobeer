import { applyD1Migrations, createExecutionContext, env, fetchMock, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { beersProxyResponseSchema } from '../../BeerSelector/src/contracts/enrichment';
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

function goldenRequest(headers: Record<string, string> = {}): Request {
  return new IncomingRequest(`https://api.golden-taproom.test/beers?sid=${GOLDEN_STORE_ID}`, {
    headers: {
      'X-API-Key': TEST_API_KEY,
      'X-Client-ID': 'golden-taproom-client',
      ...headers,
    },
  });
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
});
