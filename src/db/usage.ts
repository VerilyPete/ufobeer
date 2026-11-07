/**
 * Budgeted, deduplicated usage write for POST /usage.
 *
 * Every statement runs in one db.batch(), which D1 executes as a single
 * transaction, so the caps hold under concurrent posts and a failure leaves
 * nothing behind. The admission decision is made once, by the usage_batches
 * insert, and carried through the batch by the request ID it records: the
 * event and budget writes only run when the batch row carries this
 * request's ID. The closing SELECT classifies the outcome from the same
 * transaction state, so the reported reason cannot race another post.
 *
 * See plans/usage-telemetry.md (Write: budgeted, deduplicated and atomic).
 */

import { z } from 'zod';
import type { UsageReport } from '../schemas/request';
import {
  USAGE_BATCH_RETENTION_DAYS,
  USAGE_DAILY_RETENTION_DAYS,
  USAGE_INGEST_RETENTION_DAYS,
  USAGE_REAP_LIMIT,
} from '../constants';
import { getToday } from '../utils/date';

export const USAGE_WRITE_OUTCOMES = ['admitted', 'duplicate', 'daily_post_cap', 'new_install_cap'] as const;

export type UsageWriteOutcome = (typeof USAGE_WRITE_OUTCOMES)[number];

export type RecordUsageReportOptions = Readonly<{
  report: UsageReport;
  /** UTC day (YYYY-MM-DD), computed once by the caller for every statement */
  day: string;
  requestId: string;
  /** Unix ms */
  now: number;
  installCap: number;
  postCap: number;
}>;

const OutcomeRowSchema = z.object({ outcome: z.enum(USAGE_WRITE_OUTCOMES) });

const ADMIT_INSTALL_SQL = `
  INSERT INTO usage_installs (install_id, first_seen_day, last_seen_day)
  SELECT ?1, ?2, ?2
  WHERE NOT EXISTS (SELECT 1 FROM usage_batches WHERE install_id = ?1 AND batch_id = ?3)
    AND COALESCE((SELECT posts FROM usage_ingest_daily WHERE day = ?2), 0) < ?4
    AND (EXISTS (SELECT 1 FROM usage_installs WHERE install_id = ?1)
         OR (SELECT COUNT(*) FROM usage_installs WHERE first_seen_day = ?2) < ?5)
  ON CONFLICT (install_id) DO UPDATE SET last_seen_day = excluded.last_seen_day`;

const ADMIT_POST_SQL = `
  INSERT INTO usage_batches (install_id, batch_id, request_id, received_at)
  SELECT ?1, ?2, ?3, ?4
  WHERE EXISTS (SELECT 1 FROM usage_installs WHERE install_id = ?1)
    AND COALESCE((SELECT posts FROM usage_ingest_daily WHERE day = ?5), 0) < ?6
  ON CONFLICT (install_id, batch_id) DO NOTHING`;

const COUNT_EVENT_SQL = `
  INSERT INTO usage_daily (day, install_id, event, app_version, ai_status, os_major, count)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
  WHERE EXISTS (SELECT 1 FROM usage_batches
                WHERE install_id = ?2 AND batch_id = ?8 AND request_id = ?9)
  ON CONFLICT (day, install_id, event, app_version, ai_status, os_major)
  DO UPDATE SET count = count + excluded.count`;

const CHARGE_BUDGET_SQL = `
  INSERT INTO usage_ingest_daily (day, posts)
  SELECT ?1, 1
  WHERE EXISTS (SELECT 1 FROM usage_batches
                WHERE install_id = ?2 AND batch_id = ?3 AND request_id = ?4)
  ON CONFLICT (day) DO UPDATE SET posts = posts + 1`;

const CLASSIFY_SQL = `
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM usage_batches
                 WHERE install_id = ?1 AND batch_id = ?2 AND request_id = ?3) THEN 'admitted'
    WHEN EXISTS (SELECT 1 FROM usage_batches
                 WHERE install_id = ?1 AND batch_id = ?2) THEN 'duplicate'
    WHEN COALESCE((SELECT posts FROM usage_ingest_daily WHERE day = ?4), 0) >= ?5 THEN 'daily_post_cap'
    WHEN NOT EXISTS (SELECT 1 FROM usage_installs WHERE install_id = ?1) THEN 'new_install_cap'
  END AS outcome`;

export async function recordUsageReport(
  db: D1Database,
  { report, day, requestId, now, installCap, postCap }: RecordUsageReportOptions,
): Promise<UsageWriteOutcome> {
  const { installId, batchId } = report;

  const results = await db.batch([
    db.prepare(ADMIT_INSTALL_SQL).bind(installId, day, batchId, postCap, installCap),
    db.prepare(ADMIT_POST_SQL).bind(installId, batchId, requestId, now, day, postCap),
    ...report.events.map((event) =>
      db.prepare(COUNT_EVENT_SQL).bind(
        day, installId, event.name, report.appVersion, report.aiStatus, report.osMajor, event.count,
        batchId, requestId,
      )),
    db.prepare(CHARGE_BUDGET_SQL).bind(day, installId, batchId, requestId),
    db.prepare(CLASSIFY_SQL).bind(installId, batchId, requestId, day, postCap),
  ]);

  const classification = results.at(-1)?.results[0];
  const parsed = OutcomeRowSchema.safeParse(classification);
  if (!parsed.success) {
    throw new Error(`Unclassifiable usage write outcome: ${JSON.stringify(classification)}`);
  }
  return parsed.data.outcome;
}

const DAY_MS = 24 * 60 * 60 * 1000;

type UsageTable = 'usage_daily' | 'usage_installs' | 'usage_batches' | 'usage_ingest_daily';

export type UsageReapResult = Readonly<Record<UsageTable, number | 'failed'>>;

const reapTable = async (
  db: D1Database,
  { table, sql, cutoff }: Readonly<{ table: UsageTable; sql: string; cutoff: string | number }>,
): Promise<number | 'failed'> => {
  try {
    const result = await db.prepare(sql).bind(cutoff, USAGE_REAP_LIMIT).run();
    return result.meta.changes;
  } catch (error) {
    console.error(`[cron] ${table} reap failed:`, error);
    return 'failed';
  }
};

/**
 * Delete usage rows past their retention window, at most USAGE_REAP_LIMIT
 * per table per call. Each table is reaped independently, so one failing
 * delete is reported as 'failed' without blocking the others.
 */
export async function reapExpiredUsage(db: D1Database, now: number = Date.now()): Promise<UsageReapResult> {
  const dailyCutoff = getToday(new Date(now - USAGE_DAILY_RETENTION_DAYS * DAY_MS));
  const [usageDaily, usageInstalls, usageBatches, usageIngestDaily] = await Promise.all([
    reapTable(db, { table: 'usage_daily', sql: 'DELETE FROM usage_daily WHERE day < ? LIMIT ?', cutoff: dailyCutoff }),
    reapTable(db, { table: 'usage_installs', sql: 'DELETE FROM usage_installs WHERE last_seen_day < ? LIMIT ?', cutoff: dailyCutoff }),
    reapTable(db, {
      table: 'usage_batches',
      sql: 'DELETE FROM usage_batches WHERE received_at < ? LIMIT ?',
      cutoff: now - USAGE_BATCH_RETENTION_DAYS * DAY_MS,
    }),
    reapTable(db, {
      table: 'usage_ingest_daily',
      sql: 'DELETE FROM usage_ingest_daily WHERE day < ? LIMIT ?',
      cutoff: getToday(new Date(now - USAGE_INGEST_RETENTION_DAYS * DAY_MS)),
    }),
  ]);
  return {
    usage_daily: usageDaily,
    usage_installs: usageInstalls,
    usage_batches: usageBatches,
    usage_ingest_daily: usageIngestDaily,
  };
}
