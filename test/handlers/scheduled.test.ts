import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
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

// Mock the deterministic row reapers so tests can assert they were called
// from the cron handler without depending on real D1 SQL.
vi.mock('../../src/rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/rate-limit')>();
  return { ...real, reapOldRateLimits: vi.fn().mockResolvedValue(0) };
});
vi.mock('../../src/audit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/audit')>();
  return { ...real, reapOldAuditLog: vi.fn().mockResolvedValue(0) };
});

import { refreshTaplistForStore } from '../../src/handlers/beers';
import { getCurrentHourCT } from '../../src/utils/date';
import { reapOldRateLimits } from '../../src/rate-limit';
import { reapOldAuditLog } from '../../src/audit';

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

// Schedule gate configs, one per prepared statement in checkAndAdvanceCronSchedule:
// 1. fast-path SELECT (null = no row = immediately due),
// 2. INSERT OR IGNORE epoch seed (only .run() touched),
// 3. atomic claim UPDATE...RETURNING (must return a row for the claim to succeed).
const SCHEDULE_DUE_CONFIGS: readonly DbCallConfig[] = [
  { firstResult: null },
  {},
  { firstResult: { value: 'claimed' } },
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
  it('queries pending work and bounded expired lookup misses', async () => {
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
    expect(selectCall!.sql).toContain("enrichment_status = 'not_found' AND abv IS NULL AND updated_at <=");
    expect(selectCall!.sql).toContain('last_seen_at >=');
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

  it('marks blocklisted beers skipped even when every selected beer is blocklisted', async () => {
    const db = buildSequencedDb([
      ...SCHEDULE_DUE_CONFIGS,
      { firstResult: { total: 0 } },
      { firstResult: { request_count: 0 } },
      { allResults: [
        { id: 'beer-1', brew_name: 'Texas Flight', brewer: 'Brewery' },
        { id: 'beer-2', brew_name: '', brewer: '' },
      ]},
    ]);
    const env = createScheduledEnv({ DB: db as unknown as D1Database });

    await handleScheduledEnrichment(env, createMockCtx());

    const skipped = db.preparedStatements
      .filter(s => s.sql.includes("enrichment_status = 'skipped'"))
      .map(s => s.boundArgs);
    expect(skipped).toEqual([['beer-1'], ['beer-2']]);
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(env.ENRICHMENT_QUEUE.sendBatch).not.toHaveBeenCalled();
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
    const sendBatch = env.ENRICHMENT_QUEUE.sendBatch as Mock;
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
    const analytics = env.ANALYTICS as { writeDataPoint: Mock };

    await handleScheduledEnrichment(env, createMockCtx());

    expect(refreshTaplistForStore).not.toHaveBeenCalled();
    const dataPoint = analytics.writeDataPoint.mock.calls[0]?.[0];
    expect(dataPoint?.blobs?.[4]).toBe('skip:not_scheduled');
  });

  it('skips when outside operating hours', async () => {
    vi.mocked(getCurrentHourCT).mockReturnValueOnce(3); // 3am CT
    const env = createScheduledEnv();
    const analytics = env.ANALYTICS as { writeDataPoint: Mock };

    await handleScheduledEnrichment(env, createMockCtx());

    expect(refreshTaplistForStore).not.toHaveBeenCalled();
    const dataPoint = analytics.writeDataPoint.mock.calls[0]?.[0];
    expect(dataPoint?.blobs?.[4]).toBe('skip:outside_hours');
  });

  // ============================================================================
  // Deterministic row reapers (rate_limits, audit_log)
  // ============================================================================

  it('runs both the rate_limits and audit_log reapers on every cron tick', async () => {
    const env = createScheduledEnv();

    await handleScheduledEnrichment(env, createMockCtx());

    expect(reapOldRateLimits).toHaveBeenCalledWith(env.DB);
    expect(reapOldAuditLog).toHaveBeenCalledWith(env.DB);
  });

  it('still runs both reapers even when the kill switch is active', async () => {
    const env = createScheduledEnv({ ENRICHMENT_ENABLED: 'false' });

    await handleScheduledEnrichment(env, createMockCtx());

    expect(reapOldRateLimits).toHaveBeenCalledWith(env.DB);
    expect(reapOldAuditLog).toHaveBeenCalledWith(env.DB);
  });

  it('still runs both reapers when outside operating hours', async () => {
    vi.mocked(getCurrentHourCT).mockReturnValueOnce(3); // 3am CT
    const env = createScheduledEnv();

    await handleScheduledEnrichment(env, createMockCtx());

    expect(reapOldRateLimits).toHaveBeenCalledWith(env.DB);
    expect(reapOldAuditLog).toHaveBeenCalledWith(env.DB);
  });

  it('still runs the audit_log reaper even when the rate_limits reaper throws', async () => {
    vi.mocked(reapOldRateLimits).mockRejectedValueOnce(new Error('D1 unavailable'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = createScheduledEnv();

    await handleScheduledEnrichment(env, createMockCtx());

    expect(reapOldAuditLog).toHaveBeenCalledWith(env.DB);
    consoleSpy.mockRestore();
  });

  it('does not let a failing reaper block the enrichment sweep', async () => {
    vi.mocked(reapOldRateLimits).mockRejectedValueOnce(new Error('D1 unavailable'));
    vi.mocked(reapOldAuditLog).mockRejectedValueOnce(new Error('D1 unavailable'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = createScheduledEnv();

    await handleScheduledEnrichment(env, createMockCtx());

    expect(refreshTaplistForStore).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
