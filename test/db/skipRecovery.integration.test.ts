import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseUnblockedSkips } from '../../src/db/skipRecovery';
import { selectAndQueuePendingEnrichment } from '../../src/handlers/enrichment';
import { handleBeerSync } from '../../src/handlers/beers';
import type { Env, RequestContext } from '../../src/types';

const day = 86400000;
const longAgo = Date.now() - 30 * day;

type Row = {
  readonly id: string;
  readonly brewName: string;
  readonly brewer: string | null;
  readonly status?: string;
  readonly seenDaysAgo?: number;
  readonly abv?: number | null;
};

function insert(row: Row): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, enrichment_status, abv, updated_at, last_seen_at, description_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.id, row.brewName, row.brewer, row.status ?? 'skipped', row.abv ?? null, longAgo,
    Date.now() - (row.seenDaysAgo ?? 0) * day, `hash-${row.id}`);
}

async function seed(...rows: readonly Row[]): Promise<void> {
  await env.DB.batch(rows.map(insert));
}

async function statusOf(id: string): Promise<unknown> {
  return env.DB.prepare('SELECT enrichment_status FROM enriched_beers WHERE id = ?').bind(id).first('enrichment_status');
}

function blockedRows(count: number): readonly Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `a${String(i).padStart(4, '0')}`, brewName: 'Texas Flight', brewer: 'Flying Saucer',
  }));
}

const syncContext: RequestContext = {
  requestId: 'req-skip-recovery',
  startTime: Date.now(),
  clientIdentifier: 'test-client',
  apiKeyHash: null,
  clientIp: null,
  userAgent: null,
};

async function syncBeer(beer: Record<string, unknown>): Promise<void> {
  const sendBatch = vi.fn().mockResolvedValue(undefined);
  const worker = { ...env, CLEANUP_QUEUE: { sendBatch } } as unknown as Env;
  const request = new Request('https://api.example.com/beers/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ beers: [beer] }),
  });
  expect((await handleBeerSync(request, worker, {}, syncContext)).status).toBe(200);
}

function queueWorker() {
  const sendBatch = vi.fn().mockResolvedValue(undefined);
  return { sendBatch, worker: { ...env, ENRICHMENT_QUEUE: { sendBatch } } as unknown as Env };
}

describe('releaseUnblockedSkips (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enriched_beers').run();
  });

  it('releases a row whose placeholder brewer was corrected, and the next sweep queues it', async () => {
    await seed({ id: 'snakebite', brewName: 'Snake Bite', brewer: 'unassigned' });
    await syncBeer({ id: 'snakebite', brew_name: 'Snake Bite', brewer: 'Brooklyn Brewery' });
    expect(await env.DB.prepare('SELECT brewer, enrichment_status FROM enriched_beers WHERE id = ?').bind('snakebite').first())
      .toEqual({ brewer: 'Brooklyn Brewery', enrichment_status: 'skipped' });

    expect(await releaseUnblockedSkips(env.DB)).toMatchObject({ released: 1 });
    expect(await statusOf('snakebite')).toBe('pending');

    const { worker, sendBatch } = queueWorker();
    expect((await selectAndQueuePendingEnrichment(worker, { limit: 10 })).beersQueued).toBe(1);
    expect(sendBatch).toHaveBeenCalledWith([{
      body: { beerId: 'snakebite', beerName: 'Snake Bite', brewer: 'Brooklyn Brewery', descriptionHash: 'hash-snakebite' },
    }]);
  });

  it('releases rows that no current rule matches, as when a rule is removed', async () => {
    await seed({ id: 'legacy', brewName: 'Pilsner', brewer: 'Acme Brewing' });
    expect(await releaseUnblockedSkips(env.DB)).toMatchObject({ released: 1 });
    expect(await statusOf('legacy')).toBe('pending');
  });

  it('writes nothing for rows that are still blocklisted', async () => {
    await seed({ id: 'flight', brewName: 'Texas Flight', brewer: 'Flying Saucer' });
    expect(await releaseUnblockedSkips(env.DB)).toMatchObject({ released: 0, scanned: 1 });
    expect(await env.DB.prepare('SELECT enrichment_status, updated_at FROM enriched_beers WHERE id = ?').bind('flight').first())
      .toEqual({ enrichment_status: 'skipped', updated_at: longAgo });
  });

  it('only reconsiders recently seen skipped rows without an ABV', async () => {
    await seed(
      { id: 'gone', brewName: 'Pilsner', brewer: 'Acme Brewing', seenDaysAgo: 8 },
      { id: 'known', brewName: 'Pilsner', brewer: 'Acme Brewing', abv: 5 },
      { id: 'notfound', brewName: 'Pilsner', brewer: 'Acme Brewing', status: 'not_found' },
    );
    expect(await releaseUnblockedSkips(env.DB)).toMatchObject({ released: 0, scanned: 0 });
    expect(await statusOf('gone')).toBe('skipped');
    expect(await statusOf('known')).toBe('skipped');
    expect(await statusOf('notfound')).toBe('not_found');
  });

  it('recovers a corrected row placed after more than a page of still-blocked rows, and pending work still queues', async () => {
    await seed(...blockedRows(250), { id: 'z-corrected', brewName: 'Pilsner', brewer: 'Acme Brewing' },
      { id: 'pending-ipa', brewName: 'IPA', brewer: 'Acme Brewing', status: 'pending' });

    expect(await releaseUnblockedSkips(env.DB)).toEqual({ released: 1, scanned: 251, capReached: false });
    expect(await statusOf('z-corrected')).toBe('pending');

    const { worker, sendBatch } = queueWorker();
    expect((await selectAndQueuePendingEnrichment(worker, { limit: 10 })).beersQueued).toBe(2);
    expect(sendBatch.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('stops at the row cap and reports it through console.error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await seed(...blockedRows(5));
    expect(await releaseUnblockedSkips(env.DB, { pageSize: 2, maxRows: 3 })).toMatchObject({ scanned: 3, capReached: true });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  function racingDb(change: string, ...args: readonly unknown[]): D1Database {
    const realDb = env.DB;
    return {
      prepare: (sql: string) => realDb.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        await realDb.prepare(change).bind(...args).run();
        return realDb.batch(statements);
      },
    } as unknown as D1Database;
  }

  it('does not release a row whose identity changed between the scan and the write', async () => {
    await seed({ id: 'legacy', brewName: 'Pilsner', brewer: 'Acme Brewing' });
    const db = racingDb('UPDATE enriched_beers SET brewer = ? WHERE id = ?', 'Various', 'legacy');
    expect(await releaseUnblockedSkips(db)).toMatchObject({ released: 0 });
    expect(await statusOf('legacy')).toBe('skipped');
  });

  it('does not overwrite a row whose status changed between the scan and the write', async () => {
    await seed({ id: 'legacy', brewName: 'Pilsner', brewer: 'Acme Brewing' });
    const db = racingDb("UPDATE enriched_beers SET enrichment_status = 'enriched' WHERE id = ?", 'legacy');
    expect(await releaseUnblockedSkips(db)).toMatchObject({ released: 0 });
    expect(await statusOf('legacy')).toBe('enriched');
  });

  it('treats a missing brewer and a blank one as the same identity', async () => {
    await seed({ id: 'nobrewer', brewName: 'Pilsner', brewer: null });
    const db = racingDb("UPDATE enriched_beers SET brewer = '  ' WHERE id = ?", 'nobrewer');
    expect(await releaseUnblockedSkips(db)).toMatchObject({ released: 1 });
    expect(await statusOf('nobrewer')).toBe('pending');
  });
});
