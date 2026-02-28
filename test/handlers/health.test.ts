import { describe, it, expect, vi } from 'vitest';
import { handleHealthCheck } from '../../src/handlers/health';
import type { Env } from '../../src/types';

// ============================================================================
// Factories
// ============================================================================

type MockDbCall = {
  readonly result: unknown;
  readonly shouldThrow?: boolean;
};

const getMockDb = (overrides?: {
  selectOneResult?: unknown;
  selectOneThrows?: boolean;
  dailyResult?: { request_count: number } | null;
  dailyThrows?: boolean;
  monthlyResult?: { total: number } | null;
  monthlyThrows?: boolean;
}) => {
  const defaults = {
    selectOneResult: { '1': 1 },
    selectOneThrows: false,
    dailyResult: { request_count: 42 } as { request_count: number } | null,
    dailyThrows: false,
    monthlyResult: { total: 150 } as { total: number } | null,
    monthlyThrows: false,
  };
  const merged = { ...defaults, ...overrides };

  const calls: MockDbCall[] = [
    { result: merged.selectOneResult, shouldThrow: merged.selectOneThrows },
    { result: merged.dailyResult, shouldThrow: merged.dailyThrows },
    { result: merged.monthlyResult, shouldThrow: merged.monthlyThrows },
  ];

  let callIndex = 0;

  return {
    prepare: vi.fn().mockImplementation(() => {
      const currentCall = calls[callIndex];
      callIndex++;

      if (currentCall?.shouldThrow) {
        return {
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockRejectedValue(new Error('DB error')),
            all: vi.fn().mockRejectedValue(new Error('DB error')),
            run: vi.fn().mockRejectedValue(new Error('DB error')),
          }),
          first: vi.fn().mockRejectedValue(new Error('DB error')),
        };
      }

      return {
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(currentCall?.result ?? null),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({}),
        }),
        first: vi.fn().mockResolvedValue(currentCall?.result ?? null),
      };
    }),
  };
};

const getMockEnv = (overrides?: Partial<Env>): Env => ({
  DB: getMockDb() as unknown as D1Database,
  DAILY_ENRICHMENT_LIMIT: '500',
  MONTHLY_ENRICHMENT_LIMIT: '2000',
  ENRICHMENT_ENABLED: 'true',
  ...overrides,
} as Env);

// ============================================================================
// Tests
// ============================================================================

describe('handleHealthCheck', () => {
  it('returns a Response with status 200 on DB success', async () => {
    const env = getMockEnv();
    const response = await handleHealthCheck(env);

    expect(response.status).toBe(200);
  });

  it('response body has status ok', async () => {
    const env = getMockEnv();
    const response = await handleHealthCheck(env);
    const body = await response.json() as Record<string, unknown>;

    expect(body.status).toBe('ok');
  });

  it('response body has database connected', async () => {
    const env = getMockEnv();
    const response = await handleHealthCheck(env);
    const body = await response.json() as Record<string, unknown>;

    expect(body.database).toBe('connected');
  });

  it('response body has enrichment enabled true when ENRICHMENT_ENABLED is not false', async () => {
    const env = getMockEnv({ ENRICHMENT_ENABLED: 'true' });
    const response = await handleHealthCheck(env);
    const body = await response.json() as {
      enrichment: { enabled: boolean };
    };

    expect(body.enrichment.enabled).toBe(true);
  });

  it('response body has enrichment enabled false when ENRICHMENT_ENABLED is false', async () => {
    const env = getMockEnv({ ENRICHMENT_ENABLED: 'false' });
    const response = await handleHealthCheck(env);
    const body = await response.json() as {
      enrichment: { enabled: boolean };
    };

    expect(body.enrichment.enabled).toBe(false);
  });

  it('response body has enrichment daily used matching the DB result', async () => {
    const db = getMockDb({ dailyResult: { request_count: 75 } });
    const env = getMockEnv({ DB: db as unknown as D1Database });
    const response = await handleHealthCheck(env);
    const body = await response.json() as {
      enrichment: { daily: { used: number } };
    };

    expect(body.enrichment.daily.used).toBe(75);
  });

  it('response body has enrichment daily limit matching parseInt of env var', async () => {
    const env = getMockEnv({ DAILY_ENRICHMENT_LIMIT: '300' });
    const response = await handleHealthCheck(env);
    const body = await response.json() as {
      enrichment: { daily: { limit: number } };
    };

    expect(body.enrichment.daily.limit).toBe(300);
  });

  it('response body has enrichment daily remaining as limit minus used', async () => {
    const db = getMockDb({ dailyResult: { request_count: 42 } });
    const env = getMockEnv({
      DB: db as unknown as D1Database,
      DAILY_ENRICHMENT_LIMIT: '500',
    });
    const response = await handleHealthCheck(env);
    const body = await response.json() as {
      enrichment: { daily: { remaining: number } };
    };

    expect(body.enrichment.daily.remaining).toBe(458);
  });

  it('response body has enrichment monthly used matching the DB result', async () => {
    const db = getMockDb({ monthlyResult: { total: 800 } });
    const env = getMockEnv({ DB: db as unknown as D1Database });
    const response = await handleHealthCheck(env);
    const body = await response.json() as {
      enrichment: { monthly: { used: number } };
    };

    expect(body.enrichment.monthly.used).toBe(800);
  });

  it('response body has enrichment monthly remaining as limit minus used', async () => {
    const db = getMockDb({ monthlyResult: { total: 800 } });
    const env = getMockEnv({
      DB: db as unknown as D1Database,
      MONTHLY_ENRICHMENT_LIMIT: '2000',
    });
    const response = await handleHealthCheck(env);
    const body = await response.json() as {
      enrichment: { monthly: { remaining: number } };
    };

    expect(body.enrichment.monthly.remaining).toBe(1200);
  });

  it('daily remaining is 0 when used exceeds limit (not negative)', async () => {
    const db = getMockDb({ dailyResult: { request_count: 600 } });
    const env = getMockEnv({
      DB: db as unknown as D1Database,
      DAILY_ENRICHMENT_LIMIT: '500',
    });
    const response = await handleHealthCheck(env);
    const body = await response.json() as {
      enrichment: { daily: { remaining: number } };
    };

    expect(body.enrichment.daily.remaining).toBe(0);
  });

  it('uses default daily limit of 500 when DAILY_ENRICHMENT_LIMIT is not set', async () => {
    const env = getMockEnv({ DAILY_ENRICHMENT_LIMIT: undefined });
    const response = await handleHealthCheck(env);
    const body = await response.json() as {
      enrichment: { daily: { limit: number } };
    };

    expect(body.enrichment.daily.limit).toBe(500);
  });

  it('uses default monthly limit of 2000 when MONTHLY_ENRICHMENT_LIMIT is not set', async () => {
    const env = getMockEnv({ MONTHLY_ENRICHMENT_LIMIT: undefined });
    const response = await handleHealthCheck(env);
    const body = await response.json() as {
      enrichment: { monthly: { limit: number } };
    };

    expect(body.enrichment.monthly.limit).toBe(2000);
  });

  it('returns 503 when the initial SELECT 1 DB call throws', async () => {
    const db = getMockDb({ selectOneThrows: true });
    const env = getMockEnv({ DB: db as unknown as D1Database });
    const response = await handleHealthCheck(env);

    expect(response.status).toBe(503);
  });

  it('response body has status error on DB failure', async () => {
    const db = getMockDb({ selectOneThrows: true });
    const env = getMockEnv({ DB: db as unknown as D1Database });
    const response = await handleHealthCheck(env);
    const body = await response.json() as Record<string, unknown>;

    expect(body.status).toBe('error');
  });

  it('response body has database disconnected on DB failure', async () => {
    const db = getMockDb({ selectOneThrows: true });
    const env = getMockEnv({ DB: db as unknown as D1Database });
    const response = await handleHealthCheck(env);
    const body = await response.json() as Record<string, unknown>;

    expect(body.database).toBe('disconnected');
  });

  it('response body has generic error message on DB failure', async () => {
    const db = getMockDb({ selectOneThrows: true });
    const env = getMockEnv({ DB: db as unknown as D1Database });
    const response = await handleHealthCheck(env);
    const body = await response.json() as { error: string };

    expect(body.error).toBe('Database connection failed');
  });

  it('returns 200 with daily used 0 and monthly used 0 when enrichment_limits queries throw (graceful degradation)', async () => {
    const db = getMockDb({
      dailyThrows: true,
      monthlyThrows: true,
    });
    const env = getMockEnv({ DB: db as unknown as D1Database });

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await handleHealthCheck(env);
    const body = await response.json() as {
      status: string;
      enrichment: {
        daily: { used: number };
        monthly: { used: number };
      };
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.enrichment.daily.used).toBe(0);
    expect(body.enrichment.monthly.used).toBe(0);

    vi.restoreAllMocks();
  });
});
