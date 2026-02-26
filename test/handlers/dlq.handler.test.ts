import { describe, it, expect, vi } from 'vitest';
import {
  handleDlqList,
  handleDlqReplay,
  handleDlqAcknowledge,
  cleanupOldDlqMessages,
} from '../../src/handlers/dlq';
import type { Env, RequestContext, DlqMessageRow } from '../../src/types';

// ============================================================================
// Factories
// ============================================================================

const getMockReqCtx = (): RequestContext => ({
  requestId: 'dlq-test-req-123',
  startTime: Date.now(),
  clientIdentifier: 'admin-client',
  apiKeyHash: 'admin-hash',
  clientIp: '10.0.0.1',
  userAgent: 'AdminClient/1.0',
});

const getDefaultHeaders = (): Record<string, string> => ({
  'Content-Type': 'application/json',
});

const getMockDlqRow = (overrides?: Partial<DlqMessageRow>): DlqMessageRow => ({
  id: 1,
  message_id: 'msg-001',
  beer_id: 'beer-001',
  beer_name: 'Test IPA',
  brewer: 'Test Brewery',
  failed_at: Date.now(),
  failure_count: 3,
  failure_reason: null,
  source_queue: 'beer-enrichment',
  status: 'pending',
  replay_count: 0,
  replayed_at: null,
  acknowledged_at: null,
  raw_message: JSON.stringify({ beerId: 'beer-001', beerName: 'Test IPA', brewer: 'Test Brewery' }),
  ...overrides,
});

type DbMockConfig = {
  readonly allResults?: readonly unknown[];
  readonly firstResult?: unknown;
  readonly runResult?: { meta: { changes: number } };
  readonly shouldThrow?: boolean;
};

const buildSequencedDb = (configs: readonly DbMockConfig[]) => {
  let callIndex = 0;
  return {
    prepare: vi.fn().mockImplementation(() => {
      const config = configs[callIndex] ?? configs[configs.length - 1];
      callIndex++;

      if (config?.shouldThrow) {
        return {
          bind: vi.fn().mockReturnValue({
            all: vi.fn().mockRejectedValue(new Error('DB error')),
            first: vi.fn().mockRejectedValue(new Error('DB error')),
            run: vi.fn().mockRejectedValue(new Error('DB error')),
          }),
          all: vi.fn().mockRejectedValue(new Error('DB error')),
          first: vi.fn().mockRejectedValue(new Error('DB error')),
          run: vi.fn().mockRejectedValue(new Error('DB error')),
        };
      }

      return {
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: config?.allResults ?? [] }),
          first: vi.fn().mockResolvedValue(config?.firstResult ?? null),
          run: vi.fn().mockResolvedValue(config?.runResult ?? { meta: { changes: 0 } }),
        }),
        all: vi.fn().mockResolvedValue({ results: config?.allResults ?? [] }),
        first: vi.fn().mockResolvedValue(config?.firstResult ?? null),
        run: vi.fn().mockResolvedValue(config?.runResult ?? { meta: { changes: 0 } }),
      };
    }),
  };
};

const getMockEnv = (db: unknown): Env => ({
  DB: db as D1Database,
  ENRICHMENT_QUEUE: {
    send: vi.fn().mockResolvedValue(undefined),
    sendBatch: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queue,
} as Env);

// ============================================================================
// handleDlqList
// ============================================================================

describe('handleDlqList', () => {
  it('returns a Response with status 200 on success', async () => {
    const row = getMockDlqRow();
    const db = buildSequencedDb([
      { allResults: [row] },
      { firstResult: { count: 1 } },
    ]);
    const env = getMockEnv(db);
    const params = new URLSearchParams();

    const response = await handleDlqList(env, getDefaultHeaders(), getMockReqCtx(), params);

    expect(response.status).toBe(200);
  });

  it('response body has success true', async () => {
    const db = buildSequencedDb([
      { allResults: [] },
      { firstResult: { count: 0 } },
    ]);
    const env = getMockEnv(db);
    const params = new URLSearchParams();

    const response = await handleDlqList(env, getDefaultHeaders(), getMockReqCtx(), params);
    const body = await response.json() as { success: boolean };

    expect(body.success).toBe(true);
  });

  it('response body has data.messages as an array', async () => {
    const db = buildSequencedDb([
      { allResults: [getMockDlqRow()] },
      { firstResult: { count: 1 } },
    ]);
    const env = getMockEnv(db);
    const params = new URLSearchParams();

    const response = await handleDlqList(env, getDefaultHeaders(), getMockReqCtx(), params);
    const body = await response.json() as { data: { messages: unknown[] } };

    expect(Array.isArray(body.data.messages)).toBe(true);
  });

  it('response body has data.total_count', async () => {
    const db = buildSequencedDb([
      { allResults: [getMockDlqRow()] },
      { firstResult: { count: 5 } },
    ]);
    const env = getMockEnv(db);
    const params = new URLSearchParams();

    const response = await handleDlqList(env, getDefaultHeaders(), getMockReqCtx(), params);
    const body = await response.json() as { data: { total_count: number } };

    expect(body.data.total_count).toBe(5);
  });

  it('response body has data.has_more', async () => {
    const db = buildSequencedDb([
      { allResults: [] },
      { firstResult: { count: 0 } },
    ]);
    const env = getMockEnv(db);
    const params = new URLSearchParams();

    const response = await handleDlqList(env, getDefaultHeaders(), getMockReqCtx(), params);
    const body = await response.json() as { data: { has_more: boolean } };

    expect(typeof body.data.has_more).toBe('boolean');
  });

  it('does NOT include raw_message in message objects by default', async () => {
    const row = getMockDlqRow({ raw_message: '{"beerId":"beer-001"}' });
    const db = buildSequencedDb([
      { allResults: [row] },
      { firstResult: { count: 1 } },
    ]);
    const env = getMockEnv(db);
    const params = new URLSearchParams();

    const response = await handleDlqList(env, getDefaultHeaders(), getMockReqCtx(), params);
    const body = await response.json() as { data: { messages: Array<Record<string, unknown>> } };

    expect(body.data.messages[0]).not.toHaveProperty('raw_message');
  });

  it('includes raw_message in message objects when include_raw=true', async () => {
    const rawMsg = '{"beerId":"beer-001"}';
    const row = getMockDlqRow({ raw_message: rawMsg });
    const db = buildSequencedDb([
      { allResults: [row] },
      { firstResult: { count: 1 } },
    ]);
    const env = getMockEnv(db);
    const params = new URLSearchParams({ include_raw: 'true' });

    const response = await handleDlqList(env, getDefaultHeaders(), getMockReqCtx(), params);
    const body = await response.json() as { data: { messages: Array<{ raw_message: string }> } };

    expect(body.data.messages[0]?.raw_message).toBe(rawMsg);
  });

  it('returns status 400 when cursor param is malformed', async () => {
    const db = buildSequencedDb([]);
    const env = getMockEnv(db);
    const params = new URLSearchParams({ cursor: 'not-valid-base64!@#$' });

    const response = await handleDlqList(env, getDefaultHeaders(), getMockReqCtx(), params);

    expect(response.status).toBe(400);
  });

  it('returns status 400 when cursor base64 decodes but fails schema', async () => {
    const db = buildSequencedDb([]);
    const env = getMockEnv(db);
    const invalidCursor = btoa(JSON.stringify({ wrong: 'shape' }));
    const params = new URLSearchParams({ cursor: invalidCursor });

    const response = await handleDlqList(env, getDefaultHeaders(), getMockReqCtx(), params);

    expect(response.status).toBe(400);
  });

  it('returns status 500 when DB throws', async () => {
    const db = buildSequencedDb([{ shouldThrow: true }]);
    const env = getMockEnv(db);
    const params = new URLSearchParams();

    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleDlqList(env, getDefaultHeaders(), getMockReqCtx(), params);

    expect(response.status).toBe(500);

    vi.restoreAllMocks();
  });

  it('defaults to status=pending filter when no status param provided', async () => {
    const db = buildSequencedDb([
      { allResults: [] },
      { firstResult: { count: 0 } },
    ]);
    const env = getMockEnv(db);
    const params = new URLSearchParams();

    await handleDlqList(env, getDefaultHeaders(), getMockReqCtx(), params);

    const firstPrepareCall = db.prepare.mock.calls[0]?.[0] as string;
    expect(firstPrepareCall).toContain('status = ?');
  });

  it('accepts status=all to remove status filter', async () => {
    const db = buildSequencedDb([
      { allResults: [] },
      { firstResult: { count: 0 } },
    ]);
    const env = getMockEnv(db);
    const params = new URLSearchParams({ status: 'all' });

    await handleDlqList(env, getDefaultHeaders(), getMockReqCtx(), params);

    const firstPrepareCall = db.prepare.mock.calls[0]?.[0] as string;
    expect(firstPrepareCall).not.toContain('status = ?');
  });
});

// ============================================================================
// handleDlqReplay
// ============================================================================

describe('handleDlqReplay', () => {
  it('returns 200 with replayed_count > 0 when messages are found and queued successfully', async () => {
    const rawMessage = JSON.stringify({ beerId: 'beer-001', beerName: 'Test IPA', brewer: 'Test Brewery' });
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 1 } } },
      { allResults: [{ id: 1, raw_message: rawMessage, replay_count: 0 }] },
      { runResult: { meta: { changes: 1 } } },
    ]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      body: JSON.stringify({ ids: [1] }),
    });

    const response = await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { replayed_count: number } };

    expect(response.status).toBe(200);
    expect(body.data.replayed_count).toBeGreaterThan(0);
  });

  it('the optimistic status update sets status to replaying before queue send', async () => {
    const rawMessage = JSON.stringify({ beerId: 'beer-001', beerName: 'Test IPA', brewer: 'Test Brewery' });
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 1 } } },
      { allResults: [{ id: 1, raw_message: rawMessage, replay_count: 0 }] },
      { runResult: { meta: { changes: 1 } } },
    ]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      body: JSON.stringify({ ids: [1] }),
    });

    await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());

    const firstSql = db.prepare.mock.calls[0]?.[0] as string;
    expect(firstSql).toContain("status = 'replaying'");
  });

  it('on successful queue send sets status to replayed and increments replay_count', async () => {
    const rawMessage = JSON.stringify({ beerId: 'beer-001', beerName: 'Test IPA', brewer: 'Test Brewery' });
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 1 } } },
      { allResults: [{ id: 1, raw_message: rawMessage, replay_count: 0 }] },
      { runResult: { meta: { changes: 1 } } },
    ]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      body: JSON.stringify({ ids: [1] }),
    });

    await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());

    const successUpdateSql = db.prepare.mock.calls[2]?.[0] as string;
    expect(successUpdateSql).toContain("status = 'replayed'");
    expect(successUpdateSql).toContain('replay_count = replay_count + 1');
  });

  it('on queue send failure rolls back status to pending', async () => {
    const rawMessage = JSON.stringify({ beerId: 'beer-001', beerName: 'Test IPA', brewer: 'Test Brewery' });
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 1 } } },
      { allResults: [{ id: 1, raw_message: rawMessage, replay_count: 0 }] },
      { runResult: { meta: { changes: 1 } } },
    ]);
    const env = getMockEnv(db);
    (env.ENRICHMENT_QUEUE as { send: ReturnType<typeof vi.fn> }).send = vi.fn().mockRejectedValue(new Error('Queue send failed'));
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      body: JSON.stringify({ ids: [1] }),
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());

    const rollbackSql = db.prepare.mock.calls[2]?.[0] as string;
    expect(rollbackSql).toContain("status = 'pending'");

    vi.restoreAllMocks();
  });

  it('returns 200 with replayed_count 0 and message when no pending messages found', async () => {
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 0 } } },
    ]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      body: JSON.stringify({ ids: [999] }),
    });

    const response = await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { replayed_count: number; message: string } };

    expect(response.status).toBe(200);
    expect(body.data.replayed_count).toBe(0);
    expect(body.data.message).toContain('No pending messages');
  });

  it('limits batch to 50 IDs even if more are provided', async () => {
    const manyIds = Array.from({ length: 60 }, (_, i) => i + 1);
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 0 } } },
    ]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      body: JSON.stringify({ ids: manyIds }),
    });

    const response = await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { requested_count: number } };

    expect(body.data.requested_count).toBe(50);
  });

  it('returns 400 when request body fails schema validation', async () => {
    const db = buildSequencedDb([]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      body: JSON.stringify({ wrong: 'shape' }),
    });

    const response = await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());

    expect(response.status).toBe(400);
  });

  it('returns 500 when DB throws unexpectedly', async () => {
    const db = buildSequencedDb([{ shouldThrow: true }]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      body: JSON.stringify({ ids: [1] }),
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());

    expect(response.status).toBe(500);

    vi.restoreAllMocks();
  });

  it('skips corrupt DLQ rows where raw_message fails schema validation and includes those IDs in failed_count', async () => {
    const corruptRawMessage = JSON.stringify({ invalid: 'data' });
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 1 } } },
      { allResults: [{ id: 1, raw_message: corruptRawMessage, replay_count: 0 }] },
      { runResult: { meta: { changes: 1 } } },
    ]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      body: JSON.stringify({ ids: [1] }),
    });

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { failed_count: number; replayed_count: number } };

    expect(body.data.failed_count).toBe(1);
    expect(body.data.replayed_count).toBe(0);

    vi.restoreAllMocks();
  });
});

// ============================================================================
// handleDlqAcknowledge
// ============================================================================

describe('handleDlqAcknowledge', () => {
  it('returns 200 with acknowledged_count on success', async () => {
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 3 } } },
    ]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/acknowledge', {
      method: 'POST',
      body: JSON.stringify({ ids: [1, 2, 3] }),
    });

    const response = await handleDlqAcknowledge(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { acknowledged_count: number } };

    expect(response.status).toBe(200);
    expect(body.data.acknowledged_count).toBe(3);
  });

  it('only acknowledges messages with status pending', async () => {
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 1 } } },
    ]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/acknowledge', {
      method: 'POST',
      body: JSON.stringify({ ids: [1] }),
    });

    const response = await handleDlqAcknowledge(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { acknowledged_count: number } };

    expect(body.data.acknowledged_count).toBe(1);
  });

  it('limits to 100 IDs even if more are provided', async () => {
    const manyIds = Array.from({ length: 120 }, (_, i) => i + 1);
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 100 } } },
    ]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/acknowledge', {
      method: 'POST',
      body: JSON.stringify({ ids: manyIds }),
    });

    const response = await handleDlqAcknowledge(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { success: boolean };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    const sql = db.prepare.mock.calls[0]?.[0] as string;
    const placeholderCount = (sql.match(/\?/g) ?? []).length;
    // 1 for `now` timestamp + 100 for the limited IDs
    expect(placeholderCount).toBe(101);
  });

  it('returns 400 when ids array is missing from request body', async () => {
    const db = buildSequencedDb([]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/acknowledge', {
      method: 'POST',
      body: JSON.stringify({ wrong: 'shape' }),
    });

    const response = await handleDlqAcknowledge(request, env, getDefaultHeaders(), getMockReqCtx());

    expect(response.status).toBe(400);
  });

  it('returns 500 when DB throws', async () => {
    const db = buildSequencedDb([{ shouldThrow: true }]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/acknowledge', {
      method: 'POST',
      body: JSON.stringify({ ids: [1] }),
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleDlqAcknowledge(request, env, getDefaultHeaders(), getMockReqCtx());

    expect(response.status).toBe(500);

    vi.restoreAllMocks();
  });
});

// ============================================================================
// cleanupOldDlqMessages
// ============================================================================

describe('cleanupOldDlqMessages', () => {
  it('calls delete for acknowledged messages older than 30 days', async () => {
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 5 } } },
      { runResult: { meta: { changes: 0 } } },
    ]);

    await cleanupOldDlqMessages(db as unknown as D1Database, 'req-cleanup');

    const firstSql = db.prepare.mock.calls[0]?.[0] as string;
    expect(firstSql).toContain("status = 'acknowledged'");
    expect(firstSql).toContain('acknowledged_at < ?');
  });

  it('calls delete for replayed messages older than 30 days', async () => {
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 0 } } },
      { runResult: { meta: { changes: 5 } } },
      { runResult: { meta: { changes: 0 } } },
    ]);

    await cleanupOldDlqMessages(db as unknown as D1Database, 'req-cleanup');

    const replaySql = db.prepare.mock.calls[1]?.[0] as string;
    expect(replaySql).toContain("status = 'replayed'");
    expect(replaySql).toContain('replayed_at < ?');
  });

  it('loops if a batch deletes exactly batchLimit records (continues deleting)', async () => {
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 1000 } } },
      { runResult: { meta: { changes: 50 } } },
      { runResult: { meta: { changes: 0 } } },
    ]);

    await cleanupOldDlqMessages(db as unknown as D1Database, 'req-cleanup');

    // Should have called prepare at least 3 times:
    // ack batch 1 (1000 = batchLimit), ack batch 2 (50 < batchLimit), replay batch 1 (0)
    expect(db.prepare.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('stops looping when a batch deletes fewer than batchLimit records', async () => {
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 10 } } },
      { runResult: { meta: { changes: 5 } } },
    ]);

    await cleanupOldDlqMessages(db as unknown as D1Database, 'req-cleanup');

    // Exactly 2 calls: one for acknowledged (10 < 1000), one for replayed (5 < 1000)
    expect(db.prepare.mock.calls.length).toBe(2);
  });
});
