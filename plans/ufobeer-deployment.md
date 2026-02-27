# Plan: GitHub Actions CI/CD with D1 Migration Management

## Context

We had a production outage (Cloudflare 1101) because the cache proxy code was
deployed without first running its D1 migration. Migrations are currently
applied manually via `wrangler d1 execute`. This plan automates the
migration→deploy sequence using GitHub Actions so that:

1. Migrations always run before deploy
2. If a migration fails, the deploy is blocked
3. Already-applied migrations are tracked and skipped

---

## SQLite Idempotency: Honest Assessment

SQLite supports idempotent DDL for some operations but not others:

| Pattern | Idempotent? |
|---------|-------------|
| `CREATE TABLE IF NOT EXISTS` | Yes |
| `CREATE INDEX IF NOT EXISTS` | Yes |
| `DROP TABLE IF EXISTS` | Yes |
| `DROP INDEX IF EXISTS` | Yes |
| `ALTER TABLE ADD COLUMN` | **No** — errors with "duplicate column name" |
| `UPDATE ... WHERE` | Yes (idempotent by nature) |

Migrations 0002 and 0004 use `ALTER TABLE ADD COLUMN`, which **cannot** be
made idempotent in SQLite — there is no `IF NOT EXISTS` variant. This is a
SQLite limitation, not a tooling limitation.

**Solution:** Wrangler's migration runner tracks applied migrations in a
`d1_migrations` table. Once a migration is recorded there, it is never
re-run. This is the idempotency mechanism for non-idempotent SQL.

The one-time cost: we need to seed that tracking table with the 5
already-applied migrations so wrangler doesn't try to re-run them. This
is a single command, run once.

---

## What Claude Will Do

### Step 0: Harden error handling (TDD)

Two resilience gaps exposed by the production outage:

**0a: Top-level try/catch in `fetch` handler**

**File:** `src/index.ts` — `async fetch(request, env, ctx)` (line 82)

The entire `fetch` body has no try/catch. Any unhandled exception (D1
table missing, binding misconfiguration, etc.) becomes a bare Cloudflare
1101 error with no JSON body and no diagnostics.

**Fix:** Wrap the body after CORS preflight in a try/catch that returns
a JSON 500. Health check is included because it queries D1 for quota
data — if D1 is down, JSON 500 is better than bare 1101:

```typescript
// CORS preflight stays outside (no D1 dependency)
if (request.method === 'OPTIONS') { ... }

try {
  // Health check (queries D1) — inside try/catch
  if (url.pathname === '/health') { ... }
  // ... all other routing logic ...
} catch (error) {
  // Log full error server-side (appears in Cloudflare observability logs)
  console.error('Unhandled fetch error:', error);
  // Return generic message — do NOT expose error.message to clients
  // (could contain D1 internals, table names, SQL fragments)
  // Compute CORS header directly from env — corsHeaders may be null if
  // getCorsHeaders() failed or the error occurred before the null check.
  const errorHeaders: Record<string, string> = {};
  if (env.ALLOWED_ORIGIN) {
    errorHeaders['Access-Control-Allow-Origin'] = env.ALLOWED_ORIGIN;
  }
  return Response.json(
    { error: 'Internal Server Error', requestId: requestContext.requestId },
    { status: 500, headers: errorHeaders }
  );
}
```

**Design note:** The catch block deliberately skips the `respond()` helper
to avoid cascading failures — `respond()` calls `writeAuditLog` via
`ctx.waitUntil`, which uses D1. If D1 is the cause of the error, calling
`respond()` would attempt another D1 write. `console.error` is the
fallback, and Cloudflare's observability logs (enabled in `wrangler.jsonc`)
will capture it.

**TDD:** Write a test that causes an unhandled throw (e.g., mock D1 to
throw on rate limit check), assert the response is JSON 500 with
`requestId` and no raw error message in the body.

**0b: Guard cache lookup against D1 failures**

**File:** `src/handlers/beers.ts` — cache check block (~line 130)

`getCachedTaplist()` is in the critical path with no try/catch. If D1
throws (missing table, connection error), the entire request fails.
Additionally, the stale fallback in the `catch` block re-calls
`getCachedTaplist`, which would throw the same error if the table is
the problem.

**Fix:** Track whether the cache subsystem is available. Wrap the
initial cache lookup in try/catch, falling through to live fetch on
failure. For the stale fallback re-call, only attempt it if the
initial read succeeded:

```typescript
let cacheReadSucceeded = true;
if (!freshRequested) {
  try {
    cachedRow = await getCachedTaplist(env.DB, storeId);
  } catch (err) {
    cacheReadSucceeded = false;
    logError('cache.read.failed', err, { requestId: reqCtx.requestId, storeId });
  }
  // ... existing TTL check ...
}

// In both stale fallback blocks, wrap the re-call in try/catch.
// If the initial read succeeded but the re-call fails (transient D1 error),
// we don't want the outer catch to re-throw.
let fallbackRow = cachedRow;
if (!fallbackRow && cacheReadSucceeded) {
  try {
    fallbackRow = await getCachedTaplist(env.DB, storeId);
  } catch {
    fallbackRow = null;
  }
}
```

**TDD:** Write tests for both paths:
1. `getCachedTaplist` throws on initial call → handler falls through to
   live fetch, returns 200 with `source: 'live'`
2. `getCachedTaplist` throws on initial call, then upstream also fails →
   handler returns 502 (no stale fallback attempted)


### Step 1: Add `migrations_dir` to `wrangler.jsonc`

This tells `wrangler d1 migrations apply` where to find migration files.

**File:** `wrangler.jsonc`

Add `migrations_dir` to the D1 database config:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "beer-db",
    "database_id": "ea60d64b-d7a9-40ce-8e08-7155d78cfd3b",
    "migrations_dir": "migrations"
  }
]
```

### Step 2: Add npm scripts to `package.json`

```json
"typecheck": "tsc --noEmit",
"migrate:remote": "wrangler d1 migrations apply beer-db --remote",
"migrate:local": "wrangler d1 migrations apply beer-db --local",
"migrate:list": "wrangler d1 migrations list beer-db --remote"
```

`migrate:remote` is intentionally named to prevent accidentally running
migrations against production. `migrate:local` is for development.

`typecheck` runs `tsc --noEmit` against the root `tsconfig.json`, which
covers `src/` only (test types are excluded). The existing `typecheck:test`
script checks test types separately using `test/tsconfig.json`.

### Step 3: Create `.github/workflows/deploy.yml`

```yaml
name: Deploy

on:
  push:
    branches: [main]

# Prevent concurrent deploys — second push waits for first to finish.
# cancel-in-progress: false ensures a running migration is never interrupted.
concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - run: npm ci

      - name: Type check
        run: npm run typecheck

      - name: Run tests
        run: npx vitest run

      - name: Deploy
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          # --remote is REQUIRED (wrangler v4 defaults to --local)
          # preCommands inherits CLOUDFLARE_API_TOKEN env var set by wrangler-action
          preCommands: wrangler d1 migrations apply beer-db --remote
          command: deploy
```

Pipeline: checkout → install → typecheck → test → migrate → deploy.
If any step fails, subsequent steps are skipped.

**Note:** The `preCommands` migration step requires `migrations_dir` (Step 1)
to be committed first. Without it, `wrangler d1 migrations apply` won't find
the migration files. Steps 1–5 must all ship in the same commit/push.

**First CI run:** Watch the Actions log closely. The most likely failure mode
is a missing `D1:Edit` permission on the API token — this fails silently
(exit code 1, no error message).

### Step 4: Create `.github/workflows/ci.yml` (PR checks)

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - run: npm ci

      - name: Type check
        run: npm run typecheck

      - name: Run tests
        run: npx vitest run
```

### Step 5: Document migration conventions

Add a section to `CLAUDE.md` under a new `## Migrations` heading:

```
## Migrations

Migrations are plain SQL files in `migrations/`, numbered sequentially
(e.g., `0007_description.sql`). Applied automatically on deploy via
GitHub Actions using `wrangler d1 migrations apply`.

### Idempotent Migrations Required

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

### Migration Numbering

Migration 0001 was the initial schema (`schema.sql`), applied before
the migration tracking system existed. Numbering starts at 0002.

### Creating a New Migration

wrangler d1 migrations create beer-db "description of change"

This creates a numbered .sql file in migrations/. Fill in the SQL,
commit, and push. The deploy pipeline applies it automatically.

### Rollback Strategy

- If a migration **fails mid-execution**, wrangler auto-rolls back that
  single migration. Previously applied migrations are unaffected.
- If a migration **succeeds but breaks the app**, write a compensating
  "down" migration (e.g., `ALTER TABLE DROP COLUMN` for an unwanted
  column — supported in D1's SQLite 3.35+).
- **Emergency recovery:** D1 Time Travel provides 30-day point-in-time
  restore: `wrangler d1 time-travel restore beer-db --timestamp=<unix>`
```

---

## What You Need to Do Manually

> **IMPORTANT: Complete Manual Steps 1–3 BEFORE pushing code to main.**
> Pushing triggers the deploy workflow immediately. If the migration
> tracking table isn't bootstrapped yet, wrangler will try to re-run
> migrations 0002–0006, and 0002/0004 will fail on `ALTER TABLE ADD
> COLUMN` (columns already exist).

### Manual Step 1: Create Cloudflare API Token

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click **Create Token** → **Custom token**
3. Grant these permissions:
   - **Account** → **Workers Scripts** → **Edit**
   - **Account** → **D1** → **Edit**
4. Set Account Resources to your account
5. Create and copy the token

**Critical:** The default "Edit Cloudflare Workers" template does NOT
include D1:Edit (and may be listed as "Workers Scripts" in the dropdown). Without it, migrations fail silently (exit code 1,
no error message).

### Manual Step 2: Add GitHub Secrets

1. Go to your repo → Settings → Secrets and variables → Actions
2. Add two repository secrets:
   - `CLOUDFLARE_API_TOKEN` — the token from Manual Step 1
   - `CLOUDFLARE_ACCOUNT_ID` — visible on the Workers dashboard
     sidebar, or run `wrangler whoami`

### Manual Step 3: Bootstrap the migration tracking table (one time)

Wrangler tracks applied migrations in a `d1_migrations` table. Since
migrations 0002–0006 were applied manually before this system existed,
we need to seed the table once so wrangler doesn't try to re-run them.

**Step 3a: Verify wrangler's expected schema.** Before bootstrapping,
check what schema wrangler actually creates by inspecting a fresh D1
database or running:

```bash
wrangler d1 execute beer-db --remote --command="SELECT sql FROM sqlite_master WHERE name='d1_migrations';"
```

If the table doesn't exist yet (expected), the command returns empty.
Proceed with Step 3b using the schema below. If it does exist (someone
already ran `wrangler d1 migrations apply`), skip to the INSERT
statements only.

**Step 3b: Create the tracking table and seed it:**

```bash
wrangler d1 execute beer-db --remote --command="
CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0002_add_last_seen_at.sql'),
  ('0003_fix_enrichment_source.sql'),
  ('0004_add_queued_for_cleanup_at.sql'),
  ('0005_add_store_taplist_cache.sql'),
  ('0006_drop_cached_at_index.sql');
"
```

**Step 3c: Verify it worked:**

```bash
wrangler d1 execute beer-db --remote --command="SELECT * FROM d1_migrations ORDER BY id;"
```

You should see 5 rows. Then after Step 1 (adding `migrations_dir` to
`wrangler.jsonc`) is committed locally, verify wrangler recognizes them:

```bash
wrangler d1 migrations list beer-db --remote
```

All 5 should show as "applied".

**Step 3d: Also verify existing secrets are configured.** The deploy
assumes these secrets already exist in Cloudflare:

```bash
# These should already be set from initial setup:
# API_KEY, ADMIN_SECRET, PERPLEXITY_API_KEY, FLYING_SAUCER_API_BASE
wrangler secret list
```

**Why can't the bootstrap be automated?** The seed list is static (only
pre-existing migrations), so putting it in CI would run uselessly on
every deploy forever. One manual command, one time, done.

### Manual Step 4: Push and verify the pipeline

After Claude's changes are committed and Manual Steps 1–3 are complete:

1. Push to main
2. Check GitHub Actions tab — deploy workflow triggers
3. Migration step should show "No migrations to apply"
4. Deploy step should succeed
5. `curl https://api.ufobeer.app/health` confirms the worker is live

---

## Files Changed

| File | Action |
|------|--------|
| `src/index.ts` | Edit — add top-level try/catch (Step 0a) |
| `src/handlers/beers.ts` | Edit — guard cache lookup (Step 0b) |
| `test/handlers/beers.list.test.ts` | Edit — add cache D1 failure tests |
| `test/index.test.ts` | Edit or create — add unhandled error test |
| `wrangler.jsonc` | Edit — add `migrations_dir` |
| `package.json` | Edit — add `migrate` and `migrate:list` scripts |
| `.github/workflows/deploy.yml` | Create |
| `.github/workflows/ci.yml` | Create |
| `CLAUDE.md` | Edit — add Migrations section |

---

## Future Workflow

To add a new migration after this is set up:

```bash
wrangler d1 migrations create beer-db "add_foo_table"
# Edit the generated .sql file
# Commit and push — pipeline applies it automatically
```
