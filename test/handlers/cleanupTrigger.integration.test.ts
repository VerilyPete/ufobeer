import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCleanupTrigger } from '../../src/handlers/cleanupTrigger';
import { CLEANUP_VERSION } from '../../src/constants';
import { recordSeenBeers } from '../../src/db/seenBeers';
import { hashDescription } from '../../src/utils/hash';
import type { CleanupMessage, Env, RequestContext } from '../../src/types';

type SeededBeer = {
  readonly id: string;
  readonly cleanupVersion: number | null;
};

async function seedBeer({ id, cleanupVersion }: SeededBeer): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, brew_description_cleaned, cleanup_source, cleanup_version)
    VALUES (?, 'Valley Lager', 'Valley Brewing', 'A crisp lager', ?, ?, ?)
  `).bind(id, `Served text for ${id}`, cleanupVersion === null ? 'workers-ai' : 'deterministic', cleanupVersion).run();
}

const context: RequestContext = {
  requestId: 'request-1',
  startTime: 0,
  clientIdentifier: 'admin',
  apiKeyHash: 'hash',
  clientIp: '127.0.0.1',
  userAgent: 'test',
};

type SendBatch = (messages: readonly { readonly body: CleanupMessage }[]) => Promise<void>;

const sendsEverything = (): SendBatch => async () => undefined;

async function trigger(body: object, send: SendBatch = sendsEverything()) {
  const sendBatch = vi.fn<SendBatch>(send);
  const worker = { ...env, CLEANUP_QUEUE: { sendBatch } } as unknown as Env;
  const request = new Request('https://api.example.com/admin/cleanup/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await handleCleanupTrigger(request, worker, {}, context);
  const queuedIds = sendBatch.mock.calls
    .flatMap(([messages]) => messages.map(({ body: message }) => message.beerId));
  const messages = sendBatch.mock.calls.flatMap(([batch]) => batch.map(({ body: message }) => message));
  return { response, json: await response.json() as Record<string, unknown>, queuedIds, messages };
}

async function servedText(id: string) {
  return env.DB.prepare('SELECT brew_description_cleaned FROM enriched_beers WHERE id = ?').bind(id).first();
}

describe("cleanup trigger mode 'all' (real D1)", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enriched_beers').run();
    await env.DB.prepare('DELETE FROM system_state').run();
  });

  it('re-cleans only descriptions from an older cleanup version', async () => {
    await seedBeer({ id: 'legacy', cleanupVersion: null });
    await seedBeer({ id: 'older', cleanupVersion: CLEANUP_VERSION - 1 });
    await seedBeer({ id: 'current', cleanupVersion: CLEANUP_VERSION });

    const { queuedIds, json } = await trigger({ mode: 'all', confirm: true });

    expect(queuedIds.sort()).toEqual(['legacy', 'older']);
    expect(json).toMatchObject({ data: { beers_queued: 2, beers_remaining: 0 } });
  });

  it('keeps serving the existing cleaned text until the re-clean rewrites it', async () => {
    await seedBeer({ id: 'legacy', cleanupVersion: null });

    await trigger({ mode: 'all', confirm: true });

    expect(await servedText('legacy')).toEqual({ brew_description_cleaned: 'Served text for legacy' });
  });

  it('skips current descriptions when the limit is smaller than the table', async () => {
    await seedBeer({ id: 'current', cleanupVersion: CLEANUP_VERSION });
    await seedBeer({ id: 'legacy', cleanupVersion: null });

    const { queuedIds } = await trigger({ mode: 'all', confirm: true, limit: 1 });

    expect(queuedIds).toEqual(['legacy']);
  });

  it('recovers a beer whose changed description was never re-cleaned', async () => {
    await env.DB.prepare(`
      INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash, brew_description_cleaned, cleanup_source, cleanup_version, queued_for_cleanup_at)
      VALUES ('changed', 'Valley Lager', 'Valley Brewing', 'A crisp lager', ?, 'A crisp lager.', 'deterministic', ?, 1)
    `).bind(await hashDescription('A crisp lager'), CLEANUP_VERSION).run();

    await recordSeenBeers(env.DB, [
      { id: 'changed', brew_name: 'Valley Lager', brewer: 'Valley Brewing', brew_description: 'A hazy lager' },
    ], { now: Date.now() });
    const { queuedIds } = await trigger({ mode: 'all', confirm: true });

    expect(queuedIds).toEqual(['changed']);
  });

  it('previews only the descriptions that would be re-cleaned', async () => {
    await seedBeer({ id: 'legacy', cleanupVersion: null });
    await seedBeer({ id: 'current', cleanupVersion: CLEANUP_VERSION });

    const { json } = await trigger({ mode: 'all' });

    expect(json).toMatchObject({ preview: { beers_would_reset: 1 } });
  });
});

const NOW = new Date('2026-11-17T15:42:07Z');

type NeverCleanedBeer = {
  readonly id: string;
  readonly brewName?: string;
  readonly brewer?: string | null;
  readonly description?: string;
  readonly cleaned?: string | null;
  readonly queuedAt?: number | null;
};

function neverCleanedInsert(beer: NeverCleanedBeer): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, brew_description_cleaned, queued_for_cleanup_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    beer.id,
    beer.brewName ?? 'Valley Lager',
    beer.brewer === undefined ? 'Valley Brewing' : beer.brewer,
    beer.description ?? `A crisp lager, batch ${beer.id}`,
    beer.cleaned ?? null,
    beer.queuedAt ?? null,
  );
}

async function seedNeverCleaned(beers: readonly NeverCleanedBeer[]): Promise<void> {
  for (let start = 0; start < beers.length; start += 100) {
    await env.DB.batch(beers.slice(start, start + 100).map(neverCleanedInsert));
  }
}

async function cleanupMarks(ids: readonly string[]) {
  const { results } = await env.DB.prepare(
    `SELECT id, description_hash, queued_for_cleanup_at FROM enriched_beers WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`
  ).bind(...ids).all();
  return results;
}

const operationId = `cleanup-trigger-${NOW.getTime()}`;

describe("cleanup trigger mode 'missing' (real D1)", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enriched_beers').run();
    await env.DB.prepare('DELETE FROM system_state').run();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends at most 500 beers however large the requested limit', async () => {
    await seedNeverCleaned(Array.from({ length: 501 }, (_, index) => ({ id: `beer-${String(index).padStart(3, '0')}` })));

    const { queuedIds, json } = await trigger({ mode: 'missing', limit: 1000 });

    expect(queuedIds).toHaveLength(500);
    expect(json['data']).toEqual({
      operation_id: operationId,
      beers_queued: 500,
      beers_remaining: 1,
      mode: 'missing',
      dry_run: false,
    });
  });

  it('queues every never-cleaned, unqueued beer, flights included, with the hash it stores', async () => {
    const earlierMark = 1_731_000_000_123;
    await seedNeverCleaned([
      { id: 'pilsner', brewName: 'Bright Pils', brewer: 'Hill Country Brewing', description: 'A bright pilsner' },
      { id: 'flight', brewName: 'Texas Flight', brewer: null, description: 'Four tasters of Texas lagers' },
      { id: 'cleaned', description: 'Already done', cleaned: 'Already done.' },
      { id: 'queued', description: 'Waiting in the queue', queuedAt: earlierMark },
      { id: 'blank', description: '' },
    ]);
    const pilsnerHash = await hashDescription('A bright pilsner');
    const flightHash = await hashDescription('Four tasters of Texas lagers');

    const { json, messages } = await trigger({ mode: 'missing' });

    expect([...messages].sort((a, b) => a.beerId.localeCompare(b.beerId))).toEqual([
      { beerId: 'flight', beerName: 'Texas Flight', brewer: '', brewDescription: 'Four tasters of Texas lagers', descriptionHash: flightHash },
      { beerId: 'pilsner', beerName: 'Bright Pils', brewer: 'Hill Country Brewing', brewDescription: 'A bright pilsner', descriptionHash: pilsnerHash },
    ]);
    expect(json['data']).toEqual({
      operation_id: operationId,
      beers_queued: 2,
      beers_remaining: 0,
      mode: 'missing',
      dry_run: false,
    });
    expect(await cleanupMarks(['flight', 'pilsner', 'queued'])).toEqual([
      { id: 'flight', description_hash: flightHash, queued_for_cleanup_at: NOW.getTime() },
      { id: 'pilsner', description_hash: pilsnerHash, queued_for_cleanup_at: NOW.getTime() },
      { id: 'queued', description_hash: null, queued_for_cleanup_at: earlierMark },
    ]);
  });

  it('reports no eligible beers, sending nothing, when every description is cleaned or already queued', async () => {
    await seedNeverCleaned([
      { id: 'cleaned', cleaned: 'Already done.' },
      { id: 'queued', queuedAt: 1_731_000_000_123 },
    ]);

    const { json, messages } = await trigger({ mode: 'missing' });

    expect(messages).toEqual([]);
    expect(json['data']).toEqual({
      operation_id: operationId,
      beers_queued: 0,
      beers_remaining: 0,
      mode: 'missing',
      dry_run: false,
      skip_reason: 'no_eligible_beers',
    });
  });

  it.each([
    ['missing', {}],
    ['all', { beers_reset: 1 }],
  ] as const)("reports what a dry run in mode '%s' would queue, without sending or marking", async (mode, reset) => {
    await seedNeverCleaned([{ id: 'first' }, { id: 'second' }]);

    const { json, messages } = await trigger({ mode, limit: 1, dry_run: true });

    expect(messages).toEqual([]);
    expect(json['data']).toEqual({
      operation_id: operationId,
      beers_queued: 1,
      ...reset,
      beers_remaining: 1,
      mode,
      dry_run: true,
    });
    expect(await cleanupMarks(['first', 'second'])).toEqual([
      { id: 'first', description_hash: null, queued_for_cleanup_at: null },
      { id: 'second', description_hash: null, queued_for_cleanup_at: null },
    ]);
  });

  it('leaves a beer unmarked when its send fails, so the next run finds it again', async () => {
    await seedNeverCleaned([{ id: 'pilsner', description: 'A bright pilsner' }]);

    const { json } = await trigger({ mode: 'missing' }, async () => {
      throw new Error('queue unavailable');
    });

    expect(json['data']).toEqual({
      operation_id: operationId,
      beers_queued: 0,
      beers_remaining: 0,
      mode: 'missing',
      dry_run: false,
    });
    expect(await cleanupMarks(['pilsner'])).toEqual([
      { id: 'pilsner', description_hash: await hashDescription('A bright pilsner'), queued_for_cleanup_at: null },
    ]);
  });
});
