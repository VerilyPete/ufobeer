# Plan: Drop the unused `cleanup_limits` table

## Goal

Remove the `cleanup_limits` table from production D1, from `schema.sql`, and
from the golden contract fixture schema. PR #46 removed every production read
and write of the table (cleanup no longer calls a model, so it has no quota);
the table is now dead weight flagged in `schema.sql` and `AGENTS.md` as "to be
dropped".

## Current references (verified by grep, excluding `plans/archive`)

| File | Reference | Action |
|---|---|---|
| `migrations/0001_create_base.sql:102-108` | creates the table | **leave** — applied history, never edited |
| `schema.sql:169-177` | creates the table, marked unused | remove block |
| `contract-test/migrations/0001_golden_schema.sql:60-64` | creates the table | remove block |
| `contract-test/goldenTaproom.contract.test.ts:32` | `'cleanup_limits'` in `requiredTables` (used by `clearGoldenRows` to `DELETE FROM` each table) | remove entry, else `DELETE FROM cleanup_limits` throws "no such table" |
| `test/queue/cleanup-consumer.integration.test.ts:109-117` | seeds a 1,000,000 row count to prove cleanup ignores the old quota | delete this test (see Step 2) |
| `AGENTS.md:74` | "Unused … to be dropped" | remove the line |
| `docs/admin-trigger-cleanup.md:408-427` | "Quota Considerations" section with `SELECT`/`UPDATE cleanup_limits` runbook commands | remove the section (commands would fail after the drop) |
| `docs/cleanup-parallelization.md`, `docs/cleanup-parallelization/02-helper-functions.md`, `docs/cleanup-trigger-phases/02-handler.md`, `docs/cleanup-trigger-phases/04-tests.md` | historical design docs for the old AI cleanup | **leave** — historical record, not operational |
| `plans/pr44-review-fixes.md:183` | follow-up list item | leave (untracked working note) |

No `src/` code references the table (confirmed by grep).

## Steps (TDD)

### Step 1 — RED: migration chain no longer has the table

New test file `test/db/schema.integration.test.ts` (real D1 via
`REAL_MIGRATIONS`, same pattern as `test/quota.integration.test.ts`):

```ts
import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('D1 schema after the migration chain', () => {
  it('has no cleanup_limits table now that cleanup has no quota', async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cleanup_limits'"
    ).first();
    expect(table).toBeNull();
  });

  it('keeps the enrichment quota table', async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'enrichment_limits'"
    ).first();
    expect(table).toEqual({ name: 'enrichment_limits' });
  });
});
```

The second test guards against an over-broad drop (e.g. a typo dropping
`enrichment_limits`). Run `npm test -- test/db/schema.integration.test.ts`;
the first test must fail (table exists), the second pass.

### Step 2 — GREEN: add migration 0010

Create via `wrangler d1 migrations create beer-db "drop cleanup limits"`
(expected name `migrations/0010_drop_cleanup_limits.sql`):

```sql
-- cleanup_limits tracked Workers AI cleanup calls. Cleanup became
-- deterministic and lost its quota (PR #46); nothing reads or writes it.
DROP TABLE IF EXISTS cleanup_limits;
```

Idempotent per `AGENTS.md`. No indexes exist on the table (it only has its
primary key), so nothing else to drop.

Same commit: delete the cleanup-consumer test
`'applies the deterministic fixes however many descriptions were cleaned today'`
— it inserts into `cleanup_limits` and would now throw "no such table". Its
behaviour (no quota gates cleanup) is now structural: there is no quota table
to consult. The remaining consumer tests still prove deterministic cleanup.
Also drop the now-unused `today` helper in that file if nothing else uses it.

Run the full suite: `npm test`.

### Step 3 — Contract fixture

- Remove the `cleanup_limits` block from
  `contract-test/migrations/0001_golden_schema.sql` (fixture only, edited in
  place per `AGENTS.md`; it is not a production migration).
- Remove `'cleanup_limits'` from `requiredTables` in
  `contract-test/goldenTaproom.contract.test.ts`.

Verify with `npm run typecheck:contract && npm run test:contract` (needs the
`../BeerSelector` sibling; if absent, say so rather than claim it passed).

### Step 4 — `schema.sql` and docs

- Remove the `cleanup_limits` comment header and `CREATE TABLE` from
  `schema.sql`.
- Remove the `cleanup_limits` bullet from `AGENTS.md` "Key Tables".
- Remove the "Quota Considerations" section from
  `docs/admin-trigger-cleanup.md` (its runbook commands target the dropped
  table; the rest of that doc's quota staleness is out of scope).

### Step 5 — Verify

- `npm test -- --run`, `npm run typecheck`, `npm run typecheck:test` (deploy.yml gates on it), contract run from Step 3.
- `grep -rn cleanup_limits --exclude-dir=node_modules --exclude-dir=.git .`
  shows only `migrations/0001_create_base.sql`, `migrations/0010_*`, the new
  schema test, historical `docs/cleanup-parallelization*` and
  `docs/cleanup-trigger-phases/`, and `plans/`.
- Local apply check: `npx wrangler d1 migrations apply beer-db --local` runs
  0010 cleanly.

## Deployment / rollback

- Deploy pipeline (`.github/workflows/deploy.yml`) applies 0010 before the
  Worker deploys. The currently deployed Worker (post-#46) never touches the
  table, so drop-before-deploy is safe; no ordering hazard.
- The table holds only historical daily counters; losing them has no
  operational impact. If needed, D1 Time Travel restores (30 days).
- Compensating migration if ever needed: re-run the original
  `CREATE TABLE IF NOT EXISTS cleanup_limits (...)`.

## Out of scope

- Broader staleness in `docs/admin-trigger-cleanup.md` (`DAILY_CLEANUP_LIMIT`,
  `projected_after`) and the historical parallelization docs.
- Any other follow-up in `plans/pr44-review-fixes.md`.

## Delivery

Branch `chore/drop-cleanup-limits`, one commit per step group (1+2, 3, 4),
PR to `main` after commit approval.
