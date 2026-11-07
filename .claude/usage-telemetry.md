# Usage telemetry: queries and monitoring

`POST /usage` stores daily per-install feature counts from BeerSelector.
Design and rationale: [`plans/usage-telemetry.md`](../plans/usage-telemetry.md).
Wire format: [`.claude/api-endpoints.md`](api-endpoints.md#post-usage).

**Counts are unverified.** The API key ships inside the app and install IDs
are client-chosen, so anyone can post invented counts. Use the data for
diagnostics, trends and ratios across real installs, not exact figures.

## What is stored

| Table | One row per | Kept |
|---|---|---|
| `usage_daily` | (UTC day received, install, event, `app_version`, `ai_status`, `os_major`) with a summed `count` | 180 days |
| `usage_installs` | install ID, with `first_seen_day` and `last_seen_day` | 180 days after last seen |
| `usage_batches` | (install, batch) already counted, for deduplication | 8 days |
| `usage_ingest_daily` | UTC day, with posts counted that day (the post budget) | 30 days |

`day` is the UTC day the server **received** the counts, not when they
happened. An install that was offline uploads old counts on the day it
reconnects, so daily figures are receipt-day totals.

## Running a query

Every query below is read-only. Run it against production with:

```bash
npx wrangler d1 execute beer-db --remote --command "<query>"
```

Add `--json` for machine-readable output. Replace `<install-id>` with a
lower-case UUID.

"Last 30 days" below means 30 receipt days including today:
`day >= date('now', '-29 days')`. Today's figures are partial until the
UTC day ends; add `AND day < date('now')` for completed days only.

## Example questions

### One install's profile over 30 days

"41 sessions, 88 list views, 23 check-ins queued, 2 rewards queued, 17
suggestion opens":

```sql
SELECT event, SUM(count) AS total
FROM usage_daily
WHERE install_id = '<install-id>' AND day >= date('now', '-29 days')
GROUP BY event
ORDER BY total DESC;
```

### Where to focus

For each event: how many of the installs active in the last 30 days used
it at least once, and how often per session among those that did.

```sql
WITH recent AS (
  SELECT * FROM usage_daily WHERE day >= date('now', '-29 days')
),
active AS (SELECT COUNT(DISTINCT install_id) AS installs FROM recent),
sessions AS (
  SELECT install_id, SUM(count) AS sessions
  FROM recent WHERE event = 'session_started' GROUP BY install_id
),
per_install AS (
  SELECT install_id, event, SUM(count) AS uses
  FROM recent GROUP BY install_id, event
)
SELECT p.event,
       COUNT(*) AS installs_using,
       ROUND(100.0 * COUNT(*) / (SELECT installs FROM active), 1) AS pct_of_active,
       ROUND(1.0 * SUM(p.uses) / NULLIF(SUM(COALESCE(s.sessions, 0)), 0), 2) AS per_session
FROM per_install p
LEFT JOIN sessions s USING (install_id)
GROUP BY p.event
ORDER BY pct_of_active DESC;
```

### Heavy users ("whales") vs typical users

Installs bucketed by sessions over 30 days, with each bucket's feature mix
as uses per install. Tune the bucket edges once real data arrives.

```sql
WITH recent AS (
  SELECT * FROM usage_daily WHERE day >= date('now', '-29 days')
),
buckets AS (
  SELECT install_id,
         CASE
           WHEN SUM(CASE WHEN event = 'session_started' THEN count ELSE 0 END) >= 20 THEN '1 whale (20+ sessions)'
           WHEN SUM(CASE WHEN event = 'session_started' THEN count ELSE 0 END) >= 5 THEN '2 regular (5-19)'
           ELSE '3 light (0-4)'
         END AS bucket
  FROM recent GROUP BY install_id
),
bucket_sizes AS (SELECT bucket, COUNT(*) AS installs FROM buckets GROUP BY bucket)
SELECT b.bucket, z.installs, r.event,
       ROUND(1.0 * SUM(r.count) / z.installs, 1) AS uses_per_install
FROM recent r
JOIN buckets b USING (install_id)
JOIN bucket_sizes z USING (bucket)
GROUP BY b.bucket, r.event
ORDER BY b.bucket, uses_per_install DESC;
```

### Apple Intelligence fallback rate per install

Attempts are Apple Intelligence results plus fallbacks. A device that uses
local matching from the start (any `ai_status` other than
`apple_intelligence`) is not a fallback, so it has no attempts and is left
out.

```sql
WITH per_install AS (
  SELECT install_id, ai_status,
         SUM(CASE WHEN event LIKE 'fallback\_%' ESCAPE '\' THEN count ELSE 0 END) AS fallbacks,
         SUM(CASE WHEN (event = 'apple_intelligence_used' OR event LIKE 'fallback\_%' ESCAPE '\') THEN count ELSE 0 END) AS attempts
  FROM usage_daily
  WHERE day >= date('now', '-29 days')
  GROUP BY install_id, ai_status
)
SELECT install_id, ai_status, fallbacks, attempts,
       ROUND(100.0 * fallbacks / attempts, 1) AS fallback_pct
FROM per_install
WHERE attempts > 0
ORDER BY fallback_pct DESC, attempts DESC;
```

The pooled rate for each `ai_status` hides an install that always falls
back behind installs that rarely do, so read it next to the per-install
rates:

```sql
SELECT ai_status,
       COUNT(DISTINCT install_id) AS installs,
       SUM(CASE WHEN event LIKE 'fallback\_%' ESCAPE '\' THEN count ELSE 0 END) AS fallbacks,
       ROUND(100.0 * SUM(CASE WHEN event LIKE 'fallback\_%' ESCAPE '\' THEN count ELSE 0 END)
             / NULLIF(SUM(CASE WHEN (event = 'apple_intelligence_used' OR event LIKE 'fallback\_%' ESCAPE '\') THEN count ELSE 0 END), 0), 1) AS fallback_pct
FROM usage_daily
WHERE day >= date('now', '-29 days')
GROUP BY ai_status
ORDER BY fallbacks DESC;
```

For the split by failure reason, group by `event` with
`WHERE event LIKE 'fallback\_%' ESCAPE '\'` instead.

### Installs reporting per day

```sql
SELECT day, COUNT(DISTINCT install_id) AS installs
FROM usage_daily
GROUP BY day
ORDER BY day DESC
LIMIT 30;
```

### One install's events by day and app version (diagnostics)

When a user reports a problem and shares the install ID from the app:

```sql
SELECT day, app_version, ai_status, os_major, event, count
FROM usage_daily
WHERE install_id = '<install-id>'
ORDER BY day DESC, app_version, event;
```

## Monitoring

### Daily health check and alerts

On the first cron tick of 17:00 UTC, `runUsageHealthCheck`
(`src/db/usage.ts`) logs a `usage_health` line with the `usage_daily` row
count and, for each usage table, how long its oldest expired row has been
waiting for cleanup (`overdueMs`). It raises an alert with `console.error`,
which the `ufobeer-error-alerts` tail worker emails, when:

- `usage_daily` has more than `USAGE_DAILY_ROW_ALERT` rows (500,000). A
  beta of a few hundred installs stays well under it. A flood of invented
  installs at the growth budget crosses it in about ten days.
- A table's oldest expired row is more than a day overdue
  (`USAGE_REAP_BACKLOG_ALERT_MS`), so cleanup is falling behind ingest. The
  reapers delete 5,000 rows per table per 20-minute tick, several times the
  worst-case ingest, so a backlog points at failing reaps (look for
  `[cron] <table> reap failed` errors) rather than volume.

To see the same figures by hand:

```sql
SELECT
  (SELECT COUNT(*) FROM usage_daily) AS daily_rows,
  (SELECT MIN(day) FROM usage_daily) AS daily_oldest,
  (SELECT COUNT(*) FROM usage_installs) AS installs,
  (SELECT MIN(last_seen_day) FROM usage_installs) AS installs_oldest_last_seen,
  (SELECT datetime(MIN(received_at) / 1000, 'unixepoch') FROM usage_batches) AS batches_oldest,
  (SELECT MIN(day) FROM usage_ingest_daily) AS ingest_oldest;
```

### Posts not counted (drop reasons)

Every write's outcome goes to the `beer_enrichment_metrics` Analytics
Engine dataset with `blob7 = 'usage_ingest'` and the outcome in `blob5`:
`admitted`, `duplicate`, `daily_post_cap`, `new_install_cap`, or
`all_dropped` (a parsed report with no event this worker accepts; nothing is
written). Steady
`duplicate`s are normal (lost responses resent). Any `daily_post_cap` or
`new_install_cap` means posts were dropped: an invented-install flood, or
real growth past the budgets in `src/constants.ts`.

Query it through the Analytics Engine SQL API with an API token that has
**Account Analytics: Read**:

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --data "SELECT blob5 AS outcome, SUM(_sample_interval) AS posts
          FROM beer_enrichment_metrics
          WHERE blob7 = 'usage_ingest' AND timestamp > NOW() - INTERVAL '7' DAY
          GROUP BY outcome
          ORDER BY posts DESC"
```

`double2` on the same rows is the number of event items dropped by the
parser (unknown names or bad counts), for every parsed report including
`all_dropped` ones. A rise after an app release, or any `all_dropped`
posts, usually means the app sends an event this worker does not know yet.
Requests rejected before parsing (400, 413, 415, 429) are not in this
metric; they appear in `audit_log` and the request analytics.

### Switching ingestion off

Set `USAGE_ENABLED` to anything but `"true"` in `wrangler.jsonc` `vars`
and deploy. `/usage` then answers 204 without writing, so clients delete
their batches and do not pile up retries. Retention and the health check
keep running.
