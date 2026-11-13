/**
 * The one writer for beer sightings: the taplist refresh and POST /beers/sync
 * both record what they saw here, and get back the work to queue.
 *
 * Every write is decided against the live row and guarded, and queue work is
 * derived from the row each write returned, never from the earlier read:
 * - a first sighting inserts, or is `stale` if another writer got there first;
 * - a changed description (compared as text) replaces the original and its
 *   hash together, guarded on the original and hash that were read;
 * - any other sighting writes names and last_seen_at only. An omitted brewer
 *   keeps the stored one, repaired only if it is still what was read.
 *
 * See plans/enriched-beers-write-paths.md (D1–D4, D6, D7).
 */

import { shouldSkipEnrichment } from '../config';
import { D1_MAX_PARAMS_PER_STATEMENT, D1_MAX_STATEMENTS_PER_BATCH, LAST_SEEN_REFRESH_MS } from '../constants';
import { SYNC_CONSTANTS } from '../types';
import { cleanBeerName, cleanBeerNames } from '../utils/beer-name';
import { hashDescription } from '../utils/hash';
import { asTypedRows } from './helpers';
import { unlessVerified } from './verified';

export type SeenBeer = {
  readonly id: string;
  readonly brew_name: string;
  /** Omitted (undefined) keeps the stored brewer; '' is an explicit value. */
  readonly brewer?: string | undefined;
  /** Omitted or '' keeps the stored text and hash. */
  readonly brew_description?: string | undefined;
};

/**
 * `written`: inserted or a description change applied. `unchanged`: names and
 * last_seen_at only. `stale`: a guard refused the write (not an error).
 * `failed`: the statement's batch threw and was rolled back.
 */
export type SeenOutcome = 'written' | 'unchanged' | 'stale' | 'failed';

export type CleanupWork = {
  readonly id: string;
  readonly brew_name: string;
  readonly brewer: string;
  readonly brew_description: string;
  readonly descriptionHash: string;
};

export type EnrichmentWork = {
  readonly id: string;
  readonly brew_name: string;
  readonly brewer: string;
  readonly descriptionHash: string | null;
};

export type RecordSeenResult = {
  readonly outcomes: ReadonlyMap<string, SeenOutcome>;
  readonly cleanup: readonly CleanupWork[];
  readonly enrichment: readonly EnrichmentWork[];
};

type StoredRow = {
  readonly id: string;
  readonly brew_name: string;
  readonly brewer: string | null;
  readonly brew_description_original: string | null;
  readonly description_hash: string | null;
  readonly description_cleaned_at: number | null;
  readonly queued_for_cleanup_at: number | null;
  readonly abv: number | null;
  readonly enrichment_status: string | null;
  readonly is_verified: number | null;
  readonly last_seen_at: number | null;
};

const ROW_COLUMNS = `id, brew_name, brewer, brew_description_original, description_hash, description_cleaned_at,
  queued_for_cleanup_at, abv, enrichment_status, is_verified, last_seen_at`;

type Planned = { readonly id: string; readonly statement: D1PreparedStatement; readonly kind: 'insert' | 'change' | 'seen' };

function lastOccurrences(beers: readonly SeenBeer[]): readonly SeenBeer[] {
  return [...new Map(beers.map(beer => [beer.id, cleanBeerNames(beer)])).values()];
}

async function readStoredRows(db: D1Database, ids: readonly string[]): Promise<ReadonlyMap<string, StoredRow>> {
  const chunks = Array.from({ length: Math.ceil(ids.length / D1_MAX_PARAMS_PER_STATEMENT) },
    (_, i) => ids.slice(i * D1_MAX_PARAMS_PER_STATEMENT, (i + 1) * D1_MAX_PARAMS_PER_STATEMENT));
  const results = await db.batch(chunks.map(chunk =>
    db.prepare(`SELECT ${ROW_COLUMNS} FROM enriched_beers WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk)
  ));
  return new Map(results.flatMap(result => asTypedRows<StoredRow>(result.results)).map(row => [row.id, row]));
}

function isBlocked(brewName: string, brewer: string | null | undefined): boolean {
  return shouldSkipEnrichment({ brewName, brewer: brewer ?? null });
}

/** The brewer to write: the sighting's, or the stored one repaired while it is still what was read. */
function brewerAssignment(beer: SeenBeer, stored: StoredRow): { readonly sql: string; readonly args: readonly (string | null)[] } {
  if (beer.brewer !== undefined) return { sql: '?', args: [beer.brewer] };
  const repaired = stored.brewer === null ? null : cleanBeerName(stored.brewer);
  return { sql: 'CASE WHEN enriched_beers.brewer IS ? THEN ? ELSE enriched_beers.brewer END', args: [stored.brewer, repaired] };
}

function planInsert(db: D1Database, beer: SeenBeer, description: string | null, hash: string | null, now: number): Planned {
  const status = description === null && isBlocked(beer.brew_name, beer.brewer) ? 'skipped' : 'pending';
  return {
    id: beer.id,
    kind: 'insert',
    statement: db.prepare(
      `INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash, enrichment_status, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING
       RETURNING ${ROW_COLUMNS}`
    ).bind(beer.id, beer.brew_name, beer.brewer ?? null, description, hash, status, now, now),
  };
}

function planChange(db: D1Database, beer: SeenBeer, stored: StoredRow, description: string, hash: string, now: number): Planned {
  const brewer = brewerAssignment(beer, stored);
  return {
    id: beer.id,
    kind: 'change',
    statement: db.prepare(
      `UPDATE enriched_beers SET
         brew_name = ?,
         brewer = ${brewer.sql},
         brew_description_original = ?,
         description_hash = ?,
         brew_description_cleaned = NULL,
         description_cleaned_at = NULL,
         cleanup_source = NULL,
         cleanup_version = NULL,
         queued_for_cleanup_at = NULL,
         enrichment_status = ${unlessVerified('enrichment_status', "'pending'")},
         last_seen_at = ?,
         updated_at = ?
       WHERE id = ? AND brew_description_original IS ? AND description_hash IS ?
       RETURNING ${ROW_COLUMNS}`
    ).bind(beer.brew_name, ...brewer.args, description, hash, now, now, beer.id,
      stored.brew_description_original, stored.description_hash),
  };
}

/**
 * Names and last_seen_at. A blocklisted pending row with no ABV is also
 * marked skipped, but only if its status and ABV are still what was read,
 * it is not verified, and (when the sighting omitted the brewer, so the
 * decision used the stored one) its brewer has not changed since.
 */
function wantsSkipMark(beer: SeenBeer, stored: StoredRow): boolean {
  const decidingBrewer = beer.brewer !== undefined ? beer.brewer : stored.brewer;
  return isBlocked(beer.brew_name, decidingBrewer) &&
    (stored.enrichment_status === 'pending' || stored.enrichment_status === null);
}

/**
 * A sighting whose only effect would be moving last_seen_at forward by less
 * than LAST_SEEN_REFRESH_MS: no new description, no rename, no brewer change
 * or repair, no skip mark. Counted for slice 5's throttle decision.
 */
function isThrottleEligible(beer: SeenBeer, stored: StoredRow, now: number): boolean {
  const description = beer.brew_description ? beer.brew_description : null;
  const brewer = beer.brewer !== undefined
    ? beer.brewer
    : stored.brewer === null ? null : cleanBeerName(stored.brewer);
  const age = stored.last_seen_at === null ? null : now - stored.last_seen_at;
  return age !== null && age >= 0 && age < LAST_SEEN_REFRESH_MS &&
    (description === null || description === stored.brew_description_original) &&
    beer.brew_name === stored.brew_name && brewer === stored.brewer &&
    !wantsSkipMark(beer, stored);
}

function planSeen(db: D1Database, beer: SeenBeer, stored: StoredRow, now: number): Planned {
  const brewer = brewerAssignment(beer, stored);
  const markSkipped = wantsSkipMark(beer, stored);
  const brewerUnchanged = beer.brewer === undefined ? ' AND enriched_beers.brewer IS ?' : '';
  const skip = markSkipped
    ? {
        sql: `CASE WHEN enriched_beers.enrichment_status IS ? AND enriched_beers.abv IS NULL
                AND enriched_beers.is_verified IS NOT 1${brewerUnchanged}
              THEN 'skipped' ELSE enriched_beers.enrichment_status END`,
        args: beer.brewer === undefined ? [stored.enrichment_status, stored.brewer] : [stored.enrichment_status],
      }
    : { sql: 'enriched_beers.enrichment_status', args: [] };
  return {
    id: beer.id,
    kind: 'seen',
    statement: db.prepare(
      `UPDATE enriched_beers SET
         brew_name = ?,
         brewer = ${brewer.sql},
         enrichment_status = ${skip.sql},
         last_seen_at = ?
       WHERE id = ?
       RETURNING ${ROW_COLUMNS}`
    ).bind(beer.brew_name, ...brewer.args, ...skip.args, now, beer.id),
  };
}

async function plan(db: D1Database, beer: SeenBeer, stored: StoredRow | undefined, now: number): Promise<Planned> {
  const description = beer.brew_description ? beer.brew_description : null;
  if (stored === undefined) {
    return planInsert(db, beer, description, description === null ? null : await hashDescription(description), now);
  }
  if (description !== null && description !== stored.brew_description_original) {
    return planChange(db, beer, stored, description, await hashDescription(description), now);
  }
  return planSeen(db, beer, stored, now);
}

type Written = { readonly outcome: SeenOutcome; readonly row: StoredRow | null };

async function executeInBatches(db: D1Database, planned: readonly Planned[]): Promise<ReadonlyMap<string, Written>> {
  const written = new Map<string, Written>();
  for (let i = 0; i < planned.length; i += D1_MAX_STATEMENTS_PER_BATCH) {
    const chunk = planned.slice(i, i + D1_MAX_STATEMENTS_PER_BATCH);
    try {
      const results = await db.batch(chunk.map(item => item.statement));
      chunk.forEach((item, index) => {
        const row = asTypedRows<StoredRow>(results[index]?.results)[0] ?? null;
        const outcome: SeenOutcome = row === null ? 'stale' : item.kind === 'seen' ? 'unchanged' : 'written';
        written.set(item.id, { outcome, row });
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: 'seen_beers.write_failed',
        error: error instanceof Error ? error.message : String(error),
        batchSize: chunk.length,
      }));
      for (const item of chunk) written.set(item.id, { outcome: 'failed', row: null });
    }
  }
  return written;
}

function needsCleanup(row: StoredRow, now: number): row is StoredRow & { readonly brew_description_original: string } {
  return Boolean(row.brew_description_original) && row.description_cleaned_at === null &&
    (row.queued_for_cleanup_at === null || now - row.queued_for_cleanup_at > SYNC_CONSTANTS.REQUEUE_COOLDOWN_MS);
}

/**
 * A paid lookup only for a pending, unverified row with no ABV whose
 * description, if any, is already cleaned: cleanup extracts an ABV from the
 * text first and forwards the rest to Perplexity itself. A blocklisted row
 * was marked skipped by its write; queueBeersForEnrichment filters any that
 * a guard left pending.
 */
function needsEnrichment(row: StoredRow): boolean {
  return row.abv === null && row.enrichment_status === 'pending' && row.is_verified !== 1 &&
    (!row.brew_description_original || row.description_cleaned_at !== null);
}

/**
 * The consumer only accepts a message whose hash matches the row, so a row
 * whose stored hash is NULL or wrong gets the hash of its stored text first,
 * guarded on that text. Rows a guard refuses are left for the next sighting.
 */
async function prepareCleanup(db: D1Database, rows: readonly (StoredRow & { readonly brew_description_original: string })[]): Promise<readonly CleanupWork[]> {
  const hashed = await Promise.all(rows.map(async row => ({ row, hash: await hashDescription(row.brew_description_original) })));
  const toPrepare = hashed.filter(({ row, hash }) => row.description_hash !== hash);
  const prepared = new Set<string>();
  for (let i = 0; i < toPrepare.length; i += D1_MAX_STATEMENTS_PER_BATCH) {
    const chunk = toPrepare.slice(i, i + D1_MAX_STATEMENTS_PER_BATCH);
    try {
      const results = await db.batch(chunk.map(({ row, hash }) =>
        db.prepare('UPDATE enriched_beers SET description_hash = ? WHERE id = ? AND brew_description_original IS ?')
          .bind(hash, row.id, row.brew_description_original)
      ));
      chunk.forEach(({ row }, index) => { if (results[index]?.meta?.changes === 1) prepared.add(row.id); });
    } catch (error) {
      console.error(JSON.stringify({ event: 'seen_beers.prepare_failed', error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return hashed
    .filter(({ row, hash }) => row.description_hash === hash || prepared.has(row.id))
    .map(({ row, hash }) => ({
      id: row.id,
      brew_name: row.brew_name,
      brewer: row.brewer ?? '',
      brew_description: row.brew_description_original,
      descriptionHash: hash,
    }));
}

export async function recordSeenBeers(
  db: D1Database,
  beers: readonly SeenBeer[],
  options: { readonly now: number }
): Promise<RecordSeenResult> {
  const unique = lastOccurrences(beers);
  if (unique.length === 0) return { outcomes: new Map(), cleanup: [], enrichment: [] };

  const storedRows = await readStoredRows(db, unique.map(beer => beer.id));
  const planned = await Promise.all(unique.map(beer => plan(db, beer, storedRows.get(beer.id), options.now)));
  const written = await executeInBatches(db, planned);

  const rows = [...written.values()].flatMap(({ row }) => row === null ? [] : [row]);
  const cleanup = await prepareCleanup(db, rows.filter(row => needsCleanup(row, options.now)));
  const enrichment = rows.filter(needsEnrichment).map(row => ({
    id: row.id,
    brew_name: row.brew_name,
    brewer: row.brewer ?? '',
    descriptionHash: row.description_hash,
  }));

  const outcomes = new Map([...written].map(([id, { outcome }]) => [id, outcome]));
  const counts = [...outcomes.values()].reduce<Record<string, number>>(
    (tally, outcome) => ({ ...tally, [outcome]: (tally[outcome] ?? 0) + 1 }), {});
  const throttleEligible = unique.filter(beer => {
    const row = storedRows.get(beer.id);
    return row !== undefined && isThrottleEligible(beer, row, options.now);
  }).length;
  console.log(JSON.stringify({
    event: 'seen_beers.recorded',
    ...counts,
    rows_read: storedRows.size,
    throttle_eligible: throttleEligible,
    cleanup: cleanup.length,
    enrichment: enrichment.length,
  }));

  return { outcomes, cleanup, enrichment };
}

/**
 * Record that cleanup was sent for these rows. Guarded on the hash that was
 * sent and on the row still being uncleaned, and never moves the marker
 * backwards, so a late mark for an old description cannot suppress the
 * retry of a newer one. Throws on a D1 error; the caller decides.
 */
export async function markCleanupQueued(
  db: D1Database,
  sent: readonly { readonly id: string; readonly descriptionHash: string }[],
  options: { readonly now: number }
): Promise<void> {
  const chunks = Array.from({ length: Math.ceil(sent.length / D1_MAX_STATEMENTS_PER_BATCH) },
    (_, i) => sent.slice(i * D1_MAX_STATEMENTS_PER_BATCH, (i + 1) * D1_MAX_STATEMENTS_PER_BATCH));
  const marked = { count: 0 };
  for (const chunk of chunks) {
    const results = await db.batch(chunk.map(item =>
      db.prepare(
        `UPDATE enriched_beers SET queued_for_cleanup_at = MAX(COALESCE(queued_for_cleanup_at, 0), ?)
         WHERE id = ? AND description_hash IS ? AND description_cleaned_at IS NULL`
      ).bind(options.now, item.id, item.descriptionHash)
    ));
    marked.count += results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
  }
  console.log(JSON.stringify({ event: 'seen_beers.cleanup_marked', requested: sent.length, marked: marked.count }));
}
