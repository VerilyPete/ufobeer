/**
 * The cron sweep (pending selection, not_found retry claim, blocklist skip
 * mark) and skip recovery never change a hand-verified row, including when
 * verification lands between their selection and their write. Real D1.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseUnblockedSkips } from '../../src/db/skipRecovery';
import { selectAndQueuePendingEnrichment } from '../../src/handlers/enrichment';
import type { Env } from '../../src/types';

const day = 86400000;

type Row = {
  readonly id: string;
  readonly brewName?: string;
  readonly brewer?: string;
  readonly status: string;
  readonly isVerified?: number | null;
};

async function seed(row: Row): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, enrichment_status, abv, is_verified, updated_at, last_seen_at, description_hash)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`
  ).bind(row.id, row.brewName ?? 'Valley Lager', row.brewer ?? 'Valley Brewing', row.status,
    row.isVerified === undefined ? 0 : row.isVerified, Date.now() - 2 * day, Date.now(), `hash-${row.id}`).run();
}

async function statusOf(id: string): Promise<unknown> {
  return env.DB.prepare('SELECT enrichment_status FROM enriched_beers WHERE id = ?').bind(id).first('enrichment_status');
}

async function verify(id: string): Promise<void> {
  await env.DB.prepare('UPDATE enriched_beers SET is_verified = 1 WHERE id = ?').bind(id).run();
}

/** Real D1, except that every row-listing SELECT runs `hook` after it returns. */
function verifyingAfterSelect(id: string): D1Database {
  const realDb = env.DB;
  return {
    prepare: (sql: string) => {
      const statement = realDb.prepare(sql);
      if (!/^\s*SELECT id/.test(sql)) return statement;
      return {
        bind: (...args: unknown[]) => {
          const bound = statement.bind(...args);
          return {
            all: async () => {
              const result = await bound.all();
              await verify(id);
              return result;
            },
          };
        },
      };
    },
    batch: (statements: D1PreparedStatement[]) => realDb.batch(statements),
  } as unknown as D1Database;
}

function sweepEnv(db: D1Database = env.DB) {
  const sendBatch = vi.fn().mockResolvedValue(undefined);
  return { sendBatch, worker: { ...env, DB: db, ENRICHMENT_QUEUE: { sendBatch } } as unknown as Env };
}

describe('cron sweep and verified rows (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enriched_beers').run();
  });

  it.each([['pending'], ['not_found']])('neither selects nor changes a verified %s row', async (status) => {
    await seed({ id: 'verified', status, isVerified: 1 });
    const { worker, sendBatch } = sweepEnv();

    expect(await selectAndQueuePendingEnrichment(worker, { limit: 10 })).toMatchObject({ beersQueued: 0, noEligibleBeers: true });
    expect(sendBatch).not.toHaveBeenCalled();
    expect(await statusOf('verified')).toBe(status);
  });

  it.each([[0], [null]])('still queues a pending row with is_verified %s', async (isVerified) => {
    await seed({ id: 'open', status: 'pending', isVerified });
    const { worker } = sweepEnv();

    expect(await selectAndQueuePendingEnrichment(worker, { limit: 10 })).toMatchObject({ beersQueued: 1 });
  });

  it('does not mark a verified blocklisted row skipped', async () => {
    await seed({ id: 'flight', brewName: 'Texas Flight', status: 'pending', isVerified: 1 });
    const { worker } = sweepEnv();

    expect(await selectAndQueuePendingEnrichment(worker, { limit: 10 })).toMatchObject({ blocklistedMarked: 0 });
    expect(await statusOf('flight')).toBe('pending');
  });

  it('does not claim a not_found row verified after the selection', async () => {
    await seed({ id: 'miss', status: 'not_found' });
    const { worker, sendBatch } = sweepEnv(verifyingAfterSelect('miss'));

    expect(await selectAndQueuePendingEnrichment(worker, { limit: 10 })).toMatchObject({ beersQueued: 0 });
    expect(sendBatch).not.toHaveBeenCalled();
    expect(await statusOf('miss')).toBe('not_found');
  });

  it('does not mark skipped a blocklisted row verified after the selection', async () => {
    await seed({ id: 'flight', brewName: 'Texas Flight', status: 'pending' });
    const { worker } = sweepEnv(verifyingAfterSelect('flight'));

    expect(await selectAndQueuePendingEnrichment(worker, { limit: 10 })).toMatchObject({ blocklistedMarked: 0 });
    expect(await statusOf('flight')).toBe('pending');
  });
});

describe('skip recovery and verified rows (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enriched_beers').run();
  });

  it('does not release a verified skipped row', async () => {
    await seed({ id: 'verified', status: 'skipped', isVerified: 1 });

    expect(await releaseUnblockedSkips(env.DB)).toEqual({ released: 0, scanned: 0, capReached: false });
    expect(await statusOf('verified')).toBe('skipped');
  });

  it('still releases an unverified skipped row no rule matches', async () => {
    await seed({ id: 'open', status: 'skipped', isVerified: null });

    expect(await releaseUnblockedSkips(env.DB)).toMatchObject({ released: 1 });
    expect(await statusOf('open')).toBe('pending');
  });

  it('does not release a skipped row verified after the selection', async () => {
    await seed({ id: 'late', status: 'skipped' });

    expect(await releaseUnblockedSkips(verifyingAfterSelect('late'))).toMatchObject({ released: 0 });
    expect(await statusOf('late')).toBe('skipped');
  });
});
