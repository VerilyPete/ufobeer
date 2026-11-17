import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  computeNextCronTime,
  checkAndAdvanceCronSchedule,
} from '../../src/handlers/scheduled';
import { CRON_INTERVAL_MS, CRON_JITTER_MS, CRON_SCHEDULE_KEY } from '../../src/constants';

// ============================================================================
// Factories
// ============================================================================

function buildMockDb(options: {
  selectResult?: unknown;
  claimResult?: unknown;
} = {}) {
  const boundCalls: Array<{ sql: string; args: unknown[] }> = [];
  const runMock = vi.fn().mockResolvedValue({ meta: { changes: 1 } });

  const mockPrepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockImplementation((...args: unknown[]) => {
      boundCalls.push({ sql, args });
      return {
        first: vi.fn().mockImplementation(() => {
          // Fast-path schedule read
          if (sql.includes('SELECT CAST(value AS INTEGER)')) {
            return Promise.resolve(options.selectResult ?? null);
          }
          // Atomic claim UPDATE ... RETURNING
          if (sql.includes('RETURNING value')) {
            return Promise.resolve(options.claimResult ?? null);
          }
          return Promise.resolve(null);
        }),
        run: runMock,
      };
    }),
  }));

  return { prepare: mockPrepare, boundCalls, runMock };
}

// ============================================================================
// computeNextCronTime
// ============================================================================

describe('computeNextCronTime', () => {
  const now = 1_700_000_000_000;

  it('returns now + 2h with no jitter when random returns 0.5', () => {
    const result = computeNextCronTime(now, () => 0.5);
    expect(result).toBe(now + CRON_INTERVAL_MS);
  });

  it('returns now + 1h40m when random returns 0 (minimum jitter)', () => {
    const result = computeNextCronTime(now, () => 0);
    expect(result).toBe(now + CRON_INTERVAL_MS - CRON_JITTER_MS);
  });

  it('returns now + 2h20m when random returns 1 (maximum jitter)', () => {
    const result = computeNextCronTime(now, () => 1);
    expect(result).toBe(now + CRON_INTERVAL_MS + CRON_JITTER_MS);
  });
});

// ============================================================================
// checkAndAdvanceCronSchedule
// ============================================================================

describe('checkAndAdvanceCronSchedule', () => {
  const NOW = new Date('2026-03-01T18:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true on first run (no schedule entry exists, epoch seed claims)', async () => {
    const db = buildMockDb({ selectResult: null, claimResult: { value: 'x' } });
    const result = await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.5,
    );
    expect(result).toBe(true);

    // The seed must be epoch 0 so a fresh system is immediately due
    const seedCall = db.boundCalls.find(c =>
      c.sql.includes('INSERT OR IGNORE INTO system_state'),
    );
    expect(seedCall).toBeDefined();
    expect(seedCall!.args[0]).toBe(CRON_SCHEDULE_KEY);
    expect(seedCall!.args[1]).toBe('0');
  });

  it('returns false when scheduled time is in the future', async () => {
    const db = buildMockDb({ selectResult: { next_run: NOW + 1 } });
    const result = await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.5,
    );
    expect(result).toBe(false);
  });

  it('claims the next schedule atomically via UPDATE ... RETURNING when due', async () => {
    const db = buildMockDb({ selectResult: null, claimResult: { value: 'next' } });
    await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.75,
    );

    const claimCall = db.boundCalls.find(c =>
      c.sql.includes('UPDATE system_state') && c.sql.includes('RETURNING value'),
    );
    expect(claimCall?.args).toEqual([String(NOW + CRON_INTERVAL_MS + CRON_JITTER_MS / 2), NOW, CRON_SCHEDULE_KEY, NOW]);
  });

  it('does not write anything when not due', async () => {
    const db = buildMockDb({ selectResult: { next_run: NOW + 1 } });
    await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.5,
    );

    const anyWrite = db.boundCalls.find(c =>
      c.sql.includes('INSERT OR IGNORE INTO system_state') ||
      c.sql.includes('UPDATE system_state'),
    );
    expect(anyWrite).toBeUndefined();
  });
});