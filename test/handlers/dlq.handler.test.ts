import { describe, it, expect, vi } from 'vitest';
import {
  handleDlqList,
  handleDlqReplay,
  handleDlqAcknowledge,
} from '../../src/handlers/dlq';
import type { Env, RequestContext } from '../../src/types';

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
  CLEANUP_QUEUE: {
    send: vi.fn().mockResolvedValue(undefined),
    sendBatch: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queue,
} as Env);

// ============================================================================
// handleDlqList
// ============================================================================

describe('handleDlqList', () => {
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
});

// ============================================================================
// handleDlqReplay
// ============================================================================

// The replay itself is tested against real D1 in dlq-replay.integration.test.ts,
// dlq-replay-lease.integration.test.ts and dlq-verified.integration.test.ts.
describe('handleDlqReplay request validation', () => {
  it('rejects a request with more than 50 IDs (DLQ_REPLAY_MAX_IDS) instead of silently truncating', async () => {
    const manyIds = Array.from({ length: 60 }, (_, i) => i + 1);
    const db = buildSequencedDb([]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: manyIds }),
    });

    const response = await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { success: boolean; error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 400 when request body fails schema validation', async () => {
    const db = buildSequencedDb([]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrong: 'shape' }),
    });

    const response = await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());

    expect(response.status).toBe(400);
  });
});

// ============================================================================
// handleDlqAcknowledge
// ============================================================================

describe('handleDlqAcknowledge', () => {
  it('rejects a request with more than 100 IDs (DLQ_ACKNOWLEDGE_MAX_IDS) instead of silently truncating', async () => {
    const manyIds = Array.from({ length: 120 }, (_, i) => i + 1);
    const db = buildSequencedDb([]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: manyIds }),
    });

    const response = await handleDlqAcknowledge(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { success: boolean; error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('accepts a request with exactly 100 IDs (the DLQ_ACKNOWLEDGE_MAX_IDS boundary)', async () => {
    const hundredIds = Array.from({ length: 100 }, (_, i) => i + 1);
    const db = buildSequencedDb([
      { runResult: { meta: { changes: 100 } } },
    ]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: hundredIds }),
    });

    const response = await handleDlqAcknowledge(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { success: boolean };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    const sql = db.prepare.mock.calls[0]?.[0] as string;
    const placeholderCount = (sql.match(/\?/g) ?? []).length;
    // 1 for `now` timestamp + 100 IDs
    expect(placeholderCount).toBe(101);
  });

  it('returns 400 when ids array is missing from request body', async () => {
    const db = buildSequencedDb([]);
    const env = getMockEnv(db);
    const request = new Request('http://localhost/admin/dlq/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1] }),
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleDlqAcknowledge(request, env, getDefaultHeaders(), getMockReqCtx());

    expect(response.status).toBe(500);

    vi.restoreAllMocks();
  });
});

// ============================================================================
// Bounded body guard — /admin/dlq/replay and /admin/dlq/acknowledge
// ============================================================================

describe('DLQ handlers bounded body guard', () => {
  it('handleDlqReplay returns 415 when Content-Type is not application/json', async () => {
    const env = getMockEnv(buildSequencedDb([]));
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ids: [1] }),
    });

    const response = await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(415);
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('handleDlqReplay returns 413 when the body exceeds SMALL_JSON_BODY_MAX_BYTES', async () => {
    const env = getMockEnv(buildSequencedDb([]));
    const oversized = JSON.stringify({ ids: [1], note: 'x'.repeat(100_000) });
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    });

    const response = await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(413);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('handleDlqReplay returns 400 for malformed JSON', async () => {
    const env = getMockEnv(buildSequencedDb([]));
    const request = new Request('http://localhost/admin/dlq/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });

    const response = await handleDlqReplay(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('INVALID_JSON');
  });

  it('handleDlqAcknowledge returns 415 when Content-Type is not application/json', async () => {
    const env = getMockEnv(buildSequencedDb([]));
    const request = new Request('http://localhost/admin/dlq/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ids: [1] }),
    });

    const response = await handleDlqAcknowledge(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(415);
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('handleDlqAcknowledge returns 413 when the body exceeds SMALL_JSON_BODY_MAX_BYTES', async () => {
    const env = getMockEnv(buildSequencedDb([]));
    const oversized = JSON.stringify({ ids: [1], note: 'x'.repeat(100_000) });
    const request = new Request('http://localhost/admin/dlq/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    });

    const response = await handleDlqAcknowledge(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(413);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('handleDlqAcknowledge returns 400 for malformed JSON', async () => {
    const env = getMockEnv(buildSequencedDb([]));
    const request = new Request('http://localhost/admin/dlq/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });

    const response = await handleDlqAcknowledge(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('INVALID_JSON');
  });
});
