import { describe, it, expect, vi } from 'vitest';
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

  it('returns now + 4h with no jitter when random returns 0.5', () => {
    const result = computeNextCronTime(now, () => 0.5);
    expect(result).toBe(now + CRON_INTERVAL_MS);
  });

  it('returns now + 3h40m when random returns 0 (minimum jitter)', () => {
    const result = computeNextCronTime(now, () => 0);
    expect(result).toBe(now + CRON_INTERVAL_MS - CRON_JITTER_MS);
  });

  it('returns now + 4h20m when random returns 1 (maximum jitter)', () => {
    const result = computeNextCronTime(now, () => 1);
    expect(result).toBe(now + CRON_INTERVAL_MS + CRON_JITTER_MS);
  });
});

// ============================================================================
// checkAndAdvanceCronSchedule
// ============================================================================

describe('checkAndAdvanceCronSchedule', () => {
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

  it('returns true when scheduled time is in the past and the claim succeeds', async () => {
    const pastTime = Date.now() - 60_000;
    const db = buildMockDb({
      selectResult: { next_run: pastTime },
      claimResult: { value: 'claimed' },
    });
    const result = await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.5,
    );
    expect(result).toBe(true);
  });

  it('returns false when a concurrent caller already claimed (RETURNING empty)', async () => {
    const pastTime = Date.now() - 60_000;
    const db = buildMockDb({
      selectResult: { next_run: pastTime },
      claimResult: null,
    });
    const result = await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.5,
    );
    expect(result).toBe(false);
  });

  it('returns false when scheduled time is in the future', async () => {
    const futureTime = Date.now() + 3_600_000;
    const db = buildMockDb({ selectResult: { next_run: futureTime } });
    const result = await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.5,
    );
    expect(result).toBe(false);
  });

  it('claims the next schedule atomically via UPDATE ... RETURNING when due', async () => {
    const db = buildMockDb({ selectResult: null, claimResult: { value: 'next' } });
    const before = Date.now();
    await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.5,
    );

    const claimCall = db.boundCalls.find(c =>
      c.sql.includes('UPDATE system_state') && c.sql.includes('RETURNING value'),
    );
    expect(claimCall).toBeDefined();
    // Claim binds (nextRun, now, key, now)
    expect(claimCall!.args[2]).toBe(CRON_SCHEDULE_KEY);
    const claimedTime = Number(claimCall!.args[0]);
    expect(claimedTime).toBeGreaterThanOrEqual(before + CRON_INTERVAL_MS - CRON_JITTER_MS);
  });

  it('does not write anything when not due', async () => {
    const futureTime = Date.now() + 3_600_000;
    const db = buildMockDb({ selectResult: { next_run: futureTime } });
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