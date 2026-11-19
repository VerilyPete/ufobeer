/**
 * DLQ consumer storage against real D1: storeDlqMessage writes one complete
 * row per message ID, a redelivery refreshes only the failure fields and
 * reopens the entry, and the beer is parked as failed only while the message
 * still describes it and it has no ABV.
 */

import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeDlqMessage } from '../../src/queue/dlq';
import type { EnrichmentMessage } from '../../src/types';

const NOW = new Date('2026-05-09T18:45:00Z').getTime();
const LATER = NOW + 7_000;
const SEEDED_AT = NOW - 3_600_000;

const enrichmentBody = (overrides: Partial<EnrichmentMessage> = {}): EnrichmentMessage => ({
  beerId: 'beer-dlq-41',
  beerName: 'Harbor Porter',
  brewer: 'Pier Nine Brewing',
  descriptionHash: 'hash-porter-6c',
  ...overrides,
});

const queueMessage = (
  id: string,
  body: EnrichmentMessage,
  attempts: number,
): Message<EnrichmentMessage> => ({
  id,
  timestamp: new Date(NOW),
  body,
  attempts,
  ack: () => {},
  retry: () => {},
});

const storedEntries = async () =>
  (await env.DB.prepare(
    `SELECT message_id, beer_id, beer_name, brewer, failed_at, failure_count, failure_reason,
            source_queue, status, replay_count, replayed_at, acknowledged_at, raw_message,
            replay_claim, replay_claimed_at
     FROM dlq_messages ORDER BY id`,
  ).all()).results;

const seedBeer = async (
  id: string,
  { abv = null, descriptionHash = 'hash-porter-6c' }: { readonly abv?: number | null; readonly descriptionHash?: string } = {},
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, enrichment_status, abv, description_hash, updated_at)
     VALUES (?, 'Harbor Porter', 'Pier Nine Brewing', 'pending', ?, ?, ?)`,
  ).bind(id, abv, descriptionHash, SEEDED_AT).run();
};

const beerStates = async () =>
  (await env.DB.prepare('SELECT id, enrichment_status, abv, updated_at FROM enriched_beers ORDER BY id').all()).results;

describe('storeDlqMessage (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM dlq_messages').run();
    await env.DB.prepare('DELETE FROM enriched_beers').run();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores a complete pending entry for a new message', async () => {
    const body = enrichmentBody();

    await storeDlqMessage(env.DB, queueMessage('msg-dlq-41', body, 4), 'beer-enrichment-dlq');

    expect(await storedEntries()).toEqual([{
      message_id: 'msg-dlq-41',
      beer_id: 'beer-dlq-41',
      beer_name: 'Harbor Porter',
      brewer: 'Pier Nine Brewing',
      failed_at: NOW,
      failure_count: 4,
      failure_reason: null,
      source_queue: 'beer-enrichment-dlq',
      status: 'pending',
      replay_count: 0,
      replayed_at: null,
      acknowledged_at: null,
      raw_message: JSON.stringify(body),
      replay_claim: null,
      replay_claimed_at: null,
    }]);
  });

  it('stores an empty beer name and brewer as NULL', async () => {
    const body = enrichmentBody({ beerName: '', brewer: '', descriptionHash: null });

    await storeDlqMessage(env.DB, queueMessage('msg-dlq-blank', body, 5), 'beer-enrichment-dlq');

    expect(await storedEntries()).toEqual([{
      message_id: 'msg-dlq-blank',
      beer_id: 'beer-dlq-41',
      beer_name: null,
      brewer: null,
      failed_at: NOW,
      failure_count: 5,
      failure_reason: null,
      source_queue: 'beer-enrichment-dlq',
      status: 'pending',
      replay_count: 0,
      replayed_at: null,
      acknowledged_at: null,
      raw_message: JSON.stringify(body),
      replay_claim: null,
      replay_claimed_at: null,
    }]);
  });

  it('updates only the failure time, attempt count, raw body and status when the same message arrives again', async () => {
    await storeDlqMessage(env.DB, queueMessage('msg-dlq-41', enrichmentBody(), 4), 'beer-enrichment-dlq');
    await env.DB.prepare(
      `UPDATE dlq_messages SET status = 'acknowledged', acknowledged_at = ?, replay_count = 2,
         replayed_at = ?, failure_reason = 'manual triage'
       WHERE message_id = 'msg-dlq-41'`,
    ).bind(NOW + 1_000, NOW + 500).run();
    vi.setSystemTime(LATER);
    const redelivered = enrichmentBody({ beerId: 'beer-other-77', beerName: 'Renamed Porter', brewer: 'Other Brewing' });

    await storeDlqMessage(env.DB, queueMessage('msg-dlq-41', redelivered, 6), 'other-queue');

    expect(await storedEntries()).toEqual([{
      message_id: 'msg-dlq-41',
      beer_id: 'beer-dlq-41',
      beer_name: 'Harbor Porter',
      brewer: 'Pier Nine Brewing',
      failed_at: LATER,
      failure_count: 6,
      failure_reason: 'manual triage',
      source_queue: 'beer-enrichment-dlq',
      status: 'pending',
      replay_count: 2,
      replayed_at: NOW + 500,
      acknowledged_at: NOW + 1_000,
      raw_message: JSON.stringify(redelivered),
      replay_claim: null,
      replay_claimed_at: null,
    }]);
  });

  it('parks only the beer the message still describes, and only while it has no ABV', async () => {
    await seedBeer('beer-match');
    await seedBeer('beer-has-abv', { abv: 6.3 });
    await seedBeer('beer-new-description', { descriptionHash: 'hash-rewritten-9a' });
    await seedBeer('beer-untouched');

    await storeDlqMessage(env.DB, queueMessage('msg-match', enrichmentBody({ beerId: 'beer-match' }), 3), 'beer-enrichment-dlq');
    await storeDlqMessage(env.DB, queueMessage('msg-abv', enrichmentBody({ beerId: 'beer-has-abv' }), 3), 'beer-enrichment-dlq');
    await storeDlqMessage(env.DB, queueMessage('msg-stale', enrichmentBody({ beerId: 'beer-new-description' }), 3), 'beer-enrichment-dlq');

    expect(await beerStates()).toEqual([
      { id: 'beer-has-abv', enrichment_status: 'pending', abv: 6.3, updated_at: SEEDED_AT },
      { id: 'beer-match', enrichment_status: 'failed', abv: null, updated_at: NOW },
      { id: 'beer-new-description', enrichment_status: 'pending', abv: null, updated_at: SEEDED_AT },
      { id: 'beer-untouched', enrichment_status: 'pending', abv: null, updated_at: SEEDED_AT },
    ]);
  });
});
