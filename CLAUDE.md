# UFO Beer API

Cloudflare Workers API that enriches beer data from Flying Saucer with ABV information and cleaned descriptions.

## Quick Start

```bash
npm run dev      # Local development (wrangler dev)
npm run test     # Run all tests (vitest)
npm run test:unit # Unit tests only
npm run deploy   # Deploy to Cloudflare
```

## Architecture Overview

```
src/
├── index.ts           # Entry point, routing dispatcher
├── handlers/          # Request handlers by feature
│   ├── beers.ts       # GET /beers, POST /beers/batch, POST /beers/sync
│   ├── admin.ts       # Admin endpoints (triggers, DLQ)
│   └── health.ts      # GET /health
├── queue/             # Queue consumers
│   ├── enrichment.ts  # Perplexity API enrichment
│   ├── cleanup.ts     # Workers AI description cleanup
│   ├── cleanupHelpers.ts
│   └── dlq.ts         # Dead letter queue storage
├── db/
│   ├── helpers.ts     # Database query helpers
│   └── quota.ts       # Rate limit and quota tracking
├── services/
│   └── perplexity.ts  # Perplexity API client
├── auth.ts            # API key validation
├── rate-limit.ts      # Per-client rate limiting
├── audit.ts           # Request audit logging
├── analytics.ts       # Analytics Engine tracking
├── config.ts          # Store IDs and configuration
├── constants.ts       # Magic numbers with documentation
├── context.ts         # Request context and CORS
├── types.ts           # TypeScript types
├── utils/
│   ├── date.ts        # Date formatting utilities
│   └── log.ts         # Structured logging
└── validation/
    └── storeId.ts     # Store ID validation
```

## API Endpoints

See [.claude/api-endpoints.md](.claude/api-endpoints.md) for full documentation.

### Public (API key required)
- `GET /beers?store_id=<id>` - Fetch beers with enrichment data
- `POST /beers/batch` - Batch lookup enrichment for multiple beers
- `POST /beers/sync` - Full sync from Flying Saucer API
- `GET /health` - Health check with quota status

### Admin (admin API key required)
- `POST /admin/enrich/trigger` - Trigger enrichment processing
- `POST /admin/cleanup/trigger` - Trigger description cleanup
- `GET /admin/dlq` - List DLQ messages
- `GET /admin/dlq/stats` - DLQ statistics
- `POST /admin/dlq/replay` - Replay failed messages
- `POST /admin/dlq/acknowledge` - Acknowledge/dismiss messages

## Database

D1 SQLite database. Schema is fully documented in `schema.sql`.

### Key Tables
- `enriched_beers` - Core beer data with ABV and cleaned descriptions
- `rate_limits` - Per-client request tracking
- `enrichment_limits` / `cleanup_limits` - Daily quota tracking
- `dlq_messages` - Failed queue messages for admin inspection
- `audit_log` - Request audit trail
- `system_state` - Locks and configuration

### Running Migrations
```bash
wrangler d1 execute beer-db --file=migrations/XXXX_name.sql
```

## Queue Processing

See [.claude/queue-processing.md](.claude/queue-processing.md) for detailed queue architecture.

### Queues
| Queue | Purpose | Batch Size | Concurrency |
|-------|---------|------------|-------------|
| `beer-enrichment` | Perplexity ABV lookup | 1 | 1 |
| `description-cleanup` | Workers AI cleanup | 25 | 1 (p-limit internal) |
| `*-dlq` | Dead letter storage | 10 | - |

### Cron
- `0 */12 * * *` - Scheduled enrichment every 12 hours

## Environment Bindings

Defined in `wrangler.jsonc`:

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 | SQLite database |
| `AI` | Workers AI | LLM for description cleanup |
| `ANALYTICS` | Analytics Engine | Metrics tracking |
| `ENRICHMENT_QUEUE` | Queue | Beer enrichment jobs |
| `CLEANUP_QUEUE` | Queue | Description cleanup jobs |

### Environment Variables
```
ALLOWED_ORIGIN          # CORS origin (https://ufobeer.app)
RATE_LIMIT_RPM          # Requests per minute per client (60)
PERPLEXITY_MAX_CONCURRENCY  # Parallel Perplexity calls (10)
DAILY_ENRICHMENT_LIMIT  # Perplexity calls/day (500)
MONTHLY_ENRICHMENT_LIMIT # Perplexity calls/month (2000)
ENRICHMENT_ENABLED      # Toggle enrichment (true)
MAX_CLEANUP_CONCURRENCY # Parallel cleanup calls (10)
DAILY_CLEANUP_LIMIT     # Cleanup calls/day (1000)
```

### Secrets
```bash
wrangler secret put PERPLEXITY_API_KEY
wrangler secret put API_KEY          # Client API key
wrangler secret put ADMIN_API_KEY    # Admin API key
```

## Key Patterns

### Rate Limiting
- Per-client, per-minute tracking in `rate_limits` table
- Uses atomic `INSERT ... ON CONFLICT ... RETURNING` for efficiency
- Client identified by API key hash or IP

### Quota System
- Daily/monthly limits on Perplexity API calls (cost control)
- Daily limits on Workers AI cleanup calls
- Tracked in `enrichment_limits` and `cleanup_limits` tables

### Dead Letter Queue
- Failed messages stored in D1 for inspection
- Admin can replay or acknowledge via API
- Prevents message loss while enabling debugging

### ABV Enrichment Pipeline
1. Beer imported via `/beers/sync` or discovered via `/beers`
2. Missing ABV queued to `beer-enrichment`
3. Perplexity API called for ABV lookup
4. Result stored with confidence score and source

### Description Cleanup Pipeline
1. Beer with raw description queued to `description-cleanup`
2. Workers AI (Llama) cleans marketing fluff
3. Original preserved, cleaned version stored
4. Hash tracked for change detection

## Testing

Uses Vitest with `@cloudflare/vitest-pool-workers` for Workers environment.

```bash
npm run test          # All tests
npm run test:unit     # Unit tests only (vitest.unit.config.mts)
```

### Test Structure
```
test/
├── handlers/         # Handler tests
├── services/         # Service tests (perplexity)
├── utils/            # Utility tests
├── validation/       # Validation tests
├── load/             # Artillery load tests
├── rate-limit.test.ts
└── pipeline.integration.test.ts
```

### Load Testing
Artillery configs in `test/load/` for batch, sync, and mixed workloads.

## Common Tasks

### Add a new endpoint
1. Create handler in `src/handlers/`
2. Add route in `src/index.ts`
3. Add analytics tracking if needed
4. Add tests in `test/handlers/`

### Add a new queue consumer
1. Define queue in `wrangler.jsonc`
2. Create consumer in `src/queue/`
3. Add to exports in `src/index.ts`
4. Consider DLQ handling

### Debug failed enrichment
1. Check `/admin/dlq` for failed messages
2. Review `failure_reason` field
3. Replay with `/admin/dlq/replay` or acknowledge

### Check quotas
```bash
curl -H "X-API-Key: $API_KEY" https://api.ufobeer.app/health
```

## Cloudflare Workers AI Gotchas

### `env.AI.run()` Does Not Accept `AbortSignal` (as of Feb 2026)

The `AiOptions` type only supports `stream`. Passing `signal: AbortSignal.timeout(ms)` is a compile error under strict mode and does not work at runtime.

**Key facts:**
- Worker CPU is NOT consumed during I/O wait. Cloudflare bills CPU time, not wall-clock time. A hanging `ai.run()` call does not burn your CPU budget while it waits.
- `Promise.race` timeout is therefore acceptable: it returns control to the caller promptly, and the only "cost" is the GPU inference running to completion server-side — which no client-side approach can prevent anyway.

```typescript
// ✅ ACCEPTABLE - Promise.race timeout (CPU not burned during I/O wait)
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('AI call timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

// ❌ DOES NOT COMPILE - AiOptions has no signal property
const result = await env.AI.run(model, inputs, {
  signal: AbortSignal.timeout(AI_TIMEOUT_MS), // type error
});
```

**Infrastructure-level alternative**: AI Gateway supports `cf-aig-request-timeout` header (added Feb 2025), which enforces a timeout server-side without code changes. Best option if infrastructure-level control is needed.

**How to check for native support**: Run `wrangler types` and look for `signal?: AbortSignal` in the `AiOptions` type in `worker-configuration.d.ts`.

---

## Code Style

- TypeScript strict mode
- Handlers return `Promise<Response>`
- Use `ctx.waitUntil()` for background work (audit logs, analytics)
- Prefer atomic DB operations over read-then-write
- Extract magic numbers to `src/constants.ts`
