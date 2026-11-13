/**
 * Admin DLQ replay claims an entry with a lease (an owner token and a claim
 * time). Ownership fences every database write the replay makes; the cron
 * reaper returns abandoned claims to pending. Real D1.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseStaleReplayClaims } from '../../src/handlers/dlq';
import { DLQ_REPLAY_CLAIM_STALE_MS } from '../../src/constants';
import { storeDlqMessage } from '../../src/queue/dlq';
import { handleEnrichmentBatch } from '../../src/queue/enrichment';
import type { EnrichmentMessage, Env } from '../../src/types';
import {
  CLEANUP_BODY,
  ENRICHMENT_BODY,
  beerStatus,
  dlqEntry,
  hookedDb,
  queues,
  replay,
  replayResponse,
  seedBeer,
  seedDlqEntry,
} from './dlq-replay-harness';

const CLAIM_TIME = 1_800_000_000_000;

function stubPerplexity(abv: string): { count: number } {
  const calls = { count: 0 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://api.perplexity.ai/')) throw new Error(`Unexpected outbound request: ${url}`);
    calls.count++;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: abv } }] });
  });
  return calls;
}

function consumerEnv(): Env {
  return {
    ...env,
    PERPLEXITY_API_KEY: 'test-perplexity-key',
    ABV_FALLBACK_ENABLED: 'false',
    ENRICHMENT_ENABLED: 'true',
    DAILY_ENRICHMENT_LIMIT: '500',
    MONTHLY_ENRICHMENT_LIMIT: '2000',
    ANALYTICS: { writeDataPoint: vi.fn() },
  } as Env;
}

async function reservations(): Promise<unknown> {
  return env.DB.prepare('SELECT COALESCE(SUM(request_count), 0) AS n FROM enrichment_limits').first('n');
}

async function setVerified(beerId: string, value: number): Promise<void> {
  await env.DB.prepare('UPDATE enriched_beers SET is_verified = ? WHERE id = ?').bind(value, beerId).run();
}

async function takeOverClaim(dlqId: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE dlq_messages SET status = 'replaying', replay_claim = 'other-request', replay_claimed_at = ? WHERE id = ?"
  ).bind(CLAIM_TIME + DLQ_REPLAY_CLAIM_STALE_MS, dlqId).run();
}

async function seedClaim(messageId: string, status: string, claimedAt: number | null): Promise<number> {
  const id = await seedDlqEntry(messageId, 'beer-enrichment', ENRICHMENT_BODY);
  await env.DB.prepare('UPDATE dlq_messages SET status = ?, replay_claim = ?, replay_claimed_at = ? WHERE id = ?')
    .bind(status, claimedAt === null ? null : 'some-request', claimedAt, id).run();
  return id;
}

async function abortWhenStatusBecomes(status: string): Promise<void> {
  await env.DB.prepare(
    `CREATE TRIGGER abort_status BEFORE UPDATE OF status ON dlq_messages WHEN NEW.status = '${status}' BEGIN SELECT RAISE(ABORT, 'test abort'); END`
  ).run();
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
  await env.DB.prepare('DELETE FROM enriched_beers').run();
  await env.DB.prepare('DELETE FROM dlq_messages').run();
  await env.DB.prepare('DELETE FROM enrichment_limits').run();
  await env.DB.prepare('DROP TRIGGER IF EXISTS abort_status').run();
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('releaseStaleReplayClaims', () => {
  it('releases a claim exactly the stale age old, and keeps one a millisecond younger', async () => {
    const stale = await seedClaim('m-1', 'replaying', CLAIM_TIME - DLQ_REPLAY_CLAIM_STALE_MS);
    const fresh = await seedClaim('m-2', 'replaying', CLAIM_TIME - DLQ_REPLAY_CLAIM_STALE_MS + 1);

    expect(await releaseStaleReplayClaims(env.DB, { now: CLAIM_TIME })).toBe(1);

    expect(await dlqEntry(stale)).toMatchObject({ status: 'pending', replay_claim: null, replay_claimed_at: null });
    expect(await dlqEntry(fresh)).toMatchObject({ status: 'replaying', replay_claim: 'some-request' });
  });

  it('releases a claim with no claim time (stranded before claims were timed)', async () => {
    const legacy = await seedClaim('m-1', 'replaying', null);

    await releaseStaleReplayClaims(env.DB, { now: CLAIM_TIME });

    expect(await dlqEntry(legacy)).toMatchObject({ status: 'pending' });
  });

  it.each(['pending', 'replayed', 'acknowledged'])('leaves a %s entry alone', async (status) => {
    const id = await seedClaim('m-1', status, 0);

    expect(await releaseStaleReplayClaims(env.DB, { now: CLAIM_TIME })).toBe(0);

    expect(await dlqEntry(id)).toMatchObject({ status, replay_claimed_at: 0 });
  });
});

describe('the replay lease', () => {
  it('records its claim and clears it when the entry is finalized', async () => {
    await seedBeer('beer-1');
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const claims: Array<unknown> = [];
    const { worker } = queues(async () => {
      claims.push(await dlqEntry(dlqId));
    });

    expect(await replay(worker, [dlqId])).toMatchObject({ replayed_count: 1 });

    expect(claims).toEqual([expect.objectContaining({ status: 'replaying', replay_claim: expect.any(String), replay_claimed_at: expect.any(Number) })]);
    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'replayed', replay_count: 1, replay_claim: null, replay_claimed_at: null });
  });

  it('recovers an entry stranded by verification after the claim and a failed release', async () => {
    await seedBeer('beer-1');
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    await abortWhenStatusBecomes('pending');
    const db = hookedDb(env.DB, {
      after: async (call) => {
        if (call.index === 0) await setVerified('beer-1', 1);
      },
    });
    const { enrichment, worker } = queues();

    const response = await replayResponse({ ...worker, DB: db }, [dlqId]);

    expect(response.status).toBe(500);
    expect(enrichment).not.toHaveBeenCalled();
    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'replaying' });

    await env.DB.prepare('DROP TRIGGER abort_status').run();
    await setVerified('beer-1', 0);
    await releaseStaleReplayClaims(env.DB, { now: Date.now() + DLQ_REPLAY_CLAIM_STALE_MS });
    const retry = queues();

    expect(await replay(retry.worker, [dlqId])).toMatchObject({ replayed_count: 1 });
    expect(retry.enrichment).toHaveBeenCalledOnce();
    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'replayed' });
  });

  it('stops resetting and sending once its lease is taken over, and leaves the new claim alone', async () => {
    await seedBeer('beer-1');
    await seedBeer('beer-3');
    await seedBeer('beer-2', { status: 'enriched', abv: 5 });
    const firstId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const secondId = await seedDlqEntry('m-3', 'beer-enrichment', { ...ENRICHMENT_BODY, beerId: 'beer-3' });
    const cleanupId = await seedDlqEntry('m-2', 'description-cleanup', CLEANUP_BODY);
    const ids = [firstId, secondId, cleanupId];
    const sends = { count: 0 };
    const { enrichment, cleanup, worker } = queues(async () => {
      sends.count++;
      if (sends.count === 1) {
        await Promise.all(ids.map(takeOverClaim));
      }
    });

    await replay(worker, ids);

    expect(enrichment).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(await beerStatus('beer-3')).toBe('failed');
    for (const id of ids) {
      expect(await dlqEntry(id)).toMatchObject({ status: 'replaying', replay_count: 0, replay_claim: 'other-request' });
    }
  });

  it('still sends when the lease is lost after its reset commits (the accepted window), without touching the new claim', async () => {
    await seedBeer('beer-1');
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const db = hookedDb(env.DB, {
      after: async (call) => {
        if (call.sql.startsWith('UPDATE enriched_beers')) await takeOverClaim(dlqId);
      },
    });
    const { enrichment, worker } = queues();

    await replay({ ...worker, DB: db }, [dlqId]);

    expect(enrichment).toHaveBeenCalledOnce();
    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'replaying', replay_count: 0, replay_claim: 'other-request' });
  });

  it('does not release an entry whose failed send happened after its lease was taken over', async () => {
    await seedBeer('beer-1');
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const { worker } = queues(async () => {
      await takeOverClaim(dlqId);
      throw new Error('Queue send failed');
    });

    expect(await replay(worker, [dlqId])).toMatchObject({ failed_count: 1 });

    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'replaying', replay_claim: 'other-request' });
  });

  it('sends nothing for a missing beer once its lease is lost', async () => {
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const db = hookedDb(env.DB, {
      after: async (call) => {
        if (call.index === 0) await takeOverClaim(dlqId);
      },
    });
    const { enrichment, worker } = queues();

    await replay({ ...worker, DB: db }, [dlqId]);

    expect(enrichment).not.toHaveBeenCalled();
    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'replaying', replay_claim: 'other-request' });
  });

  it('does not mistake a later claim made in the same millisecond for its own', async () => {
    await seedBeer('beer-1');
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    vi.spyOn(Date, 'now').mockReturnValue(CLAIM_TIME);
    const second = queues();
    const db = hookedDb(env.DB, {
      after: async (call) => {
        if (call.index !== 0) return;
        await storeDlqMessage(env.DB, { id: 'm-1', attempts: 3, body: ENRICHMENT_BODY } as unknown as Message<EnrichmentMessage>, 'beer-enrichment');
        await replay(second.worker, [dlqId]);
      },
    });
    const first = queues();

    await replay({ ...first.worker, DB: db }, [dlqId]);

    expect(second.enrichment).toHaveBeenCalledOnce();
    expect(first.enrichment).not.toHaveBeenCalled();
    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'replayed', replay_count: 1 });
  });
});

describe('an entry whose beer was resolved since it failed', () => {
  it('is not re-sent after an ambiguous replay: send went out, finalize failed, the consumer enriched the beer', async () => {
    await seedBeer('beer-1');
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    await abortWhenStatusBecomes('replayed');
    const first = queues();

    expect((await replayResponse(first.worker, [dlqId])).status).toBe(500);
    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'replaying' });

    await env.DB.prepare('DROP TRIGGER abort_status').run();
    const perplexityCalls = stubPerplexity('5.2');
    const [sent] = first.enrichment.mock.calls.map(([body]) => body);
    const delivered = { body: sent, ack: vi.fn(), retry: vi.fn() };
    await handleEnrichmentBatch({ messages: [delivered] } as unknown as MessageBatch<EnrichmentMessage>, consumerEnv());
    expect(delivered.ack).toHaveBeenCalledOnce();
    expect(await env.DB.prepare('SELECT abv FROM enriched_beers WHERE id = ?').bind('beer-1').first('abv')).toBe(5.2);
    expect(perplexityCalls.count).toBe(1);
    expect(await reservations()).toBe(1);

    await releaseStaleReplayClaims(env.DB, { now: Date.now() + DLQ_REPLAY_CLAIM_STALE_MS });
    const second = queues();

    expect(await replay(second.worker, [dlqId])).toMatchObject({ replayed_count: 0, skipped_resolved: [dlqId] });
    expect(second.enrichment).not.toHaveBeenCalled();
    expect(perplexityCalls.count).toBe(1);
    expect(await reservations()).toBe(1);
    expect(await beerStatus('beer-1')).toBe('enriched');
    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'pending', replay_claim: null });
  });

  it('is not re-sent when its beer was skipped', async () => {
    await seedBeer('beer-1', { status: 'skipped' });
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const { enrichment, worker } = queues();

    expect(await replay(worker, [dlqId])).toMatchObject({ replayed_count: 0, skipped_resolved: [dlqId] });
    expect(enrichment).not.toHaveBeenCalled();
    expect(await beerStatus('beer-1')).toBe('skipped');
    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'pending' });
  });

  it.each(['failed', 'pending', 'not_found'])('still replays a %s beer with no ABV', async (status) => {
    await seedBeer('beer-1', { status });
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const { enrichment, worker } = queues();

    expect(await replay(worker, [dlqId])).toMatchObject({ replayed_count: 1, skipped_resolved: [] });
    expect(enrichment).toHaveBeenCalledOnce();
    expect(await beerStatus('beer-1')).toBe('pending');
  });
});

describe('verification changing around the claim', () => {
  it.each([
    ['before', 0, 1],
    ['before', 1, 0],
    ['after', 0, 1],
    ['after', 1, 0],
  ] as const)('reports the entry exactly once when the flag flips %s the first call (%i to %i)', async (when, from, to) => {
    await seedBeer('beer-1', { isVerified: from });
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const flip = async (call: { readonly index: number }) => {
      if (call.index === 0) await setVerified('beer-1', to);
    };
    const db = hookedDb(env.DB, when === 'before' ? { before: flip } : { after: flip });
    const { enrichment, worker } = queues();

    const data = await replay({ ...worker, DB: db } as Env, [dlqId]);

    const outcomes = [
      ...(data.skipped_verified ?? []),
      ...(data.skipped_resolved ?? []),
    ].length + (data.replayed_count ?? 0) + (data.failed_count ?? 0);
    expect(outcomes).toBe(1);
    const status = (await dlqEntry(dlqId))?.status;
    expect(status).toBe(data.replayed_count === 1 ? 'replayed' : 'pending');
    expect(enrichment).toHaveBeenCalledTimes(data.replayed_count ?? 0);
  });
});
