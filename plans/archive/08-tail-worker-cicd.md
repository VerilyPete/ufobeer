---
title: Add tail worker to CI and deploy workflows
implemented: 2026-02-27
commit: e879032
tags: [ci-cd, github-actions, tail-worker, deployment]
---

## Problem

The tail worker (`ufobeer-error-alerts`) was deployed manually and could drift from the repo. The main worker's `tail_consumers` reference would fail if the tail worker was missing or broken.

## Decision

Added tail worker checks to both GitHub Actions workflows.

**Ordering constraint**: Tail worker MUST deploy before the main worker (since `wrangler.jsonc` references it via `tail_consumers`). A tail worker deploy failure blocks the main worker deploy entirely — sequential steps in a single job guarantee this.

**`ci.yml` (PR checks)**: Added install, typecheck, and test steps for the tail worker after main worker checks.

**`deploy.yml` (merge to main)**: Added install, typecheck, test, and deploy steps for the tail worker between the main worker tests and the main worker deploy. Deploy uses `cloudflare/wrangler-action@v3` with `workingDirectory: workers/error-alerts`.

**npm cache**: Both workflows add `cache-dependency-path` to `actions/setup-node` covering both `package-lock.json` files.

## Trade-offs

- Both workers' checks run in a single job (sequential), not parallel. Simpler than a multi-job matrix; acceptable given the ordering dependency.
- `npx wrangler` (not `npm run`) used in working-directory steps because `npx` doesn't support `--prefix`.
