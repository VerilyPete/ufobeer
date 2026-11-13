/**
 * Consumer-side stale-result binding on the enrichment queue, against real
 * D1 built from the migration chain.
 *
 * A message carries the description hash, name and brewer it was built
 * from; the consumer writes only while the row is still pending, unverified
 * and matches all three. `IS` (not `=`) lets a null message hash -- a beer
 * with no description -- match a genuinely null stored column.
 *
 * @module test/queue/enrichment-stale-binding.integration.test
 */

import { applyD1Migrations, env as testEnv } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEnrichmentBatch } from '../../src/queue/enrichment';
import { queueBeersForEnrichment } from '../../src/queue/helpers';
import type { Env, EnrichmentMessage } from '../../src/types';

vi.mock('../../src/services/perplexity', () => ({
  fetchAbvFromPerplexity: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/analytics', () => ({
  trackEnrichment: vi.fn(),
}));

import { fetchAbvFromPerplexity } from '../../src/services/perplexity';

const BEER_NAME = 'Test IPA';
const BREWER = 'Test Brewery';

type SeedRow = {
  readonly id: string;
  readonly status: string;
  readonly hash: string | null;
  readonly abv?: number | null;
};

async function seed(row: SeedRow): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, description_hash, enrichment_status, abv, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).bind(row.id, BEER_NAME, BREWER, row.hash, row.status, row.abv ?? null, Date.now()).run();
}

async function stored(id: string) {
  return testEnv.DB.prepare('SELECT enrichment_status, abv FROM enriched_beers WHERE id = ?')
    .bind(id).first<{ enrichment_status: string | null; abv: number | null }>();
}

function createMessage(body: EnrichmentMessage): Message<EnrichmentMessage> {
  return {
    id: `msg-${body.beerId}`,
    timestamp: new Date(),
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<EnrichmentMessage>;
}

function messageFor(beerId: string, descriptionHash: string | null): Message<EnrichmentMessage> {
  return createMessage({ beerId, beerName: BEER_NAME, brewer: BREWER, descriptionHash });
}

function createBatch(messages: Message<EnrichmentMessage>[]): MessageBatch<EnrichmentMessage> {
  return {
    messages,
    queue: 'beer-enrichment',
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<EnrichmentMessage>;
}

function createEnv(): Env {
  return {
    ...testEnv,
    ANALYTICS: { writeDataPoint: vi.fn() },
    ENRICHMENT_ENABLED: 'true',
    DAILY_ENRICHMENT_LIMIT: '500',
    MONTHLY_ENRICHMENT_LIMIT: '2000',
    PERPLEXITY_API_KEY: 'test-key',
  } as unknown as Env;
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.REAL_MIGRATIONS);
  for (const table of ['enriched_beers', 'enrichment_limits', 'abv_fallback_limits']) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
  vi.clearAllMocks();
  vi.mocked(fetchAbvFromPerplexity).mockReset().mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('consumer-side stale-result binding (enrichment queue)', () => {
  it.each([[6.5], [null]])('acks without a lookup or write when the message hash no longer matches the row (Perplexity would say %s)', async (abv) => {
    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(abv);
    await seed({ id: 'beer-1', status: 'pending', hash: 'hash-CURRENT' });
    const message = messageFor('beer-1', 'hash-STALE');

    await handleEnrichmentBatch(createBatch([message]), createEnv());

    expect(await stored('beer-1')).toEqual({ enrichment_status: 'pending', abv: null });
    expect(fetchAbvFromPerplexity).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('writes exactly once (idempotently) across a duplicate delivery of the same message', async () => {
    await seed({ id: 'beer-3', status: 'pending', hash: 'hash-match' });
    const worker = createEnv();

    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(5.5);
    const first = messageFor('beer-3', 'hash-match');
    await handleEnrichmentBatch(createBatch([first]), worker);
    expect(await stored('beer-3')).toEqual({ enrichment_status: 'enriched', abv: 5.5 });
    expect(first.ack).toHaveBeenCalledOnce();

    vi.mocked(fetchAbvFromPerplexity).mockClear();
    const duplicate = messageFor('beer-3', 'hash-match');
    await handleEnrichmentBatch(createBatch([duplicate]), worker);

    expect(await stored('beer-3')).toEqual({ enrichment_status: 'enriched', abv: 5.5 });
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(fetchAbvFromPerplexity).not.toHaveBeenCalled();
  });

  it('a null message descriptionHash matches a genuinely null stored column (beer with no description)', async () => {
    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(5.0);
    await seed({ id: 'beer-4', status: 'pending', hash: null });
    const message = messageFor('beer-4', null);

    await handleEnrichmentBatch(createBatch([message]), createEnv());

    expect(await stored('beer-4')).toEqual({ enrichment_status: 'enriched', abv: 5.0 });
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it.each(['enriched', 'not_found', 'skipped', 'failed'])('skips a %s row whose hash still matches, without a lookup', async (status) => {
    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(6.0);
    await seed({ id: 'beer-5', status, hash: 'hash-match', abv: 4.2 });
    const message = messageFor('beer-5', 'hash-match');

    await handleEnrichmentBatch(createBatch([message]), createEnv());

    expect(await stored('beer-5')).toEqual({ enrichment_status: status, abv: 4.2 });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(fetchAbvFromPerplexity).not.toHaveBeenCalled();
  });
});

describe('producer -> consumer seam (queueBeersForEnrichment -> handleEnrichmentBatch)', () => {
  it('a message produced by queueBeersForEnrichment with a descriptionHash is written by the consumer when its hash matches the current row', async () => {
    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(5.5);
    await seed({ id: 'beer-6', status: 'pending', hash: 'hash-abc' });

    let capturedMessages: Array<{ body: EnrichmentMessage }> = [];
    const producerEnv = {
      ENRICHMENT_QUEUE: {
        sendBatch: vi.fn().mockImplementation((messages: Array<{ body: EnrichmentMessage }>) => {
          capturedMessages = messages;
          return Promise.resolve(undefined);
        }),
      },
    } as unknown as Env;

    const queueResult = await queueBeersForEnrichment(
      producerEnv,
      [{ id: 'beer-6', brew_name: BEER_NAME, brewer: BREWER, descriptionHash: 'hash-abc' }],
      'req-seam'
    );

    expect(queueResult.queued).toBe(1);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0]!.body.descriptionHash).toBe('hash-abc');

    const deliveredMessage = createMessage(capturedMessages[0]!.body);
    await handleEnrichmentBatch(createBatch([deliveredMessage]), createEnv());

    expect(await stored('beer-6')).toEqual({ enrichment_status: 'enriched', abv: 5.5 });
    expect(deliveredMessage.ack).toHaveBeenCalledOnce();
  });

  it('a beer queued with a null descriptionHash produces a message with an explicit null (not an omitted key)', async () => {
    // EnrichmentMessage.descriptionHash is required-but-nullable: the
    // producer self-computes with `?? null`, the same shape
    // queueBeersForCleanup uses, rather than conditionally omitting the
    // key under exactOptionalPropertyTypes.
    let capturedMessages: Array<{ body: EnrichmentMessage }> = [];
    const producerEnv = {
      ENRICHMENT_QUEUE: {
        sendBatch: vi.fn().mockImplementation((messages: Array<{ body: EnrichmentMessage }>) => {
          capturedMessages = messages;
          return Promise.resolve(undefined);
        }),
      },
    } as unknown as Env;

    await queueBeersForEnrichment(
      producerEnv,
      [{ id: 'beer-7', brew_name: 'No Description Beer', brewer: 'Test Brewery', descriptionHash: null }],
      'req-seam-2'
    );

    expect(capturedMessages).toHaveLength(1);
    expect('descriptionHash' in capturedMessages[0]!.body).toBe(true);
    expect(capturedMessages[0]!.body.descriptionHash).toBeNull();
  });
});

describe('queueBeersForEnrichment blocklist', () => {
  it('does not queue a beer whose brewer marks it as a mixed pour', async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const producerEnv = { ENRICHMENT_QUEUE: { sendBatch } } as unknown as Env;

    const result = await queueBeersForEnrichment(
      producerEnv,
      [{ id: 'beer-8', brew_name: 'Black Velvet Pour', brewer: 'Various', descriptionHash: null }],
      'req-blocklist'
    );

    expect(result).toEqual({ queued: 0, skipped: 1 });
    expect(sendBatch).not.toHaveBeenCalled();
  });
});
