/**
 * Enrichment consumer preflight and verified-row protection, against real D1.
 *
 * A hand-verified row's abv, confidence, enrichment_source and
 * enrichment_status change only through a human, and a message that no
 * longer describes its row spends no quota and calls no provider.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleEnrichmentBatch } from '../../src/queue/enrichment';
import type { EnrichmentMessage, Env } from '../../src/types';
import anniversary from '../fixtures/exa/18th-anniversary.json';

const BEER = { id: '22212289', name: '(512) 18th Anniversary', brewer: '(512) Brewing Co.', hash: 'hash-anniversary' } as const;

type Hook = () => Promise<void>;
type Reply = () => Response | Promise<Response>;
type Upstreams = { readonly perplexity: Reply; readonly exa?: Reply; readonly beforePerplexityReply?: Hook; readonly beforeExaReply?: Hook };

const perplexitySays = (content: string): Reply => () =>
  Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });

function stubUpstreams(upstreams: Upstreams) {
  const calls = { perplexity: 0, exa: 0 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://api.perplexity.ai/')) {
      calls.perplexity++;
      await upstreams.beforePerplexityReply?.();
      return upstreams.perplexity();
    }
    if (url === 'https://api.exa.ai/search') {
      calls.exa++;
      if (!upstreams.exa) throw new Error('Exa must not be called');
      await upstreams.beforeExaReply?.();
      return upstreams.exa();
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  return calls;
}

function workerEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    PERPLEXITY_API_KEY: 'test-perplexity-key',
    EXA_API_KEY: 'test-exa-key',
    ABV_FALLBACK_ENABLED: 'true',
    EXA_DAILY_LIMIT: '50',
    ENRICHMENT_ENABLED: 'true',
    DAILY_ENRICHMENT_LIMIT: '500',
    MONTHLY_ENRICHMENT_LIMIT: '2000',
    ANALYTICS: { writeDataPoint: vi.fn() },
    ...overrides,
  } as Env;
}

type Seed = { readonly isVerified?: number | null; readonly abv?: number | null; readonly status?: string };

async function seedRow(seed: Seed = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, description_hash, enrichment_status, abv, is_verified, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).bind(BEER.id, BEER.name, BEER.brewer, BEER.hash, seed.status ?? 'pending', seed.abv ?? null,
    seed.isVerified === undefined ? 0 : seed.isVerified, Date.now()).run();
}

const verifyRow: Hook = async () => {
  await env.DB.prepare('UPDATE enriched_beers SET is_verified = 1 WHERE id = ?').bind(BEER.id).run();
};

function message(body: Partial<EnrichmentMessage> = {}) {
  return {
    body: { beerId: BEER.id, beerName: BEER.name, brewer: BEER.brewer, descriptionHash: BEER.hash, ...body },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function run(worker: Env, msg = message()) {
  await handleEnrichmentBatch({ messages: [msg] } as unknown as MessageBatch<EnrichmentMessage>, worker);
  return msg;
}

async function protectedFields() {
  return env.DB.prepare(
    'SELECT abv, confidence, enrichment_source, enrichment_status FROM enriched_beers WHERE id = ?'
  ).bind(BEER.id).first();
}

async function reservations() {
  const perplexity = await env.DB.prepare('SELECT COALESCE(SUM(request_count), 0) AS n FROM enrichment_limits').first<number>('n');
  const exa = await env.DB.prepare('SELECT COALESCE(SUM(request_count), 0) AS n FROM abv_fallback_limits').first<number>('n');
  return { perplexity, exa };
}

const UNTOUCHED_PENDING = { abv: null, confidence: 0.5, enrichment_source: null, enrichment_status: 'pending' };
const NOTHING_SPENT = { perplexity: 0, exa: 0 };

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
  for (const table of ['enriched_beers', 'abv_fallback_limits', 'enrichment_limits']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enrichment preflight', () => {
  it('reserves no quota and calls no provider for a row verified before dequeue', async () => {
    await seedRow({ isVerified: 1 });
    const calls = stubUpstreams({ perplexity: perplexitySays('5.5') });

    const msg = await run(workerEnv());

    expect(calls).toEqual(NOTHING_SPENT);
    expect(await reservations()).toEqual(NOTHING_SPENT);
    expect(await protectedFields()).toEqual(UNTOUCHED_PENDING);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('reserves no quota and calls no provider for a missing row', async () => {
    const calls = stubUpstreams({ perplexity: perplexitySays('5.5') });

    const msg = await run(workerEnv());

    expect(calls).toEqual(NOTHING_SPENT);
    expect(await reservations()).toEqual(NOTHING_SPENT);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM enriched_beers').first('n')).toBe(0);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it.each([
    ['description hash', { descriptionHash: 'hash-older' }],
    ['null description hash', { descriptionHash: null }],
    ['beer name', { beerName: '(512) 17th Anniversary' }],
    ['brewer', { brewer: 'Other Brewing' }],
  ])('reserves no quota and calls no provider when the message %s no longer matches the row', async (_label, body) => {
    await seedRow();
    const calls = stubUpstreams({ perplexity: perplexitySays('5.5') });

    const msg = await run(workerEnv(), message(body));

    expect(calls).toEqual(NOTHING_SPENT);
    expect(await reservations()).toEqual(NOTHING_SPENT);
    expect(await protectedFields()).toEqual(UNTOUCHED_PENDING);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it.each([[0], [null]])('treats is_verified %s as unverified and enriches the row', async (isVerified) => {
    await seedRow({ isVerified });
    const calls = stubUpstreams({ perplexity: perplexitySays('5.5') });

    await run(workerEnv());

    expect(calls.perplexity).toBe(1);
    expect(await protectedFields()).toEqual({ abv: 5.5, confidence: 0.7, enrichment_source: 'perplexity', enrichment_status: 'enriched' });
  });
});

describe('verification landing while a lookup runs', () => {
  it('refuses the Perplexity result for a row verified during the call', async () => {
    await seedRow();
    stubUpstreams({ perplexity: perplexitySays('5.5'), beforePerplexityReply: verifyRow });

    await run(workerEnv());

    expect(await protectedFields()).toEqual(UNTOUCHED_PENDING);
  });

  it('skips Exa without reserving a slot and refuses not_found when the row is verified during a Perplexity unknown', async () => {
    await seedRow();
    const calls = stubUpstreams({ perplexity: perplexitySays('unknown'), exa: () => Response.json(anniversary), beforePerplexityReply: verifyRow });

    await run(workerEnv());

    expect(calls.exa).toBe(0);
    expect((await reservations()).exa).toBe(0);
    expect(await protectedFields()).toEqual(UNTOUCHED_PENDING);
  });

  it('refuses the Exa result for a row verified while Exa runs', async () => {
    await seedRow();
    const calls = stubUpstreams({ perplexity: perplexitySays('unknown'), exa: () => Response.json(anniversary), beforeExaReply: verifyRow });

    await run(workerEnv());

    expect(calls.exa).toBe(1);
    expect(await protectedFields()).toEqual(UNTOUCHED_PENDING);
  });

  it('refuses not_found for a row verified during an unknown with no fallback available', async () => {
    await seedRow();
    stubUpstreams({ perplexity: perplexitySays('unknown'), beforePerplexityReply: verifyRow });

    await run(workerEnv({ EXA_API_KEY: undefined }));

    expect(await protectedFields()).toEqual(UNTOUCHED_PENDING);
  });

  it('keeps a verified ABV of 0', async () => {
    await seedRow({ abv: 0 });
    stubUpstreams({ perplexity: perplexitySays('5.5'), beforePerplexityReply: verifyRow });

    await run(workerEnv());

    expect(await protectedFields()).toEqual({ ...UNTOUCHED_PENDING, abv: 0 });
  });
});

describe('identity changing while a lookup runs', () => {
  it('discards a Perplexity answer for a beer renamed during the call', async () => {
    await seedRow();
    stubUpstreams({
      perplexity: perplexitySays('5.5'),
      beforePerplexityReply: async () => {
        await env.DB.prepare('UPDATE enriched_beers SET brew_name = ? WHERE id = ?').bind('(512) 19th Anniversary', BEER.id).run();
      },
    });

    await run(workerEnv());

    expect(await protectedFields()).toEqual(UNTOUCHED_PENDING);
  });
});
