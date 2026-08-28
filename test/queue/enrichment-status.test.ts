/**
 * Tests for enrichment_status transitions in the enrichment queue consumer.
 *
 * Verifies:
 * - Beers with non-pending status are skipped
 * - ABV found sets enrichment_status = 'enriched'
 * - ABV not found sets enrichment_status = 'not_found'
 */

import { describe, it, expect, vi } from 'vitest';
import { handleEnrichmentBatch } from '../../src/queue/enrichment';
import type { Env, EnrichmentMessage } from '../../src/types';

// Mock perplexity service
vi.mock('../../src/services/perplexity', () => ({
  fetchAbvFromPerplexity: vi.fn().mockResolvedValue(null),
}));

// Mock analytics
vi.mock('../../src/analytics', () => ({
  trackEnrichment: vi.fn(),
}));

import { fetchAbvFromPerplexity } from '../../src/services/perplexity';

// ============================================================================
// Factories
// ============================================================================

function createMessage(body: EnrichmentMessage) {
  return {
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

type PrepareCall = {
  readonly sql: string;
  readonly boundArgs: unknown[];
  readonly runCalled: boolean;
};

function createTrackingDb(options: {
  readonly enrichmentStatus?: string | null;
  readonly reservationResult?: { new_count: number } | null;
  readonly preCount?: number;
  readonly monthlyTotal?: number;
}) {
  const prepareCalls: PrepareCall[] = [];
  let callIndex = 0;

  return {
    prepareCalls,
    db: {
      prepare: vi.fn().mockImplementation((sql: string) => {
        const idx = callIndex++;
        return {
          bind: vi.fn().mockImplementation((...args: unknown[]) => {
            const call: PrepareCall = { sql, boundArgs: args, runCalled: false };
            prepareCalls.push(call);
            return {
              first: vi.fn().mockImplementation(() => {
                if (sql.includes('enrichment_status') && sql.includes('SELECT')) {
                  if (options.enrichmentStatus === undefined) return Promise.resolve(null);
                  return Promise.resolve({ enrichment_status: options.enrichmentStatus });
                }
                if (sql.includes('enrichment_limits') && sql.includes('SUM')) {
                  return Promise.resolve({ total: options.monthlyTotal ?? 0 });
                }
                if (sql.includes('UPDATE enrichment_limits') && sql.includes('RETURNING')) {
                  return Promise.resolve(options.reservationResult ?? { new_count: 1 });
                }
                if (sql.includes('SELECT request_count') && sql.includes('enrichment_limits')) {
                  return Promise.resolve({ request_count: options.preCount ?? 0 });
                }
                return Promise.resolve(null);
              }),
              run: vi.fn().mockImplementation(() => {
                (call as { runCalled: boolean }).runCalled = true;
                return Promise.resolve({ meta: { changes: 1 } });
              }),
              all: vi.fn().mockResolvedValue({ results: [] }),
            };
          }),
        };
      }),
    } as unknown as D1Database,
  };
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

// ============================================================================
// enrichment_status transitions
// ============================================================================

describe('handleEnrichmentBatch — enrichment_status', () => {
  it('skips beers with enrichment_status = enriched', async () => {
    const { db } = createTrackingDb({ enrichmentStatus: 'enriched' });
    const msg = createMessage({ beerId: 'beer-1', beerName: 'Test IPA', brewer: 'Brewery' });
    const batch = createBatch([msg]);

    await handleEnrichmentBatch(batch, createEnv(db));

    expect(msg.ack).toHaveBeenCalled();
    expect(fetchAbvFromPerplexity).not.toHaveBeenCalled();
  });

  it('skips beers with enrichment_status = not_found', async () => {
    const { db } = createTrackingDb({ enrichmentStatus: 'not_found' });
    const msg = createMessage({ beerId: 'beer-1', beerName: 'Test IPA', brewer: 'Brewery' });
    const batch = createBatch([msg]);

    await handleEnrichmentBatch(batch, createEnv(db));

    expect(msg.ack).toHaveBeenCalled();
    expect(fetchAbvFromPerplexity).not.toHaveBeenCalled();
  });

  it('skips beers with enrichment_status = skipped', async () => {
    const { db } = createTrackingDb({ enrichmentStatus: 'skipped' });
    const msg = createMessage({ beerId: 'beer-1', beerName: 'Test IPA', brewer: 'Brewery' });
    const batch = createBatch([msg]);

    await handleEnrichmentBatch(batch, createEnv(db));

    expect(msg.ack).toHaveBeenCalled();
    expect(fetchAbvFromPerplexity).not.toHaveBeenCalled();
  });

  it('sets enrichment_status to enriched when ABV is found', async () => {
    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(6.5);
    const { db, prepareCalls } = createTrackingDb({
      enrichmentStatus: 'pending',
      preCount: 0,
      reservationResult: { new_count: 1 },
    });
    const msg = createMessage({ beerId: 'beer-1', beerName: 'Test IPA', brewer: 'Brewery' });
    const batch = createBatch([msg]);

    await handleEnrichmentBatch(batch, createEnv(db));

    const updateCall = prepareCalls.find(
      c => c.sql.includes('UPDATE enriched_beers') && c.sql.includes('enrichment_status')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toContain("enrichment_status = 'enriched'");
    expect(msg.ack).toHaveBeenCalled();
  });

  it('sets enrichment_status to not_found when ABV is null', async () => {
    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(null);
    const { db, prepareCalls } = createTrackingDb({
      enrichmentStatus: 'pending',
      preCount: 0,
      reservationResult: { new_count: 1 },
    });
    const msg = createMessage({ beerId: 'beer-1', beerName: 'Test IPA', brewer: 'Brewery' });
    const batch = createBatch([msg]);

    await handleEnrichmentBatch(batch, createEnv(db));

    const updateCall = prepareCalls.find(
      c => c.sql.includes("enrichment_status = 'not_found'")
    );
    expect(updateCall).toBeDefined();
    expect(msg.ack).toHaveBeenCalled();
  });

  it('acks without an API call when the daily limit is reached (counter parked at limit)', async () => {
    // Pre-count = limit and post-count unchanged → reserved=false.
    // Regression guard for the original bug where a RETURNING-side
    // `<= limit` check kept approving reservations at exactly the limit.
    const { db } = createTrackingDb({
      enrichmentStatus: 'pending',
      preCount: 500,
      reservationResult: { new_count: 500 },
    });
    const msg = createMessage({ beerId: 'beer-1', beerName: 'Test IPA', brewer: 'Brewery' });
    const batch = createBatch([msg]);

    await handleEnrichmentBatch(batch, createEnv(db));

    expect(msg.ack).toHaveBeenCalled();
    expect(fetchAbvFromPerplexity).not.toHaveBeenCalled();
  });

  it('reserves the limit-th slot when the counter is at limit - 1', async () => {
    // Pre=499 → post=500: this is the 500th, in-budget call and must proceed.
    // Regression guard for the over-correction where a `< limit` check
    // rejected exactly this case.
    vi.mocked(fetchAbvFromPerplexity).mockResolvedValueOnce(5.5);
    const { db } = createTrackingDb({
      enrichmentStatus: 'pending',
      preCount: 499,
      reservationResult: { new_count: 500 },
    });
    const msg = createMessage({ beerId: 'beer-1', beerName: 'Test IPA', brewer: 'Brewery' });
    const batch = createBatch([msg]);

    await handleEnrichmentBatch(batch, createEnv(db));

    expect(fetchAbvFromPerplexity).toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
  });
});
