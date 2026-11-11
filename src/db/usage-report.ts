/**
 * Aggregate queries behind GET /reports/usage (plans/usage-dashboards.md,
 * Read endpoint). Every query selects fixed aggregate columns, never
 * install_id, and reads only days in [from, to].
 *
 * Each part (usage rows, installs, ingest counters) is aggregated on its
 * own and then joined on day, so a join never multiplies a count. Range
 * counts of installs are distinct over the whole range, never sums of daily
 * distinct counts.
 */

import { USAGE_DROP_COUNTERS_SINCE, USAGE_POSTS_SINCE } from '../constants';

export type UsageReportRange = Readonly<{ from: string; to: string }>;

export type DailyReportRow = Readonly<{
  day: string;
  active_installs: number;
  new_installs: number;
  sessions: number;
  posts: number | null;
  duplicates: number | null;
  dropped_post_cap: number | null;
  dropped_new_install: number | null;
  dropped_all_events: number | null;
  dropped_events: number | null;
}>;

export type EventsReportRow = Readonly<{ day: string; event: string; count: number; installs: number }>;

export type AdoptionReportRow = Readonly<{
  event: string;
  installs_using: number;
  active_installs: number;
  share: number;
  avg_per_session: number | null;
}>;

export type BreakdownReportRow = Readonly<{
  day: string;
  dimension: 'app_version' | 'ai_status' | 'os_major';
  value: string;
  active_installs: number;
}>;

const counterSince = (column: string, sinceParam: string): string =>
  `CASE WHEN d.day < ${sinceParam} THEN NULL ELSE COALESCE(ingest.${column}, 0) END AS ${column}`;

const DAILY_SQL = `
  WITH RECURSIVE days(day) AS (
    SELECT ?1
    UNION ALL
    SELECT date(day, '+1 day') FROM days WHERE day < ?2
  ),
  usage AS (
    SELECT day,
           COUNT(DISTINCT install_id) AS active_installs,
           SUM(CASE WHEN event = 'session_started' THEN count ELSE 0 END) AS sessions
    FROM usage_daily
    WHERE day BETWEEN ?1 AND ?2
    GROUP BY day
  ),
  installs AS (
    SELECT first_seen_day AS day, COUNT(*) AS new_installs
    FROM usage_installs
    WHERE first_seen_day BETWEEN ?1 AND ?2
    GROUP BY first_seen_day
  )
  SELECT d.day AS day,
         COALESCE(usage.active_installs, 0) AS active_installs,
         COALESCE(installs.new_installs, 0) AS new_installs,
         COALESCE(usage.sessions, 0) AS sessions,
         ${counterSince('posts', '?3')},
         ${counterSince('duplicates', '?4')},
         ${counterSince('dropped_post_cap', '?4')},
         ${counterSince('dropped_new_install', '?4')},
         ${counterSince('dropped_all_events', '?4')},
         ${counterSince('dropped_events', '?4')}
  FROM days d
  LEFT JOIN usage ON usage.day = d.day
  LEFT JOIN installs ON installs.day = d.day
  LEFT JOIN usage_ingest_daily ingest ON ingest.day = d.day
  ORDER BY d.day`;

const EVENTS_SQL = `
  SELECT day, event, SUM(count) AS count, COUNT(DISTINCT install_id) AS installs
  FROM usage_daily
  WHERE day BETWEEN ?1 AND ?2
  GROUP BY day, event
  ORDER BY day, event`;

const ADOPTION_SQL = `
  WITH per_install AS (
    SELECT install_id, event, SUM(count) AS total
    FROM usage_daily
    WHERE day BETWEEN ?1 AND ?2
    GROUP BY install_id, event
  ),
  sessions AS (
    SELECT install_id, total AS sessions FROM per_install WHERE event = 'session_started'
  ),
  active AS (
    SELECT COUNT(DISTINCT install_id) AS installs FROM per_install
  )
  SELECT p.event AS event,
         COUNT(*) AS installs_using,
         active.installs AS active_installs,
         CAST(COUNT(*) AS REAL) / active.installs AS share,
         CAST(SUM(p.total) AS REAL) / NULLIF(SUM(s.sessions), 0) AS avg_per_session
  FROM per_install p
  CROSS JOIN active
  LEFT JOIN sessions s ON s.install_id = p.install_id
  GROUP BY p.event
  ORDER BY p.event`;

const BREAKDOWN_SQL = `
  SELECT day, 'app_version' AS dimension, app_version AS value, COUNT(DISTINCT install_id) AS active_installs
  FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY day, app_version
  UNION ALL
  SELECT day, 'ai_status', ai_status, COUNT(DISTINCT install_id)
  FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY day, ai_status
  UNION ALL
  SELECT day, 'os_major', CAST(os_major AS TEXT), COUNT(DISTINCT install_id)
  FROM usage_daily WHERE day BETWEEN ?1 AND ?2 GROUP BY day, os_major
  ORDER BY day, dimension, value`;

/** One row per day in the range, zeros where nothing arrived; counters are null before they existed. */
export async function readDailyReport(db: D1Database, { from, to }: UsageReportRange): Promise<readonly DailyReportRow[]> {
  return (await db.prepare(DAILY_SQL).bind(from, to, USAGE_POSTS_SINCE, USAGE_DROP_COUNTERS_SINCE).all<DailyReportRow>()).results;
}

export async function readEventsReport(db: D1Database, { from, to }: UsageReportRange): Promise<readonly EventsReportRow[]> {
  return (await db.prepare(EVENTS_SQL).bind(from, to).all<EventsReportRow>()).results;
}

/**
 * One row per event over the whole range. avg_per_session divides the
 * event's total by the session_started total of the installs that used it,
 * and is null when those installs reported no sessions.
 */
export async function readAdoptionReport(db: D1Database, { from, to }: UsageReportRange): Promise<readonly AdoptionReportRow[]> {
  return (await db.prepare(ADOPTION_SQL).bind(from, to).all<AdoptionReportRow>()).results;
}

/**
 * Distinct installs per day for each dimension value. An install that
 * changed value during a day counts under each, so a day's values can sum
 * to more than its active installs.
 */
export async function readBreakdownReport(db: D1Database, { from, to }: UsageReportRange): Promise<readonly BreakdownReportRow[]> {
  return (await db.prepare(BREAKDOWN_SQL).bind(from, to).all<BreakdownReportRow>()).results;
}
