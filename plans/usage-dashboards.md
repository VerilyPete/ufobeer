# Plan: keep usage data longer and chart it in Grafana

## Why

Usage telemetry (`plans/usage-telemetry.md`) stores per-install daily counts in
D1 and deletes them 180 days after the day they were received. There is no way
to see the data except `wrangler d1 execute`. Two gaps:

1. **History disappears.** Per-install rows go after 180 days, so year-over-year
   questions and long per-install profiles are impossible.
2. **No dashboard.** Answering "is anyone using Suggestions?" needs hand-written
   SQL.

Pete chose (2026-11-10): keep **per-install** data longer, and chart it in
**Grafana Cloud's free tier**.

## Why not Cloudflare's own dashboards

Checked against Cloudflare's docs on 2026-11-10:

| Tool | Can it chart usage history? |
|---|---|
| Custom Dashboards (free, all plans since 2026-04-22) | No. Sources are GraphQL analytics datasets, Workers Observability logs/traces and Log Explorer. Not D1, not Analytics Engine. Workers Logs keep 7 days on Workers Paid, so a chart built from a logged daily summary never shows more than a week. |
| Workers Observability Query Builder | Same 7-day log window. |
| Workers Analytics Engine | Keeps 3 months, and Cloudflare has no built-in UI for it. Its SQL API feeds Grafana. |
| D1 | Keeps data as long as we choose, at negligible cost (Workers Paid includes 25 billion rows read and 50 million written a month). |

So D1 stays the store. Grafana reads it through a small read-only endpoint on
this Worker. Custom Dashboards remain useful for request-level health (errors,
CPU, WAF) and are out of scope here.

## Decisions

| Topic | Decision |
|---|---|
| Retention, returning installs | Per-install rows kept **2 years** (730 days) after the day received. Confirmed by Pete 2026-11-10 as a starting point. |
| Retention, one-day installs | Installs whose `first_seen_day = last_seen_day` keep today's 180 days (see Storage bound). |
| IP link | Unchanged: `usage_batches` still goes after 8 days. |
| Store | Existing D1 tables. No new copy of the data. |
| Read path | `GET /reports/usage`, returning **aggregates only**. No install ID ever leaves D1 through it. |
| Credential | New secret `USAGE_REPORT_TOKEN`, valid only on `/reports/usage`. Not `ADMIN_SECRET`: Grafana must not hold a credential that can replay the DLQ or trigger enrichment. |
| Dashboard | Grafana Cloud free tier, Infinity data source (JSON over HTTPS). Dashboard JSON committed to `dashboards/usage.json`. |
| Per-install questions | Still `wrangler d1 execute`, by hand. Not exposed to Grafana. |
| Ingest drops | Counted per reason in D1 (`usage_ingest_daily`), so the dashboard needs no second data source. |

## Storage bound

The growth budget allows at most 50,000 `usage_daily` rows a day (2,000 posts ×
25 events). Kept 730 days, that is 36.5 million rows, several GB with the
`(install_id, day)` index, too close to D1's 10 GB database limit to be
comfortable.

The worst case comes from invented install IDs, which post on one day and never
return. Keeping one-day installs at 180 days bounds them exactly as today. Only
installs seen on two or more UTC days get the longer window, and those are
limited by real users. At beta scale (tens of installs, about 10 rows per
install-day) two years is roughly 100,000–300,000 rows.

An install that returns after its 180-day rows were deleted is treated as
returning from then on; its earlier one-day rows are already gone. That is
acceptable.

## Retention changes

The reaps in `src/handlers/scheduled.ts` keep their pattern (every tick, before
the enrichment checks, bounded, own try/catch).

| Table | Deleted when |
|---|---|
| `usage_daily` | `day` older than 730 days; or `day` older than 180 days and the install's `first_seen_day = last_seen_day` |
| `usage_installs` | `last_seen_day` older than 730 days; or older than 180 days with `first_seen_day = last_seen_day` |
| `usage_batches` | unchanged (8 days) |
| `usage_ingest_daily` | 730 days, so the dashboard can show accepted posts over the same window |

`USAGE_DAILY_RETENTION_DAYS` splits into `USAGE_RETURNING_RETENTION_DAYS = 730`
and `USAGE_ONE_DAY_RETENTION_DAYS = 180`. The one-day reap joins
`usage_installs`; it needs an index that serves `first_seen_day = last_seen_day
AND last_seen_day < ?` (a partial index on `last_seen_day WHERE first_seen_day =
last_seen_day` is the candidate; confirm with `EXPLAIN QUERY PLAN`).

## Read endpoint

`GET /reports/usage?view=<view>&from=YYYY-MM-DD&to=YYYY-MM-DD`

- Auth: `X-API-Key` as on every route, plus `Authorization: Bearer
  <USAGE_REPORT_TOKEN>`, compared timing-safe. Missing or wrong token: 401.
  `ADMIN_SECRET` is not accepted here, and the token is not accepted on
  `/admin/*`.
- Range: at most 730 days; default the last 90. Days are UTC receipt days, as
  everywhere in usage telemetry.
- Response: a JSON array of flat rows, which Infinity charts without
  transformation. `Cache-Control: no-store`.
- Audit: normal `respond()` path, so each read is in `audit_log`.

| View | Rows | Answers |
|---|---|---|
| `daily` | `day, active_installs, new_installs, sessions, posts, duplicates, dropped_post_cap, dropped_new_install, dropped_all_events` | Is anyone using the app; is telemetry still arriving; is any being lost |
| `events` | `day, event, count, installs` | Feature use over time |
| `adoption` | `event, installs_using, active_installs, share, avg_per_session` over the range | Where to focus |
| `breakdown` | `day, dimension, value, active_installs` with `dimension` one of `app_version`, `ai_status`, `os_major` | Version rollout; Apple Intelligence fallbacks |

`sessions` is the sum of `session_started`. `new_installs` counts
`usage_installs.first_seen_day` in the range, so it under-counts once the
one-day reap has removed old one-day installs; the view's tests document that.

## Grafana

Manual setup, recorded in `.claude/api-endpoints.md`:

1. Grafana Cloud free stack. Install the Infinity data source (verify it is
   available on the free tier before slice 4; if not, fall back to a page served
   by this Worker behind Cloudflare Access).
2. Data source base URL `https://api.ufobeer.app/reports/usage`, with
   `X-API-Key` and `Authorization` as secure headers, and allowed hosts limited
   to that URL.
3. Import `dashboards/usage.json`: active installs and sessions per day, events
   per day, adoption table, app version and AI status breakdowns.
4. Alerts (Grafana free alerting): no accepted posts for 24 hours; any
   `dropped_*` count above zero. Cleanup lag stays with the existing usage
   health check in `src/db/usage.ts`.

Grafana sees only totals that aren't linked to any install, so the privacy
page's "never sold or shared" sentence still holds.

## Privacy and docs

Change in the same release as the retention slice:

- `ufobeer-site` privacy page: "until 180 days after you last use the app"
  becomes the new period, in both places it appears.
- `plans/usage-telemetry.md` Retention table and Privacy label section.
- BeerSelector `native-ios/Docs/USAGE-TELEMETRY.md`, if it states retention.
- App Store privacy details: no change (categories and purposes are the same).

## Slices (TDD, each one shippable)

1. **Retention split.** Constants, the two-rule reaps, the index migration, and
   `usage_ingest_daily` at 730 days. Tests against D1 in the Workers pool: a
   returning install's 200-day-old rows survive; a one-day install's do not;
   both go at 731 days; the boundary days; the reap limit; the query plan uses
   the index. The usage health check in `src/db/usage.ts` (oldest expired
   row per table) computes "expired" with the matching rule, so a returning
   install's 200-day-old row is not reported as overdue. Ship with the privacy
   page and doc changes.
2. **Drop counters.** Migration adding `duplicates`, `dropped_post_cap`,
   `dropped_new_install` and `dropped_all_events` (INTEGER NOT NULL DEFAULT 0)
   to `usage_ingest_daily`. Each non-admitted outcome increments its column
   for the UTC day, in the same statement batch that decides the outcome.
   This changes one rule in `plans/usage-telemetry.md`: an all-dropped report
   now writes one counter row; update that rule and its tests. A
   `daily_post_cap` drop increments a counter on a row that already exists,
   so a flood costs one D1 row write per dropped post, bounded by the per-IP
   limit. Analytics Engine tracking stays as it is.
3. **Report route and auth.** `USAGE_REPORT_TOKEN` in `secrets.required`, the
   route, range validation, and auth tests (no token, wrong token, admin
   secret rejected, token rejected on `/admin/*`, missing API key). Returns an
   empty array for every view.
4. **Views.** The four queries, tested against seeded D1: no install ID in any
   response; counts match hand-computed fixtures; empty ranges; the
   `new_installs` caveat.
5. **Grafana.** Data source, dashboard JSON committed, alerts. Acceptance:
   the dashboard shows the beta's real data, and both alerts fire in a test.

## Open questions

- Is the Infinity data source available on Grafana Cloud's free tier? Checked
  before any more planning (see Grafana, step 1).
