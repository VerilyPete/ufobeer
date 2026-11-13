/**
 * recordSeenBeers: the one writer for beer sightings (taplist refresh and
 * POST /beers/sync), against real D1. Plan slice 4 (D1–D4, D6, D7).
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markCleanupQueued, recordSeenBeers } from '../../src/db/seenBeers';
import type { SeenBeer } from '../../src/db/seenBeers';
import { handleCleanupBatch } from '../../src/queue/cleanup';
import { sendCleanupAndMark } from '../../src/queue/helpers';
import { hashDescription } from '../../src/utils/hash';
import type { CleanupMessage, Env } from '../../src/types';

const day = 86400000;
const TEXT_A = 'A crisp lager';
const TEXT_B = 'A hazy pale ale';
const TEXT_C = 'A dark porter';

type Row = {
  readonly id: string;
  readonly brewName?: string;
  readonly brewer?: string | null;
  readonly original?: string | null;
  readonly hash?: string | null;
  readonly cleaned?: string | null;
  readonly queuedAt?: number | null;
  readonly abv?: number | null;
  readonly status?: string;
  readonly isVerified?: number;
};

async function seed(row: Row): Promise<void> {
  const original = row.original === undefined ? TEXT_A : row.original;
  const hash = row.hash !== undefined ? row.hash : original === null ? null : await hashDescription(original);
  const cleaned = row.cleaned ?? null;
  await env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash, brew_description_cleaned,
       description_cleaned_at, cleanup_source, queued_for_cleanup_at, abv, enrichment_status, is_verified, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
  ).bind(row.id, row.brewName ?? 'Valley Lager', row.brewer === undefined ? 'Valley Brewing' : row.brewer, original, hash,
    cleaned, cleaned === null ? null : 1, cleaned === null ? null : 'deterministic', row.queuedAt ?? null,
    row.abv ?? null, row.status ?? 'pending', row.isVerified ?? 0).run();
}

async function stored(id: string) {
  return env.DB.prepare(
    `SELECT brew_name, brewer, brew_description_original, description_hash, brew_description_cleaned, queued_for_cleanup_at,
       abv, enrichment_status, last_seen_at FROM enriched_beers WHERE id = ?`
  ).bind(id).first<Record<string, unknown>>();
}

const beer = (id: string, extra: Partial<SeenBeer> = {}): SeenBeer =>
  ({ id, brew_name: 'Valley Lager', brewer: 'Valley Brewing', ...extra });

const NOW = Date.now();
const see = (beers: readonly SeenBeer[], db: D1Database = env.DB) => recordSeenBeers(db, beers, { now: NOW });

/** Real D1; `hook` runs once, right after the writer's `afterBatch`-th batch (1: the read, 2: the writes). */
function afterRead(hook: () => Promise<void>, afterBatch = 1): D1Database {
  const realDb = env.DB;
  let batches = 0;
  return {
    prepare: (sql: string) => realDb.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const result = await realDb.batch(statements);
      batches++;
      if (batches === afterBatch) await hook();
      return result;
    },
  } as unknown as D1Database;
}

async function consume(messages: readonly CleanupMessage[]): Promise<void> {
  const worker = { ...env, ENRICHMENT_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) } } as unknown as Env;
  await handleCleanupBatch({ messages: messages.map(body => ({ body, ack: vi.fn(), retry: vi.fn() })) } as unknown as MessageBatch<CleanupMessage>, worker);
}

const ids = (work: readonly { readonly id: string }[]) => work.map(item => item.id).sort();

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
  await env.DB.prepare('DROP TRIGGER IF EXISTS abort_write').run();
  await env.DB.prepare('DELETE FROM enriched_beers').run();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('first sightings', () => {
  it('stores a described beer pending and queues only cleanup', async () => {
    const result = await see([beer('new', { brew_description: TEXT_A })]);

    expect(result.outcomes.get('new')).toBe('written');
    expect(await stored('new')).toMatchObject({ brew_description_original: TEXT_A, description_hash: await hashDescription(TEXT_A), enrichment_status: 'pending' });
    expect(result.cleanup).toEqual([{ id: 'new', brew_name: 'Valley Lager', brewer: 'Valley Brewing', brew_description: TEXT_A, descriptionHash: await hashDescription(TEXT_A) }]);
    expect(result.enrichment).toEqual([]);
  });

  it('stores an undescribed beer pending and queues enrichment', async () => {
    const result = await see([beer('new')]);

    expect(await stored('new')).toMatchObject({ brew_description_original: null, description_hash: null, enrichment_status: 'pending' });
    expect(result.enrichment).toEqual([{ id: 'new', brew_name: 'Valley Lager', brewer: 'Valley Brewing', descriptionHash: null }]);
    expect(result.cleanup).toEqual([]);
  });

  it('stores an undescribed blocklisted beer skipped and queues nothing', async () => {
    const result = await see([beer('flight', { brew_name: 'Texas Flight' })]);

    expect(await stored('flight')).toMatchObject({ enrichment_status: 'skipped' });
    expect(result.enrichment).toEqual([]);
  });

  it('queues cleanup but no paid lookup for a described blocklisted beer, ABV in the text or not', async () => {
    const result = await see([
      beer('flight', { brew_name: 'Texas Flight', brew_description: 'Four tasters, 5% ABV' }),
      beer('pour', { brew_name: 'Black Velvet', brewer: 'Various', brew_description: 'Stout over cider' }),
    ]);

    expect(ids(result.cleanup)).toEqual(['flight', 'pour']);
    expect(result.enrichment).toEqual([]);
    expect(await stored('flight')).toMatchObject({ enrichment_status: 'pending' });
  });

  it('stores a beer with no brewer', async () => {
    await see([{ id: 'new', brew_name: 'Valley Lager' }]);

    expect(await stored('new')).toMatchObject({ brewer: null });
  });

  it('repairs escaped names before storing and queueing', async () => {
    const result = await see([{ id: 'new', brew_name: "Dragon\\'s Milk ", brewer: "Brasserie D\\'achouffe" }]);

    expect(await stored('new')).toMatchObject({ brew_name: "Dragon's Milk", brewer: "Brasserie D'achouffe" });
    expect(result.enrichment).toEqual([expect.objectContaining({ brew_name: "Dragon's Milk", brewer: "Brasserie D'achouffe" })]);
  });

  it('marks the second of two concurrent first sightings stale without aborting its batch', async () => {
    const db = afterRead(async () => {
      await see([beer('race', { brew_description: TEXT_A })]);
    });

    const result = await see([beer('race', { brew_description: TEXT_B }), beer('other')], db);

    expect(result.outcomes.get('race')).toBe('stale');
    expect(result.outcomes.get('other')).toBe('written');
    expect(await stored('race')).toMatchObject({ brew_description_original: TEXT_A });
    expect(ids(result.cleanup)).toEqual([]);
  });
});

describe('description changes', () => {
  it('replaces text and hash together, clears cleanup state and queues cleanup', async () => {
    await seed({ id: 'b', cleaned: 'Cleaned A', queuedAt: NOW - 1000, abv: 5, status: 'enriched' });

    const result = await see([beer('b', { brew_description: TEXT_B })]);

    expect(result.outcomes.get('b')).toBe('written');
    expect(await stored('b')).toMatchObject({
      brew_description_original: TEXT_B, description_hash: await hashDescription(TEXT_B),
      brew_description_cleaned: null, queued_for_cleanup_at: null, enrichment_status: 'pending', abv: 5,
    });
    expect(await env.DB.prepare('SELECT updated_at FROM enriched_beers WHERE id = ?').bind('b').first('updated_at')).toBe(NOW);
    expect(result.cleanup).toEqual([expect.objectContaining({ id: 'b', brew_description: TEXT_B })]);
  });

  it('repairs a damaged row whose hash already matches the sighted text', async () => {
    await seed({ id: 'b', hash: await hashDescription(TEXT_B), cleaned: TEXT_A });

    const result = await see([beer('b', { brew_description: TEXT_B })]);

    expect(await stored('b')).toMatchObject({ brew_description_original: TEXT_B, brew_description_cleaned: null });
    expect(result.cleanup).toEqual([expect.objectContaining({ brew_description: TEXT_B })]);
  });

  it('lets the first of two writers that read A win, and marks the second stale', async () => {
    await seed({ id: 'b' });
    const db = afterRead(async () => {
      await see([beer('b', { brew_description: TEXT_B })]);
    });

    const result = await see([beer('b', { brew_description: TEXT_C })], db);

    expect(result.outcomes.get('b')).toBe('stale');
    expect(await stored('b')).toMatchObject({ brew_description_original: TEXT_B });
    expect(result.cleanup).toEqual([]);
  });

  it('treats a duplicate A→B arriving after B was cleaned as a no-op', async () => {
    await seed({ id: 'b' });
    const db = afterRead(async () => {
      const first = await see([beer('b', { brew_description: TEXT_B })]);
      await consume(first.cleanup.map(item => ({ beerId: item.id, beerName: item.brew_name, brewer: item.brewer, brewDescription: item.brew_description, descriptionHash: item.descriptionHash })));
    });

    await see([beer('b', { brew_description: TEXT_B })], db);

    expect(await stored('b')).toMatchObject({ brew_description_original: TEXT_B, brew_description_cleaned: 'A hazy pale ale.' });
  });

  it('still applies A→B when cleanup of A landed after the read', async () => {
    await seed({ id: 'b' });
    const db = afterRead(async () => {
      await consume([{ beerId: 'b', beerName: 'Valley Lager', brewer: 'Valley Brewing', brewDescription: TEXT_A, descriptionHash: await hashDescription(TEXT_A) }]);
    });

    const result = await see([beer('b', { brew_description: TEXT_B })], db);

    expect(result.outcomes.get('b')).toBe('written');
    expect(await stored('b')).toMatchObject({ brew_description_original: TEXT_B, brew_description_cleaned: null });
  });

  it('lets an older sync replace a newer taplist description (first guarded write wins)', async () => {
    await seed({ id: 'b' });
    await see([beer('b', { brew_description: TEXT_B })]);

    await see([beer('b', { brew_description: TEXT_A })]);

    expect(await stored('b')).toMatchObject({ brew_description_original: TEXT_A });
  });
});

describe('unchanged sightings', () => {
  it('updates names and last_seen_at only', async () => {
    await seed({ id: 'b', cleaned: 'Cleaned A', abv: 5, status: 'enriched' });

    const result = await see([beer('b', { brew_name: 'Valley Lager Renamed', brew_description: TEXT_A })]);

    expect(result.outcomes.get('b')).toBe('unchanged');
    expect(await stored('b')).toMatchObject({ brew_name: 'Valley Lager Renamed', brew_description_cleaned: 'Cleaned A', last_seen_at: NOW });
    expect(result.cleanup).toEqual([]);
    expect(result.enrichment).toEqual([]);
  });

  it.each([['omitted', undefined], ['empty', '']])('keeps the stored text and hash when the description is %s', async (_case, description) => {
    await seed({ id: 'b', cleaned: 'Cleaned A' });

    await see([beer('b', description === undefined ? {} : { brew_description: description })]);

    expect(await stored('b')).toMatchObject({ brew_description_original: TEXT_A, description_hash: await hashDescription(TEXT_A), brew_description_cleaned: 'Cleaned A' });
  });

  it('re-queues enrichment for a pending row on every sighting', async () => {
    await seed({ id: 'b', original: null });

    expect((await see([beer('b')])).enrichment).toEqual([{ id: 'b', brew_name: 'Valley Lager', brewer: 'Valley Brewing', descriptionHash: null }]);
    expect((await see([beer('b')])).enrichment).toHaveLength(1);
  });

  it('queues enrichment for a pending described row once its description is cleaned', async () => {
    await seed({ id: 'b', cleaned: 'Cleaned A' });

    expect((await see([beer('b', { brew_description: TEXT_A })])).enrichment).toEqual([expect.objectContaining({ id: 'b', descriptionHash: await hashDescription(TEXT_A) })]);
  });

  it.each(['not_found', 'skipped', 'failed', 'enriched'])('sends no enrichment for a %s row', async (status) => {
    await seed({ id: 'b', original: null, status });

    expect((await see([beer('b')])).enrichment).toEqual([]);
  });

  it('sends no enrichment for a verified pending row', async () => {
    await seed({ id: 'b', original: null, isVerified: 1 });

    expect((await see([beer('b')])).enrichment).toEqual([]);
  });

  it('keeps an ABV of 0 and sends no enrichment', async () => {
    await seed({ id: 'b', original: null, abv: 0, status: 'enriched' });

    expect((await see([beer('b')])).enrichment).toEqual([]);
    expect(await stored('b')).toMatchObject({ abv: 0 });
  });

  it('marks a blocklisted pending row skipped', async () => {
    await seed({ id: 'flight', brewName: 'Texas Flight', original: null });

    expect((await see([beer('flight', { brew_name: 'Texas Flight' })])).enrichment).toEqual([]);
    expect(await stored('flight')).toMatchObject({ enrichment_status: 'skipped' });
  });

  it('leaves a blocklisted not_found row not_found', async () => {
    await seed({ id: 'flight', brewName: 'Texas Flight', original: null, status: 'not_found' });

    await see([beer('flight', { brew_name: 'Texas Flight' })]);

    expect(await stored('flight')).toMatchObject({ enrichment_status: 'not_found' });
  });

  it.each([
    ['an ABV lands', "UPDATE enriched_beers SET abv = 5 WHERE id = 'flight'"],
    ['the row is verified', "UPDATE enriched_beers SET is_verified = 1 WHERE id = 'flight'"],
  ])('does not mark a blocklisted pending row skipped when %s after the read', async (_case, sql) => {
    await seed({ id: 'flight', brewName: 'Texas Flight', original: null });

    await see([beer('flight', { brew_name: 'Texas Flight' })], afterRead(async () => { await env.DB.prepare(sql).run(); }));

    expect(await stored('flight')).toMatchObject({ enrichment_status: 'pending' });
  });

  it('does not mark skipped by a stored placeholder brewer that was corrected after the read', async () => {
    await seed({ id: 'b', brewer: 'Various', original: null });
    const db = afterRead(async () => {
      await env.DB.prepare("UPDATE enriched_beers SET brewer = 'Valley Brewing' WHERE id = 'b'").run();
    });

    await see([{ id: 'b', brew_name: 'Valley Lager' }], db);

    expect(await stored('b')).toMatchObject({ brewer: 'Valley Brewing', enrichment_status: 'pending' });
  });

  it('sends no enrichment for a pending row that already has an ABV', async () => {
    await seed({ id: 'b', original: null, abv: 5 });

    expect((await see([beer('b')])).enrichment).toEqual([]);
  });

  it('keeps a blocklisted row enriched when cleanup enriched it after the read', async () => {
    await seed({ id: 'flight', brewName: 'Texas Flight', original: null });
    const db = afterRead(async () => {
      await env.DB.prepare("UPDATE enriched_beers SET abv = 5, enrichment_status = 'enriched' WHERE id = 'flight'").run();
    });

    await see([beer('flight', { brew_name: 'Texas Flight' })], db);

    expect(await stored('flight')).toMatchObject({ abv: 5, enrichment_status: 'enriched' });
  });
});

describe('brewer', () => {
  it('keeps the stored brewer, repaired, when a sighting omits it', async () => {
    await seed({ id: 'b', brewer: "Brasserie D\\'achouffe", original: null });

    const result = await see([{ id: 'b', brew_name: 'Valley Lager' }]);

    expect(await stored('b')).toMatchObject({ brewer: "Brasserie D'achouffe" });
    expect(result.enrichment).toEqual([expect.objectContaining({ brewer: "Brasserie D'achouffe" })]);
  });

  it('keeps a newer brewer written after the read when a sighting omits it', async () => {
    await seed({ id: 'b', brewer: "Brasserie D\\'achouffe", original: null });
    const db = afterRead(async () => {
      await env.DB.prepare("UPDATE enriched_beers SET brewer = 'Achouffe Brewery' WHERE id = 'b'").run();
    });

    const result = await see([{ id: 'b', brew_name: 'Valley Lager' }], db);

    expect(await stored('b')).toMatchObject({ brewer: 'Achouffe Brewery' });
    expect(result.enrichment).toEqual([expect.objectContaining({ brewer: 'Achouffe Brewery' })]);
  });

  it('stores an explicit empty brewer as sent', async () => {
    await seed({ id: 'b', original: null });

    await see([beer('b', { brewer: '' })]);

    expect(await stored('b')).toMatchObject({ brewer: '' });
  });
});

describe('cleanup retry (D7)', () => {
  it('queues an uncleaned row never queued, from the stored text, even when the sighting has no description', async () => {
    await seed({ id: 'b' });

    expect((await see([beer('b')])).cleanup).toEqual([{ id: 'b', brew_name: 'Valley Lager', brewer: 'Valley Brewing', brew_description: TEXT_A, descriptionHash: await hashDescription(TEXT_A) }]);
  });

  it('waits 24 hours after a queued mark', async () => {
    await seed({ id: 'recent', queuedAt: NOW - day + 1000 });
    await seed({ id: 'old', queuedAt: NOW - day - 1000 });

    expect(ids((await see([beer('recent'), beer('old')])).cleanup)).toEqual(['old']);
  });

  it('queues cleanup for a terminal row that gets no enrichment', async () => {
    await seed({ id: 'b', status: 'not_found' });

    const result = await see([beer('b')]);

    expect(ids(result.cleanup)).toEqual(['b']);
    expect(result.enrichment).toEqual([]);
  });

  it.each([['NULL', null], ['wrong', 'wrong-hash']])('prepares a %s stored hash before queueing', async (_case, hash) => {
    await seed({ id: 'b', hash });

    const result = await see([beer('b')]);

    expect(await stored('b')).toMatchObject({ description_hash: await hashDescription(TEXT_A) });
    expect(result.cleanup).toEqual([expect.objectContaining({ descriptionHash: await hashDescription(TEXT_A) })]);
  });

  it('does not prepare or queue a stale hash when the description changes before preparation', async () => {
    await seed({ id: 'b', hash: null });
    const hashB = await hashDescription(TEXT_B);
    const db = afterRead(async () => {
      await env.DB.prepare('UPDATE enriched_beers SET brew_description_original = ?, description_hash = ? WHERE id = ?')
        .bind(TEXT_B, hashB, 'b').run();
    }, 2);

    const result = await see([beer('b')], db);

    expect(result.cleanup).toEqual([]);
    expect(await stored('b')).toMatchObject({ brew_description_original: TEXT_B, description_hash: hashB });
  });

  it('leaves the marker of a row cleaned before the mark alone', async () => {
    await seed({ id: 'b', cleaned: 'Cleaned A' });

    await markCleanupQueued(env.DB, [{ id: 'b', descriptionHash: await hashDescription(TEXT_A) }], { now: NOW });

    expect(await stored('b')).toMatchObject({ queued_for_cleanup_at: null });
  });

  it('does not suppress B’s retry with a late mark for A', async () => {
    await seed({ id: 'b' });
    await see([beer('b', { brew_description: TEXT_B })]);

    await markCleanupQueued(env.DB, [{ id: 'b', descriptionHash: await hashDescription(TEXT_A) }], { now: NOW });

    expect((await see([beer('b')])).cleanup).toEqual([expect.objectContaining({ brew_description: TEXT_B })]);
  });

  it('never moves the marker backwards', async () => {
    await seed({ id: 'b', queuedAt: NOW });

    await markCleanupQueued(env.DB, [{ id: 'b', descriptionHash: await hashDescription(TEXT_A) }], { now: NOW - 5000 });

    expect(await stored('b')).toMatchObject({ queued_for_cleanup_at: NOW });
  });

  it('resends a sent row whose mark batch failed after an earlier one committed, until it is consumed', async () => {
    const all = Array.from({ length: 150 }, (_, i) => `b${String(i).padStart(3, '0')}`);
    for (const id of all) await seed({ id });
    await env.DB.prepare(
      "CREATE TRIGGER abort_write BEFORE UPDATE OF queued_for_cleanup_at ON enriched_beers WHEN NEW.id = 'b120' BEGIN SELECT RAISE(ABORT, 'test abort'); END"
    ).run();
    const sent: CleanupMessage[] = [];
    const worker = {
      ...env,
      CLEANUP_QUEUE: { sendBatch: vi.fn(async (messages: readonly { readonly body: CleanupMessage }[]) => { sent.push(...messages.map(m => m.body)); }) },
    } as unknown as Env;

    const first = await see(all.map(id => beer(id)));
    const { queued, markError } = await sendCleanupAndMark(worker, first.cleanup, 'request-1', NOW);
    await env.DB.prepare('DROP TRIGGER abort_write').run();

    expect(queued).toBe(150);
    expect(markError).toBeInstanceOf(Error);
    const unmarked = all.slice(100);
    expect(ids((await see(all.map(id => beer(id)))).cleanup)).toEqual(unmarked);

    await consume(sent.filter(message => unmarked.includes(message.beerId)));
    expect((await see(all.map(id => beer(id)))).cleanup).toEqual([]);
  });
});

describe('input', () => {
  it('collapses duplicate ids to the last occurrence, each version hashed from its own text', async () => {
    const result = await see([beer('b', { brew_description: TEXT_B }), beer('b', { brew_description: TEXT_A })]);

    expect(await stored('b')).toMatchObject({ brew_description_original: TEXT_A, description_hash: await hashDescription(TEXT_A) });
    expect(result.cleanup).toEqual([expect.objectContaining({ brew_description: TEXT_A })]);
  });

  it('lets a later duplicate without a description keep the stored text', async () => {
    await seed({ id: 'b', cleaned: 'Cleaned A' });

    await see([beer('b', { brew_description: TEXT_B }), beer('b')]);

    expect(await stored('b')).toMatchObject({ brew_description_original: TEXT_A, brew_description_cleaned: 'Cleaned A' });
  });
});

describe('write failures', () => {
  it('fails only the batch that aborted, and queues nothing for it', async () => {
    const beers = Array.from({ length: 150 }, (_, i) => beer(`b${String(i).padStart(3, '0')}`));
    await env.DB.prepare(
      "CREATE TRIGGER abort_write BEFORE INSERT ON enriched_beers WHEN NEW.id = 'b120' BEGIN SELECT RAISE(ABORT, 'test abort'); END"
    ).run();

    const result = await see(beers);

    const failed = [...result.outcomes].filter(([, outcome]) => outcome === 'failed').map(([id]) => id);
    expect(failed).toHaveLength(50);
    expect(failed).toContain('b120');
    expect(result.enrichment).toHaveLength(100);
    expect(result.enrichment.map(item => item.id)).not.toContain('b120');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM enriched_beers').first('n')).toBe(100);
  });
});
