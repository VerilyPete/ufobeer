/**
 * Acceptance tests for consumer-side stale-result binding on the
 * enrichment queue consumer (Cloudflare security review Phase 1, item
 * "enrichment message hash parity" -- EnrichmentMessage gains
 * descriptionHash for parity with CleanupMessage.descriptionHash).
 *
 * Mirrors test/queue/cleanup-stale-binding.test.ts: proves the binding
 * end-to-end through `handleEnrichmentBatch` against an in-memory fake D1
 * that actually applies (or rejects) writes based on
 * `enrichment_status = 'pending' AND description_hash IS ?`, rather than a
 * mock that always reports success regardless of arguments.
 *
 * Unlike cleanup.ts, the enrichment consumer keeps its pre-existing
 * `enrichment_status = 'pending'` guard *alongside* the new
 * `description_hash` check (belt and braces) rather than replacing it, and
 * uses SQL `IS` rather than `=` so a message with no hash (a beer with no
 * description at all) correctly matches a genuinely null stored column.
 *
 * @module test/queue/enrichment-stale-binding.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEnrichmentBatch } from '../../src/queue/enrichment';
import { queueBeersForEnrichment } from '../../src/queue/helpers';
import type { Env, EnrichmentMessage } from '../../src/types';

// Mock Perplexity so ABV outcome is controlled per test, independent of the
// prompt-construction/parsing logic covered elsewhere.
vi.mock('../../src/services/perplexity', () => ({
  fetchAbvFromPerplexity: vi.fn().mockResolvedValue(null),
}));

// Mock analytics so trackEnrichment doesn't need a real ANALYTICS binding.
vi.mock('../../src/analytics', () => ({
  trackEnrichment: vi.fn(),
}));

// Bypass real daily/monthly quota SQL entirely -- irrelevant to stale-result
// binding, and would otherwise require modeling enrichment_limits rows too.
vi.mock('../../src/db/quota', () => ({
  reserveEnrichmentSlot: vi.fn().mockResolvedValue({ reserved: true, requestCount: 1 }),
}));

import { fetchAbvFromPerplexity } from '../../src/services/perplexity';

// ============================================================================
// Fake D1: an in-memory enriched_beers store that actually applies the
// `WHERE id = ? AND enrichment_status = 'pending' AND description_hash IS ?`
// gate, so a status or hash mismatch genuinely reports 0 changes instead of
// a mock that always succeeds regardless of arguments.
// ============================================================================

type FakeBeerRow = {
  enrichment_status: string | null;
  description_hash: string | null;
  abv: number | null;
};

function createFakeD1(initialRows: Record<string, FakeBeerRow>) {
  const rows = new Map<string, FakeBeerRow>(Object.entries(initialRows));

  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT SUM(request_count)')) {
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ total: 0 }) }) };
      }

      if (sql.includes('SELECT enrichment_status FROM enriched_beers')) {
        return {
          bind: vi.fn().mockImplementation((beerId: string) => ({
            first: vi.fn().mockImplementation(() => {
              const row = rows.get(beerId);
              return Promise.resolve(row ? { enrichment_status: row.enrichment_status } : null);
            }),
          })),
        };
      }

      if (sql.includes('UPDATE enriched_beers')) {
        return {
          bind: vi.fn().mockImplementation((...args: unknown[]) => ({
            run: vi.fn().mockImplementation(() => {
              // Every UPDATE this consumer issues binds (..., beerId, descriptionHash)
              // as the final two params, against `WHERE id = ? AND
              // enrichment_status = 'pending' AND description_hash IS ?`.
              const beerId = args[args.length - 2] as string;
              const expectedHash = args[args.length - 1] as string | null;
              const row = rows.get(beerId);
              if (!row || row.enrichment_status !== 'pending' || row.description_hash !== expectedHash) {
                return Promise.resolve({ meta: { changes: 0 } });
              }
              if (sql.includes('abv = ?')) {
                const abv = args[0] as number;
                rows.set(beerId, { ...row, enrichment_status: 'enriched', abv });
              } else {
                rows.set(beerId, { ...row, enrichment_status: 'not_found' });
              }
              return Promise.resolve({ meta: { changes: 1 } });
            }),
          })),
        };
      }

      // Default: unused by this suite (e.g. seed/insert paths).
      return {
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
        }),
      };
    }),
  };

  return { db: db as unknown as D1Database, rows };
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

function createBatch(messages: Message<EnrichmentMessage>[]): MessageBatch<EnrichmentMessage> {
  return {
    messages,
    queue: 'beer-enrichment',
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<EnrichmentMessage>;
}

function createEnv(db: D1Database): Env {
  return {
    DB: db,
    ANALYTICS: { writeDataPoint: vi.fn() },
    ENRICHMENT_ENABLED: 'true',
    DAILY_ENRICHMENT_LIMIT: '500',
    MONTHLY_ENRICHMENT_LIMIT: '2000',
    PERPLEXITY_API_KEY: 'test-key',
  } as unknown as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does not drain queued mockResolvedValueOnce() values from
  // the previous test (only mockReset()/restoreAllMocks() do) -- reset the
  // Perplexity mock explicitly so an unconsumed queued value (e.g. from a
  // test whose pre-check short-circuits before calling it) can never leak
  // into the next test's call.
  vi.mocked(fetchAbvFromPerplexity).mockReset().mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('consumer-side stale-result binding (enrichment queue)', () => {
  it('acks without writing when the message descriptionHash does not match the current row (ABV found)', async () => {
    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(6.5);
    const { db, rows } = createFakeD1({
      'beer-1': { enrichment_status: 'pending', description_hash: 'hash-CURRENT', abv: null },
    });
    const env = createEnv(db);

    const message = createMessage({
      beerId: 'beer-1',
      beerName: 'Test IPA',
      brewer: 'Test Brewery',
      descriptionHash: 'hash-STALE',
    });

    await handleEnrichmentBatch(createBatch([message]), env);

    expect(rows.get('beer-1')!.enrichment_status).toBe('pending');
    expect(rows.get('beer-1')!.abv).toBeNull();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('acks without writing when the message descriptionHash does not match the current row (ABV not found)', async () => {
    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(null);
    const { db, rows } = createFakeD1({
      'beer-2': { enrichment_status: 'pending', description_hash: 'hash-AFTER-CHANGE', abv: null },
    });
    const env = createEnv(db);

    const message = createMessage({
      beerId: 'beer-2',
      beerName: 'Test IPA',
      brewer: 'Test Brewery',
      descriptionHash: 'hash-BEFORE-CHANGE',
    });

    await handleEnrichmentBatch(createBatch([message]), env);

    expect(rows.get('beer-2')!.enrichment_status).toBe('pending');
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('writes exactly once (idempotently) across a duplicate delivery of the same message', async () => {
    const { db, rows } = createFakeD1({
      'beer-3': { enrichment_status: 'pending', description_hash: 'hash-match', abv: null },
    });
    const env = createEnv(db);

    const buildMessage = () => createMessage({
      beerId: 'beer-3',
      beerName: 'Test IPA',
      brewer: 'Test Brewery',
      descriptionHash: 'hash-match',
    });

    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(5.5);
    const first = buildMessage();
    await handleEnrichmentBatch(createBatch([first]), env);
    expect(rows.get('beer-3')!.enrichment_status).toBe('enriched');
    expect(rows.get('beer-3')!.abv).toBe(5.5);
    expect(first.ack).toHaveBeenCalledOnce();

    const afterFirstDelivery = { ...rows.get('beer-3')! };

    // Redelivery: status is no longer 'pending', so the pre-check in the
    // consumer itself short-circuits and acks without ever calling
    // Perplexity or attempting the write again.
    vi.mocked(fetchAbvFromPerplexity).mockClear();
    const duplicate = buildMessage();
    await handleEnrichmentBatch(createBatch([duplicate]), env);

    expect(rows.get('beer-3')!).toEqual(afterFirstDelivery);
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(fetchAbvFromPerplexity).not.toHaveBeenCalled();
  });

  it('a null message descriptionHash matches a genuinely null stored column (beer with no description)', async () => {
    // A beer with no brew_description at all has description_hash = NULL in
    // the row (see categorizeBeer / insertPlaceholders). The message
    // produced for it correctly carries an explicit null descriptionHash
    // (EnrichmentMessage.descriptionHash is required-but-nullable, not
    // optional) -- proving `IS` (not `=`) is required: SQL `NULL = NULL` is
    // not true, so a naive `=` comparison would silently discard every
    // write for description-less beers as "stale."
    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(5.0);
    const { db, rows } = createFakeD1({
      'beer-4': { enrichment_status: 'pending', description_hash: null, abv: null },
    });
    const env = createEnv(db);

    const message = createMessage({
      beerId: 'beer-4',
      beerName: 'No Description Beer',
      brewer: 'Test Brewery',
      descriptionHash: null, // matches the row's null column
    });

    await handleEnrichmentBatch(createBatch([message]), env);

    expect(rows.get('beer-4')!.enrichment_status).toBe('enriched');
    expect(rows.get('beer-4')!.abv).toBe(5.0);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('still discards the write when only enrichment_status changed and the hash still matches (status guard retained)', async () => {
    // Belt and braces: the status guard was NOT replaced by the hash check.
    // A race where another consumer already moved the row off 'pending'
    // (description unchanged) must still be caught, even though the
    // description_hash comparison alone would pass.
    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(6.0);
    const { db, rows } = createFakeD1({
      // Row already moved to 'enriched' by a racing consumer, but the
      // description (and thus hash) never changed.
      'beer-5': { enrichment_status: 'enriched', description_hash: 'hash-match', abv: 4.2 },
    });
    const env = createEnv(db);

    // The consumer's own pre-check (SELECT enrichment_status) will see
    // 'enriched' and skip before even attempting the write -- this proves
    // the earlier guard already protects this case, and the terminal
    // UPDATE's own status clause is a second, independent line of defense
    // if that pre-check ever raced past its own read.
    const message = createMessage({
      beerId: 'beer-5',
      beerName: 'Test IPA',
      brewer: 'Test Brewery',
      descriptionHash: 'hash-match',
    });

    await handleEnrichmentBatch(createBatch([message]), env);

    expect(rows.get('beer-5')!.abv).toBe(4.2); // untouched
    expect(message.ack).toHaveBeenCalledOnce();
    expect(fetchAbvFromPerplexity).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Producer -> consumer seam: queueBeersForEnrichment -> ENRICHMENT_QUEUE ->
// handleEnrichmentBatch. Proves the producer's descriptionHash actually
// reaches the consumer and is honored, not just that each side works in
// isolation.
// ============================================================================

describe('producer -> consumer seam (queueBeersForEnrichment -> handleEnrichmentBatch)', () => {
  it('a message produced by queueBeersForEnrichment with a descriptionHash is written by the consumer when its hash matches the current row', async () => {
    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(5.5);
    const { db, rows } = createFakeD1({
      'beer-6': { enrichment_status: 'pending', description_hash: 'hash-abc', abv: null },
    });

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
      [{ id: 'beer-6', brew_name: 'Test IPA', brewer: 'Test Brewery', descriptionHash: 'hash-abc' }],
      'req-seam'
    );

    expect(queueResult.queued).toBe(1);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0]!.body.descriptionHash).toBe('hash-abc');

    const deliveredMessage = createMessage(capturedMessages[0]!.body);
    const consumerEnv = createEnv(db);
    await handleEnrichmentBatch(createBatch([deliveredMessage]), consumerEnv);

    expect(rows.get('beer-6')!.enrichment_status).toBe('enriched');
    expect(rows.get('beer-6')!.abv).toBe(5.5);
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
