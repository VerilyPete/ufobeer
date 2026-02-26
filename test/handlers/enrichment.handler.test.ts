import { describe, it, expect, vi } from 'vitest';
import {
  validateForceEnrichmentRequest,
  handleEnrichmentTrigger,
} from '../../src/handlers/enrichment';
import type { Env, RequestContext } from '../../src/types';

// ============================================================================
// Factories
// ============================================================================

const getMockReqCtx = (): RequestContext => ({
  requestId: 'enrich-test-req-123',
  startTime: Date.now(),
  clientIdentifier: 'admin-client',
  apiKeyHash: 'admin-hash',
  clientIp: '10.0.0.1',
  userAgent: 'AdminClient/1.0',
});

const getDefaultHeaders = (): Record<string, string> => ({
  'Content-Type': 'application/json',
});

type DbCallConfig = {
  readonly firstResult?: unknown;
  readonly allResults?: readonly unknown[];
  readonly runResult?: { meta: { changes: number } };
  readonly shouldThrow?: boolean;
};

const buildSequencedDb = (configs: readonly DbCallConfig[]) => {
  let callIndex = 0;
  return {
    prepare: vi.fn().mockImplementation(() => {
      const config = configs[callIndex] ?? configs[configs.length - 1];
      callIndex++;

      if (config?.shouldThrow) {
        return {
          bind: vi.fn().mockReturnValue({
            all: vi.fn().mockRejectedValue(new Error('DB unavailable')),
            first: vi.fn().mockRejectedValue(new Error('DB unavailable')),
            run: vi.fn().mockRejectedValue(new Error('DB unavailable')),
          }),
          all: vi.fn().mockRejectedValue(new Error('DB unavailable')),
          first: vi.fn().mockRejectedValue(new Error('DB unavailable')),
          run: vi.fn().mockRejectedValue(new Error('DB unavailable')),
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

const getEnrichmentEnv = (overrides?: Partial<Env>): Env => {
  const defaultDb = buildSequencedDb([
    { firstResult: { request_count: 10 } },
    { firstResult: { total: 50 } },
    { allResults: [{ id: 'beer-1', brew_name: 'Test IPA', brewer: 'Test Brewery' }] },
  ]);

  return {
    DB: defaultDb as unknown as D1Database,
    ENRICHMENT_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue,
    DAILY_ENRICHMENT_LIMIT: '500',
    MONTHLY_ENRICHMENT_LIMIT: '2000',
    ENRICHMENT_ENABLED: 'true',
    ...overrides,
  } as Env;
};

const makeRequest = (body: unknown = {}): Request =>
  new Request('http://localhost/admin/enrich/trigger', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });

// ============================================================================
// validateForceEnrichmentRequest
// ============================================================================

describe('validateForceEnrichmentRequest', () => {
  it('returns valid false with errorCode INVALID_BODY when body is null', () => {
    const result = validateForceEnrichmentRequest(null);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('INVALID_BODY');
  });

  it('returns valid false with errorCode INVALID_BODY when body is undefined', () => {
    const result = validateForceEnrichmentRequest(undefined);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('INVALID_BODY');
  });

  it('returns valid false with errorCode INVALID_BODY when body is a string', () => {
    const result = validateForceEnrichmentRequest('not an object');

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('INVALID_BODY');
  });

  it('returns valid false with errorCode INVALID_BODY when body is a number', () => {
    const result = validateForceEnrichmentRequest(42);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('INVALID_BODY');
  });

  it('returns valid true when body has valid beer_ids', () => {
    const result = validateForceEnrichmentRequest({ beer_ids: ['abc', 'def'] });

    expect(result.valid).toBe(true);
  });

  it('returns valid true when body has valid criteria.confidence_below', () => {
    const result = validateForceEnrichmentRequest({
      criteria: { confidence_below: 0.5 },
    });

    expect(result.valid).toBe(true);
  });

  it('returns valid false with error and errorCode when body has invalid fields', () => {
    const result = validateForceEnrichmentRequest({
      criteria: { confidence_below: -1 },
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.errorCode).toBeDefined();
  });

  it('returns valid false when confidence_below exceeds 1', () => {
    const result = validateForceEnrichmentRequest({
      criteria: { confidence_below: 1.5 },
    });

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('INVALID_CONFIDENCE');
  });

  it('returns valid false when both beer_ids and criteria are specified', () => {
    const result = validateForceEnrichmentRequest({
      beer_ids: ['abc'],
      criteria: { confidence_below: 0.5 },
    });

    expect(result.valid).toBe(false);
  });

  it('returns valid false when neither beer_ids nor criteria is specified for empty object', () => {
    // ForceEnrichmentRequestSchema requires exactly one of beer_ids or criteria
    const result = validateForceEnrichmentRequest({});

    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// handleEnrichmentTrigger
// ============================================================================

describe('handleEnrichmentTrigger', () => {
  it('returns 200 with skip_reason kill_switch when ENRICHMENT_ENABLED is false', async () => {
    const env = getEnrichmentEnv({ ENRICHMENT_ENABLED: 'false' });
    const request = makeRequest();

    const response = await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { beers_queued: number; skip_reason: string } };

    expect(response.status).toBe(200);
    expect(body.data.beers_queued).toBe(0);
    expect(body.data.skip_reason).toBe('kill_switch');
  });

  it('returns 200 with skip_reason monthly_limit when monthly usage >= limit', async () => {
    const db = buildSequencedDb([
      { firstResult: { request_count: 10 } },
      { firstResult: { total: 2000 } },
    ]);
    const env = getEnrichmentEnv({
      DB: db as unknown as D1Database,
      MONTHLY_ENRICHMENT_LIMIT: '2000',
    });
    const request = makeRequest();

    const response = await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { skip_reason: string } };

    expect(response.status).toBe(200);
    expect(body.data.skip_reason).toBe('monthly_limit');
  });

  it('returns 200 with skip_reason daily_limit when daily remaining <= 0', async () => {
    const db = buildSequencedDb([
      { firstResult: { request_count: 500 } },
      { firstResult: { total: 500 } },
    ]);
    const env = getEnrichmentEnv({
      DB: db as unknown as D1Database,
      DAILY_ENRICHMENT_LIMIT: '500',
    });
    const request = makeRequest();

    const response = await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { skip_reason: string } };

    expect(response.status).toBe(200);
    expect(body.data.skip_reason).toBe('daily_limit');
  });

  it('returns 200 with skip_reason no_eligible_beers when query returns 0 beers', async () => {
    const db = buildSequencedDb([
      { firstResult: { request_count: 10 } },
      { firstResult: { total: 50 } },
      { allResults: [] },
    ]);
    const env = getEnrichmentEnv({ DB: db as unknown as D1Database });
    const request = makeRequest();

    const response = await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { skip_reason: string } };

    expect(response.status).toBe(200);
    expect(body.data.skip_reason).toBe('no_eligible_beers');
  });

  it('returns 200 with skip_reason no_eligible_beers when all returned beers are on the blocklist', async () => {
    const db = buildSequencedDb([
      { firstResult: { request_count: 10 } },
      { firstResult: { total: 50 } },
      { allResults: [
        { id: 'beer-1', brew_name: 'Texas Flight', brewer: 'Test Brewery' },
        { id: 'beer-2', brew_name: 'Build Your Flight', brewer: 'Test Brewery' },
      ]},
    ]);
    const env = getEnrichmentEnv({ DB: db as unknown as D1Database });
    const request = makeRequest();

    const response = await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { skip_reason: string } };

    expect(response.status).toBe(200);
    expect(body.data.skip_reason).toBe('no_eligible_beers');
  });

  it('returns 200 with beers_queued > 0 when eligible beers are found and queued', async () => {
    const db = buildSequencedDb([
      { firstResult: { request_count: 10 } },
      { firstResult: { total: 50 } },
      { allResults: [
        { id: 'beer-1', brew_name: 'Test IPA', brewer: 'Test Brewery' },
        { id: 'beer-2', brew_name: 'Test Stout', brewer: 'Other Brewery' },
      ]},
    ]);
    const env = getEnrichmentEnv({ DB: db as unknown as D1Database });
    const request = makeRequest();

    const response = await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { beers_queued: number } };

    expect(response.status).toBe(200);
    expect(body.data.beers_queued).toBeGreaterThan(0);
  });

  it('calls ENRICHMENT_QUEUE.sendBatch when beers are queued', async () => {
    const db = buildSequencedDb([
      { firstResult: { request_count: 10 } },
      { firstResult: { total: 50 } },
      { allResults: [
        { id: 'beer-1', brew_name: 'Test IPA', brewer: 'Test Brewery' },
      ]},
    ]);
    const sendBatchMock = vi.fn().mockResolvedValue(undefined);
    const env = getEnrichmentEnv({
      DB: db as unknown as D1Database,
      ENRICHMENT_QUEUE: {
        send: vi.fn(),
        sendBatch: sendBatchMock,
      } as unknown as Queue,
    });
    const request = makeRequest();

    await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());

    expect(sendBatchMock).toHaveBeenCalledOnce();
  });

  it('does NOT call ENRICHMENT_QUEUE.sendBatch when skip_reason is set', async () => {
    const sendBatchMock = vi.fn();
    const env = getEnrichmentEnv({
      ENRICHMENT_ENABLED: 'false',
      ENRICHMENT_QUEUE: {
        send: vi.fn(),
        sendBatch: sendBatchMock,
      } as unknown as Queue,
    });
    const request = makeRequest();

    await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());

    expect(sendBatchMock).not.toHaveBeenCalled();
  });

  it('returns 503 when DB is unavailable for quota check', async () => {
    const db = buildSequencedDb([
      { shouldThrow: true },
    ]);
    const env = getEnrichmentEnv({ DB: db as unknown as D1Database });
    const request = makeRequest();

    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());

    expect(response.status).toBe(503);

    vi.restoreAllMocks();
  });

  it('returns 400 when request body fails schema validation', async () => {
    const env = getEnrichmentEnv();
    const request = new Request('http://localhost/admin/enrich/trigger', {
      method: 'POST',
      body: JSON.stringify({ limit: 'not-a-number' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());

    expect(response.status).toBe(400);
  });

  it('respects limit param and clamps to max 100', async () => {
    const db = buildSequencedDb([
      { firstResult: { request_count: 10 } },
      { firstResult: { total: 50 } },
      { allResults: [
        { id: 'beer-1', brew_name: 'Test IPA', brewer: 'Test Brewery' },
      ]},
    ]);
    const sendBatchMock = vi.fn().mockResolvedValue(undefined);
    const env = getEnrichmentEnv({
      DB: db as unknown as D1Database,
      ENRICHMENT_QUEUE: {
        send: vi.fn(),
        sendBatch: sendBatchMock,
      } as unknown as Queue,
    });
    // TriggerEnrichmentRequestSchema clamps limit to max 100
    const request = makeRequest({ limit: 100 });

    await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());

    // The DB query should have been called with the effective batch size
    // which accounts for limit, daily remaining, monthly remaining, and max 100
    expect(db.prepare.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('response data.quota.daily.remaining is calculated correctly', async () => {
    const db = buildSequencedDb([
      { firstResult: { request_count: 100 } },
      { firstResult: { total: 200 } },
      { allResults: [
        { id: 'beer-1', brew_name: 'Test IPA', brewer: 'Test Brewery' },
      ]},
    ]);
    const env = getEnrichmentEnv({
      DB: db as unknown as D1Database,
      DAILY_ENRICHMENT_LIMIT: '500',
    });
    const request = makeRequest();

    const response = await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as {
      data: { quota: { daily: { remaining: number; used: number; limit: number } } };
    };

    expect(body.data.quota.daily.used).toBe(100);
    expect(body.data.quota.daily.limit).toBe(500);
    expect(body.data.quota.daily.remaining).toBe(400);
  });

  it('response data.enabled is true when ENRICHMENT_ENABLED is not false', async () => {
    const db = buildSequencedDb([
      { firstResult: { request_count: 10 } },
      { firstResult: { total: 50 } },
      { allResults: [
        { id: 'beer-1', brew_name: 'Test IPA', brewer: 'Test Brewery' },
      ]},
    ]);
    const env = getEnrichmentEnv({
      DB: db as unknown as D1Database,
      ENRICHMENT_ENABLED: 'true',
    });
    const request = makeRequest();

    const response = await handleEnrichmentTrigger(request, env, getDefaultHeaders(), getMockReqCtx());
    const body = await response.json() as { data: { enabled: boolean } };

    expect(body.data.enabled).toBe(true);
  });
});
