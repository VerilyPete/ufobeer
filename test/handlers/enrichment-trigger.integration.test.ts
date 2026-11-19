/**
 * POST /admin/enrich/trigger batch size against real D1: the number of beers
 * sent is the smallest of the requested limit, the daily and monthly quota
 * remaining, and 100.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleEnrichmentTrigger } from '../../src/handlers/enrichment';
import type { EnrichmentMessage, Env, RequestContext } from '../../src/types';

const NOW = new Date('2026-11-17T15:42:07Z');
const USED_TODAY = 12;
const USED_EARLIER_THIS_MONTH = 30;
const USED_THIS_MONTH = USED_TODAY + USED_EARLIER_THIS_MONTH;
const ELIGIBLE_BEERS = 120;

type SendBatch = (messages: readonly { readonly body: EnrichmentMessage }[]) => Promise<void>;

const context: RequestContext = {
  requestId: 'enrich-trigger-request',
  startTime: 0,
  clientIdentifier: 'admin',
  apiKeyHash: 'hash',
  clientIp: '127.0.0.1',
  userAgent: 'test',
};

async function seedPendingBeers(count: number): Promise<void> {
  const inserts = Array.from({ length: count }, (_, index) =>
    env.DB.prepare(
      "INSERT INTO enriched_beers (id, brew_name, brewer, description_hash, enrichment_status) VALUES (?, ?, 'Valley Brewing', ?, 'pending')"
    ).bind(`beer-${index}`, `Valley Lager ${index}`, `hash-${index}`)
  );
  for (let start = 0; start < inserts.length; start += 100) {
    await env.DB.batch(inserts.slice(start, start + 100));
  }
}

async function seedQuotaUsage(): Promise<void> {
  await env.DB.batch([
    ['2026-10-31', 977],
    ['2026-11-04', USED_EARLIER_THIS_MONTH],
    ['2026-11-17', USED_TODAY],
  ].map(([date, count]) =>
    env.DB.prepare('INSERT INTO enrichment_limits (date, request_count, last_updated) VALUES (?, ?, 0)').bind(date, count)
  ));
}

type Limits = { readonly daily: number; readonly monthly: number };

async function trigger(body: object, limits: Limits) {
  const sendBatch = vi.fn<SendBatch>(async () => undefined);
  const worker = {
    ...env,
    DAILY_ENRICHMENT_LIMIT: String(limits.daily),
    MONTHLY_ENRICHMENT_LIMIT: String(limits.monthly),
    ENRICHMENT_ENABLED: 'true',
    ENRICHMENT_QUEUE: { sendBatch },
  } as unknown as Env;
  const request = new Request('https://api.example.com/admin/enrich/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await handleEnrichmentTrigger(request, worker, {}, context);
  const sent = sendBatch.mock.calls.flatMap(([messages]) => messages);
  return { response, json: await response.json() as Record<string, unknown>, sent };
}

describe('enrichment trigger batch size (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enriched_beers').run();
    await env.DB.prepare('DELETE FROM enrichment_limits').run();
    await env.DB.prepare('DELETE FROM dlq_messages').run();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedPendingBeers(ELIGIBLE_BEERS);
    await seedQuotaUsage();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['the request limit', 7, 50, 60, 7],
    ['the daily quota remaining', 100, 3, 60, 3],
    ['the monthly quota remaining', 100, 50, 4, 4],
    ['the 100-message cap', 100, 150, 200, 100],
  ])('sends as many beers as %s allows', async (_cap, limit, dailyRemaining, monthlyRemaining, expectedSent) => {
    const limits = { daily: USED_TODAY + dailyRemaining, monthly: USED_THIS_MONTH + monthlyRemaining };

    const { json, sent } = await trigger({ limit }, limits);

    expect(sent).toHaveLength(expectedSent);
    expect(json['data']).toEqual({
      beers_queued: expectedSent,
      quota: {
        daily: { used: USED_TODAY, limit: limits.daily, remaining: dailyRemaining },
        monthly: { used: USED_THIS_MONTH, limit: limits.monthly, remaining: monthlyRemaining },
      },
      enabled: true,
      filters: { exclude_failures: false },
    });
  });

  it('rejects a request limit above 100 without sending anything', async () => {
    const { response, json, sent } = await trigger({ limit: 101 }, { daily: 500, monthly: 2000 });

    expect(response.status).toBe(400);
    expect(json).toEqual({ error: 'Invalid request body', requestId: 'enrich-trigger-request' });
    expect(sent).toEqual([]);
  });
});
