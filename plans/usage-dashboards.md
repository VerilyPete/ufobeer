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
| Ingest drops | Counted per reason in D1 (`usage_ingest_daily`), saturating at a daily ceiling, so the dashboard needs no second data source. |
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
flushes), so 500 is far above beta traffic. The existing `daily_post_cap`
alert, and the new drop counter, show when real growth reaches it.

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
the same constants, so it follows without a rule change.

## Read endpoint

`GET /reports/usage?view=<view>&from=YYYY-MM-DD&to=YYYY-MM-DD`

- Auth: `X-API-Key` as on every route, plus `Authorization: Bearer
  <USAGE_REPORT_TOKEN>`, compared timing-safe. Missing or wrong token: 401.
  `ADMIN_SECRET` is not accepted here, and the token is not accepted on
  `/admin/*`.
- Rate limit: its own key and limit (constant, for example 60 per minute),
  checked after the pre-auth limiter and before the shared per-key limiter.
- Range: inclusive, at most 730 days; default the last 90. Days are UTC
  receipt days, as everywhere in usage telemetry.
- Response: a JSON array of flat rows with fixed field names, so no install ID
  can appear by accident. `Cache-Control: no-store`.
- Audit: normal `respond()` path, so each read is in `audit_log`.

| View | Rows | Answers |
|---|---|---|
| `daily` | `day, active_installs, new_installs, sessions, posts, duplicates, dropped_post_cap, dropped_new_install, dropped_all_events` | Is anyone using the app; is telemetry still arriving; is any being lost |
| `events` | `day, event, count, installs` | Feature use over time |
| `adoption` | `event, installs_using, active_installs, share, avg_per_session` over the range | Where to focus |
| `breakdown` | `day, dimension, value, active_installs` with `dimension` one of `app_version`, `ai_status`, `os_major` | Version rollout; Apple Intelligence fallbacks |

Definitions (slice 4 tests each one):

- **active_installs:** distinct `install_id` with any `usage_daily` row that
  day (in `adoption`, over the whole range). A sum of daily distinct counts is
  never used as a range count.
- **new_installs:** `usage_installs` rows whose `first_seen_day` is that day.
- **sessions:** sum of `count` for `session_started`.
- **posts, duplicates, dropped_*:** straight from `usage_ingest_daily`; a day
  with no row is zeros.
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
   - **Drops:** any `dropped_*` above zero on the last complete UTC day.

   Cleanup lag stays with the existing usage health check in `src/db/usage.ts`.

## Privacy and docs

Change in the same release as slice 1:

- `ufobeer-site` privacy page: "180 days after you last use the app" becomes 2
  years, in both places it appears, with `test/site.test.ts` updated to match.
  The sharing sentence is unchanged (see Decisions).
- `plans/usage-telemetry.md`: Retention table, Growth budget figures and the
  throughput calculation.
- `schema.sql`, alongside each migration.
- BeerSelector `native-ios/Docs/USAGE-TELEMETRY.md`, if it states retention.
- App Store privacy details: no change (categories and purposes are the same).

## Slices (TDD, each one shippable)

1. **Retention and budget.** Check real peak posts per day and measure bytes
   per row, then set the caps. Retention constants to 730, caps to the chosen
   values. Tests against D1 in the Workers pool: rows survive at 730 days and go
   at 731; the cap boundaries; the reap limit. Ship with the privacy page and
   doc changes.
2. **Drop counters.** Migration adding `duplicates`, `dropped_post_cap`,
   `dropped_new_install` and `dropped_all_events` (INTEGER NOT NULL DEFAULT 0)
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
   Tests: the last admitted post, a duplicate at the cap, both caps reached,
   saturation, rollback leaving counters unchanged, an all-dropped report.
   Analytics Engine tracking stays as it is.
3. **Report route and auth.** `USAGE_REPORT_TOKEN` in `secrets.required`, the
   route and its limiter, range validation. Tests: no token, wrong token, admin
   secret rejected, token rejected on `/admin/*`, missing API key, report reads
   don't use the `/beers` bucket. Returns an empty array for every view.
4. **Views.** The four queries, tested against seeded D1 with several events,
   several dimension tuples per install, repeated days, and event users with no
   `session_started`: every definition above, no install ID in any response,
   empty ranges, range limits.
5. **Grafana.** Data source, dashboard JSON committed, alerts. Acceptance: the
   dashboard shows the beta's real data, and both alerts fire in a test.

## Open questions

- Caps: 500 posts and 100 new installs a day, pending slice 1's check of real
  traffic.
