/**
 * Enrichment consumer: daily quota reservation and the Perplexity result
 * write, against real D1. Perplexity is reached through a stubbed fetch, so
 * the real client, quota table and guarded write run.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleEnrichmentBatch } from '../../src/queue/enrichment';
import type { EnrichmentMessage, Env } from '../../src/types';

const NOW = new Date('2026-11-17T15:42:07Z');
const TODAY = '2026-11-17';
const DAILY_LIMIT = 37;
const SEEDED_UPDATED_AT = 1_731_000_000_123;
const BEER = { id: 'beer-41', name: 'Hill Country Pils', brewer: 'Valley Brewing', hash: 'hash-pils' } as const;

type PerplexityReply = () => Response | Promise<Response>;

const perplexitySays = (content: string): PerplexityReply => () =>
  Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });

function stubPerplexity(reply: PerplexityReply) {
  const calls = { perplexity: 0 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://api.perplexity.ai/')) throw new Error(`Unexpected outbound request: ${url}`);
    calls.perplexity++;
    return reply();
  });
  return calls;
}

function workerEnv(): Env {
  return {
    ...env,
    PERPLEXITY_API_KEY: 'test-perplexity-key',
    EXA_API_KEY: undefined,
    ABV_FALLBACK_ENABLED: 'false',
    ENRICHMENT_ENABLED: 'true',
    DAILY_ENRICHMENT_LIMIT: String(DAILY_LIMIT),
    MONTHLY_ENRICHMENT_LIMIT: '900',
    ANALYTICS: { writeDataPoint: vi.fn() },
  } as Env;
}

async function seedPendingBeer(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, description_hash, enrichment_status, abv, updated_at)
     VALUES (?, ?, ?, ?, 'pending', NULL, ?)`
  ).bind(BEER.id, BEER.name, BEER.brewer, BEER.hash, SEEDED_UPDATED_AT).run();
}

async function seedUsedToday(count: number): Promise<void> {
  await env.DB.prepare('INSERT INTO enrichment_limits (date, request_count, last_updated) VALUES (?, ?, 0)')
    .bind(TODAY, count).run();
}

async function run() {
  const message = {
    body: { beerId: BEER.id, beerName: BEER.name, brewer: BEER.brewer, descriptionHash: BEER.hash },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  await handleEnrichmentBatch({ messages: [message] } as unknown as MessageBatch<EnrichmentMessage>, workerEnv());
  return message;
}

async function storedBeer() {
  return env.DB.prepare(
    'SELECT abv, confidence, enrichment_source, enrichment_status, description_hash, updated_at FROM enriched_beers WHERE id = ?'
  ).bind(BEER.id).first();
}

async function quotaCounters() {
  const { results } = await env.DB.prepare('SELECT date, request_count FROM enrichment_limits ORDER BY date').all();
  return results;
}

const UNTOUCHED = {
  abv: null,
  confidence: 0.5,
  enrichment_source: null,
  enrichment_status: 'pending',
  description_hash: BEER.hash,
  updated_at: SEEDED_UPDATED_AT,
};

describe('enrichment consumer quota and Perplexity write (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    for (const table of ['enriched_beers', 'enrichment_limits', 'abv_fallback_limits']) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedPendingBeer();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('acknowledges without calling Perplexity once the daily quota is used up', async () => {
    await seedUsedToday(DAILY_LIMIT);
    const calls = stubPerplexity(perplexitySays('6.7'));

    const message = await run();

    expect(calls).toEqual({ perplexity: 0 });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await quotaCounters()).toEqual([{ date: TODAY, request_count: DAILY_LIMIT }]);
    expect(await storedBeer()).toEqual(UNTOUCHED);
  });

  it("spends the day's last slot on Perplexity and stores its ABV", async () => {
    await seedUsedToday(DAILY_LIMIT - 1);
    const calls = stubPerplexity(perplexitySays('6.7'));

    const message = await run();

    expect(calls).toEqual({ perplexity: 1 });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await quotaCounters()).toEqual([{ date: TODAY, request_count: DAILY_LIMIT }]);
    expect(await storedBeer()).toEqual({
      abv: 6.7,
      confidence: 0.7,
      enrichment_source: 'perplexity',
      enrichment_status: 'enriched',
      description_hash: BEER.hash,
      updated_at: NOW.getTime(),
    });
  });

  it('discards the ABV and warns when the description changes during the Perplexity call', async () => {
    await seedUsedToday(5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    stubPerplexity(async () => {
      await env.DB.prepare('UPDATE enriched_beers SET description_hash = ? WHERE id = ?').bind('hash-rewritten', BEER.id).run();
      return perplexitySays('6.7')();
    });

    const message = await run();

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await quotaCounters()).toEqual([{ date: TODAY, request_count: 6 }]);
    expect(await storedBeer()).toEqual({ ...UNTOUCHED, description_hash: 'hash-rewritten' });
    const warnings = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(warnings.map(({ event, beerId }) => ({ event, beerId }))).toEqual([
      { event: 'enrichment.stale_result', beerId: BEER.id },
    ]);
    expect(log.mock.calls.flat().filter(line => String(line).startsWith('Enriched'))).toEqual([]);
  });
});
