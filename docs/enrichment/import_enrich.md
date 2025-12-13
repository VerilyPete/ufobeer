# Feature: Immediate Enrichment on Import

## Overview

Currently, beers discovered via `/beers` endpoint are synced to D1 with ABV parsed from descriptions. Beers where ABV parsing fails must wait up to 12 hours for the cron job to queue them for Perplexity enrichment.

**Goal**: Queue beers for Perplexity enrichment immediately after import if ABV couldn't be parsed from the description.

## Current Flow

```
/beers request
    │
    ▼
insertPlaceholders() ─► Parse ABV from description
    │                        │
    │                   ┌────┴────┐
    │                   ▼         ▼
    │              ABV found   ABV null
    │              (0.9 conf)  (wait for cron)
    │                   │         │
    └───────────────────┴─────────┘
                        │
                        ▼
              Response returned
                        │
        [12 hour wait for cron to run]
                        │
                        ▼
              Queue for Perplexity
```

## Proposed Flow

```
/beers request
    │
    ▼
insertPlaceholders() ─► Parse ABV from description
    │                        │
    │                   ┌────┴────┐
    │                   ▼         ▼
    │              ABV found   ABV null
    │              (0.9 conf)  (queue immediately)
    │                   │         │
    └───────────────────┴─────────┘
                        │
                        ▼
              Response returned
                        │
              ctx.waitUntil(queueForEnrichment)
                        │
                        ▼
              Queue consumer processes
              (within seconds/minutes)
```

---

## Phase 1: Update insertPlaceholders Return Type

**File**: `src/db/helpers.ts`

**Changes**:

1. Define return type interface:
```typescript
interface InsertPlaceholdersResult {
  totalSynced: number;
  withAbv: number;
  needsEnrichment: Array<{
    id: string;
    brew_name: string;
    brewer: string;
  }>;
}
```

2. Modify `insertPlaceholders()` to:
   - Track beers where `extractABV()` returned null
   - Return the result object instead of void
   - Keep the existing logging

3. Update the function signature:
```typescript
export async function insertPlaceholders(
  db: D1Database,
  beers: Array<{ id: string; brew_name: string; brewer: string; brew_description?: string }>,
  requestId: string
): Promise<InsertPlaceholdersResult>
```

**Verification**: `tsc --noEmit` passes

---

## Phase 2: Create queueBeersForEnrichment Helper

**File**: `src/db/helpers.ts` (add to existing file)

**New Function**:

```typescript
/**
 * Queue beers for Perplexity enrichment.
 * Filters out blocklisted items (flights, mixed drinks).
 * Uses sendBatch for efficiency.
 */
export async function queueBeersForEnrichment(
  queue: Queue,
  beers: Array<{ id: string; brew_name: string; brewer: string }>,
  requestId: string
): Promise<number>
```

**Logic**:
1. Filter out blocklisted items using `shouldSkipEnrichment()` from config
2. If no beers remain after filtering, return 0
3. Use `queue.sendBatch()` to queue all beers (max 100 per batch)
4. Log the count queued
5. Return number queued

**Note**: No quota check here - the queue consumer handles quota. We just queue; the consumer will ack without processing if quota exceeded.

**Verification**: `tsc --noEmit` passes

---

## Phase 3: Update db/index.ts Exports

**File**: `src/db/index.ts`

**Changes**:
1. Export the new `queueBeersForEnrichment` function
2. Export the `InsertPlaceholdersResult` type

```typescript
export { insertPlaceholders, queueBeersForEnrichment } from './helpers';
export type { InsertPlaceholdersResult } from './helpers';
```

**Verification**: `tsc --noEmit` passes

---

## Phase 4: Update handleBeerList Handler

**File**: `src/handlers/beers.ts`

**Changes**:

1. Import the new function:
```typescript
import { insertPlaceholders, queueBeersForEnrichment } from '../db';
```

2. Update the handler to get the Env (already has it) and queue:
```typescript
// Current code (line 109):
ctx.waitUntil(insertPlaceholders(env.DB, beersForPlaceholders, reqCtx.requestId));

// New code:
ctx.waitUntil(
  insertPlaceholders(env.DB, beersForPlaceholders, reqCtx.requestId)
    .then(result => {
      if (result.needsEnrichment.length > 0) {
        return queueBeersForEnrichment(
          env.ENRICHMENT_QUEUE,
          result.needsEnrichment,
          reqCtx.requestId
        );
      }
      return 0;
    })
);
```

**Verification**:
- `tsc --noEmit` passes
- `npx wrangler deploy --dry-run` succeeds

---

## Phase 5: Final Verification

**Commands**:
```bash
cd /workspace/ufobeer
npx tsc --noEmit
npx wrangler deploy --dry-run
```

**Manual Test** (after deployment):
1. Call `/beers?sid=13879` endpoint
2. Check logs for "Queued X beers for enrichment"
3. Verify queue consumer processes them

---

## Implementation Notes

### Why no quota check in queueBeersForEnrichment?

The queue consumer already handles quota enforcement:
- It checks daily/monthly limits before making Perplexity calls
- If quota exceeded, it acks the message without processing
- This keeps the queuing logic simple and the enforcement centralized

### Why filter blocklist but not DLQ failures?

- **Blocklist**: These items (flights, mixed drinks) should never be enriched. Filter early to avoid wasting queue capacity.
- **DLQ failures**: A beer in DLQ may have failed due to transient issues. The queue consumer will handle retries appropriately.

### Batch size considerations

- `sendBatch()` max is 100 messages
- A single taplist typically has 50-150 beers
- Most beers have ABV in description, so only 10-30% typically need enrichment
- This means usually <50 beers queued per request

### Rate limiting

The queue consumer already implements:
- 2-second delay between Perplexity API calls
- 429 (rate limit) handling with 120-second retry delay

No changes needed to rate limiting logic.

---

## Files Modified

| File | Change |
|------|--------|
| `src/db/helpers.ts` | Update return type, add queueBeersForEnrichment |
| `src/db/index.ts` | Export new function and type |
| `src/handlers/beers.ts` | Queue beers after insertPlaceholders |

---

## Rollback

If issues arise:
1. Revert the changes to `handleBeerList` to not call queueBeersForEnrichment
2. The cron job continues to work as before
3. No data migration needed - this is purely additive
