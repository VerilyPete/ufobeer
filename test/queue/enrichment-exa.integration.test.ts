/**
 * Exa Untappd fallback in the enrichment consumer, against real D1.
 *
 * Perplexity and Exa are both reached through a stubbed fetch, so the real
 * clients, guarded writes, quota table and NULL/'' brewer semantics run.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleEnrichmentBatch } from '../../src/queue/enrichment';
import { getToday } from '../../src/utils/date';
import type { EnrichmentMessage, Env } from '../../src/types';
import anniversary from '../fixtures/exa/18th-anniversary.json';
import pecanPorter from '../fixtures/exa/512-wba-pecan-porter.json';

const BEER = { id: '22212289', name: '(512) 18th Anniversary', brewer: '(512) Brewing Co.', hash: 'hash-anniversary' } as const;

type Reply = () => Response | Promise<Response>;
type Upstreams = { readonly perplexity: Reply; readonly exa?: Reply };

const perplexitySays = (content: string): Reply => () =>
  Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
const exaReturns = (body: object): Reply => () => Response.json(body);

function stubUpstreams(upstreams: Upstreams) {
  const calls = { perplexity: 0, exa: 0 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://api.perplexity.ai/')) {
      calls.perplexity++;
      return upstreams.perplexity();
    }
    if (url === 'https://api.exa.ai/search') {
      calls.exa++;
      if (!upstreams.exa) throw new Error('Exa must not be called');
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

async function seedRow(overrides: { brewName?: string; brewer?: string | null; status?: string } = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, description_hash, enrichment_status, abv, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`
  ).bind(BEER.id, overrides.brewName ?? BEER.name, overrides.brewer === undefined ? BEER.brewer : overrides.brewer,
    BEER.hash, overrides.status ?? 'pending', Date.now()).run();
}

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

async function row() {
  return env.DB.prepare(
    'SELECT abv, confidence, enrichment_source, enrichment_status, brewer FROM enriched_beers WHERE id = ?'
  ).bind(BEER.id).first();
}

async function slotsUsedToday(): Promise<number> {
  const count = await env.DB.prepare('SELECT request_count FROM abv_fallback_limits WHERE date = ?')
    .bind(getToday()).first<number>('request_count');
  return count ?? 0;
}

const NOT_FOUND = { abv: null, enrichment_status: 'not_found' };

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

describe('Exa fallback after a Perplexity unknown', () => {
  it('writes the matched Untappd ABV with source exa and confidence 0.8', async () => {
    await seedRow();
    const calls = stubUpstreams({ perplexity: perplexitySays('unknown'), exa: exaReturns(anniversary) });
    const worker = workerEnv();

    const msg = await run(worker);

    expect(await row()).toMatchObject({ abv: 8, confidence: 0.8, enrichment_source: 'exa', enrichment_status: 'enriched' });
    expect(calls).toEqual({ perplexity: 1, exa: 1 });
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(await slotsUsedToday()).toBe(1);
    expect(vi.mocked(worker.ANALYTICS!.writeDataPoint)).toHaveBeenCalledWith(expect.objectContaining({
      indexes: ['enrichment:exa'],
      blobs: expect.arrayContaining(['success', 'exa']),
    }));
  });

  it('marks not_found when Exa finds no matching beer, and acknowledges', async () => {
    await seedRow({ brewName: '(512) Whiskey Barrel Aged Pecan Porter' });
    const calls = stubUpstreams({ perplexity: perplexitySays('unknown'), exa: exaReturns(pecanPorter) });
    const worker = workerEnv();

    const msg = await run(worker, message({ beerName: '(512) Whiskey Barrel Aged Pecan Porter' }));

    expect(await row()).toMatchObject(NOT_FOUND);
    expect(calls.exa).toBe(1);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(vi.mocked(worker.ANALYTICS!.writeDataPoint)).toHaveBeenCalledWith(expect.objectContaining({
      indexes: ['enrichment:exa'],
      blobs: expect.arrayContaining(['enrichment_fail', 'exa']),
    }));
  });
});

describe('when the fallback never runs', () => {
  it('keeps the Perplexity ABV and never calls Exa', async () => {
    await seedRow();
    const calls = stubUpstreams({ perplexity: perplexitySays('8.1') });
    await run(workerEnv());
    expect(await row()).toMatchObject({ abv: 8.1, enrichment_source: 'perplexity' });
    expect(calls.exa).toBe(0);
  });

  it('retries a Perplexity error without calling Exa', async () => {
    await seedRow();
    const calls = stubUpstreams({ perplexity: () => Response.json({}, { status: 500 }) });
    const msg = await run(workerEnv());
    expect(calls.exa).toBe(0);
    expect(msg.retry).toHaveBeenCalledOnce();
    expect(await row()).toMatchObject({ enrichment_status: 'pending' });
  });

  it.each<[string, Partial<Env>]>([
    ['no Exa key', { EXA_API_KEY: undefined }],
    ['the kill switch off', { ABV_FALLBACK_ENABLED: 'false' }],
    ['the kill switch unset', { ABV_FALLBACK_ENABLED: undefined }],
    ['the kill switch not exactly "true"', { ABV_FALLBACK_ENABLED: 'TRUE' }],
    ['a zero daily cap', { EXA_DAILY_LIMIT: '0' }],
  ])('takes the ordinary miss path with %s: not_found, acknowledged, no slot, no Exa call', async (_label, overrides) => {
    await seedRow();
    const calls = stubUpstreams({ perplexity: perplexitySays('unknown') });
    const msg = await run(workerEnv(overrides));
    expect(await row()).toMatchObject(NOT_FOUND);
    expect(calls.exa).toBe(0);
    expect(await slotsUsedToday()).toBe(0);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('takes the ordinary miss path once the daily cap is used up', async () => {
    await seedRow();
    await env.DB.prepare('INSERT INTO abv_fallback_limits (date, request_count, last_updated) VALUES (?, 50, 0)')
      .bind(getToday()).run();
    const calls = stubUpstreams({ perplexity: perplexitySays('unknown') });
    const msg = await run(workerEnv());
    expect(await row()).toMatchObject(NOT_FOUND);
    expect(calls.exa).toBe(0);
    expect(await slotsUsedToday()).toBe(50);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('does not call Exa when the slot reservation fails, and still records the miss', async () => {
    await seedRow();
    const calls = stubUpstreams({ perplexity: perplexitySays('unknown') });
    const realDb = env.DB;
    const db = {
      prepare: (sql: string) => realDb.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        throw new Error(`D1 unavailable for ${statements.length} statements`);
      },
    } as unknown as D1Database;
    const msg = await run(workerEnv({ DB: db }));
    expect(calls.exa).toBe(0);
    expect(await row()).toMatchObject(NOT_FOUND);
    expect(msg.ack).toHaveBeenCalledOnce();
  });
});

describe('Exa failures', () => {
  it.each<[string, Reply]>([
    ['a 429', () => Response.json({ error: 'slow down' }, { status: 429 })],
    ['a 500', () => Response.json({}, { status: 500 })],
    ['a 503', () => Response.json({}, { status: 503 })],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['an invalid body', () => new Response('<html>')],
    ['a wrongly shaped body', () => Response.json({ results: 'many' })],
  ])('mark not_found and acknowledge after %s, without a second Perplexity call', async (_label, exa) => {
    await seedRow();
    const calls = stubUpstreams({ perplexity: perplexitySays('unknown'), exa });
    const msg = await run(workerEnv());
    expect(await row()).toMatchObject(NOT_FOUND);
    expect(calls).toEqual({ perplexity: 1, exa: 1 });
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('retries the message when the not_found write itself fails', async () => {
    await seedRow();
    stubUpstreams({ perplexity: perplexitySays('unknown'), exa: () => Response.json({}, { status: 500 }) });
    const realDb = env.DB;
    const db = {
      prepare: (sql: string) => sql.includes("'not_found'")
        ? { bind: () => ({ run: () => Promise.reject(new Error('D1 write failed')) }) }
        : realDb.prepare(sql),
      batch: (statements: D1PreparedStatement[]) => realDb.batch(statements),
    } as unknown as D1Database;
    const msg = await run(workerEnv({ DB: db }));
    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });
});

describe('stale messages', () => {
  const changeWhileExaRuns = (sql: string, args: readonly unknown[], reply: Reply): Reply => async () => {
    await env.DB.prepare(sql).bind(...args).run();
    return reply();
  };

  it.each<[string, Reply]>([
    ['a find', exaReturns(anniversary)],
    ['a miss', exaReturns(pecanPorter)],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ])('discard %s when the brewer changes while Exa runs, leaving the row pending', async (_label, reply) => {
    await seedRow();
    const exa = changeWhileExaRuns('UPDATE enriched_beers SET brewer = ? WHERE id = ?', ['Brooklyn Brewery', BEER.id], reply);
    stubUpstreams({ perplexity: perplexitySays('unknown'), exa });
    const msg = await run(workerEnv());
    expect(await row()).toMatchObject({ abv: null, enrichment_status: 'pending', brewer: 'Brooklyn Brewery' });
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it.each<[string, Reply]>([
    ['a find', exaReturns(anniversary)],
    ['a miss', exaReturns(pecanPorter)],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ])('discard %s when only the name changes while Exa runs', async (_label, reply) => {
    await seedRow();
    const exa = changeWhileExaRuns('UPDATE enriched_beers SET brew_name = ? WHERE id = ?', ['(512) 19th Anniversary', BEER.id], reply);
    stubUpstreams({ perplexity: perplexitySays('unknown'), exa });
    await run(workerEnv());
    expect(await row()).toMatchObject({ abv: null, enrichment_status: 'pending' });
  });

  it.each<[string, string, readonly unknown[]]>([
    ['the brewer changed', 'UPDATE enriched_beers SET brewer = ? WHERE id = ?', ['Brooklyn Brewery', BEER.id]],
    ['the name changed', 'UPDATE enriched_beers SET brew_name = ? WHERE id = ?', ['(512) 19th Anniversary', BEER.id]],
    ['cleanup wrote an ABV', "UPDATE enriched_beers SET abv = 7.9, enrichment_status = 'enriched', enrichment_source = 'description' WHERE id = ?", [BEER.id]],
    ['the description changed', 'UPDATE enriched_beers SET description_hash = ? WHERE id = ?', ['hash-new', BEER.id]],
    ['the row was deleted', 'DELETE FROM enriched_beers WHERE id = ?', [BEER.id]],
  ])('skip Exa, reserve no slot and acknowledge when %s during the Perplexity call', async (_label, sql, args) => {
    await seedRow();
    const before = await row();
    const calls = stubUpstreams({
      perplexity: async () => {
        await env.DB.prepare(sql).bind(...args).run();
        return perplexitySays('unknown')();
      },
    });
    const msg = await run(workerEnv());
    expect(calls.exa).toBe(0);
    expect(await slotsUsedToday()).toBe(0);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(await row()).not.toMatchObject(NOT_FOUND);
    expect(before).toMatchObject({ enrichment_status: 'pending' });
  });
});

describe('after a stale message', () => {
  it('a message carrying the corrected identity is processed to completion', async () => {
    await seedRow();
    stubUpstreams({
      perplexity: perplexitySays('unknown'),
      exa: async () => {
        await env.DB.prepare('UPDATE enriched_beers SET brewer = ? WHERE id = ?').bind('(512) Brewing Company', BEER.id).run();
        return Response.json(anniversary);
      },
    });
    await run(workerEnv());
    expect(await row()).toMatchObject({ abv: null, enrichment_status: 'pending' });

    vi.restoreAllMocks();
    stubUpstreams({ perplexity: perplexitySays('unknown'), exa: exaReturns(anniversary) });
    const followUp = await run(workerEnv(), message({ brewer: '(512) Brewing Company' }));

    expect(await row()).toMatchObject({ abv: 8, enrichment_source: 'exa', enrichment_status: 'enriched' });
    expect(followUp.ack).toHaveBeenCalledOnce();
  });
});

describe('daily cap across midnight', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('charges the UTC day on which the Exa slot is reserved, not the day the batch started', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T23:59:59Z'));
    await seedRow();
    await env.DB.prepare('INSERT INTO abv_fallback_limits (date, request_count, last_updated) VALUES (?, 50, 0)')
      .bind('2026-11-10').run();
    const calls = stubUpstreams({
      perplexity: () => {
        vi.setSystemTime(new Date('2026-11-11T00:00:01Z'));
        return perplexitySays('unknown')();
      },
      exa: exaReturns(anniversary),
    });

    await run(workerEnv());

    expect(calls.exa).toBe(1);
    expect(await env.DB.prepare('SELECT date, request_count FROM abv_fallback_limits ORDER BY date').all())
      .toMatchObject({ results: [{ date: '2026-11-10', request_count: 50 }, { date: '2026-11-11', request_count: 1 }] });
  });
});

describe('NULL versus blank brewer (real D1)', () => {
  it("treats a stored NULL brewer and a message brewer of '' as the same beer", async () => {
    await seedRow({ brewName: 'Mystery Pils', brewer: null });
    const calls = stubUpstreams({ perplexity: perplexitySays('unknown'), exa: exaReturns({ results: [] }) });
    const msg = await run(workerEnv(), message({ beerName: 'Mystery Pils', brewer: '' }));
    expect(calls.exa).toBe(1);
    expect(await row()).toMatchObject(NOT_FOUND);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('still rejects the write when a real brewer appears while Exa runs', async () => {
    await seedRow({ brewName: 'Mystery Pils', brewer: null });
    stubUpstreams({
      perplexity: perplexitySays('unknown'),
      exa: async () => {
        await env.DB.prepare('UPDATE enriched_beers SET brewer = ? WHERE id = ?').bind('Live Oak Brewing', BEER.id).run();
        return Response.json({ results: [] });
      },
    });
    await run(workerEnv(), message({ beerName: 'Mystery Pils', brewer: '' }));
    expect(await row()).toMatchObject({ enrichment_status: 'pending', brewer: 'Live Oak Brewing' });
  });
});
