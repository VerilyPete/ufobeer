/**
 * DLQ acknowledge and retention against real D1: acknowledge only touches
 * pending entries, and the cron's retention sweep deletes only acknowledged
 * or replayed entries older than 30 days.
 */

import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupOldDlqMessages, handleDlqAcknowledge } from '../../src/handlers/dlq';
import type { RequestContext } from '../../src/types';
import { ENRICHMENT_BODY, seedDlqEntry } from './dlq-replay-harness';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-01T12:00:00Z').getTime();

const reqCtx: RequestContext = {
  requestId: 'dlq-housekeeping',
  startTime: 0,
  clientIdentifier: 'admin',
  apiKeyHash: 'hash',
  clientIp: '127.0.0.1',
  userAgent: 'test',
};

type Seed = { readonly status: 'pending' | 'acknowledged' | 'replaying' | 'replayed'; readonly ageDays?: number };

const seed = async (messageId: string, { status, ageDays = 0 }: Seed): Promise<number> => {
  const id = await seedDlqEntry(messageId, 'beer-enrichment', ENRICHMENT_BODY);
  const at = Date.now() - ageDays * DAY_MS;
  await env.DB.prepare(
    `UPDATE dlq_messages SET status = ?,
       acknowledged_at = CASE WHEN ? = 'acknowledged' THEN ? END,
       replayed_at = CASE WHEN ? = 'replayed' THEN ? END
     WHERE id = ?`
  ).bind(status, status, at, status, at, id).run();
  return id;
};

const statuses = async (): Promise<Record<string, string>> => {
  const { results } = await env.DB.prepare('SELECT message_id, status FROM dlq_messages')
    .all<{ message_id: string; status: string }>();
  return Object.fromEntries(results.map((row) => [row.message_id, row.status]));
};

const rows = async () =>
  (await env.DB.prepare(
    'SELECT message_id, status, acknowledged_at, replay_claim FROM dlq_messages ORDER BY message_id'
  ).all()).results;

const acknowledge = async (ids: readonly number[]) => {
  const response = await handleDlqAcknowledge(new Request('https://api.ufobeer.app/admin/dlq/acknowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }), env, {}, reqCtx);
  return { status: response.status, body: await response.json() };
};

describe('DLQ housekeeping (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM dlq_messages').run();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('acknowledges only the requested pending entries and reports the rest as not acknowledged', async () => {
    const pending = await seed('pending', { status: 'pending' });
    await seed('pending-unrequested', { status: 'pending' });
    const replaying = await seed('replaying', { status: 'replaying' });
    await env.DB.prepare('UPDATE dlq_messages SET replay_claim = ?, replay_claimed_at = ? WHERE id = ?')
      .bind('claim-token', Date.now(), replaying).run();
    const replayed = await seed('replayed', { status: 'replayed' });
    const acknowledged = await seed('acknowledged', { status: 'acknowledged', ageDays: 10 });
    const before = await rows();

    const { status, body } = await acknowledge([pending, replaying, replayed, acknowledged, 9999]);

    expect(status).toBe(200);
    expect(body).toMatchObject({ data: { acknowledged_count: 1, requested_count: 5, failed_count: 4 } });
    const after = await rows();
    expect(after.filter((row) => row.message_id !== 'pending')).toEqual(before.filter((row) => row.message_id !== 'pending'));
    expect(after.find((row) => row.message_id === 'pending')).toMatchObject({ status: 'acknowledged', acknowledged_at: NOW });
  });

  it('deletes acknowledged and replayed entries older than 30 days and keeps everything else', async () => {
    await seed('acknowledged-31d', { status: 'acknowledged', ageDays: 31 });
    await seed('acknowledged-29d', { status: 'acknowledged', ageDays: 29 });
    await seed('replayed-31d', { status: 'replayed', ageDays: 31 });
    await seed('replayed-29d', { status: 'replayed', ageDays: 29 });
    await seed('pending', { status: 'pending' });

    await cleanupOldDlqMessages(env.DB, 'dlq-housekeeping');

    expect(await statuses()).toEqual({
      'acknowledged-29d': 'acknowledged',
      'replayed-29d': 'replayed',
      pending: 'pending',
    });
  });
});
