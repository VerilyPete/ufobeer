/**
 * DLQ housekeeping against real D1: acknowledge only touches pending
 * entries, the cron's retention sweep deletes only acknowledged or replayed
 * entries older than 30 days, and the stats and list endpoints report what
 * the table holds.
 */

import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupOldDlqMessages, handleDlqAcknowledge, handleDlqList, handleDlqStats } from '../../src/handlers/dlq';
import type { DlqMessageRow, RequestContext } from '../../src/types';
import { ENRICHMENT_BODY, seedDlqEntry } from './dlq-replay-harness';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
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

type DlqFields = Omit<DlqMessageRow, 'id'>;

const dlqRow = (messageId: string, overrides: Partial<DlqFields> = {}): DlqFields => ({
  message_id: messageId,
  beer_id: `beer-${messageId}`,
  beer_name: `Beer ${messageId}`,
  brewer: 'Seed Brewing',
  failed_at: NOW - 2 * DAY_MS,
  failure_count: 4,
  failure_reason: `timeout ${messageId}`,
  source_queue: 'beer-enrichment',
  status: 'pending',
  replay_count: 0,
  replayed_at: null,
  acknowledged_at: null,
  raw_message: JSON.stringify({ beerId: `beer-${messageId}` }),
  ...overrides,
});

const insertDlqRows = async (rows: readonly DlqFields[]): Promise<readonly number[]> => {
  const ids: number[] = [];
  for (const row of rows) {
    const id = await env.DB.prepare(
      `INSERT INTO dlq_messages (message_id, beer_id, beer_name, brewer, failed_at, failure_count,
         failure_reason, source_queue, status, replay_count, replayed_at, acknowledged_at, raw_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(
      row.message_id, row.beer_id, row.beer_name, row.brewer, row.failed_at, row.failure_count,
      row.failure_reason, row.source_queue, row.status, row.replay_count, row.replayed_at,
      row.acknowledged_at, row.raw_message,
    ).first<number>('id');
    if (id === null) throw new Error('DLQ insert failed');
    ids.push(id);
  }
  return ids;
};

const stats = async () => {
  const response = await handleDlqStats(env, {}, reqCtx);
  return { status: response.status, body: await response.json() };
};

type ListData = {
  readonly messages: readonly Record<string, unknown>[];
  readonly total_count: number;
  readonly limit: number;
  readonly next_cursor: string | null;
  readonly has_more: boolean;
};

const list = async (params: Record<string, string>): Promise<ListData> => {
  const response = await handleDlqList(env, {}, reqCtx, new URLSearchParams(params));
  const body: { readonly data: ListData } = await response.json();
  return body.data;
};

const listed = (id: number | undefined, row: DlqFields) => ({
  id,
  message_id: row.message_id,
  beer_id: row.beer_id,
  beer_name: row.beer_name,
  brewer: row.brewer,
  failed_at: row.failed_at,
  failure_count: row.failure_count,
  failure_reason: row.failure_reason,
  source_queue: row.source_queue,
  status: row.status,
  replay_count: row.replay_count,
  replayed_at: row.replayed_at,
  acknowledged_at: row.acknowledged_at,
});

const listedIds = (data: ListData) => data.messages.map((message) => message['id']);

const seedOldEntries = async (status: 'acknowledged' | 'replayed', count: number): Promise<void> => {
  const at = NOW - 31 * DAY_MS;
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO dlq_messages (message_id, beer_id, failed_at, status, acknowledged_at, replayed_at)
     SELECT ? || '-' || i, 'beer-' || i, ?, ?,
            CASE WHEN ? = 'acknowledged' THEN ? END,
            CASE WHEN ? = 'replayed' THEN ? END
     FROM n`
  ).bind(count, status, at, status, status, at, status, at).run();
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

  it('keeps deleting past the 1,000-row batch until every old acknowledged and replayed entry is gone', async () => {
    await seedOldEntries('acknowledged', 1001);
    await seedOldEntries('replayed', 1001);
    await seed('pending', { status: 'pending' });

    await cleanupOldDlqMessages(env.DB, 'dlq-housekeeping');

    expect(await statuses()).toEqual({ pending: 'pending' });
  });

  describe('handleDlqStats', () => {
    it('reports each status count, the oldest pending age, top brewers, repeat failures and the last 24 hours', async () => {
      await insertDlqRows([
        dlqRow('p-a1', { brewer: 'Alpha Ales', failed_at: NOW - 7.44 * HOUR_MS, replay_count: 2 }),
        dlqRow('p-a2', { brewer: 'Alpha Ales', failed_at: NOW - 2 * HOUR_MS, replay_count: 5 }),
        dlqRow('p-a3', { brewer: 'Alpha Ales', failed_at: NOW - 3 * HOUR_MS }),
        dlqRow('p-b1', { brewer: 'Bravo Brewing', failed_at: NOW - 4 * HOUR_MS, replay_count: 3, replayed_at: NOW - HOUR_MS }),
        dlqRow('p-b2', { brewer: 'Bravo Brewing', failed_at: NOW - 5 * HOUR_MS, acknowledged_at: NOW - HOUR_MS }),
        dlqRow('p-n', { brewer: null, failed_at: NOW - 6 * HOUR_MS }),
        dlqRow('r-1', { status: 'replaying', brewer: 'Charlie Cellars', failed_at: NOW - HOUR_MS, replay_count: 7 }),
        dlqRow('r-2', { status: 'replaying', brewer: 'Charlie Cellars', failed_at: NOW - HOUR_MS }),
        dlqRow('d-1', { status: 'replayed', brewer: 'Charlie Cellars', replay_count: 6, replayed_at: NOW - 2 * HOUR_MS }),
        dlqRow('d-2', { status: 'replayed', brewer: 'Charlie Cellars', replay_count: 6, replayed_at: NOW - 3 * HOUR_MS }),
        dlqRow('d-3', { status: 'replayed', brewer: 'Charlie Cellars', replay_count: 6, replayed_at: NOW - DAY_MS }),
        dlqRow('k-1', { status: 'acknowledged', brewer: 'Delta Draught', acknowledged_at: NOW - HOUR_MS }),
        dlqRow('k-2', { status: 'acknowledged', brewer: 'Delta Draught', acknowledged_at: NOW - 2 * HOUR_MS }),
        dlqRow('k-3', { status: 'acknowledged', brewer: 'Delta Draught', acknowledged_at: NOW - 3 * HOUR_MS }),
        dlqRow('k-4', { status: 'acknowledged', brewer: 'Delta Draught', failed_at: NOW - DAY_MS, acknowledged_at: NOW - 30 * HOUR_MS }),
      ]);

      expect(await stats()).toEqual({
        status: 200,
        body: {
          success: true,
          requestId: 'dlq-housekeeping',
          data: {
            by_status: { pending: 6, replaying: 2, replayed: 3, acknowledged: 4 },
            oldest_pending_age_hours: 7.4,
            top_failing_brewers: [
              { brewer: 'Alpha Ales', count: 3 },
              { brewer: 'Bravo Brewing', count: 2 },
            ],
            repeat_failures: [
              { beer_id: 'beer-p-a2', beer_name: 'Beer p-a2', replay_count: 5 },
              { beer_id: 'beer-p-b1', beer_name: 'Beer p-b1', replay_count: 3 },
              { beer_id: 'beer-p-a1', beer_name: 'Beer p-a1', replay_count: 2 },
            ],
            last_24h: { replayed_24h: 2, acknowledged_24h: 3, new_failures_24h: 8 },
          },
        },
      });
    });

    it('reports zero for statuses with no entries, and no pending age when nothing is pending', async () => {
      await insertDlqRows([
        dlqRow('d-1', { status: 'replayed', replayed_at: NOW - 2 * DAY_MS }),
        dlqRow('d-2', { status: 'replayed', replayed_at: NOW - 2 * DAY_MS }),
        dlqRow('d-3', { status: 'replayed', replayed_at: NOW - 2 * DAY_MS }),
        dlqRow('k-1', { status: 'acknowledged', acknowledged_at: NOW - 2 * DAY_MS }),
        dlqRow('k-2', { status: 'acknowledged', acknowledged_at: NOW - 2 * DAY_MS }),
      ]);

      expect((await stats()).body).toEqual({
        success: true,
        requestId: 'dlq-housekeeping',
        data: {
          by_status: { pending: 0, replaying: 0, replayed: 3, acknowledged: 2 },
          oldest_pending_age_hours: 0,
          top_failing_brewers: [],
          repeat_failures: [],
          last_24h: { replayed_24h: 0, acknowledged_24h: 0, new_failures_24h: 0 },
        },
      });
    });

    it('reports zero everywhere for an empty DLQ', async () => {
      expect((await stats()).body).toEqual({
        success: true,
        requestId: 'dlq-housekeeping',
        data: {
          by_status: { pending: 0, replaying: 0, replayed: 0, acknowledged: 0 },
          oldest_pending_age_hours: 0,
          top_failing_brewers: [],
          repeat_failures: [],
          last_24h: { replayed_24h: 0, acknowledged_24h: 0, new_failures_24h: 0 },
        },
      });
    });
  });

  describe('handleDlqList', () => {
    it('lists pending entries by default, newest failure first, without the raw message', async () => {
      const oldest = dlqRow('p-old', { failed_at: NOW - 3 * HOUR_MS });
      const newest = dlqRow('p-new', {
        failed_at: NOW - HOUR_MS, brewer: null, failure_reason: null, replay_count: 2, replayed_at: NOW - 2 * HOUR_MS,
      });
      const middle = dlqRow('p-mid', { failed_at: NOW - 2 * HOUR_MS, source_queue: 'description-cleanup', failure_count: 5 });
      const [oldestId, newestId, middleId] = await insertDlqRows([
        oldest,
        newest,
        middle,
        dlqRow('replayed', { status: 'replayed', failed_at: NOW - 30 * 60 * 1000, replayed_at: NOW }),
        dlqRow('acknowledged', { status: 'acknowledged', failed_at: NOW - 10 * 60 * 1000, acknowledged_at: NOW }),
      ]);

      expect(await list({})).toEqual({
        messages: [listed(newestId, newest), listed(middleId, middle), listed(oldestId, oldest)],
        total_count: 3,
        limit: 50,
        next_cursor: null,
        has_more: false,
      });
    });

    it('filters by status and beer ID, and status=all lists every status', async () => {
      const [pendingShared, pendingOther, replayedShared, acknowledged] = await insertDlqRows([
        dlqRow('p-1', { failed_at: NOW - 4 * HOUR_MS, beer_id: 'beer-shared' }),
        dlqRow('p-2', { failed_at: NOW - 3 * HOUR_MS }),
        dlqRow('d-1', { status: 'replayed', failed_at: NOW - 2 * HOUR_MS, beer_id: 'beer-shared' }),
        dlqRow('k-1', { status: 'acknowledged', failed_at: NOW - HOUR_MS }),
      ]);
      const summary = (data: ListData) => ({ ids: listedIds(data), total: data.total_count });

      expect({
        all: summary(await list({ status: 'all' })),
        replayed: summary(await list({ status: 'replayed' })),
        sharedBeer: summary(await list({ status: 'all', beer_id: 'beer-shared' })),
        pendingSharedBeer: summary(await list({ beer_id: 'beer-shared' })),
      }).toEqual({
        all: { ids: [acknowledged, replayedShared, pendingOther, pendingShared], total: 4 },
        replayed: { ids: [replayedShared], total: 1 },
        sharedBeer: { ids: [replayedShared, pendingShared], total: 2 },
        pendingSharedBeer: { ids: [pendingShared], total: 1 },
      });
    });

    it('includes the raw message when include_raw=true', async () => {
      const row = dlqRow('p-raw', { raw_message: '{"beerId":"beer-raw","attempt":3}' });
      const [id] = await insertDlqRows([row]);

      expect((await list({ include_raw: 'true' })).messages).toEqual([
        { ...listed(id, row), raw_message: '{"beerId":"beer-raw","attempt":3}' },
      ]);
    });

    it('pages through entries that share a failure time in id order, with no duplicates or gaps', async () => {
      const shared = NOW - 2 * HOUR_MS;
      const [early, s0, s1, s2, s3, s4, s5, , late1, late2] = await insertDlqRows([
        dlqRow('early', { failed_at: shared - 5 * 60 * 1000 }),
        ...Array.from({ length: 6 }, (_, i) => dlqRow(`same-${i}`, { failed_at: shared })),
        dlqRow('replayed-same', { status: 'replayed', failed_at: shared }),
        dlqRow('late-1', { failed_at: shared + 5 * 60 * 1000 }),
        dlqRow('late-2', { failed_at: shared + 5 * 60 * 1000 }),
      ]);

      const pages: { readonly ids: readonly unknown[]; readonly hasMore: boolean; readonly total: number }[] = [];
      let cursor: string | null = null;
      do {
        const data: ListData = await list(cursor === null ? { limit: '3' } : { limit: '3', cursor });
        pages.push({ ids: listedIds(data), hasMore: data.has_more, total: data.total_count });
        cursor = data.next_cursor;
      } while (cursor !== null && pages.length < 10);

      expect(pages).toEqual([
        { ids: [late2, late1, s5], hasMore: true, total: 9 },
        { ids: [s4, s3, s2], hasMore: true, total: 9 },
        { ids: [s1, s0, early], hasMore: false, total: 9 },
      ]);
    });
  });
});
