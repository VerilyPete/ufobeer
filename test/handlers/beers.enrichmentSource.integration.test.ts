/**
 * X-Enrichment-Sources negotiation through src/index.ts against real D1:
 * exa is stored and cached as-is, but only a client that asks for it sees it
 * on /beers (live, cache hit, stale) and /beers/batch.
 */
import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { handleBeerList } from '../../src/handlers/beers';
import type { Env, RequestContext } from '../../src/types';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const API_KEY = 'enrichment-source-test-key';
const ORIGIN = 'https://flying-saucer.golden-taproom.test';
const STORE_ID = '13879';
const ASK_FOR_EXA = { 'X-Enrichment-Sources': 'exa' };

const testEnv: Env = { ...env, API_KEY, FLYING_SAUCER_API_BASE: ORIGIN };

const taplistBeers = [
  { id: 'beer-exa', brew_name: '18th Anniversary', brewer: '(512) Brewing Co.' },
  { id: 'beer-pplx', brew_name: 'Pecan Porter', brewer: '(512) Brewing Co.' },
] as const;

const cachedBeers = [
  { ...taplistBeers[0], enriched_abv: 8, enrichment_confidence: 0.8, enrichment_source: 'exa', is_description_cleaned: false },
  { ...taplistBeers[1], enriched_abv: 6.8, enrichment_confidence: 0.7, enrichment_source: 'perplexity', is_description_cleaned: false },
];

async function seedEnrichment(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO enriched_beers (id, brew_name, brewer, abv, confidence, enrichment_source, enrichment_status)
      VALUES ('beer-exa', '18th Anniversary', '(512) Brewing Co.', 8, 0.8, 'exa', 'enriched')`),
    env.DB.prepare(`INSERT INTO enriched_beers (id, brew_name, brewer, abv, confidence, enrichment_source, enrichment_status)
      VALUES ('beer-pplx', 'Pecan Porter', '(512) Brewing Co.', 6.8, 0.7, 'perplexity', 'enriched')`),
  ]);
}

async function seedCache(ageMs: number): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO store_taplist_cache (store_id, response_json, cached_at, content_hash, enrichment_hash)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(STORE_ID, JSON.stringify(cachedBeers), Date.now() - ageMs, 'content-hash', 'enrichment-hash').run();
}

const FRESH = 0;
const EXPIRED = 60 * 60 * 1000;

async function expireCache(): Promise<void> {
  await env.DB.prepare('UPDATE store_taplist_cache SET cached_at = ? WHERE store_id = ?')
    .bind(Date.now() - EXPIRED, STORE_ID).run();
}

type Upstream = 'taplist' | 'down';

function stubUpstream(mode: Upstream): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => mode === 'taplist'
    ? Response.json([{ store_info: 'x' }, { brewInStock: taplistBeers }])
    : Response.json({ error: 'unavailable' }, { status: 503 }));
}

async function invoke(request: Request, workerEnv: Env = testEnv): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function beersRequest(headers: Record<string, string> = {}): Request {
  return new IncomingRequest(`https://api.ufobeer.test/beers?sid=${STORE_ID}`, {
    headers: { 'X-API-Key': API_KEY, ...headers },
  });
}

function batchRequest(headers: Record<string, string> = {}, ids: readonly string[] = ['beer-exa', 'beer-pplx']): Request {
  return new IncomingRequest('https://api.ufobeer.test/beers/batch', {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ ids }),
  });
}

type Labelled = { readonly id: string; readonly enrichment_source: unknown; readonly enriched_abv: unknown; readonly enrichment_confidence: unknown };

async function labels(response: Response): Promise<Record<string, Pick<Labelled, 'enrichment_source' | 'enriched_abv' | 'enrichment_confidence'>>> {
  const body = await response.json<{ beers: Labelled[] }>();
  return Object.fromEntries(body.beers.map(b => [b.id, {
    enrichment_source: b.enrichment_source, enriched_abv: b.enriched_abv, enrichment_confidence: b.enrichment_confidence,
  }]));
}

const HIDDEN = {
  'beer-exa': { enrichment_source: null, enriched_abv: 8, enrichment_confidence: 0.8 },
  'beer-pplx': { enrichment_source: 'perplexity', enriched_abv: 6.8, enrichment_confidence: 0.7 },
};
const SHOWN = { ...HIDDEN, 'beer-exa': { ...HIDDEN['beer-exa'], enrichment_source: 'exa' } };

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
  for (const table of ['enriched_beers', 'store_taplist_cache', 'rate_limits', 'audit_log']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Path = {
  readonly name: string;
  readonly source: string;
  readonly setup: () => Promise<void>;
  readonly beforeEachRequest: () => Promise<void>;
  readonly upstream: Upstream | null;
};

const paths: readonly Path[] = [
  { name: 'cache hit', source: 'cache', setup: () => seedCache(FRESH), beforeEachRequest: async () => {}, upstream: null },
  { name: 'live', source: 'live', setup: async () => { await seedEnrichment(); await seedCache(EXPIRED); }, beforeEachRequest: expireCache, upstream: 'taplist' },
  { name: 'stale fallback', source: 'stale', setup: () => seedCache(EXPIRED), beforeEachRequest: async () => {}, upstream: 'down' },
];

describe.each(paths)('GET /beers $name path', (path) => {
  async function get(headers: Record<string, string> = {}): Promise<Response> {
    await path.beforeEachRequest();
    if (path.upstream) stubUpstream(path.upstream);
    const response = await invoke(beersRequest(headers));
    vi.restoreAllMocks();
    return response;
  }

  it('hides exa without the header and shows it with the header, ABV and confidence intact', async () => {
    await path.setup();
    const headerless = await get();
    expect(headerless.status).toBe(200);
    expect(await headerless.clone().json()).toMatchObject({ source: path.source });
    expect(await labels(headerless)).toEqual(HIDDEN);
    expect(await labels(await get(ASK_FOR_EXA))).toEqual(SHOWN);
  });

  it('sends Vary: X-Enrichment-Sources on 200 and 304', async () => {
    await path.setup();
    const ok = await get();
    expect(ok.headers.get('Vary')).toBe('X-Enrichment-Sources');
    const notModified = await get({ 'If-None-Match': ok.headers.get('ETag') ?? '' });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('Vary')).toBe('X-Enrichment-Sources');
  });

  it('gives each variant its own stable ETag with a working 304 round trip', async () => {
    await path.setup();
    const headerlessEtag = (await get()).headers.get('ETag');
    const exaEtag = (await get(ASK_FOR_EXA)).headers.get('ETag');
    expect(headerlessEtag).toMatch(/^".+"$/);
    expect(exaEtag).toMatch(/^".+"$/);
    expect(exaEtag).not.toBe(headerlessEtag);
    expect((await get()).headers.get('ETag')).toBe(headerlessEtag);
    expect((await get(ASK_FOR_EXA)).headers.get('ETag')).toBe(exaEtag);
    expect((await get({ 'If-None-Match': headerlessEtag! })).status).toBe(304);
    expect((await get({ ...ASK_FOR_EXA, 'If-None-Match': exaEtag! })).status).toBe(304);
  });

  it('answers a conditional from the other variant with a full 200 and the right labels', async () => {
    await path.setup();
    const headerlessEtag = (await get()).headers.get('ETag')!;
    const exaEtag = (await get(ASK_FOR_EXA)).headers.get('ETag')!;

    const upgraded = await get({ ...ASK_FOR_EXA, 'If-None-Match': headerlessEtag });
    expect(upgraded.status).toBe(200);
    expect(await labels(upgraded)).toEqual(SHOWN);

    const downgraded = await get({ 'If-None-Match': exaEtag });
    expect(downgraded.status).toBe(200);
    expect(await labels(downgraded)).toEqual(HIDDEN);
  });
});

describe('GET /beers live path cache write', () => {
  it('stores exa in the taplist cache whatever the requesting client accepted', async () => {
    await seedEnrichment();
    stubUpstream('taplist');
    await invoke(beersRequest());
    const row = await env.DB.prepare('SELECT response_json FROM store_taplist_cache WHERE store_id = ?')
      .bind(STORE_ID).first<{ response_json: string }>();
    const stored = JSON.parse(row!.response_json) as Labelled[];
    expect(stored.find(b => b.id === 'beer-exa')?.enrichment_source).toBe('exa');
  });
});

describe('POST /beers/batch', () => {
  type BatchBody = { enrichments: Record<string, { enrichment_source: unknown; enriched_abv: unknown; enrichment_confidence: unknown }> };

  it('hides exa without the header and shows it with the header, and varies on the header', async () => {
    await seedEnrichment();
    const headerless = await invoke(batchRequest());
    expect(headerless.status).toBe(200);
    expect(headerless.headers.get('Vary')).toBe('X-Enrichment-Sources');
    const hidden = await headerless.json<BatchBody>();
    expect(hidden.enrichments['beer-exa']).toMatchObject({ enrichment_source: null, enriched_abv: 8, enrichment_confidence: 0.8 });
    expect(hidden.enrichments['beer-pplx']).toMatchObject({ enrichment_source: 'perplexity' });

    const shown = await (await invoke(batchRequest(ASK_FOR_EXA))).json<BatchBody>();
    expect(shown.enrichments['beer-exa']).toMatchObject({ enrichment_source: 'exa', enriched_abv: 8, enrichment_confidence: 0.8 });
  });

  it('returns only the requested beers when other beers are stored', async () => {
    await seedEnrichment();

    const body = await (await invoke(batchRequest({}, ['beer-pplx', 'beer-unknown']))).json<BatchBody>();

    expect(Object.keys(body.enrichments)).toEqual(['beer-pplx']);
  });
});

// Known buildCombinedEtag outputs for content hash 'abc123', pinned in
// test/utils/hash.test.ts.
const STORED_CONTENT_HASH = 'abc123';
const PINNED_ETAGS = [
  { enrichmentHash: 'def456', etag: '"93c716548884edbe2d401a649fc94fbe"' },
  { enrichmentHash: null, etag: '"869726fac5200468bd9157965bf77503"' },
] as const;

const FIXED_NOW = Date.UTC(2026, 10, 17, 18, 30, 15);

function fixTheClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

async function seedCacheHashes(ageMs: number, enrichmentHash: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO store_taplist_cache (store_id, response_json, cached_at, content_hash, enrichment_hash)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(STORE_ID, JSON.stringify(cachedBeers), Date.now() - ageMs, STORED_CONTENT_HASH, enrichmentHash).run();
}

type Served = { readonly status: number; readonly source: unknown; readonly etag: string | null; readonly cacheControl: string | null };

async function served(response: Response): Promise<Served> {
  const body = await response.json<{ source: unknown }>();
  return { status: response.status, source: body.source, etag: response.headers.get('ETag'), cacheControl: response.headers.get('Cache-Control') };
}

async function getWith(upstream: Upstream | null, headers: Record<string, string> = {}, workerEnv: Env = testEnv): Promise<Response> {
  if (upstream) stubUpstream(upstream);
  const response = await invoke(beersRequest(headers), workerEnv);
  vi.restoreAllMocks();
  return response;
}

describe.each([
  { name: 'cache hit', source: 'cache', ageMs: FRESH, upstream: null },
  { name: 'stale fallback', source: 'stale', ageMs: EXPIRED, upstream: 'down' },
] as const)('GET /beers $name ETag', ({ source, ageMs, upstream }) => {
  fixTheClock();

  it.each(PINNED_ETAGS)('is built from the stored content hash and enrichment hash $enrichmentHash', async ({ enrichmentHash, etag }) => {
    await seedCacheHashes(ageMs, enrichmentHash);

    const response = await getWith(upstream);

    expect(await served(response)).toEqual({ status: 200, source, etag, cacheControl: 'private, max-age=300' });
  });
});

describe('GET /beers live path ETag and cache write', () => {
  fixTheClock();

  it('serves the same ETag and cache headers live as from the cache row it writes', async () => {
    await seedEnrichment();

    const live = await served(await getWith('taplist'));
    const cached = await served(await getWith(null));

    expect({ ...live, source: 'cache' }).toEqual(cached);
    expect(live.source).toBe('live');
  });

  it('rewrites the cache when only enrichment changed, so the next cache hit serves the new ABV', async () => {
    await seedEnrichment();
    await getWith('taplist');
    await env.DB.prepare("UPDATE enriched_beers SET abv = 7.3 WHERE id = 'beer-pplx'").run();
    await expireCache();
    await getWith('taplist');

    const cacheHit = await getWith(null);

    expect(await cacheHit.clone().json()).toMatchObject({ source: 'cache' });
    expect(await labels(cacheHit)).toEqual({ ...HIDDEN, 'beer-pplx': { ...HIDDEN['beer-pplx'], enriched_abv: 7.3 } });
  });
});

describe.each(paths)('GET /beers $name path 304 analytics', (path) => {
  fixTheClock();

  it('records a 304 as a conditional answer with no beers returned', async () => {
    await path.setup();
    await path.beforeEachRequest();
    const etag = (await getWith(path.upstream)).headers.get('ETag') ?? '';
    const points: AnalyticsEngineDataPoint[] = [];
    const analytics = { writeDataPoint: (point?: AnalyticsEngineDataPoint) => { if (point) points.push(point); } };
    await path.beforeEachRequest();

    const notModified = await getWith(path.upstream, { 'If-None-Match': etag }, { ...testEnv, ANALYTICS: analytics });

    expect(notModified.status).toBe(304);
    expect(points.filter(point => point.blobs?.[6] === 'request').map(point => ({
      cacheOutcome: point.blobs?.[8], beersReturned: point.doubles?.[2],
    }))).toEqual([{ cacheOutcome: 'conditional', beersReturned: 0 }]);
  });
});

describe('GET /beers store ID checks', () => {
  it('rejects a store that is not enabled before anything reaches upstream', async () => {
    stubUpstream('taplist');
    const response = await invoke(new IncomingRequest('https://api.ufobeer.test/beers?sid=abc', { headers: { 'X-API-Key': API_KEY } }));
    const upstreamCalls = vi.mocked(globalThis.fetch).mock.calls.length;
    vi.restoreAllMocks();

    expect({ status: response.status, body: await response.json(), upstreamCalls }).toEqual({
      status: 400,
      body: { error: 'Invalid store ID', requestId: response.headers.get('X-Request-ID') },
      upstreamCalls: 0,
    });
  });

  it('has the handler itself reject a malformed store ID without fetching upstream', async () => {
    stubUpstream('taplist');
    const reqCtx: RequestContext = {
      requestId: 'request-41', startTime: 0, clientIdentifier: 'client', apiKeyHash: 'hash', clientIp: '127.0.0.1', userAgent: 'test',
    };
    const ctx = createExecutionContext();
    const result = await handleBeerList(
      new Request('https://api.ufobeer.test/beers?sid=abc'), testEnv, ctx, {}, reqCtx, 'abc'
    );
    await waitOnExecutionContext(ctx);
    const upstreamCalls = vi.mocked(globalThis.fetch).mock.calls.length;
    vi.restoreAllMocks();

    expect({ status: result.response.status, body: await result.response.json(), upstreamCalls }).toEqual({
      status: 400,
      body: { error: 'Invalid store ID format', code: 'INVALID_STORE_ID', requestId: 'request-41' },
      upstreamCalls: 0,
    });
  });
});
