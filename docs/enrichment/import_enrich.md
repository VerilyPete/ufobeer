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

## Review Findings (Incorporated)

Issues identified during Cloudflare expert review:

| Issue | Resolution |
|-------|------------|
| No error handling in ctx.waitUntil | Add `.catch()` with logging |
| Race condition: duplicate queuing | Add consumer-side deduplication |
| Missing chunking for >100 beers | Add batch chunking in sendBatch |
| Wrong file location (db/helpers.ts) | Move to `queue/helpers.ts` |
| Insufficient logging | Add detailed logging with requestId |
| Missing type safety | Use `EnrichmentMessage` type |

---

## Phase 1: Update insertPlaceholders Return Type

**File**: `src/db/helpers.ts`

**Changes**:

1. Define return type interface:
```typescript
export interface InsertPlaceholdersResult {
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

4. Collect beers needing enrichment during processing:
```typescript
const needsEnrichment: Array<{ id: string; brew_name: string; brewer: string }> = [];

// In the loop:
if (abv === null) {
  withoutAbv++;
  needsEnrichment.push({ id: b.id, brew_name: b.brew_name, brewer: b.brewer });
}

// Return:
return { totalSynced: beers.length, withAbv, needsEnrichment };
```

**Verification**: `tsc --noEmit` passes

---

## Phase 2: Create queueBeersForEnrichment Helper

**File**: `src/queue/helpers.ts` (NEW FILE)

**Contents**:

```typescript
/**
 * Queue helper functions for beer enrichment.
 * Separated from consumer logic for clarity.
 */

import type { EnrichmentMessage } from '../types';
import { shouldSkipEnrichment } from '../config';

const BATCH_SIZE = 100; // sendBatch limit

/**
 * Queue beers for Perplexity enrichment.
 * Filters out blocklisted items (flights, mixed drinks).
 * Uses sendBatch with chunking for efficiency.
 *
 * @returns Number of beers queued
 */
export async function queueBeersForEnrichment(
  queue: Queue<EnrichmentMessage>,
  beers: Array<{ id: string; brew_name: string; brewer: string }>,
  requestId: string
): Promise<number> {
  if (beers.length === 0) {
    return 0;
  }

  console.log(`[queueBeersForEnrichment] Starting: ${beers.length} beers, requestId=${requestId}`);

  // Filter blocklisted items
  const filtered = beers.filter(b => !shouldSkipEnrichment(b.brew_name));
  const blockedCount = beers.length - filtered.length;

  if (blockedCount > 0) {
    console.log(`[queueBeersForEnrichment] Filtered ${blockedCount} blocklisted items, requestId=${requestId}`);
  }

  if (filtered.length === 0) {
    console.log(`[queueBeersForEnrichment] No beers to queue after filtering, requestId=${requestId}`);
    return 0;
  }

  // Queue in chunks (sendBatch limit is 100)
  const startTime = Date.now();
  let totalQueued = 0;

  for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
    const chunk = filtered.slice(i, i + BATCH_SIZE);
    const messages = chunk.map(beer => ({
      body: {
        beerId: beer.id,
        beerName: beer.brew_name,
        brewer: beer.brewer,
      } as EnrichmentMessage,
    }));

    await queue.sendBatch(messages);
    totalQueued += chunk.length;
  }

  const durationMs = Date.now() - startTime;
  console.log(`[queueBeersForEnrichment] Queued ${totalQueued} beers in ${durationMs}ms, requestId=${requestId}`);

  return totalQueued;
}
```

**Verification**: `tsc --noEmit` passes

---

## Phase 3: Update queue/index.ts Exports

**File**: `src/queue/index.ts`

**Changes**:
```typescript
export { handleEnrichmentBatch } from './enrichment';
export { handleDlqBatch } from './dlq';
export { queueBeersForEnrichment } from './helpers';
```

**Verification**: `tsc --noEmit` passes

---

## Phase 4: Add Consumer-Side Deduplication

**File**: `src/queue/enrichment.ts`

**Change**: Add check before Perplexity API call to skip already-enriched beers.

This prevents duplicate processing when concurrent `/beers` requests queue the same beer.

```typescript
// In handleEnrichmentBatch, before calling fetchAbvFromPerplexity:

// Check if beer already has ABV (may have been enriched by another message)
const existing = await env.DB.prepare(
  'SELECT abv FROM enriched_beers WHERE id = ?'
).bind(beerId).first<{ abv: number | null }>();

if (existing?.abv !== null) {
  console.log(`[enrichment] Beer ${beerId} already enriched, skipping, requestId=${requestId}`);
  message.ack();
  continue;
}
```

**Location**: Insert this check after the quota reservation but before the Perplexity API call.

**Verification**: `tsc --noEmit` passes

---

## Phase 5: Update handleBeerList Handler

**File**: `src/handlers/beers.ts`

**Changes**:

1. Import the new function:
```typescript
import { insertPlaceholders } from '../db';
import { queueBeersForEnrichment } from '../queue';
```

2. Update the background task with error handling:
```typescript
// Replace the existing ctx.waitUntil call:
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
    .catch(error => {
      // Log but don't fail - cron job provides fallback
      console.error(`[handleBeerList] Background sync/queue failed: ${error}, requestId=${reqCtx.requestId}`);
    })
);
```

**Verification**:
- `tsc --noEmit` passes
- `npx wrangler deploy --dry-run` succeeds

---

## Phase 6: Update db/index.ts Exports

**File**: `src/db/index.ts`

**Changes**: Export the new type:
```typescript
export { insertPlaceholders } from './helpers';
export type { InsertPlaceholdersResult } from './helpers';
export { getEnrichmentQuotaStatus } from './quota';
```

**Verification**: `tsc --noEmit` passes

---

## Phase 7: Final Verification

**Commands**:
```bash
cd /workspace/ufobeer
npx tsc --noEmit
npx wrangler deploy --dry-run
```

**Manual Test** (after deployment):
1. Call `/beers?sid=13879` endpoint
2. Check logs for:
   - `[insertPlaceholders] Synced X beers (Y with ABV, Z need enrichment)`
   - `[queueBeersForEnrichment] Queued Z beers in Nms`
3. Verify queue consumer processes them
4. Check consumer logs for any `already enriched, skipping` messages (deduplication working)

---

## Implementation Notes

### Why no quota check in queueBeersForEnrichment?

The queue consumer already handles quota enforcement:
- It checks daily/monthly limits before making Perplexity calls
- If quota exceeded, it acks the message without processing
- This keeps the queuing logic simple and the enforcement centralized

### Failsafe Behavior

If the queue operation fails for any reason:
- Error is logged but doesn't affect the `/beers` response
- Beers will be picked up by the cron job (max 12-hour delay)
- No data is lost

### Rate Limiting

The queue consumer already implements:
- 2-second delay between Perplexity API calls
- 429 (rate limit) handling with 120-second retry delay

No changes needed to rate limiting logic.

### Deduplication Strategy

Consumer-side deduplication was chosen over producer-side because:
1. Simpler implementation (no distributed state needed)
2. One extra D1 read is cheap compared to Perplexity API cost
3. Handles all duplicate scenarios (concurrent requests, retries, etc.)

---

## Files Modified

| File | Change |
|------|--------|
| `src/db/helpers.ts` | Update return type of insertPlaceholders |
| `src/db/index.ts` | Export new type |
| `src/queue/helpers.ts` | NEW - queueBeersForEnrichment function |
| `src/queue/index.ts` | Export new function |
| `src/queue/enrichment.ts` | Add deduplication check |
| `src/handlers/beers.ts` | Wire up queuing with error handling |

---

## Rollback

If issues arise:
1. Revert `handleBeerList` to not call `queueBeersForEnrichment`
2. Messages already in queue will continue to be processed normally
3. No need to purge the queue
4. Cron job continues to work as fallback
5. Other changes (return type, deduplication) can remain - they're backwards compatible
