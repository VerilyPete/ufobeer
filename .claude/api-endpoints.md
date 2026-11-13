# API Endpoints Reference

## Authentication

All endpoints require `X-API-Key` header. Admin endpoints require the admin API key.

```bash
curl -H "X-API-Key: your-api-key" https://api.ufobeer.app/beers?store_id=1
```

### Enrichment source negotiation (`X-Enrichment-Sources`)

`enrichment_source` is always one of `description`, `description-fallback`,
`perplexity`, `manual` or `null`, unless the client asks for more. A newer stored
source such as `exa` is sent only to a client that lists it, for example
`X-Enrichment-Sources: exa`. Every other client gets `null` for that beer, with
`enriched_abv` and `enrichment_confidence` unchanged.

- The header is comma-separated, case-insensitive and capped at 256 characters
  and eight sources. Malformed tokens are ignored.
- `GET /beers` gives each accepted-source set its own `ETag`; headerless ETags
  are unchanged. `GET /beers` and `POST /beers/batch` send
  `Vary: X-Enrichment-Sources`.
- The cache stores the real source. Labels are chosen per response
  (`src/utils/enrichmentSource.ts`).

---

## Public Endpoints

### GET /beers

Fetch beers from Flying Saucer with enrichment data.

**Query Parameters:**
- `store_id` (required) - Flying Saucer location ID

**Response:**
```json
{
  "beers": [
    {
      "id": "12345",
      "brew_name": "Hazy IPA",
      "brewer": "Local Brewery",
      "abv": 6.5,
      "confidence": 0.9,
      "enrichment_source": "description",
      "brew_description_cleaned": "A juicy, hazy IPA with notes of citrus..."
    }
  ],
  "store_id": "1",
  "count": 42
}
```

### POST /beers/batch

Batch lookup enrichment data for multiple beers.

**Request Body:**
```json
{
  "beers": [
    { "id": "12345", "brew_name": "Hazy IPA", "brewer": "Local Brewery" },
    { "id": "12346", "brew_name": "Pilsner", "brewer": "Czech Brewery" }
  ]
}
```

**Response:**
```json
{
  "results": [
    { "id": "12345", "abv": 6.5, "confidence": 0.9 },
    { "id": "12346", "abv": 4.8, "confidence": 0.7 }
  ],
  "enriched_count": 2,
  "not_found_count": 0
}
```

### POST /beers/sync

Records beers the mobile client saw that the API may not know yet (found via
`POST /beers/batch`). Each item is validated on its own; invalid items are
reported in `errors` and the rest are still written. Repeated ids collapse to
the last valid item, but every valid item counts toward `synced`.

- A **changed description** (text differs from the stored original) replaces
  the original and its hash together, clears the cleaned text, resets an
  unverified row to `pending`, and queues cleanup. It is written only if the
  row still holds the description this request read; otherwise it changes
  nothing and queues nothing.
- An **unchanged, empty or omitted description** updates only the name,
  brewer and `last_seen_at`. An uncleaned description is re-queued for
  cleanup at most once per 24 hours.
- An omitted brewer keeps the stored one.

**Request Body:** (at most 50 beers, `SYNC_CONSTANTS.MAX_BATCH_SIZE`)
```json
{
  "beers": [
    { "id": "21720679", "brew_name": "Leo Carillo", "brewer": "Great Heights", "brew_description": "A crisp lager" }
  ]
}
```

**Response:**
```json
{
  "synced": 1,
  "queued_for_cleanup": 1,
  "requestId": "…"
}
```

### GET /reports/usage

Aggregate usage for the Grafana dashboard (`plans/usage-dashboards.md`).
Needs `X-API-Key` and `Authorization: Bearer <USAGE_REPORT_TOKEN>`; the token
is accepted nowhere else and `ADMIN_SECRET` is not accepted here.

**Query:** `view` is `daily`, `events`, `adoption` or `breakdown`. `from` and
`to` are inclusive UTC days, given as `YYYY-MM-DD` or as epoch milliseconds
(Grafana's `${__from}` and `${__to}`), which become their UTC day on the
server so the caller's timezone can't shift the range. `from` defaults to 89
days before today and must be on or after today minus 730 days; `to` defaults
to today and can't be later; `from` can't be after `to`.

**Views** (definitions: `plans/usage-dashboards.md`, Read endpoint):

| View | One row per | Fields |
|---|---|---|
| `daily` | day in the range, including days with nothing | `day, active_installs, new_installs, sessions, posts, duplicates, dropped_post_cap, dropped_new_install, dropped_all_events, dropped_events` |
| `events` | day and event used | `day, event, count, installs` |
| `adoption` | event used in the range | `event, installs_using, active_installs, share, avg_per_session` |
| `breakdown` | day and dimension value | `day, dimension, value, active_installs` |

In `daily`, `posts` is `null` before 2026-11-10 and the drop counters are
`null` before 2026-11-12, the days each began. `avg_per_session` is `null`
when the installs using an event reported no sessions. In `breakdown`, an
install that changed value during a day counts under each value.

**Responses:** `200` with a JSON array of flat rows and `Cache-Control:
no-store`; `400` with
`{"error": "Invalid report query", "detail": ...}`; `401` without a valid
API key or report token; `429` over the report limit.

The token is in the macOS login Keychain on Pete's Mac:
`security find-generic-password -s ufobeer-usage-report-token -w`.

**Grafana** (`plans/usage-dashboards.md`, slice 5). Stack
`largefireplace1608.grafana.net`, set up 2026-11-11:

1. Data source **ufobeer usage reports** (Infinity): base URL
   `https://api.ufobeer.app/reports/usage`; custom headers `X-API-Key` (the
   app's key) and `Authorization` (`Bearer <token>`); allowed hosts
   `https://api.ufobeer.app`. Infinity's health check does not call the API,
   so a wrong header still "succeeds"; check a panel instead.
2. Dashboard: import `dashboards/usage.json` and pick that data source for
   `DS_UFOBEER`. Panels use the backend (JSONata) parser, which alerting needs.
3. **Bot Fight Mode is off for the `ufobeer.app` zone** (turned off
   2026-11-11). It answered Grafana's requests (Amazon ASN, Go HTTP client)
   with a managed challenge, so Grafana saw 403 and nothing reached the
   Worker; on the Free plan it can't be skipped for one path. The same
   setting caused the edge 403 on `OPTIONS` noted in `plans/remove-cors.md`.
   Turning it back on breaks the dashboard and its alerts. Diagnose with
   Security Events (`firewallEventsAdaptive`, `source: botFight`) and
   `audit_log` rows with user agent `Go-http-client`.
4. When a value field is filled, keep the browser's password manager out of
   it: these are password-type inputs, and autofill puts a saved password in
   the header (seen as `Invalid API key` or `Invalid report token` in
   `audit_log`).
5. Alerts: `dashboards/usage-alerts.json` is the rule group
   `beerselector-usage` (folder `BeerSelector`, evaluated hourly), with five
   rules on the last complete UTC day: no reports (`posts` below 1; no data
   or a query error also alerts), and one rule per drop counter (above 0; no
   data is OK, because counters are `null` before 2026-11-12). One rule per
   counter because Infinity returns a wide frame's numbers as unlabeled
   series, which Grafana alerting can't tell apart. Rules notify contact
   point **BeerSelector usage email**. On this plan an email contact point
   only accepts addresses of org members.
   To apply the file, replace `${DS_UFOBEER}` with the data source UID and
   `PUT /api/v1/provisioning/folder/beerselector/rule-groups/beerselector-usage`
   with header `X-Disable-Provenance: true` (keeps the rules editable in the
   UI), adding `folderUID` and `ruleGroup` to each rule. Test a rule with
   `POST /api/v1/eval` and its `data`: set up 2026-11-11, each rule was
   normal (or no data) as saved and firing with its threshold tripped.

### POST /usage

Daily per-install feature counts from BeerSelector (beta usage telemetry).
Counts are **unverified**: the API key ships in the app and install IDs are
client-chosen, so use them for trends and ratios, not exact figures. Design:
`plans/usage-telemetry.md`; operations and queries: `.claude/usage-telemetry.md`.

**Request Body:**
```json
{
  "install_id": "3f2b8c1e-5d4a-4e7b-9c0f-1a2b3c4d5e6f",
  "batch_id": "9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  "app_version": "2.4.0",
  "ai_status": "apple_intelligence",
  "os_major": 26,
  "events": [
    { "name": "suggestions_opened", "count": 3 },
    { "name": "fallback_deadline_expired", "count": 1 }
  ]
}
```

- `install_id`, `batch_id`: UUIDs (lower-cased on receipt). A repeated
  `(install_id, batch_id)` is ignored, so the client resends a batch with the
  same `batch_id` until it gets a 204.
- `app_version`: `^\d{1,2}\.\d{1,3}\.\d{1,3}$`. `os_major`: integer 13–99.
- `ai_status`: any string; unknown values are stored as `other`.
- `events`: at most 40 items. Each item needs a known `name` (the
  `USAGE_EVENTS` list in `src/schemas/request.ts`) and an integer `count`
  of 1–500. Bad items are dropped, not rejected. Repeated names are summed
  and clamped to 500.

**Response:** `204` with no body in every accepted case: counted, duplicate
batch, `USAGE_ENABLED` not `"true"`, every event dropped, or a daily growth
budget spent. A 204 tells the client to delete the batch.

| Status | When |
|---|---|
| `400` | Malformed JSON or a bad envelope field |
| `413` / `415` | Body over 64 KiB, or not `application/json` |
| `429` | More than 6 posts a minute from one IP |
| `500` / `503` | Write failed, or the rate limiter is unavailable (client resends later) |

### GET /health

Health check with quota status.

**Response:**
```json
{
  "status": "healthy",
  "quotas": {
    "enrichment": {
      "daily_used": 45,
      "daily_limit": 500,
      "monthly_used": 1200,
      "monthly_limit": 2000
    }
  },
  "rate_limit": {
    "remaining": 55,
    "limit": 60,
    "reset_at": 1704067260000
  }
}
```

---

## Admin Endpoints

All admin endpoints require the admin API key.

### POST /admin/enrich/trigger

Manually trigger enrichment processing for beers missing ABV.

**Query Parameters:**
- `limit` (optional) - Max beers to process (default: 50)

**Response:**
```json
{
  "queued": 25,
  "message": "Queued 25 beers for enrichment"
}
```

### POST /admin/cleanup/trigger

Trigger description cleanup. One run every 5 minutes (dry runs are exempt).

**JSON Body:**
- `mode` (required) - `missing`: beers never cleaned and not yet queued. `all`: beers whose cleaned text came from legacy cleanup or an older `CLEANUP_VERSION`. Their current cleaned text keeps being served until the re-clean rewrites it.
- `limit` (optional) - Max beers per run, 1-500 (default: 500). Repeat `all` runs to work through the rest; re-cleaned beers stop matching.
- `dry_run` (optional) - Report counts without queueing
- `confirm` (required for `all` unless `dry_run`) - Without it, `all` returns `CONFIRMATION_REQUIRED` with `preview.beers_would_reset`

**Response:**
```json
{
  "success": true,
  "data": {
    "operation_id": "cleanup-trigger-1761750000000",
    "beers_queued": 500,
    "beers_reset": 500,
    "beers_remaining": 848,
    "mode": "all",
    "dry_run": false
  },
  "requestId": "..."
}
```

To re-clean every description after changing cleanup rules: bump `CLEANUP_VERSION` in `src/constants.ts`, deploy, then repeat `{"mode": "all", "confirm": true}` until `beers_remaining` is 0.

### GET /admin/dlq

List dead letter queue messages.

**Query Parameters:**
- `status` (optional) - Filter by status: `pending`, `replayed`, `acknowledged`
- `limit` (optional) - Max messages (default: 50)
- `cursor` (optional) - Pagination cursor

**Response:**
```json
{
  "messages": [
    {
      "id": 1,
      "message_id": "abc123",
      "beer_id": "12345",
      "beer_name": "Failed Beer",
      "status": "pending",
      "failure_reason": "Perplexity API timeout",
      "failed_at": 1704067200000,
      "replay_count": 0
    }
  ],
  "cursor": "eyJpZCI6MX0",
  "has_more": true
}
```

### GET /admin/dlq/stats

Get DLQ statistics.

**Response:**
```json
{
  "total": 15,
  "by_status": {
    "pending": 10,
    "replayed": 3,
    "acknowledged": 2
  },
  "by_source": {
    "beer-enrichment": 12,
    "description-cleanup": 3
  }
}
```

### POST /admin/dlq/replay

Replay failed messages to the queue each one failed on (enrichment or cleanup).
An enrichment entry for a hand-verified beer (`is_verified = 1`) is not
replayed: its DLQ id is listed in `skipped_verified` and the entry stays
`pending`, so it can be replayed once a human clears the flag. An enrichment
entry whose beer already has an ABV or is `skipped` is not re-sent either (that
would pay for the lookup again): it is listed in `skipped_resolved` and stays
`pending` for you to acknowledge.

A replay claims its entries (`replaying`) under a lease: a random token and the
claim time. Every write it makes is guarded on that token. If a replay fails
before releasing its claim, the cron returns the entry to `pending` once the
claim is 10 minutes old (`DLQ_REPLAY_CLAIM_STALE_MS`), within 30 minutes; the
entry is not re-sent until you replay it again.

**Request Body:** (`ids` are DLQ row ids, at most 50; `delay_seconds` optional)
```json
{
  "ids": [12, 13, 14]
}
```

**Response:**
```json
{
  "success": true,
  "requestId": "…",
  "data": {
    "requested_count": 3,
    "claimed_count": 3,
    "replayed_count": 2,
    "failed_count": 0,
    "skipped_verified": [14],
    "skipped_resolved": [],
    "queued_to": "beer-enrichment",
    "queued_counts": { "enrichment": 2, "cleanup": 0 }
  }
}
```

### POST /admin/dlq/acknowledge

Acknowledge (dismiss) pending messages without replaying them. Only
`pending` entries change; `failed_count` counts the requested ids that were
not pending.

**Request Body:** (`ids` are DLQ row ids, at most 100)
```json
{
  "ids": [12, 13]
}
```

**Response:**
```json
{
  "success": true,
  "requestId": "…",
  "data": {
    "acknowledged_count": 2,
    "requested_count": 2,
    "failed_count": 0
  }
}
```

---

## Error Responses

All errors return JSON with `error` field:

```json
{
  "error": "Rate limit exceeded",
  "retry_after": 45
}
```

### Common Status Codes
- `400` - Bad request (missing params, invalid input)
- `401` - Unauthorized (missing or invalid API key)
- `403` - Forbidden (not admin for admin endpoints)
- `429` - Rate limit exceeded
- `500` - Internal server error
- `503` - Service unavailable (quota exhausted)

---

## Rate Limiting

- 60 requests per minute per client
- Tracked by API key hash (or IP if no key)
- `POST /usage` is outside that bucket: 6 per minute per IP, under its own
  `usage:{ip}` key. Every install shares one API key, so the per-key bucket
  is fleet-wide and telemetry must not spend it. The 30/min pre-auth per-IP
  limit still covers every route, `/usage` included.
- `GET /reports/usage` is outside it too: 60 per minute in one `reports:usage`
  bucket, checked only after the report token, so the app's API key alone
  can't spend it.
- Returns `429` with `Retry-After` header when exceeded
- Check remaining quota in `/health` response
