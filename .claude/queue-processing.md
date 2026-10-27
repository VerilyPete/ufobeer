# Queue Processing Architecture

## Overview

UFO Beer uses Cloudflare Queues for async processing of two main pipelines:
1. **Enrichment** - ABV lookup via Perplexity API
2. **Cleanup** - Deterministic description cleaning (no model call)

Each pipeline has a main queue and a dead letter queue (DLQ).

```
                    ┌─────────────────────┐
                    │  /beers/sync        │
                    │  /admin/*/trigger   │
                    └──────────┬──────────┘
                               │
              ┌────────────────┴────────────────┐
              ▼                                 ▼
    ┌──────────────────┐              ┌──────────────────┐
    │ beer-enrichment  │              │ description-     │
    │     queue        │              │ cleanup queue    │
    └────────┬─────────┘              └────────┬─────────┘
             │                                  │
             ▼                                  ▼
    ┌──────────────────┐              ┌──────────────────┐
    │ Perplexity API   │              │ Deterministic    │
    │ (ABV lookup)     │              │ fixes            │
    └────────┬─────────┘              └────────┬─────────┘
             │                                  │
      ┌──────┴──────┐                   ┌──────┴──────┐
      ▼             ▼                   ▼             ▼
   Success       Failure             Success       Failure
      │             │                   │             │
      ▼             ▼                   ▼             ▼
   Update DB    DLQ after            Update DB    DLQ after
               3 retries                         2 retries
```

## Queue Configuration

All queue config is in `wrangler.jsonc`.

### beer-enrichment

```jsonc
{
  "queue": "beer-enrichment",
  "max_batch_size": 1,        // One message at a time
  "max_batch_timeout": 30,    // 30 second timeout
  "max_retries": 3,           // 3 attempts before DLQ
  "max_concurrency": 1,       // Single consumer (rate limit protection)
  "retry_delay": 60,          // 60 seconds between retries
  "dead_letter_queue": "beer-enrichment-dlq"
}
```

**Why these settings:**
- `max_batch_size: 1` - Perplexity has rate limits, process one at a time
- `max_concurrency: 1` - Prevents parallel calls that would hit 429s
- `retry_delay: 60` - Spreads out retries to avoid rate limit stacking

### description-cleanup

```jsonc
{
  "queue": "description-cleanup",
  "max_batch_size": 25,       // Batch for efficiency
  "max_batch_timeout": 30,
  "max_retries": 2,
  "max_concurrency": 1,
  "retry_delay": 30,
  "dead_letter_queue": "description-cleanup-dlq"
}
```

**Why these settings:**
- `max_batch_size: 25` - Cleanup is cheap CPU work, so one D1 batch covers 25 descriptions

### DLQ Consumers

Both DLQs use the same pattern:
```jsonc
{
  "max_batch_size": 10,
  "max_retries": 3,      // Retry D1 writes
  "max_batch_timeout": 60
}
```

DLQ consumers store messages in `dlq_messages` table for admin inspection.

## Message Types

### EnrichmentMessage

```typescript
interface EnrichmentMessage {
  beerId: string;
  beerName: string;
  brewer?: string;
  description?: string;  // For ABV extraction
  priority?: 'high' | 'normal';
}
```

### CleanupMessage

```typescript
interface CleanupMessage {
  beerId: string;
  beerName: string;
  description: string;   // Original description to clean
  brewer?: string;
}
```

## Consumer Implementation

### Enrichment Consumer (src/queue/enrichment.ts)

```typescript
export async function handleEnrichmentBatch(
  batch: MessageBatch<EnrichmentMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    try {
      // 1. Check quota
      if (await isQuotaExhausted(env.DB)) {
        message.retry({ delaySeconds: 300 });
        continue;
      }

      // 2. Call Perplexity API
      const result = await lookupABV(message.body, env);

      // 3. Update database
      await updateBeerABV(env.DB, message.body.beerId, result);

      // 4. Acknowledge success
      message.ack();
    } catch (error) {
      // Will retry or go to DLQ based on attempts
      message.retry();
    }
  }
}
```

### Cleanup Consumer (src/queue/cleanup.ts)

```typescript
export async function handleCleanupBatch(
  batch: MessageBatch<CleanupMessage>,
  env: Env
): Promise<void> {
  // 1. Ack messages with no descriptionHash without writing
  // 2. Clean each description (applyCleanupFixes) and extract its ABV
  // 3. One D1 batch, each UPDATE bound to the message's description_hash
  // 4. Queue beers without an ABV for Perplexity (skipping stale writes
  //    and blocklisted beers)
  // 5. Ack every message; a D1 failure retries the whole batch
}
```

## DLQ Handling

Failed messages are stored in D1 for inspection:

```sql
INSERT INTO dlq_messages (
  message_id, beer_id, beer_name, brewer,
  failed_at, failure_count, failure_reason,
  source_queue, status, raw_message
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?);
```

Admin can then:
1. **Inspect** - View failed messages via `/admin/dlq`
2. **Replay** - Re-queue via `/admin/dlq/replay`
3. **Acknowledge** - Dismiss via `/admin/dlq/acknowledge`

## Quota Protection

Enrichment has quota limits to control Perplexity costs. Cleanup calls no model, so it has none.

### Enrichment Quotas
- `DAILY_ENRICHMENT_LIMIT` (500) - Perplexity calls/day
- `MONTHLY_ENRICHMENT_LIMIT` (2000) - Perplexity calls/month
- Tracked in `enrichment_limits` table

When quota is exhausted:
1. Consumer delays message retry (5+ minutes)
2. `/health` endpoint shows quota status
3. Admin can monitor and adjust limits

## Triggering Processing

### Automatic (Cron)
```
*/20 * * * *  # Polls every 20 min; runs every ~2h (±20 min jitter), noon–11pm CT only
```

Cron fires every 20 minutes but is gated by two checks:
1. **Operating hours** — skips outside noon–11pm Central Time (DST-aware)
2. **Schedule jitter** — `checkAndAdvanceCronSchedule()` gates execution
   to ~4 hours with ±20 minutes of randomization (stored in `system_state`)

When due, triggers `handleScheduledEnrichment()` which:
1. Refreshes taplist for all enabled stores
2. Finds beers with pending enrichment status
3. Queues them for enrichment (respecting daily/monthly limits)

### Manual (Admin)
```bash
# Trigger enrichment
curl -X POST -H "X-API-Key: $ADMIN_KEY" \
  "https://api.ufobeer.app/admin/enrich/trigger?limit=50"

# Trigger cleanup
curl -X POST -H "X-API-Key: $ADMIN_KEY" \
  "https://api.ufobeer.app/admin/cleanup/trigger?mode=missing&limit=100"
```

## Debugging

### Check queue status
Cloudflare Dashboard > Workers & Pages > Queues

### Check failed messages
```bash
curl -H "X-API-Key: $ADMIN_KEY" \
  "https://api.ufobeer.app/admin/dlq?status=pending"
```

### View quota usage
```bash
curl -H "X-API-Key: $API_KEY" \
  "https://api.ufobeer.app/health"
```

### Replay specific failures
```bash
curl -X POST -H "X-API-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message_ids": ["abc123"]}' \
  "https://api.ufobeer.app/admin/dlq/replay"
```
