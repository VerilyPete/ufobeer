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
| Retention | Per-install rows kept **2 years** (730 days) after the day received, for every install. Confirmed by Pete 2026-11-10 as a starting point. |
| Storage bound | Lower the daily growth budget so 730 days of worst case fits comfortably in D1 (see Storage bound). |
| IP link | Unchanged: `usage_batches` still goes after 8 days. |
| Store | Existing D1 tables. No new copy of the data. |
| Read path | `GET /reports/usage`, returning **aggregates only**. No install ID ever leaves D1 through it. |
| Credential | New secret `USAGE_REPORT_TOKEN`, valid only on `/reports/usage`. Not `ADMIN_SECRET`: Grafana must not hold a credential that can replay the DLQ or trigger enrichment. |
| Rate limit | `/reports/usage` has its own limiter, routed before the shared per-key bucket, so dashboard reads never use up `/beers` capacity. |
| Dashboard | Grafana Cloud free tier, Infinity data source (JSON over HTTPS). Dashboard JSON committed to `dashboards/usage.json`. |
| Per-install questions | Still `wrangler d1 execute`, by hand. Not exposed to Grafana. |
| Ingest drops | Counted per reason in D1 (`usage_ingest_daily`), saturating at a daily ceiling, so the dashboard needs no second data source. Dropped reports and dropped event entries are counted separately. |
| Privacy page | "Never sold or shared" stays as written. Pete, 2026-11-10: Grafana receives only aggregated totals that can't be linked to anyone. Only the retention period changes. |

## Storage bound

`usage_daily` gains a row per distinct (install, event, dimensions) per day.
Repeat posts from the same install on the same day update existing rows, so
rows per day are bounded by **accepted posts × events per post**. Install IDs
are chosen by the client, so a flood can invent IDs and reuse them on later
days; retention can't tell those apart from real installs. The post cap is the
bound that holds.

| Post cap | Worst rows/day (× 25 events) | Worst rows in 730 days |
|---|---|---|
| 2,000 (today) | 50,000 | 36.5 million, too close to D1's 10 GB limit |
| 500 (proposed) | 12,500 | 9.1 million |

Proposed caps: **500 accepted posts** and **100 new installs** per UTC day.
Slice 1 checks real peak `usage_ingest_daily.posts` first, and measures bytes
per row (table plus both indexes) on a seeded copy to turn the row bound into a
size bound. Each install posts a few times a day (session start and background
flushes), so 500 is far above beta traffic.

Nothing alerts on a cap today. A capped post logs at `console.log` level and
goes to Analytics Engine (`src/handlers/usage.ts:64`), and it still returns
204, so the error-alerts tail worker (`workers/error-alerts/src/filter.ts:3`)
never sees it. Slice 1 lowers the caps, so it must also add the alert: the
daily usage health check raises a `console.error` when the previous UTC day's
`posts` reached the post cap, or its `first_seen_day` installs reached the
new-install cap. That uses the alert path the health check already has, and
works before Grafana exists.

**Row-count alert.** `USAGE_DAILY_ROW_ALERT` (500,000, `src/constants.ts:128`)
was sized for 180 days. Over 730 days, 100 daily installs writing 7 distinct
event rows each reach 511,000 rows, well inside the caps, so it would fire on
legitimate traffic. Slice 1 recalibrated it from the bytes-per-row measurement
(below) to **1,000,000 rows**, about 300 MB. That's about twice two years of
beta traffic, and an invented-install flood at the cap reaches it in about 80
days. A 2 GB budget (about 7 million rows) was considered and rejected: a flood
at the cap would take about 19 months to reach it.

**Measured in slice 1 (2026-11-10).** Production had one `usage_ingest_daily`
row (2026-11-10, 10 posts), 4 installs (all first seen that day) and 16
`usage_daily` rows. A local SQLite copy seeded with 500,000 worst-case rows
(random UUID install IDs, the longest app version and AI status, all 25
events, shuffled insert order) measured, by `dbstat`, 110 bytes a row in the
table, 122 in the primary-key index and 66 in `idx_usage_daily_install`:
**298 bytes a row**, rounded to 300. So 9.1 million rows at the cap is about
2.7 GB, and the caps stay at 500 posts and 100 new installs.

## Retention changes

The reaps in `src/handlers/scheduled.ts` keep their pattern (every tick, before
the enrichment checks, bounded, own try/catch).

| Table | Deleted when |
|---|---|
| `usage_daily` | `day` older than 730 days |
| `usage_installs` | `last_seen_day` older than 730 days |
| `usage_batches` | unchanged (8 days) |
| `usage_ingest_daily` | `day` older than 730 days, so posts and drops cover the same window |

`USAGE_DAILY_RETENTION_DAYS` and `USAGE_INGEST_RETENTION_DAYS` become 730. The
usage health check in `src/db/usage.ts` (oldest expired row per table) reads
the same constants, so it follows without a rule change. What does change:

- `USAGE_DAILY_ROW_ALERT` and its comment (see Storage bound).
- The comments on `USAGE_INGEST_RETENTION_DAYS` ("only matter for today's post
  budget" is no longer true) and `USAGE_REAP_LIMIT` (its 50,000-rows-a-day
  figure follows the post cap).
- `test/db/usage-health.integration.test.ts:17`, which writes out the old
  windows and the 500,000 threshold, alongside the retention tests.

**Deadline.** `usage_ingest_daily` rows are deleted after 30 days today, and
lengthening retention can't bring a deleted row back. Slice 1 has to deploy
before the oldest `usage_ingest_daily` row is reaped. For a 2026-11-10 row
(telemetry went on that day), the strict `day < cutoff` reap first deletes it
on 2026-12-11. Treat **2026-12-07** as the safety deadline (slice 1 checks the real oldest
day). Otherwise the `posts` history starts with a gap.

## Read endpoint

`GET /reports/usage?view=<view>&from=YYYY-MM-DD&to=YYYY-MM-DD`

- Auth: `X-API-Key` as on every route, plus `Authorization: Bearer
  <USAGE_REPORT_TOKEN>`, compared timing-safe. Missing or wrong token: 401.
  `ADMIN_SECRET` is not accepted here, and the token is not accepted on
  `/admin/*`.
- Rate limit: its own key and limit (constant, for example 60 per minute),
  checked after the pre-auth limiter and before the shared per-key limiter.
- Range: inclusive; default the last 90 days. Days are UTC receipt days, as
  everywhere in usage telemetry. `from` must be on or after the retention
  cutoff (today − 730 days, the same cutoff the reap uses), and `to` must be no
  later than today. Anything else, or `from` after `to`, returns 400. That
  keeps expired days out of every response, so a reaped day can never come
  back as a false zero. It also caps the range at 731 days without a separate
  length rule.
- Response: a JSON array of flat rows with fixed field names, so no install ID
  can appear by accident. `Cache-Control: no-store`.
- Audit: normal `respond()` path, so each read is in `audit_log`.

| View | Rows | Answers |
|---|---|---|
| `daily` | `day, active_installs, new_installs, sessions, posts, duplicates, dropped_post_cap, dropped_new_install, dropped_all_events, dropped_events` | Is anyone using the app; is telemetry still arriving; is any being lost |
| `events` | `day, event, count, installs` | Feature use over time |
| `adoption` | `event, installs_using, active_installs, share, avg_per_session` over the range | Where to focus |
| `breakdown` | `day, dimension, value, active_installs` with `dimension` one of `app_version`, `ai_status`, `os_major` | Version rollout; Apple Intelligence fallbacks |

Definitions (slice 4 tests each one):

- **active_installs:** distinct `install_id` with any `usage_daily` row that
  day (in `adoption`, over the whole range). A sum of daily distinct counts is
  never used as a range count.
- **new_installs:** `usage_installs` rows whose `first_seen_day` is that day.
- **sessions:** sum of `count` for `session_started`.
- **posts, duplicates, dropped_*:** straight from `usage_ingest_daily`. A day
  with no row is zeros, but only on days the counter existed. Two constants
  record when each one starts: `USAGE_POSTS_SINCE` (the oldest
  `usage_ingest_daily` day when slice 1 deploys) and
  `USAGE_DROP_COUNTERS_SINCE` (the first full UTC day after slice 2 deploys).
  Before its start day, a counter is `null`, never 0, because a `DEFAULT 0`
  column can't say a day had no drops. The dashboard shows null as "no data".
- **dropped_post_cap, dropped_new_install, dropped_all_events, duplicates**
  count **reports**. **dropped_events** counts **event entries** that
  validation dropped from reports whose other events were stored (a valid
  `session_started` next to an event name the worker doesn't know). The units
  differ, and the panel labels them apart.
- **installs (events view):** distinct installs with that event that day.
- **share:** `installs_using / active_installs` as a fraction 0–1, over the
  range.
- **avg_per_session:** the event's total count divided by the
  `session_started` total **of the installs that used the event**; `null` when
  that denominator is 0.
- **breakdown overlap:** an install that changes app version or AI status
  during a day counts once under each value, so a day's values can sum to more
  than `active_installs`. The dashboard panel says so.
- Each part (usage rows, installs, ingest counters) is aggregated on its own
  and joined on `day`, so joins never multiply counts.

## Grafana

Manual setup, recorded in `.claude/api-endpoints.md`:

1. Grafana Cloud free stack. Infinity is pre-installed on Grafana Cloud stacks
   and the free tier is listed in its catalog; confirm under Connections.
2. Data source base URL `https://api.ufobeer.app/reports/usage`, with
   `X-API-Key` and `Authorization` as secure headers, and allowed hosts limited
   to that URL. Infinity calls it from Grafana's servers.
3. Import `dashboards/usage.json`: active installs and sessions per day, events
   per day, adoption table, app version and AI status breakdowns, ingest and
   drops.
4. Alerts (Grafana free alerting, which needs Infinity's backend parser):
   - **No reports:** the last complete UTC day has `posts = 0`. Evaluated
     after 01:00 UTC. Missing data and query errors alert too.
   - **Drops:** any `dropped_*` (including `dropped_events`) above zero on the
     last complete UTC day.

   Cleanup lag stays with the existing usage health check in `src/db/usage.ts`.

## Privacy and docs

Change in the same release as slice 1:

- `ufobeer-site` privacy page (`public/privacy/index.html:50` and `:64`). Today
  it says counts are kept "until 180 days after you last use the app". That's
  the wrong clock: each day's counts expire by the day the server received
  them, and the install record expires by the last day it reported
  (`src/db/usage.ts:139`). The two differ when a report is sent offline and
  arrives later. New wording for both places: "Each day's usage counts are
  deleted 2 years after the server receives them. The install ID is deleted 2
  years after the last report from it." `test/site.test.ts:169` asserts the
  new wording. The sharing sentence is unchanged (see Decisions).
- `plans/usage-telemetry.md`: Retention table, Growth budget figures and the
  throughput calculation. With slice 2, the rule that an all-dropped report
  writes nothing.
- `.claude/usage-telemetry.md`: retention windows (line 15) and the row-alert
  rationale (line 183).
- `AGENTS.md`: the caps, and (with slice 2) the drop behavior.
- `schema.sql`, alongside each migration.
- BeerSelector `native-ios/Docs/USAGE-TELEMETRY.md`: it doesn't state
  retention, so nothing changes for this plan. Its 30-day IP-link sentence is
  wrong (the link lasts about 8 days, as long as `usage_batches`), but that's
  already being fixed on BeerSelector branch `docs/usage-ip-join-8-days`.
- App Store privacy details: no change (categories and purposes are the same).

## Slices (TDD, each one shippable)

1. **Retention and budget.** Check real peak posts per day and measure bytes
   per row, then set the caps. Retention constants to 730, caps to the chosen
   values, `USAGE_DAILY_ROW_ALERT` recalibrated, `USAGE_POSTS_SINCE` set.
   The health check alerts when the previous UTC day hit either cap. Tests
   against D1 in the Workers pool: rows survive at 730 days and go at 731; the
   cap boundaries; the reap limit; the health check's new windows and
   threshold; a cap alert on a day at each cap and none on a day one below it.
   Ship with the privacy page and doc changes, before the deadline under
   Retention changes.
2. **Drop counters.** Migration adding `duplicates`, `dropped_post_cap`,
   `dropped_new_install`, `dropped_all_events` and `dropped_events` (INTEGER
   NOT NULL DEFAULT 0)
   to `usage_ingest_daily`, plus `schema.sql`. Each non-admitted outcome
   increments its column with a guarded upsert in the same batch that decides
   the outcome (`src/db/usage.ts:76`), keeping the existing order of checks.
   Counters stop at a daily ceiling (`WHERE col < ceiling`, so a saturated
   counter costs no further row writes); a value at the ceiling means
   "at least". Under a flood each dropped post below the ceiling costs one D1
   row write, on top of the limiter and audit writes it already causes.
   All-dropped reports skip that batch today (`src/handlers/usage.ts:48`); they
   get their own single-statement increment, which changes one rule in
   `plans/usage-telemetry.md` (an all-dropped report now writes a counter).
   An admitted post with dropped entries adds its `droppedCount` to
   `dropped_events` in the same batch, saturating at the same ceiling. A post
   can add more than one, so that update is `SET dropped_events =
   MIN(ceiling, dropped_events + ?)` with the same `WHERE dropped_events <
   ceiling` guard. Without the `MIN`, a value one below the ceiling plus three
   would overshoot it.
   `USAGE_DROP_COUNTERS_SINCE` is set.
   Tests: the last admitted post, a duplicate at the cap, both caps reached,
   saturation, rollback leaving counters unchanged, an all-dropped report, a
   mixed report (stored events plus dropped entries), a `dropped_events`
   increment that crosses the ceiling (it stops at the ceiling), and a later
   increment once it's saturated (no write).
   Analytics Engine tracking stays as it is.
3. **Report route and auth.** `USAGE_REPORT_TOKEN` in `secrets.required`, the
   route and its limiter, range validation. **Before deploying:** generate the
   token and set it with `wrangler secret put USAGE_REPORT_TOKEN`, because a
   missing `secrets.required` entry fails the deploy (`wrangler.jsonc:94`).
   Tests get their own binding. Grafana's copy of the token can wait until
   slice 5. Tests: no token, wrong token, admin
   secret rejected, token rejected on `/admin/*`, missing API key, report reads
   don't use the `/beers` bucket. Returns an empty array for every view.
4. **Views.** The four queries, tested against seeded D1 with several events,
   several dimension tuples per install, repeated days, and event users with no
   `session_started`: every definition above, no install ID in any response,
   empty ranges, range limits (`from` before the retention cutoff, `to` in
   the future, `from` after `to`, each tested with the clock moved past 730
   days), and `null` counters for days before each
   counter's start day.
5. **Grafana.** Data source, dashboard JSON committed, alerts. Acceptance: the
   dashboard shows the beta's real data, and both alerts fire in a test.

## Open questions

None. Slice 1 settled the caps (500 posts, 100 new installs) and the row
alert (1,000,000 rows); see Storage bound.
