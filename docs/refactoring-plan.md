# Refactoring Plan: Split index.ts into Modules

## Problem

`src/index.ts` has grown to **2,337 lines**, making it difficult for:
- Agents to maintain context when making changes
- Developers to navigate and understand the codebase
- Testing individual components in isolation

## Goal

Split into focused modules of **200-400 lines each** while maintaining:
- Cloudflare Workers compatibility (single entry point)
- Type safety across modules
- Clear separation of concerns

---

## Proposed File Structure

```
src/
├── index.ts              # Entry point: minimal routing dispatcher (~200 lines)
├── types.ts              # All TypeScript interfaces and type guards (~150 lines)
├── config.ts             # Constants, blocklists, store IDs (~80 lines)
├── context.ts            # Request context creation, CORS, error boundary (~150 lines)
├── auth.ts               # Authentication and security helpers (~150 lines)
├── rate-limit.ts         # Rate limiting logic (~100 lines)
├── audit.ts              # Audit logging (~100 lines)
├── db/
│   ├── index.ts          # Re-exports
│   ├── helpers.ts        # Database helpers, insertPlaceholders (~200 lines)
│   └── quota.ts          # Quota tracking and checks (~150 lines)
├── services/
│   └── perplexity.ts     # Perplexity API client for ABV lookups (~100 lines)
├── handlers/
│   ├── index.ts          # Re-exports
│   ├── enrichment.ts     # Enrichment trigger + force handlers (~300 lines)
│   ├── dlq.ts            # DLQ handlers (list, stats, replay, ack) (~400 lines)
│   ├── beers.ts          # Beer list endpoint handler (~150 lines)
│   ├── health.ts         # Health check handler (~50 lines)
│   └── scheduled.ts      # Cron job handler (~200 lines)
└── queue/
    ├── index.ts          # Re-exports
    ├── enrichment.ts     # Queue consumer for enrichment (~300 lines)
    └── dlq.ts            # Queue consumer for DLQ (~100 lines)
```

### Changes from Initial Plan (per review feedback)
- **Renamed `env.ts` → `config.ts`**: `env.ts` implies environment variables; `config.ts` better describes hardcoded constants
- **Added `context.ts`**: Middleware pattern for CORS, error handling, analytics, request context
- **Added `handlers/scheduled.ts`**: Extract cron job business logic from index.ts
- **Slimmer `index.ts`**: Now truly minimal (~200 lines) - just dispatches to handlers

---

## Phases 1-6 Review (Completed)

**Review Date**: 2024-12-12
**Status**: ✅ Approved to proceed with Phases 7-9

### Review Findings

| Area | Status | Notes |
|------|--------|-------|
| Module extractions | ✅ Pass | Follow Workers best practices |
| Circular dependencies | ✅ Pass | Clean dependency graph with types.ts as leaf |
| Bundle size | ✅ Pass | 64.55 KiB / 13.39 KiB gzipped |
| TypeScript compilation | ✅ Pass | `tsc --noEmit` succeeds |
| Dry-run deployment | ✅ Pass | `wrangler deploy --dry-run` succeeds |

### Issues Found (to address in Phases 7-9)

1. **Duplicate types in index.ts**: The current `index.ts` still contains duplicate interface definitions (`FlyingSaucerBeer`, `DlqMessageRow`, `PaginationCursor`, etc.) that already exist in `types.ts`. These must be removed and replaced with imports.

2. **Unused import**: `extractABV` is imported in `index.ts` but never used directly (it's called internally by `insertPlaceholders`). Remove from imports.

3. **`validateForceEnrichmentRequest()` placement**: Currently in `types.ts` but contains validation logic beyond type checking. Consider moving to `handlers/enrichment.ts` during Phase 7.

### Recommendations for Phases 7-9

1. **Extract Perplexity API logic**: Move `fetchAbvFromPerplexity()` to `src/services/perplexity.ts` to keep `queue/enrichment.ts` focused on queue processing logic.

2. **Enforce handler isolation**: No handler should import from another handler. Shared logic must live in utilities (`db/`, `config.ts`, `services/`) or be passed via context.

---

## Module Breakdown

### Phase 1: Extract Types (`src/types.ts`)

**Contents:**
- `Env` interface
- `RequestContext` interface
- `QuotaStatus` interface
- All DLQ types (`DlqMessage`, `DlqStats`, etc.)
- All enrichment types (`TriggerEnrichmentRequest`, `TriggerEnrichmentResponse`, etc.)
- Type guards (`isEnrichmentMessage`, etc.)

**Lines:** ~150

**Dependencies:** None (leaf module)

---

### Phase 2: Extract Config (`src/config.ts`)

**Contents:**
- `VALID_STORE_IDS` Set
- `ENRICHMENT_BLOCKLIST` Set
- `ENRICHMENT_BLOCKLIST_PATTERNS` array
- `shouldSkipEnrichment()` function
- Any other constants

**Lines:** ~80

**Dependencies:** None

> **Note**: Named `config.ts` instead of `env.ts` to avoid confusion with environment variables (the `Env` interface stays in `types.ts`).

---

### Phase 2.5: Extract Context/Middleware (`src/context.ts`)

**Contents:**
- `getCorsHeaders()` function
- `createRequestContext()` function
- `withErrorBoundary()` wrapper (try/catch + analytics)
- `respond()` helper function

**Lines:** ~150

**Dependencies:**
- `types.ts` (for `Env`, `RequestContext`)
- `analytics.ts` (already exists at `src/analytics.ts` - no extraction needed)

This enables a clean middleware pattern in `index.ts`:
```typescript
export default {
  async fetch(request, env, ctx) {
    return withErrorBoundary(request, env, ctx, async (reqCtx, corsHeaders) => {
      // routing logic here
    });
  }
}
```

---

### Phase 3: Extract Auth (`src/auth.ts`)

**Contents:**
- `hashApiKey()` function
- `hashClientIp()` function
- `validateApiKey()` function
- `authorizeAdmin()` function
- `generateRequestId()` function

**Lines:** ~150

**Dependencies:**
- `types.ts` (for `Env`, `RequestContext`)

---

### Phase 4: Extract Rate Limiting (`src/rate-limit.ts`)

**Contents:**
- `checkRateLimit()` function
- `RateLimitResult` interface
- Rate limit constants

**Lines:** ~100

**Dependencies:**
- `types.ts` (for `Env`)

---

### Phase 5: Extract Audit Logging (`src/audit.ts`)

**Contents:**
- `writeAuditLog()` function
- `writeAdminAuditLog()` function
- Audit log cleanup logic

**Lines:** ~100

**Dependencies:**
- `types.ts` (for `RequestContext`)

---

### Phase 6: Extract Database Helpers (`src/db/`)

#### `src/db/helpers.ts`
**Contents:**
- `insertPlaceholders()` function
- `parseAbvFromDescription()` function
- Beer sync helpers

**Lines:** ~200

#### `src/db/quota.ts`
**Contents:**
- `getEnrichmentQuotaStatus()` function
- `reserveEnrichmentQuota()` function
- Quota-related types

**Lines:** ~150

**Dependencies:**
- `types.ts`

---

### Phase 7: Extract Handlers (`src/handlers/`)

#### `src/handlers/enrichment.ts`
**Contents:**
- `handleEnrichmentTrigger()` function
- `handleForceEnrichment()` function (new)
- `validateForceEnrichmentRequest()` function (new)
- `queryBeersForReEnrichment()` helper (new)
- `clearEnrichmentData()` helper (new)

**Lines:** ~300

#### `src/handlers/dlq.ts`
**Contents:**
- `handleDlqList()` function
- `handleDlqStats()` function
- `handleDlqReplay()` function
- `handleDlqAcknowledge()` function
- `cleanupOldDlqMessages()` function

**Lines:** ~400

#### `src/handlers/beers.ts`
**Contents:**
- `handleBeerList()` function (the /beers endpoint)

**Lines:** ~150

#### `src/handlers/health.ts`
**Contents:**
- `handleHealthCheck()` function

**Lines:** ~50

#### `src/handlers/scheduled.ts`
**Contents:**
- `handleScheduledEnrichment()` function (cron job logic)
- Quota checking for cron
- DB queries for unenriched beers
- Filtering logic (blocklist)
- Queue batching
- Analytics tracking

**Lines:** ~200

> **Note**: Per review feedback, this extracts the significant business logic from the `scheduled()` handler. The cron entry point in `index.ts` becomes a simple dispatcher.

**Dependencies:**
- `types.ts`
- `config.ts` (for `shouldSkipEnrichment`)
- `db/helpers.ts`
- `db/quota.ts`
- `audit.ts`

---

### Phase 7.5: Extract Perplexity Service (`src/services/perplexity.ts`)

> **New phase** added per review recommendation to keep queue handlers focused on queue processing logic.

**Contents:**
- `fetchAbvFromPerplexity()` function
- Perplexity API request/response handling
- ABV parsing from API response

**Lines:** ~100

**Dependencies:**
- `types.ts` (for `Env`)

**Rationale:** Separating the external API client from queue processing improves testability and follows single responsibility principle. The queue consumer calls this service but doesn't need to know API implementation details.

---

### Phase 8: Extract Queue Handlers (`src/queue/`)

#### `src/queue/enrichment.ts`
**Contents:**
- `handleEnrichmentBatch()` function
- ABV update logic
- Rate limiting and quota checks
- DLQ retry logic

**Lines:** ~300

**Dependencies:**
- `types.ts`
- `services/perplexity.ts` (for `fetchAbvFromPerplexity`)
- `db/quota.ts`
- `analytics.ts`

#### `src/queue/dlq.ts`
**Contents:**
- `handleDlqBatch()` function (consumer for `beer-enrichment-dlq`)
- `storeDlqMessage()` function

**Lines:** ~100

**Dependencies:**
- `types.ts`
- `audit.ts`

---

### Phase 9: Slim Down Index (`src/index.ts`)

**Remaining Contents:**
- Import all modules
- `fetch` handler with route matching (using `withErrorBoundary`)
- `scheduled` handler dispatch to `handleScheduledEnrichment`
- `queue` handler dispatch to `handleEnrichmentBatch`

**Lines:** ~200

#### Cleanup Tasks (from review)

These issues were identified during the Phase 1-6 review and must be addressed:

- [ ] **Remove duplicate interfaces** from index.ts:
  - `FlyingSaucerBeer` → import from `types.ts`
  - `DlqMessageRow` → import from `types.ts`
  - `PaginationCursor` → import from `types.ts`
  - `DlqReplayRequest` → import from `types.ts`
  - `DlqAcknowledgeRequest` → import from `types.ts`
  - `TriggerEnrichmentRequest` → import from `types.ts`
  - `QuotaStatus` → import from `types.ts`
  - `TriggerEnrichmentData` → import from `types.ts`
  - `GetBeersResult` → import from `types.ts`

- [ ] **Remove duplicate type guards** from index.ts:
  - `isValidBeer()` → import from `types.ts`
  - `hasBeerStock()` → import from `types.ts`

- [ ] **Remove unused import**: `extractABV` (only used internally by `insertPlaceholders`)

- [ ] **Move `validateForceEnrichmentRequest()`** from `types.ts` to `handlers/enrichment.ts` (contains validation logic beyond type checking)

**Final Structure:**
```typescript
// src/index.ts (~200 lines)
import type { Env } from './types';
import { withErrorBoundary, getCorsHeaders } from './context';
import { validateApiKey, authorizeAdmin } from './auth';
import { checkRateLimit } from './rate-limit';
import { writeAuditLog } from './audit';
import {
  handleBeerList,
  handleHealthCheck,
  handleEnrichmentTrigger,
  handleForceEnrichment,
  handleDlqList,
  handleDlqStats,
  handleDlqReplay,
  handleDlqAcknowledge,
  handleScheduledEnrichment,
} from './handlers';
import { handleEnrichmentBatch, handleDlqBatch } from './queue';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return withErrorBoundary(request, env, ctx, async (reqCtx, corsHeaders) => {
      const url = new URL(request.url);

      // OPTIONS (CORS preflight)
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Public routes
      if (url.pathname === '/health') {
        return handleHealthCheck(env, reqCtx, corsHeaders);
      }

      // API key required routes
      const apiKeyValid = await validateApiKey(request, env, reqCtx);
      if (!apiKeyValid) { /* return 401 */ }

      // Rate limiting
      const rateLimit = await checkRateLimit(env.DB, reqCtx.clientIdentifier, ...);
      if (!rateLimit.allowed) { /* return 429 */ }

      // Route: GET /beers
      if (url.pathname === '/beers' && request.method === 'GET') {
        return handleBeerList(request, env, reqCtx, corsHeaders);
      }

      // Admin routes (require X-Admin-Secret)
      if (url.pathname.startsWith('/admin/')) {
        const adminAuth = await authorizeAdmin(request, env, reqCtx);
        if (!adminAuth.authorized) { /* return 403 */ }

        // Route matching for admin endpoints...
        if (url.pathname === '/admin/enrich/trigger') { ... }
        if (url.pathname === '/admin/enrich/force') { ... }
        if (url.pathname === '/admin/dlq') { ... }
        // etc.
      }

      return new Response('Not Found', { status: 404 });
    });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await handleScheduledEnrichment(env, ctx);
  },

  async queue(batch: MessageBatch, env: Env) {
    if (batch.queue === 'beer-enrichment-dlq') {
      await handleDlqBatch(batch, env);
    } else {
      await handleEnrichmentBatch(batch, env);
    }
  },
};
```

---

## Implementation Order

Execute phases in order to minimize broken builds:

| Step | Phase | Description | Test |
|------|-------|-------------|------|
| 0 | Pre-flight | Record smoke test baselines | See below |
| 1 | Phase 1 | Extract types.ts | `tsc --noEmit` |
| 2 | Phase 2 | Extract config.ts | `tsc --noEmit` |
| 3 | Phase 2.5 | Extract context.ts | `tsc --noEmit` |
| 4 | Phase 3 | Extract auth.ts | `tsc --noEmit` |
| 5 | Phase 4 | Extract rate-limit.ts | `tsc --noEmit` |
| 6 | Phase 5 | Extract audit.ts | `tsc --noEmit` |
| 7 | Phase 6 | Extract db/ modules | `tsc --noEmit` |
| - | **Review** | ✅ Phases 1-6 reviewed and approved | See review section |
| 8 | Phase 7 | Extract handlers/ (incl. scheduled.ts) | `tsc --noEmit` + `wrangler deploy --dry-run` |
| 9 | Phase 7.5 | Extract services/perplexity.ts | `tsc --noEmit` |
| 10 | Phase 8 | Extract queue/ | `tsc --noEmit` + `wrangler deploy --dry-run` |
| 11 | Phase 9 | Clean up index.ts + remove duplicates | `wrangler deploy --dry-run` |
| 12 | Verify | Run smoke tests | Compare with baselines |
| 13 | Deploy | Deploy to staging | Full integration test |

### Pre-flight Smoke Test (Step 0)

Before starting refactoring, record responses from **all** endpoints listed in the verification checklist:

```bash
#!/bin/bash
# smoke-test-baseline.sh
# Run this BEFORE starting refactoring

BASE_URL="https://ufobeer.your-domain.workers.dev"
API_KEY="your-api-key"
ADMIN_SECRET="your-admin-secret"

# Public endpoint
curl -s "$BASE_URL/health" > baseline-health.json

# API key required endpoints
curl -s -H "X-API-Key: $API_KEY" \
  "$BASE_URL/beers?sid=13879&limit=5" > baseline-beers.json

# Admin endpoints (all 8)
curl -s -H "X-API-Key: $API_KEY" -H "X-Admin-Secret: $ADMIN_SECRET" \
  "$BASE_URL/admin/dlq?limit=1" > baseline-dlq-list.json

curl -s -H "X-API-Key: $API_KEY" -H "X-Admin-Secret: $ADMIN_SECRET" \
  "$BASE_URL/admin/dlq/stats" > baseline-dlq-stats.json

curl -s -X POST -H "X-API-Key: $API_KEY" -H "X-Admin-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"limit":1,"dry_run":true}' \
  "$BASE_URL/admin/enrich/trigger" > baseline-trigger.json

curl -s -X POST -H "X-API-Key: $API_KEY" -H "X-Admin-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"criteria":{"confidence_below":0.5},"limit":1,"dry_run":true}' \
  "$BASE_URL/admin/enrich/force" > baseline-force.json

# Error cases (verify error handling still works)
curl -s "$BASE_URL/beers?sid=invalid" > baseline-error-invalid-store.json
curl -s "$BASE_URL/admin/dlq" > baseline-error-no-auth.json

echo "Baselines saved. Keep these files until refactoring is complete."
```

After Step 10, run the same commands and compare:

```bash
#!/bin/bash
# smoke-test-verify.sh
# Run this AFTER refactoring, compare with baselines

# Compare key fields (ignoring dynamic values like requestId, timestamps)
for file in baseline-*.json; do
  current="${file/baseline-/current-}"
  # Re-run the same curl command to get current response
  # Then compare structure:
  echo "Comparing $file..."
  diff <(jq 'del(.requestId, .timestamp)' "$file") \
       <(jq 'del(.requestId, .timestamp)' "$current")
done
```

---

## Migration Strategy

### For Each Phase:

1. **Create new file** with extracted code
2. **Add exports** from new file
3. **Update index.ts** to import from new file
4. **Remove duplicated code** from index.ts
5. **Run `tsc --noEmit`** to verify types
6. **Commit** the phase

### Example: Extracting types.ts

```typescript
// src/types.ts
export interface Env {
  DB: D1Database;
  ENRICHMENT_QUEUE: Queue;
  // ... rest of Env
}

export interface RequestContext {
  requestId: string;
  startTime: number;
  // ...
}

// ... all other types
```

```typescript
// src/index.ts
import type { Env, RequestContext } from './types';
// Remove type definitions from index.ts
```

---

## Verification Checklist

After refactoring:

- [ ] `tsc --noEmit` passes
- [ ] `wrangler deploy --dry-run` succeeds
- [ ] All endpoints respond correctly:
  - [ ] `GET /beers?sid=...`
  - [ ] `GET /health`
  - [ ] `POST /admin/enrich/trigger`
  - [ ] `POST /admin/enrich/force` (new)
  - [ ] `GET /admin/dlq`
  - [ ] `GET /admin/dlq/stats`
  - [ ] `POST /admin/dlq/replay`
  - [ ] `POST /admin/dlq/acknowledge`
- [ ] Cron job runs successfully (scheduled handler)
- [ ] Queue consumer processes messages
- [ ] Audit logs are written
- [ ] Smoke test responses match baselines (per Step 0)

---

## Rollback Plan

If issues arise after deployment:

```bash
# Revert to previous version
wrangler rollback

# Or revert git commit
git revert HEAD
wrangler deploy
```

---

## Notes

- **Cloudflare Workers bundling**: esbuild handles imports/exports fine
- **Circular dependencies**: Avoid by keeping types.ts as a leaf module
- **Handler isolation rule**: No handler should import from another handler directly. Shared logic should live in utilities (db/, config.ts) or be passed via context.
- **Re-exports**: Use `index.ts` files in subdirectories for clean imports

### Re-export Index Files

```typescript
// src/handlers/index.ts
export { handleEnrichmentTrigger, handleForceEnrichment } from './enrichment';
export { handleDlqList, handleDlqStats, handleDlqReplay, handleDlqAcknowledge } from './dlq';
export { handleBeerList } from './beers';
export { handleHealthCheck } from './health';
export { handleScheduledEnrichment } from './scheduled';
```

```typescript
// src/db/index.ts
export { insertPlaceholders } from './helpers';  // Note: extractABV is internal, not exported
export { getEnrichmentQuotaStatus, reserveEnrichmentQuota } from './quota';
```

```typescript
// src/queue/index.ts
export { handleEnrichmentBatch } from './enrichment';
export { handleDlqBatch } from './dlq';
```

This allows clean imports in `index.ts`:
```typescript
import { handleBeerList, handleHealthCheck, handleEnrichmentTrigger } from './handlers';
import { getEnrichmentQuotaStatus } from './db';
import { handleEnrichmentBatch, handleDlqBatch } from './queue';
```

---

## Future Considerations

After refactoring, the modular structure enables better testing and maintenance:

### Post-Refactor Testing Plan

The isolated modules can now be unit tested:

| Module | Testable Functions | Priority |
|--------|-------------------|----------|
| `config.ts` | `shouldSkipEnrichment()` | High - critical business logic |
| `db/helpers.ts` | `extractABV()`, `insertPlaceholders()` | High - data integrity |
| `db/quota.ts` | `getEnrichmentQuotaStatus()` | Medium - rate limiting |
| `auth.ts` | `validateApiKey()`, `authorizeAdmin()` | Medium - security |
| `handlers/enrichment.ts` | `validateForceEnrichmentRequest()` | High - input validation |
| `services/perplexity.ts` | `fetchAbvFromPerplexity()` | Medium - external API (mock tests) |

Example test structure:
```typescript
// test/config.test.ts
import { shouldSkipEnrichment } from '../src/config';

describe('shouldSkipEnrichment', () => {
  it('blocks flight items', () => {
    expect(shouldSkipEnrichment('Hop Head Flight')).toBe(true);
    expect(shouldSkipEnrichment('Texas Flight')).toBe(true);
  });

  it('allows regular beers', () => {
    expect(shouldSkipEnrichment('Sierra Nevada Pale Ale')).toBe(false);
  });
});
```

### Other Improvements

1. **Shared utilities** - Extract common patterns if they emerge across handlers
2. **API documentation** - Generate OpenAPI spec from handler types
3. **Performance monitoring** - Add timing metrics per handler
