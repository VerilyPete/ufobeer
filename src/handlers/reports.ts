/**
 * GET /reports/usage: aggregate usage telemetry for the Grafana dashboard
 * (plans/usage-dashboards.md, Read endpoint). Responses are flat rows with
 * fixed field names, so no install ID can leave D1 through this route.
 *
 * Days are UTC receipt days. A range must sit inside the retention window,
 * so a reaped day can never come back as a false zero.
 */

import { USAGE_DAILY_RETENTION_DAYS, USAGE_REPORT_DEFAULT_DAYS } from '../constants';
import { getToday } from '../utils/date';
import {
  readAdoptionReport,
  readBreakdownReport,
  readDailyReport,
  readEventsReport,
  type UsageReportRange,
} from '../db/usage-report';

export const USAGE_REPORT_VIEWS = ['daily', 'events', 'adoption', 'breakdown'] as const;

export type UsageReportView = (typeof USAGE_REPORT_VIEWS)[number];

export type UsageReportQuery =
  | Readonly<{ ok: true; view: UsageReportView; from: string; to: string }>
  | Readonly<{ ok: false; error: string }>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isUsageReportView = (value: string): value is UsageReportView =>
  USAGE_REPORT_VIEWS.some((view) => view === value);

const isCalendarDay = (value: string): boolean => {
  if (!DAY_PATTERN.test(value)) {
    return false;
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && getToday(new Date(ms)) === value;
};

const invalid = (error: string): UsageReportQuery => ({ ok: false, error });

/**
 * Parse and bound a report query. `from` defaults to the start of the last
 * USAGE_REPORT_DEFAULT_DAYS days and `to` to today; `from` must be on or
 * after the retention cutoff the reap uses, `to` no later than today, and
 * `from` no later than `to`.
 */
export function parseUsageReportQuery(params: URLSearchParams, now: number): UsageReportQuery {
  const view = params.get('view');
  if (view === null || !isUsageReportView(view)) {
    return invalid(`view must be one of ${USAGE_REPORT_VIEWS.join(', ')}`);
  }

  const today = getToday(new Date(now));
  const cutoff = getToday(new Date(now - USAGE_DAILY_RETENTION_DAYS * DAY_MS));
  const from = params.get('from') ?? getToday(new Date(now - (USAGE_REPORT_DEFAULT_DAYS - 1) * DAY_MS));
  const to = params.get('to') ?? today;

  if (!isCalendarDay(from) || !isCalendarDay(to)) {
    return invalid('from and to must be calendar days as YYYY-MM-DD');
  }
  if (from < cutoff) {
    return invalid(`from must be on or after ${cutoff}, the start of the retention window`);
  }
  if (to > today) {
    return invalid(`to must be on or before ${today}`);
  }
  if (from > to) {
    return invalid('from must be on or before to');
  }
  return { ok: true, view, from, to };
}

export type UsageReportRow = Readonly<Record<string, string | number | null>>;

const READERS: Readonly<Record<UsageReportView, (db: D1Database, range: UsageReportRange) => Promise<readonly UsageReportRow[]>>> = {
  daily: readDailyReport,
  events: readEventsReport,
  adoption: readAdoptionReport,
  breakdown: readBreakdownReport,
};

/** Rows for a validated query, from the view's aggregate query. */
export async function readUsageReport(
  db: D1Database,
  { view, from, to }: Extract<UsageReportQuery, { ok: true }>,
): Promise<readonly UsageReportRow[]> {
  return READERS[view](db, { from, to });
}
