import { describe, it, expect, vi } from 'vitest';
import { handleScheduledEnrichment } from '../../src/handlers/scheduled';
import type { Env } from '../../src/types';

// Mock refreshTaplistForStore
vi.mock('../../src/handlers/beers', () => ({
  refreshTaplistForStore: vi.fn().mockResolvedValue({
    beersRefreshed: 10,
    upstreamLatencyMs: 200,
    success: true,
  }),
}));

// Mock getCurrentHourCT to always return within operating hours (2pm CT)
vi.mock('../../src/utils/date', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/date')>();
  return {
    ...actual,
    getCurrentHourCT: vi.fn().mockReturnValue(14),
  };
});

import { refreshTaplistForStore } from '../../src/handlers/beers';
import { getCurrentHourCT } from '../../src/utils/date';

// ============================================================================
// Factories
// ============================================================================

type DbCallConfig = {
  readonly firstResult?: unknown;
  readonly allResults?: readonly unknown[];
  readonly runResult?: { meta: { changes: number } };
  readonly shouldThrow?: boolean;
};

function buildSequencedDb(configs: readonly DbCallConfig[]) {
  let callIndex = 0;
  const preparedStatements: Array<{ sql: string; boundArgs: unknown[] }> = [];

  const mockPrepare = vi.fn().mockImplementation((sql: string) => {
    const config = configs[callIndex] ?? configs[configs.length - 1];
    callIndex++;

    if (config?.shouldThrow) {
      return {
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockRejectedValue(new Error('DB unavailable')),
          first: vi.fn().mockRejectedValue(new Error('DB unavailable')),
          run: vi.fn().mockRejectedValue(new Error('DB unavailable')),
        }),
      };
    }

    return {
      bind: vi.fn().mockImplementation((...args: unknown[]) => {
        preparedStatements.push({ sql, boundArgs: args });
        return {
          all: vi.fn().mockResolvedValue({ results: config?.allResults ?? [] }),
          first: vi.fn().mockResolvedValue(config?.firstResult ?? null),
          run: vi.fn().mockResolvedValue(config?.runResult ?? { meta: { changes: 0 } }),
        };
      }),
    };
  });

  return {
    prepare: mockPrepare,
    batch: vi.fn().mockResolvedValue([]),
    preparedStatements,
  };
}

// Schedule check configs: first query returns null (first run = due),
// second query is the INSERT to advance the schedule.
const SCHEDULE_DUE_CONFIGS: readonly DbCallConfig[] = [
  { firstResult: null },
  {},
];

function createScheduledEnv(overrides?: Partial<Env>): Env {
  const defaultDb = buildSequencedDb([
    ...SCHEDULE_DUE_CONFIGS,
    { firstResult: { total: 0 } },
    { firstResult: { request_count: 0 } },
    { allResults: [] },
  ]);

  return {
    DB: defaultDb as unknown as D1Database,
    ANALYTICS: { writeDataPoint: vi.fn() },
    ENRICHMENT_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue,
    DAILY_ENRICHMENT_LIMIT: '500',
    MONTHLY_ENRICHMENT_LIMIT: '2000',
    ENRICHMENT_ENABLED: 'true',
    ...overrides,
  } as Env;
}

function createMockCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

// ============================================================================
// handleScheduledEnrichment — enrichment sweep
// ============================================================================

describe('handleScheduledEnrichment', () => {
  it('queries enriched_beers WHERE enrichment_status = pending', async () => {
    const db = buildSequencedDb([
      ...SCHEDULE_DUE_CONFIGS,
      { firstResult: { total: 0 } },
      { firstResult: { request_count: 0 } },
      { allResults: [] },
    ]);
    const env = createScheduledEnv({ DB: db as unknown as D1Database });

    await handleScheduledEnrichment(env, createMockCtx());

    const selectCall = db.preparedStatements.find(
      s => s.sql.includes('FROM enriched_beers')
    );
    expect(selectCall).toBeDefined();
    expect(selectCall!.sql).toContain('enrichment_status');
    expect(selectCall!.sql).toContain('pending');
    expect(selectCall!.sql).not.toContain('abv IS NULL');
  });

  it('batch-updates blocklisted beers to enrichment_status = skipped', async () => {
    const db = buildSequencedDb([
      ...SCHEDULE_DUE_CONFIGS,
      { firstResult: { total: 0 } },
      { firstResult: { request_count: 0 } },
      { allResults: [
        { id: 'beer-1', brew_name: 'Texas Flight', brewer: 'Brewery' },
        { id: 'beer-2', brew_name: 'Build Your Flight', brewer: 'Brewery' },
        { id: 'beer-3', brew_name: 'Real IPA', brewer: 'Brewery' },
      ]},
    ]);
    const env = createScheduledEnv({ DB: db as unknown as D1Database });

    await handleScheduledEnrichment(env, createMockCtx());

    expect(db.batch).toHaveBeenCalled();
    const batchArgs = db.batch.mock.calls[0]?.[0] as Array<{ sql: string }> | undefined;
    expect(batchArgs).toBeDefined();
    if (batchArgs) {
      expect(batchArgs.length).toBe(2);
    }
  });

  // ============================================================================
  // Taplist refresh phase
  // ============================================================================

  it('calls refreshTaplistForStore for each store in ENABLED_STORE_IDS', async () => {
    const env = createScheduledEnv();

    await handleScheduledEnrichment(env, createMockCtx());

    expect(refreshTaplistForStore).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      '13879',
      expect.any(String),
    );
  });

  it('continues enrichment sweep even when taplist refresh fails', async () => {
    vi.mocked(refreshTaplistForStore).mockRejectedValueOnce(new Error('FS down'));
    const db = buildSequencedDb([
      ...SCHEDULE_DUE_CONFIGS,
      { firstResult: { total: 0 } },
      { firstResult: { request_count: 0 } },
      { allResults: [
        { id: 'beer-1', brew_name: 'Test IPA', brewer: 'Brewery' },
      ]},
    ]);
    const env = createScheduledEnv({ DB: db as unknown as D1Database });
    const ctx = createMockCtx();

    await handleScheduledEnrichment(env, ctx);

    // Enrichment sweep should still run despite taplist refresh failure
    const sendBatch = env.ENRICHMENT_QUEUE.sendBatch as ReturnType<typeof vi.fn>;
    expect(sendBatch).toHaveBeenCalled();
  });

  it('skips taplist refresh when kill switch is active', async () => {
    const env = createScheduledEnv({ ENRICHMENT_ENABLED: 'false' });

    await handleScheduledEnrichment(env, createMockCtx());

    expect(refreshTaplistForStore).not.toHaveBeenCalled();
  });

  // ============================================================================
  // Schedule gating
  // ============================================================================

  it('skips entirely when cron is not yet due', async () => {
    const futureTime = Date.now() + 3_600_000;
    const db = buildSequencedDb([
      { firstResult: { next_run: futureTime } },
    ]);
    const env = createScheduledEnv({ DB: db as unknown as D1Database });
    const analytics = env.ANALYTICS as { writeDataPoint: ReturnType<typeof vi.fn> };

    await handleScheduledEnrichment(env, createMockCtx());

    expect(refreshTaplistForStore).not.toHaveBeenCalled();
    const dataPoint = analytics.writeDataPoint.mock.calls[0]?.[0];
    expect(dataPoint?.blobs?.[4]).toBe('skip:not_scheduled');
  });

  it('skips when outside operating hours', async () => {
    vi.mocked(getCurrentHourCT).mockReturnValueOnce(3); // 3am CT
    const env = createScheduledEnv();
    const analytics = env.ANALYTICS as { writeDataPoint: ReturnType<typeof vi.fn> };

    await handleScheduledEnrichment(env, createMockCtx());

    expect(refreshTaplistForStore).not.toHaveBeenCalled();
    const dataPoint = analytics.writeDataPoint.mock.calls[0]?.[0];
    expect(dataPoint?.blobs?.[4]).toBe('skip:outside_hours');
  });
});
