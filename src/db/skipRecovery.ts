/**
 * Re-checks skipped rows against the current blocklist rules.
 *
 * `skipped` is terminal for categorizeBeer and the sweep, and /beers/sync
 * overwrites name and brewer without touching the status. So a real beer
 * first seen under a placeholder brewer, or caught by a rule later narrowed,
 * would stay skipped for good. This scan visits every recently seen skipped
 * row and returns those no rule matches any more to `pending`, where the
 * normal quota-checked sweep picks them up.
 */

import { shouldSkipEnrichment } from '../config';
import { ABV_LOOKUP_RECENTLY_SEEN_MS, SKIP_RECHECK_MAX_ROWS, SKIP_RECHECK_PAGE_SIZE } from '../constants';
import { SAME_IDENTITY_SQL } from './identity';
import { NOT_VERIFIED_SQL } from './verified';
import { asTypedRows } from './helpers';

type SkippedRow = { readonly id: string; readonly brew_name: string; readonly brewer: string | null };

export type SkipRecoveryResult = {
  readonly released: number;
  readonly scanned: number;
  readonly capReached: boolean;
};

type ScanOptions = { readonly pageSize?: number; readonly maxRows?: number };

async function releaseRows(db: D1Database, rows: readonly SkippedRow[], now: number): Promise<number> {
  if (rows.length === 0) return 0;
  const results = await db.batch(rows.map(row =>
    db.prepare(
      `UPDATE enriched_beers SET enrichment_status = 'pending', updated_at = ?
       WHERE id = ? AND enrichment_status = 'skipped' AND ${NOT_VERIFIED_SQL} AND ${SAME_IDENTITY_SQL}`
    ).bind(now, row.id, row.brew_name, row.brewer)
  ));
  return results.reduce((count, result) => count + (result.meta?.changes ?? 0), 0);
}

async function scanFrom(
  db: D1Database,
  scan: { readonly cursor: string; readonly seenCutoff: number; readonly now: number; readonly pageSize: number; readonly maxRows: number },
  progress: { readonly released: number; readonly scanned: number }
): Promise<SkipRecoveryResult> {
  const limit = Math.min(scan.pageSize, scan.maxRows - progress.scanned);
  const page = asTypedRows<SkippedRow>((await db.prepare(
    `SELECT id, brew_name, brewer FROM enriched_beers
     WHERE enrichment_status = 'skipped' AND abv IS NULL AND ${NOT_VERIFIED_SQL} AND last_seen_at >= ? AND id > ?
     ORDER BY id LIMIT ?`
  ).bind(scan.seenCutoff, scan.cursor, limit).all()).results);

  const unblocked = page.filter(row => !shouldSkipEnrichment({ brewName: row.brew_name, brewer: row.brewer }));
  const next = {
    released: progress.released + await releaseRows(db, unblocked, scan.now),
    scanned: progress.scanned + page.length,
  };
  const last = page[page.length - 1];
  if (last === undefined || page.length < limit) {
    return { ...next, capReached: false };
  }
  if (next.scanned >= scan.maxRows) {
    console.error(JSON.stringify({ event: 'skip_recheck_cap_reached', maxRows: scan.maxRows, released: next.released }));
    return { ...next, capReached: true };
  }
  return scanFrom(db, { ...scan, cursor: last.id }, next);
}

export async function releaseUnblockedSkips(db: D1Database, options: ScanOptions = {}): Promise<SkipRecoveryResult> {
  const now = Date.now();
  return scanFrom(db, {
    cursor: '',
    seenCutoff: now - ABV_LOOKUP_RECENTLY_SEEN_MS,
    now,
    pageSize: options.pageSize ?? SKIP_RECHECK_PAGE_SIZE,
    maxRows: options.maxRows ?? SKIP_RECHECK_MAX_ROWS,
  }, { released: 0, scanned: 0 });
}
