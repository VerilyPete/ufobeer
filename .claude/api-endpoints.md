# API Endpoints Reference

## Authentication

All endpoints require `X-API-Key` header. Admin endpoints require the admin API key.

```bash
curl -H "X-API-Key: your-api-key" https://api.ufobeer.app/beers?store_id=1
```

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
- Returns `429` with `Retry-After` header when exceeded
- Check remaining quota in `/health` response
