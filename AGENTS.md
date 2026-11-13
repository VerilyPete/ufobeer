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
│   ├── health.ts      # GET /health
│   └── usage.ts       # POST /usage (usage telemetry)
├── queue/             # Queue consumers
│   ├── enrichment.ts  # Perplexity API enrichment
│   ├── cleanup.ts     # Deterministic description cleanup
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
├── context.ts         # Error responses and security headers
├── types.ts           # TypeScript types
├── utils/
│   ├── date.ts        # Date formatting utilities
│   └── log.ts         # Structured logging
└── validation/
    └── storeId.ts     # Store ID validation
```

## API Endpoints

See [.claude/api-endpoints.md](.claude/api-endpoints.md) for full documentation.

The API has no browser clients and sends no CORS headers; every `OPTIONS` gets 403.
`enrichment_source` values beyond the original four (today `exa`) are shown only
to clients that send `X-Enrichment-Sources: exa`; others get `null`. Once an
`exa` row exists, never deploy a worker older than that negotiation (see the
rollback floor in `plans/abv-untappd-fallback.md`). The native BeerSelector app is the only application client, and monitoring uses `/health`.

### Public (API key required)
- `GET /beers?store_id=<id>` - Fetch beers with enrichment data
- `POST /beers/batch` - Batch lookup enrichment for multiple beers
- `POST /beers/sync` - Full sync from Flying Saucer API
- `GET /health` - Health check with quota status
- `POST /usage` - Beta usage telemetry from BeerSelector (per-install daily feature counts)

### Reports (API key plus `Authorization: Bearer <USAGE_REPORT_TOKEN>`)
- `GET /reports/usage?view=daily|events|adoption|breakdown&from=YYYY-MM-DD&to=YYYY-MM-DD` -
  Aggregate usage for the Grafana dashboard; never returns an install ID.
  The token works nowhere else, and `ADMIN_SECRET` doesn't work here. Reads
  have their own bucket (`USAGE_REPORT_RATE_LIMIT_RPM`, checked after the
  token) outside the shared per-key limiter. `from` defaults to 89 days ago
  (90 days including today) and must be inside the 730-day retention window; `to` defaults to today
  and can't be later. Queries live in `src/db/usage-report.ts`; metric
  definitions are in `plans/usage-dashboards.md` (Read endpoint).

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
- `enrichment_limits` - Daily/monthly Perplexity quota tracking
- `abv_fallback_limits` - Daily Exa fallback call count (migration 0013, 90-day retention)
- `dlq_messages` - Failed queue messages for admin inspection
- `audit_log` - Request audit trail
- `system_state` - Locks and configuration
- `usage_daily`, `usage_installs`, `usage_batches`, `usage_ingest_daily` - Usage telemetry (migration 0012; see Usage Telemetry below)

### Migrations

Migrations are plain SQL files in `migrations/`, numbered sequentially
(e.g., `0007_description.sql`). Applied automatically on deploy via
GitHub Actions using `wrangler d1 migrations apply`.

#### Idempotent Migrations Required

**All migrations MUST be idempotent.** Use these patterns:
- `CREATE TABLE IF NOT EXISTS` (never bare `CREATE TABLE`)
- `CREATE INDEX IF NOT EXISTS`
- `DROP TABLE IF EXISTS` / `DROP INDEX IF EXISTS`
- `INSERT OR IGNORE` / `INSERT OR REPLACE` for seed data
- `UPDATE ... WHERE` (naturally idempotent)

**`ALTER TABLE ADD COLUMN` is the exception.** SQLite has no
`IF NOT EXISTS` variant. The migration runner's tracking prevents
re-runs, but the SQL itself is not re-runnable. If you must use
ALTER TABLE ADD COLUMN, document it with a comment:
```sql
-- NOT IDEMPOTENT: relies on migration tracking to prevent re-runs
ALTER TABLE foo ADD COLUMN bar INTEGER;
```

#### Migration Numbering

Migration 0001 was the initial schema (`schema.sql`), applied before
the migration tracking system existed. Numbering starts at 0002.

#### Creating a New Migration

```bash
wrangler d1 migrations create beer-db "description of change"
```

This creates a numbered .sql file in migrations/. Fill in the SQL,
commit, and push. The deploy pipeline applies it automatically.

#### Rollback Strategy

- If a migration **fails mid-execution**, wrangler auto-rolls back that
  single migration. Previously applied migrations are unaffected.
- If a migration **succeeds but breaks the app**, write a compensating
  "down" migration (e.g., `ALTER TABLE DROP COLUMN` for an unwanted
  column — supported in D1's SQLite 3.35+).
- **Emergency recovery:** D1 Time Travel provides 30-day point-in-time
  restore: `wrangler d1 time-travel restore beer-db --timestamp=<unix>`

## Queue Processing

See [.claude/queue-processing.md](.claude/queue-processing.md) for detailed queue architecture.

### Queues
| Queue | Purpose | Batch Size | Concurrency |
|-------|---------|------------|-------------|
| `beer-enrichment` | Perplexity ABV lookup | 1 | 1 |
| `description-cleanup` | Deterministic cleanup | 25 | 1 |
| `*-dlq` | Dead letter storage | 10 | - |

### Cron
- `*/20 * * * *` - Polls every 20 min; enrichment runs every ~2h (±20 min jitter), noon–11pm CT only

## Environment Bindings

Defined in `wrangler.jsonc`:

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 | SQLite database |
| `ANALYTICS` | Analytics Engine | Metrics tracking |
| `ENRICHMENT_QUEUE` | Queue | Beer enrichment jobs |
| `CLEANUP_QUEUE` | Queue | Description cleanup jobs |

### Environment Variables
```
RATE_LIMIT_RPM          # Requests per minute per client (60)
PRE_AUTH_RPM            # Pre-auth requests/min per IP, all routes (30)
PERPLEXITY_MAX_CONCURRENCY  # Parallel Perplexity calls (10)
DAILY_ENRICHMENT_LIMIT  # Perplexity calls/day (500)
MONTHLY_ENRICHMENT_LIMIT # Perplexity calls/month (2000)
ENRICHMENT_ENABLED      # Toggle enrichment (true)
USAGE_ENABLED           # POST /usage ingests only when exactly "true" (true)
ABV_FALLBACK_ENABLED    # Exa Untappd fallback runs only when exactly "true" (false)
EXA_DAILY_LIMIT         # Exa fallback calls/day (50)
```

### Secrets
```bash
wrangler secret put PERPLEXITY_API_KEY
wrangler secret put EXA_API_KEY      # Optional: Exa Untappd ABV fallback
wrangler secret put API_KEY          # Client API key
wrangler secret put ADMIN_SECRET     # Admin secret for /admin/* routes (X-Admin-Secret header)
wrangler secret put USAGE_REPORT_TOKEN  # Bearer token for GET /reports/usage (Grafana); required to deploy
```

## Key Patterns

### Rate Limiting
- Per-client, per-minute tracking in `rate_limits` table
- Uses atomic `INSERT ... ON CONFLICT ... RETURNING` for efficiency
- Client identified by API key hash or IP
- Pre-auth per-IP bucket (`preauth:{ip}`, `PRE_AUTH_RPM` var, default 30/min) runs before auth so unauthenticated traffic — including /health and 401 brute force — is throttled
- Fails closed on D1 errors: callers map `degraded: true` to 503 (transient), not 429

### Quota System
- Daily/monthly limits on Perplexity API calls (cost control)
- Tracked in the `enrichment_limits` table

### Dead Letter Queue
- Failed messages stored in D1 for inspection
- Admin can replay or acknowledge via API
- Replay claims entries under a lease (`replay_claim` token, `replay_claimed_at`,
  migration 0015); every replay write is guarded on the token, and the cron
  returns claims older than `DLQ_REPLAY_CLAIM_STALE_MS` to `pending`
  (`releaseStaleReplayClaims`). Replay never re-opens a beer that already has
  an ABV or is skipped; those entries are reported in `skipped_resolved`
- Prevents message loss while enabling debugging

### ABV Enrichment Pipeline
1. Beer imported via `/beers/sync` or discovered via `/beers`
2. Missing ABV queued to `beer-enrichment`
3. Perplexity API called for ABV lookup
4. On Perplexity's explicit `unknown` only, the Exa fallback (`src/services/exa.ts`) searches
   untappd.com and reads the ABV from a strictly matched beer page (`src/services/untappdMatch.ts`),
   stored as source `exa`, confidence 0.8. It runs only with `EXA_API_KEY` set and
   `ABV_FALLBACK_ENABLED` exactly `"true"`, within `EXA_DAILY_LIMIT` calls per UTC day
   (`abv_fallback_limits`, migration 0013, reserved by one conditional increment). A miss or
   any Exa failure marks `not_found` and acknowledges; it never retries the Perplexity call.
   All its writes are guarded on status, description hash, name and brewer.
5. Result stored with confidence score and source

Non-beers (flights, blends, mixed pours) are skipped by `shouldSkipEnrichment({ brewName, brewer })`
in `src/config.ts`: name rules, placeholder brewers (`n/a`, `unassigned`, `various`, `flights`),
the Saucer's `Brewfusion` house label, and name-plus-brewer entries. A blank brewer is never a skip
signal. `skipped` is terminal, so each enrichment run first re-checks recently seen skipped rows
(`releaseUnblockedSkips`, `src/db/skipRecovery.ts`) and returns any that no rule matches to `pending`.

### Hand-Verified Rows
A row with `is_verified = 1` keeps its `abv`, `confidence`, `enrichment_source`
and `enrichment_status`: only a human changes them (NULL counts as unverified).
Every automatic writer enforces this against the live row (`src/db/verified.ts`):
row-level writes add `NOT_VERIFIED_SQL`; writes that also carry a description or
names (taplist upserts, the cleanup consumer) use `unlessVerified()` per protected
column, so the description is still updated and re-cleaned. Selectors skip
verified rows, the enrichment consumer's preflight acks them before reserving
quota, and admin DLQ replay reports them in `skipped_verified`.

### Description Cleanup Pipeline
1. Beer with raw description queued to `description-cleanup`
2. Deterministic fixes applied (`applyCleanupFixes` in `src/queue/cleanupGuard.ts`): reviewed spelling pairs, a missing space after a comma or between a percentage and ABV, a final full stop. No model is called.
3. Original preserved, cleaned version stored with `cleanup_source = 'deterministic'`
   and `cleanup_version = CLEANUP_VERSION` (`src/constants.ts`)
4. Hash tracked for change detection
5. After changing cleanup output, bump `CLEANUP_VERSION`; `POST /admin/cleanup/trigger`
   with `mode: 'all'` then re-cleans older rows, 500 per run, without blanking served text.
   The trigger stores each hash only while the description is still the text it read,
   sends only those rows, then marks the sent ones (guarded on hash and on the row still
   being uncleaned). A never-cleaned row whose send or mark fails is found by the next
   `mode: 'missing'` run; an outdated row whose re-clean send fails keeps its version and is
   found by the next `mode: 'all'` run.

### Usage Telemetry (`POST /usage`)
- BeerSelector posts daily per-install feature counts keyed by a random
  install ID. Counts are **unverified** (the API key ships in the app and
  install IDs are client-chosen): good for trends and ratios, not exact figures.
- `USAGE_ENABLED` kill switch: anything but `"true"` returns 204 without
  writing. Every accepted case is a 204, because a 204 tells the client to
  delete its batch; only a bad envelope is a 400.
- Rate limit: 6/min per IP under `usage:{ip}`, routed before the shared
  per-API-key bucket so telemetry never spends the `/beers` budget.
- Growth budgets (UTC day, `src/constants.ts`): at most 100 new install IDs
  and 500 counted posts. Over budget is a 204 that stores no usage and is
  logged plus sent to Analytics Engine with its reason.
- Drop counters on `usage_ingest_daily` (`duplicates`, `dropped_post_cap`,
  `dropped_new_install`, `dropped_all_events`, `dropped_events`) count every
  post or event entry not stored, per UTC day, saturating at
  `USAGE_DROP_COUNTER_DAILY_CEILING` (10,000). An all-dropped report now
  writes its counter and nothing else.
- Writes run in one `db.batch()` transaction (`recordUsageReport` in
  `src/db/usage.ts`); a repeated `(install_id, batch_id)` is ignored.
- Retention, reaped every cron tick before the enrichment gates, 5,000 rows
  per table per tick: `usage_daily`, `usage_installs` and `usage_ingest_daily`
  730 days, `usage_batches` 8 days (the dedup window).
- Daily health check (17:00 UTC tick) logs `usage_daily` size and cleanup
  backlog, and alerts when the previous UTC day reached either growth budget;
  alerts go out via `console.error` and the error-alerts tail worker.
- Adding an event: add it to `USAGE_EVENTS` in `src/schemas/request.ts` and
  recompute the reap throughput note in `src/constants.ts`. Until deployed,
  the worker drops the unknown event and nothing breaks.
- Queries and monitoring: `.claude/usage-telemetry.md`. Design: `plans/usage-telemetry.md`.

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

### Golden Taproom Contracts

The API owns the public response shape and the producer-side harness in
`contract-test/`. The harness invokes `src/index.ts` against isolated D1 and
checks successful `/beers`, `/beers/batch`, `/beers/sync`, and `/health`
responses (including `/beers` 304) with the mobile consumer contracts. The
mobile repository owns those consumer contracts; keep the API harness focused
on the wire boundary.

Adding unknown or optional response fields is normally compatible. Removing a
required field, changing a type, adding an unsupported enum value, or changing
nullability requires coordinated mobile work and a contract update. Keep
`contract-test/migrations/0001_golden_schema.sql` as a test fixture only; it is
not a production migration. Beside `contract-test/fixtures.ts`, keep fixtures
minimal: add the smallest record that exposes a new wire-level distinction,
not a full production taplist or many equivalent beers.

The `POST /usage` request contract runs the other way:
`contract-test/usageReport.contract.test.ts` parses BeerSelector's golden
`native-ios/Tests/Fixtures/usage-report.request.json` (written by the app's
real Swift encoder) with `parseUsageReport` and requires the result to equal
`usage-report.expected.json` with nothing dropped or merged; the app's
events must be a subset of `USAGE_EVENTS`, so a new event lands here and
deploys before the app adds it. Set
`USAGE_CONTRACT_FIXTURES_DIR` to try other fixtures. See slice 7 of
`plans/usage-telemetry.md`.

For local cross-repository runs, check out the siblings in this exact layout:

```text
<parent>/
├── BeerSelector/
└── ufobeer/
```

From `ufobeer` with `BeerSelector` at the sibling path, run:

```bash
npm run typecheck:contract
npm run test:contract
```

To install both checkouts and run the same gate from the parent directory:

```bash
npm ci --prefix BeerSelector
npm ci --prefix ufobeer
npm run typecheck:contract --prefix ufobeer
npm run test:contract --prefix ufobeer
```

For rollout, land the API harness/scripts on `ufobeer` `main` and the mobile
consumer contracts on `BeerSelector` `main` before expecting the opposite
repository's `Golden Taproom Contract` workflow to pass.

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

## Code Style

- TypeScript strict mode
- Handlers return `Promise<Response>`
- Use `ctx.waitUntil()` for background work (audit logs, analytics)
- Prefer atomic DB operations over read-then-write
- Extract magic numbers to `src/constants.ts`
