---
title: CI/CD pipeline with automated D1 migrations and D1 failure hardening
implemented: 2026-02-27
commit: e6c4472
tags: [ci-cd, github-actions, d1, migrations, error-handling, deployment]
---

## Problem

Production outage (Cloudflare 1101 error) caused by deploying cache proxy code without first running its D1 migration. Migrations were applied manually with no enforcement. Additionally, any unhandled exception in the `fetch` handler produced a bare 1101 with no JSON body and no diagnostics, and `getCachedTaplist()` was in the critical path with no try/catch.

## Decision

**Step 0a — Top-level try/catch**: Wrapped the entire `fetch` handler body (after CORS preflight) in try/catch returning JSON 500 with `requestId`. Catch block computes CORS from `env.ALLOWED_ORIGIN` directly — avoids cascading failure via `respond()` helper which calls `writeAuditLog` via D1.

**Step 0b — Cache D1 guard**: Wrapped initial `getCachedTaplist()` call in try/catch with `cacheReadSucceeded` boolean. Stale fallback re-call only attempted if initial read succeeded. Duplicated stale fallback logic extracted to `resolveStaleRow()` helper. On cache D1 failure: falls through to live fetch. On cache D1 failure + upstream failure: returns upstream error (no stale fallback attempted).

**CI/CD** (`deploy.yml`): checkout → install → typecheck → test → `wrangler d1 migrations apply beer-db --remote` (via `preCommands`) → `wrangler deploy`. Concurrency group `deploy-production` with `cancel-in-progress: false` prevents interrupted migrations. If migration fails, deploy is blocked.

**PR checks** (`ci.yml`): checkout → install → typecheck → test. No migration step (remote D1 not available on PRs).

**`wrangler.jsonc`**: Added `migrations_dir: "migrations"` so wrangler finds migration files.

**`package.json`**: Added `typecheck`, `migrate:remote`, `migrate:local`, `migrate:list` scripts.

**Bootstrap requirement (one-time manual)**: Wrangler's `d1_migrations` tracking table had to be seeded with the 5 pre-existing migrations (0002–0006) before the first CI run. Without this, wrangler would attempt to re-run them and fail on `ALTER TABLE ADD COLUMN` (no `IF NOT EXISTS` in SQLite). This was a one-time manual step.

**CLAUDE.md**: Added Migrations section documenting idempotency requirements, the `ALTER TABLE` exception, numbering convention, rollback strategy, and D1 Time Travel as emergency recovery.

## Trade-offs

- `ALTER TABLE ADD COLUMN` is not idempotent in SQLite — relies entirely on migration tracking to prevent re-runs. Documented with required comment in migration files.
- Cloudflare API token requires `Workers Scripts: Edit` AND `D1: Edit` permissions. The default "Edit Cloudflare Workers" template omits D1:Edit and fails silently (exit code 1, no message). Documented in plan.
- Health check is inside the try/catch despite no D1 dependency at routing time — included because it queries D1 for quota data and JSON 500 is better than bare 1101 if D1 is down.
- `TS enforcer finding` applied opportunistically: `as unknown[]` on `fsResp.json()` replaced with `const fsData: unknown`.
