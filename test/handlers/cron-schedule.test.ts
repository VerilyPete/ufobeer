import { describe, it, expect, vi } from 'vitest';
import {
  computeNextCronTime,
  checkAndAdvanceCronSchedule,
  isWithinOperatingHours,
} from '../../src/handlers/scheduled';
import { CRON_INTERVAL_MS, CRON_JITTER_MS, CRON_SCHEDULE_KEY } from '../../src/constants';

// ============================================================================
// Factories
// ============================================================================

function buildMockDb(firstResult: unknown = null) {
  const boundCalls: Array<{ sql: string; args: unknown[] }> = [];
  const runMock = vi.fn().mockResolvedValue({ meta: { changes: 1 } });

  const mockPrepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockImplementation((...args: unknown[]) => {
      boundCalls.push({ sql, args });
      return {
        first: vi.fn().mockResolvedValue(firstResult),
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
  it('returns true on first run (no schedule entry exists)', async () => {
    const db = buildMockDb(null);
    const result = await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.5,
    );
    expect(result).toBe(true);
  });

  it('returns true when scheduled time is in the past', async () => {
    const pastTime = Date.now() - 60_000;
    const db = buildMockDb({ next_run: pastTime });
    const result = await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.5,
    );
    expect(result).toBe(true);
  });

  it('returns false when scheduled time is in the future', async () => {
    const futureTime = Date.now() + 3_600_000;
    const db = buildMockDb({ next_run: futureTime });
    const result = await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.5,
    );
    expect(result).toBe(false);
  });

  it('writes next schedule to system_state when due', async () => {
    const db = buildMockDb(null);
    await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.5,
    );

    const writeCall = db.boundCalls.find(c =>
      c.sql.includes('INSERT INTO system_state'),
    );
    expect(writeCall).toBeDefined();
    expect(writeCall!.args[0]).toBe(CRON_SCHEDULE_KEY);
  });

  it('does not write schedule when not due', async () => {
    const futureTime = Date.now() + 3_600_000;
    const db = buildMockDb({ next_run: futureTime });
    await checkAndAdvanceCronSchedule(
      db as unknown as D1Database,
      () => 0.5,
    );

    const writeCall = db.boundCalls.find(c =>
      c.sql.includes('INSERT INTO system_state'),
    );
    expect(writeCall).toBeUndefined();
  });
});

// ============================================================================
// isWithinOperatingHours
// ============================================================================

describe('isWithinOperatingHours', () => {
  it('returns true at noon CT', () => {
    expect(isWithinOperatingHours(12)).toBe(true);
  });

  it('returns true at 10pm CT', () => {
    expect(isWithinOperatingHours(22)).toBe(true);
  });

  it('returns false at 11pm CT', () => {
    expect(isWithinOperatingHours(23)).toBe(false);
  });

  it('returns false at 11am CT', () => {
    expect(isWithinOperatingHours(11)).toBe(false);
  });

  it('returns false at midnight CT', () => {
    expect(isWithinOperatingHours(0)).toBe(false);
  });

  it('returns false at 6am CT', () => {
    expect(isWithinOperatingHours(6)).toBe(false);
  });
});
