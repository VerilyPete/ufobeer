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

Full sync from Flying Saucer API. Imports all beers and queues for enrichment.

**Query Parameters:**
- `store_id` (required) - Flying Saucer location ID

**Response:**
```json
{
  "imported": 150,
  "queued_for_enrichment": 25,
  "queued_for_cleanup": 30
}
```

### GET /reports/usage

Aggregate usage for the Grafana dashboard (`plans/usage-dashboards.md`).
Needs `X-API-Key` and `Authorization: Bearer <USAGE_REPORT_TOKEN>`; the token
is accepted nowhere else and `ADMIN_SECRET` is not accepted here.

**Query:** `view` is `daily`, `events`, `adoption` or `breakdown`. `from` and
`to` are inclusive UTC days (`YYYY-MM-DD`): `from` defaults to 89 days before
today and must be on or after today minus 730 days; `to` defaults to today
and can't be later; `from` can't be after `to`.

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

Replay failed messages back to the main queue.

**Request Body:**
```json
{
  "message_ids": ["abc123", "def456"]
}
```

**Response:**
```json
{
  "replayed": 2,
  "failed": 0
}
```

### POST /admin/dlq/acknowledge

Acknowledge/dismiss messages (remove from pending).

**Request Body:**
```json
{
  "message_ids": ["abc123", "def456"]
}
```

**Response:**
```json
{
  "acknowledged": 2
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
