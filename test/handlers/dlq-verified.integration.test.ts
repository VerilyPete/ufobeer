/**
 * Dead-letter storage and admin replay never change a hand-verified row's
 * enrichment_status. A refused replay is reported and its entry returns to
 * pending, so it can be replayed once a human clears the flag. Real D1.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDlqReplay } from '../../src/handlers/dlq';
import { storeDlqMessage } from '../../src/queue/dlq';
import type { EnrichmentMessage, Env, RequestContext } from '../../src/types';
import { hookedDb } from './dlq-replay-harness';

const context: RequestContext = {
  requestId: 'dlq-verified',
  startTime: 0,
  clientIdentifier: 'admin',
  apiKeyHash: 'hash',
  clientIp: '127.0.0.1',
  userAgent: 'test',
};

const ENRICHMENT_BODY: EnrichmentMessage = { beerId: 'beer-1', beerName: 'Valley Lager', brewer: 'Valley Brewing', descriptionHash: 'hash-1' };
const CLEANUP_BODY = { beerId: 'beer-2', beerName: 'Hill Ale', brewer: 'Hill Brewing', brewDescription: 'A pale ale', descriptionHash: 'hash-2' };

async function seedBeer(id: string, isVerified: number | null, status = 'failed'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, enrichment_status, abv, is_verified, description_hash)
     VALUES (?, 'Valley Lager', 'Valley Brewing', ?, NULL, ?, ?)`
  ).bind(id, status, isVerified, `hash-${id.slice(-1)}`).run();
}

async function seedDlqEntry(messageId: string, sourceQueue: string, body: object): Promise<number> {
  const id = await env.DB.prepare(
    `INSERT INTO dlq_messages (message_id, beer_id, failed_at, source_queue, raw_message, status)
     VALUES (?, ?, 0, ?, ?, 'pending') RETURNING id`
  ).bind(messageId, (body as { beerId: string }).beerId, sourceQueue, JSON.stringify(body)).first<number>('id');
  if (id === null) throw new Error('DLQ seed failed');
  return id;
}

async function beerStatus(id: string): Promise<unknown> {
  return env.DB.prepare('SELECT enrichment_status FROM enriched_beers WHERE id = ?').bind(id).first('enrichment_status');
}

async function setVerified(value: number): Promise<void> {
  await env.DB.prepare('UPDATE enriched_beers SET is_verified = ? WHERE id = ?').bind(value, 'beer-1').run();
}

async function dlqStatus(id: number): Promise<unknown> {
  return env.DB.prepare('SELECT status FROM dlq_messages WHERE id = ?').bind(id).first('status');
}

function queues() {
  const enrichment = vi.fn().mockResolvedValue(undefined);
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const worker = { ...env, ENRICHMENT_QUEUE: { send: enrichment }, CLEANUP_QUEUE: { send: cleanup } } as unknown as Env;
  return { enrichment, cleanup, worker };
}

async function replay(worker: Env, ids: readonly number[]) {
  const request = new Request('https://api.example.com/admin/dlq/replay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const response = await handleDlqReplay(request, worker, {}, context);
  return (await response.json() as { data: Record<string, unknown> }).data;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
  await env.DB.prepare('DELETE FROM enriched_beers').run();
  await env.DB.prepare('DELETE FROM dlq_messages').run();
  await env.DB.prepare('DROP TRIGGER IF EXISTS abort_finalize').run();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('dead-letter storage of a verified row', () => {
  it('stores the message without marking a verified NULL-ABV row failed', async () => {
    await seedBeer('beer-1', 1, 'pending');

    await storeDlqMessage(env.DB, { id: 'm-1', attempts: 3, body: ENRICHMENT_BODY } as unknown as Message<EnrichmentMessage>, 'beer-enrichment');

    expect(await beerStatus('beer-1')).toBe('pending');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM dlq_messages').first('n')).toBe(1);
  });

  it.each([[0], [null]])('still marks a NULL-ABV row with is_verified %s failed', async (isVerified) => {
    await seedBeer('beer-1', isVerified, 'pending');

    await storeDlqMessage(env.DB, { id: 'm-1', attempts: 3, body: ENRICHMENT_BODY } as unknown as Message<EnrichmentMessage>, 'beer-enrichment');

    expect(await beerStatus('beer-1')).toBe('failed');
  });
});

describe('admin replay of a verified row', () => {
  it('refuses and reports the replay, returns the entry to pending, and replays it once the flag is cleared', async () => {
    await seedBeer('beer-1', 1);
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const { enrichment, worker } = queues();

    expect(await replay(worker, [dlqId])).toMatchObject({ replayed_count: 0, skipped_verified: [dlqId] });
    expect(enrichment).not.toHaveBeenCalled();
    expect(await beerStatus('beer-1')).toBe('failed');
    expect(await dlqStatus(dlqId)).toBe('pending');

    await env.DB.prepare('UPDATE enriched_beers SET is_verified = 0 WHERE id = ?').bind('beer-1').run();

    expect(await replay(worker, [dlqId])).toMatchObject({ replayed_count: 1, skipped_verified: [] });
    expect(enrichment).toHaveBeenCalledOnce();
    expect(await beerStatus('beer-1')).toBe('pending');
    expect(await dlqStatus(dlqId)).toBe('replayed');
  });

  it('keeps a refused verified entry replayable when finalizing the sent entries fails', async () => {
    await seedBeer('beer-1', 1);
    await seedBeer('beer-2', 0, 'enriched');
    const verifiedId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const sentId = await seedDlqEntry('m-2', 'description-cleanup', CLEANUP_BODY);
    await env.DB.prepare(
      "CREATE TRIGGER abort_finalize BEFORE UPDATE OF status ON dlq_messages WHEN NEW.status = 'replayed' BEGIN SELECT RAISE(ABORT, 'test abort'); END"
    ).run();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await replay(queues().worker, [verifiedId, sentId]);
    await env.DB.prepare('DROP TRIGGER abort_finalize').run();

    expect(await dlqStatus(verifiedId)).toBe('pending');
    await env.DB.prepare('UPDATE enriched_beers SET is_verified = 0 WHERE id = ?').bind('beer-1').run();
    const { enrichment, worker } = queues();
    expect(await replay(worker, [verifiedId])).toMatchObject({ replayed_count: 1 });
    expect(enrichment).toHaveBeenCalledOnce();
  });

  it('refuses, reports and releases an entry whose beer is verified after the claim', async () => {
    await seedBeer('beer-1', 0);
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const racingDb = hookedDb(env.DB, {
      after: async (call) => {
        if (call.index === 0) await setVerified(1);
      },
    });
    const { enrichment, worker } = queues();

    expect(await replay({ ...worker, DB: racingDb }, [dlqId])).toMatchObject({ replayed_count: 0, skipped_verified: [dlqId] });
    expect(enrichment).not.toHaveBeenCalled();
    expect(await dlqStatus(dlqId)).toBe('pending');
    expect(await beerStatus('beer-1')).toBe('failed');
  });

  it('refuses a beer verified after the claim, and does not send if the flag is cleared before the follow-up read', async () => {
    await seedBeer('beer-1', 0);
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const racingDb = hookedDb(env.DB, {
      after: async (call) => {
        if (call.index === 0) await setVerified(1);
        if (call.sql.startsWith('UPDATE enriched_beers')) await setVerified(0);
      },
    });
    const { enrichment, worker } = queues();

    const data = await replay({ ...worker, DB: racingDb }, [dlqId]);

    expect(enrichment).not.toHaveBeenCalled();
    expect(data).toMatchObject({ replayed_count: 0, failed_count: 1 });
    expect(await dlqStatus(dlqId)).toBe('pending');
    const retry = queues();
    expect(await replay(retry.worker, [dlqId])).toMatchObject({ replayed_count: 1 });
    expect(await beerStatus('beer-1')).toBe('pending');
  });

  it('never claims an entry for a verified beer, so a failed release cannot strand it', async () => {
    await seedBeer('beer-1', 1);
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    await env.DB.prepare(
      "CREATE TRIGGER abort_finalize BEFORE UPDATE OF status ON dlq_messages WHEN NEW.status = 'pending' BEGIN SELECT RAISE(ABORT, 'test abort'); END"
    ).run();
    const { enrichment, worker } = queues();

    const data = await replay(worker, [dlqId]);
    await env.DB.prepare('DROP TRIGGER abort_finalize').run();

    expect(data).toMatchObject({ replayed_count: 0, skipped_verified: [dlqId] });
    expect(enrichment).not.toHaveBeenCalled();
    expect(await dlqStatus(dlqId)).toBe('pending');
  });

  it('still replays a cleanup entry for a verified beer', async () => {
    await seedBeer('beer-2', 1, 'enriched');
    const dlqId = await seedDlqEntry('m-2', 'description-cleanup', CLEANUP_BODY);
    const { cleanup, worker } = queues();

    expect(await replay(worker, [dlqId])).toMatchObject({ replayed_count: 1, skipped_verified: [] });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('replays a mixed cleanup and enrichment batch with unchanged counts', async () => {
    await seedBeer('beer-1', 0);
    await seedBeer('beer-2', null, 'enriched');
    const enrichmentId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const cleanupId = await seedDlqEntry('m-2', 'description-cleanup', CLEANUP_BODY);
    const { enrichment, cleanup, worker } = queues();

    expect(await replay(worker, [enrichmentId, cleanupId])).toMatchObject({
      claimed_count: 2, replayed_count: 2, failed_count: 0, skipped_verified: [], queued_counts: { enrichment: 1, cleanup: 1 },
    });
    expect(enrichment).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('still replays an enrichment entry whose beer row no longer exists', async () => {
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const { enrichment, worker } = queues();

    expect(await replay(worker, [dlqId])).toMatchObject({ replayed_count: 1, skipped_verified: [] });
    expect(enrichment).toHaveBeenCalledOnce();
  });
});
