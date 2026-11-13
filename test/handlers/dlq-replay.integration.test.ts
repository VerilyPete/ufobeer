/**
 * Admin DLQ replay against real D1: routing to the queue each entry failed
 * on, the beer reset before an enrichment send, finalizing, rolling back a
 * failed send, and the response counts.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDlqReplay } from '../../src/handlers/dlq';
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

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
  await env.DB.prepare('DELETE FROM enriched_beers').run();
  await env.DB.prepare('DELETE FROM dlq_messages').run();
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('admin DLQ replay', () => {
  it('resets the beer to pending before sending, then marks the entry replayed', async () => {
    await seedBeer('beer-1');
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const statusAtSend: unknown[] = [];
    const { enrichment, worker } = queues(async () => {
      statusAtSend.push(await beerStatus('beer-1'));
    });

    const data = await replay(worker, [dlqId]);

    expect(data).toMatchObject({ requested_count: 1, claimed_count: 1, replayed_count: 1, failed_count: 0, queued_to: 'beer-enrichment' });
    expect(enrichment).toHaveBeenCalledWith(ENRICHMENT_BODY, {});
    expect(statusAtSend).toEqual(['pending']);
    const entry = await env.DB.prepare('SELECT status, replay_count, replayed_at FROM dlq_messages WHERE id = ?')
      .bind(dlqId).first<{ status: string; replay_count: number; replayed_at: number | null }>();
    expect(entry).toMatchObject({ status: 'replayed', replay_count: 1, replayed_at: expect.any(Number) });
  });

  it('routes a cleanup entry to the cleanup queue with its description and hash', async () => {
    const dlqId = await seedDlqEntry('m-2', 'description-cleanup', CLEANUP_BODY);
    const { enrichment, cleanup, worker } = queues();

    const data = await replay(worker, [dlqId]);

    expect(cleanup).toHaveBeenCalledWith(CLEANUP_BODY, {});
    expect(enrichment).not.toHaveBeenCalled();
    expect(data).toMatchObject({ queued_to: 'description-cleanup', queued_counts: { enrichment: 0, cleanup: 1 } });
  });

  it('passes a delay through to the queue', async () => {
    const dlqId = await seedDlqEntry('m-2', 'description-cleanup', CLEANUP_BODY);
    const { cleanup, worker } = queues();
    const request = new Request('https://api.example.com/admin/dlq/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [dlqId], delay_seconds: 30 }),
    });

    await handleDlqReplay(request, worker, {}, { requestId: 'r', startTime: 0, clientIdentifier: 'a', apiKeyHash: 'h', clientIp: '127.0.0.1', userAgent: 't' });

    expect(cleanup).toHaveBeenCalledWith(CLEANUP_BODY, { delaySeconds: 30 });
  });

  it('omits queued_to for a mixed batch', async () => {
    await seedBeer('beer-1');
    const ids = [
      await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY),
      await seedDlqEntry('m-2', 'description-cleanup', CLEANUP_BODY),
    ];

    const data = await replay(queues().worker, ids);

    expect(data.queued_counts).toEqual({ enrichment: 1, cleanup: 1 });
    expect(data).not.toHaveProperty('queued_to');
  });

  it.each([
    ['cleanup', 'description-cleanup'],
    ['enrichment', 'beer-enrichment'],
  ])('counts a corrupt %s entry as failed, sends nothing, and returns it to pending', async (_label, sourceQueue) => {
    const dlqId = await seedDlqEntry('m-1', sourceQueue, { beerId: 'beer-1' });
    const { enrichment, cleanup, worker } = queues();

    expect(await replay(worker, [dlqId])).toMatchObject({ replayed_count: 0, failed_count: 1 });
    expect(enrichment).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'pending', replay_count: 0, replay_claim: null });
  });

  it('returns an entry whose send failed to pending', async () => {
    await seedBeer('beer-1');
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    const { worker } = queues(async () => {
      throw new Error('Queue send failed');
    });

    expect(await replay(worker, [dlqId])).toMatchObject({ replayed_count: 0, failed_count: 1 });
    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'pending', replay_count: 0, replay_claim: null });
  });

  it('reports when nothing is pending', async () => {
    await seedBeer('beer-1');
    const dlqId = await seedDlqEntry('m-1', 'beer-enrichment', ENRICHMENT_BODY);
    await env.DB.prepare("UPDATE dlq_messages SET status = 'acknowledged' WHERE id = ?").bind(dlqId).run();
    const { enrichment, worker } = queues();

    expect(await replay(worker, [dlqId])).toMatchObject({
      replayed_count: 0, skipped_verified: [], skipped_resolved: [], message: 'No pending messages found to replay',
    });
    expect(enrichment).not.toHaveBeenCalled();
  });

  it('replays 50 entries in one request (the DLQ_REPLAY_MAX_IDS boundary)', async () => {
    const ids = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      seedDlqEntry(`m-${i}`, 'description-cleanup', { ...CLEANUP_BODY, beerId: `beer-${i}` })));
    const { cleanup, worker } = queues();

    expect(await replay(worker, ids)).toMatchObject({ requested_count: 50, replayed_count: 50 });
    expect(cleanup).toHaveBeenCalledTimes(50);
  });

  it('returns 500 when the claim fails', async () => {
    const dlqId = await seedDlqEntry('m-2', 'description-cleanup', CLEANUP_BODY);
    const db = hookedDb(env.DB, {
      before: async () => {
        throw new Error('D1 unavailable');
      },
    });
    const { cleanup, worker } = queues();

    const response = await replayResponse({ ...worker, DB: db }, [dlqId]);

    expect(response.status).toBe(500);
    expect(cleanup).not.toHaveBeenCalled();
    expect(await dlqEntry(dlqId)).toMatchObject({ status: 'pending' });
  });
});
