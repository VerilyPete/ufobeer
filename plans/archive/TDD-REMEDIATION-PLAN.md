---
title: TDD remediation — new test coverage, anti-pattern fixes, duplicate deletion
implemented: 2026-02-26
commit: 402414e
tags: [tdd, testing, coverage, anti-patterns, factory-functions]
---

## Problem

Audit identified zero-coverage on security-critical and high-traffic code (`auth.ts`, `analytics.ts`, `audit.ts`, `context.ts`, `config.ts`, `utils/hash.ts`), SQL-string assertions in tests (implementation coupling), `let`/`beforeEach` anti-patterns in multiple test files, and a duplicate `withTimeout` test file.

## Decision

**Wave 1 — New coverage** (all parallel): Created 6 test files for previously untested modules. Key decisions:
- Web Crypto API tested with real implementation (Node 19+ has it natively via `globalThis.crypto`) — no mocks, because the behavior IS the cryptographic correctness.
- All factories use `(overrides?: Partial<T>): T` pattern, no `let`/`beforeEach`.
- Private functions tested via public API only.

**Wave 2 — Anti-pattern fixes**: Removed SQL string assertions from `rate-limit.test.ts` (SQL is an implementation detail; behavior already covered). Replaced `let`/`beforeEach` with factory functions across all affected files including `cleanupTrigger.test.ts`, `handle-fallback-batch.test.ts`, `pipeline.integration.test.ts`, `cleanup-integration.test.ts`, and `services/perplexity.test.ts`. Deleted duplicate `test/queue/cleanupHelpers-timeout.test.ts` after merging any unique cases into the primary file.

**Wave 3 — Untested handlers**: Added test files for `health.ts`, `queue/dlq.ts`, `handlers/dlq.ts`, `handlers/enrichment.ts`. All mock D1/queue/analytics.

**Wave 4 — Cross-cutting**: Added `test/constants.test.ts` documenting intent and catching inadvertent constant changes.

Follow-up commit `6f32cf0` removed SQL-inspection tests that leaked through initial implementation in `audit.test.ts`, `queue/dlq.test.ts`, and `handlers/dlq.handler.test.ts`. Renamed tests from implementation language to business behavior language.

## Trade-offs

- Queue routing tests (`test/queue/routing.test.ts`) not created — `batch as MessageBatch<T>` casts are Cloudflare infrastructure-level; meaningful tests require full Workers integration.
- Admin response re-parsing tests (`test/handlers/admin-analytics.test.ts`) not created — internal response parsing is covered by `index.spec.ts` integration tests.
- `test/services/perplexity.test.ts` extended significantly (146 lines) beyond plan scope — brought Perplexity coverage in line with other modules.
- Final count: 748 tests across 30 files (after both commits).
