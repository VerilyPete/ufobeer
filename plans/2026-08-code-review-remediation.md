# Backend Code Review — Remediation Plan (v3)

Source: full-codebase review of `~/claude/ufobeer` (2026-08-28), followed by two
review rounds: an adversarial self-review and an independent agent review.
Baseline at plan time: `npm run typecheck` + `typecheck:test` clean,
955 tests / 44 files green (re-verified independently).
Implementation branch: `remediation/code-review-2026-08`.

Document layout:

- **Part 1** — the plan as originally proposed (v1)
- **Part 2** — adversarial review round (attack-by-attack, verdicts)
- **Part 3** — independent agent review round (verification + new findings)
- **Part 4** — final executable plan (v3)

---

## Part 1 — Plan v1

### WS1 — Fix enrichment quota off-by-one (bug)

Extract the reservation SQL from `src/queue/enrichment.ts:109-120` into
`reserveEnrichmentSlot(db, date, dailyLimit)` in `src/db/quota.ts`; change
`(request_count <= ?)` to `(request_count < ?)` in the `RETURNING` clause.
Add a real-D1 boundary test by extending `vitest.config.mts` to always inject
the real `./migrations` as a binding.

### WS2 — Fix DLQ replay misrouting cleanup messages (bug)

Add `CleanupMessageSchema`; branch `handleDlqReplay` on `source_queue`
(enrichment rows → `ENRICHMENT_QUEUE`, cleanup rows → `CLEANUP_QUEUE`);
replace hardcoded `queued_to` with per-queue counts.

### WS3 — Timeouts on outbound fetches

`UPSTREAM_TAPLIST_TIMEOUT_MS = 10_000`, `PERPLEXITY_TIMEOUT_MS = 30_000`;
`AbortSignal.timeout(...)` on both Flying Saucer fetches and the Perplexity fetch.

### WS4 — Sync: mark `queued_for_cleanup_at` only after successful queue send

`queueBeersForCleanup` returns `{ queued, queuedIds }`; timestamps marked only
for sent IDs.

### WS5 — Stop queue churn from `not_found` beers

`categorizeBeer` returns `unchanged` when `abv IS NULL` and status is
`not_found`/`skipped`; queue only for `pending`/null.

### WS6 — Minor fixes bundle

CORS `X-Admin-Secret`; fail-closed `validateApiKey` on unset `API_KEY`;
confidence constants; doc-comment fix; additive `/beers/batch` truncation
fields; NaN-guard DLQ limit; remove dead `createResponder`; atomic cron gate;
`/health` exposure recorded as contract-pinned intentional decision.

### WS7 — Deduplication refactor (behavior-preserving, last)

Extract shared taplist core and shared pending→blocklist→queue logic.

### Verification (v1)

Full suite + contract tests via a symlink
`ln -s /Users/pete/BeerSelector /Users/pete/claude/BeerSelector`.

---

## Part 2 — Adversarial review round

| # | Attack | Verdict | Outcome |
|---|---|---|---|
| A1 | Is `<` the correct boundary condition? | **CAUGHT** | No: RETURNING sees the post-update count, so at pre=limit−1 the increment lands exactly on limit and `<` wrongly rejects the limit-th call — the "fix" caps daily quota at limit−1. Adopt the `reserveCleanupQuotaBatch` pattern (read pre-count → atomic conditional UPDATE → `reserved = post > pre`). (R1) |
| A2 | Is "always inject real migrations" config-safe? | **HARDENED** | New binding name, golden branch untouched, suite green before adding the new test. (R4) |
| A3 | Does anything parse `queued_to`? | **HARDENED** | Make replay response additive. (R5) |
| A4 | What does a 10s client-path timeout break? | **HARDENED** | Slow-but-alive upstream + cold cache now 502s instead of hanging. Accepted, recorded. |
| A5 | WS4 signature ripples | **HARDENED** | Call sites enumerated (corrected to three by Part 3). |
| A6 | Does the status filter stop the churn that matters? | **CAUGHT** | No: DLQ'd beers keep `enrichment_status='pending'` forever and re-reserve quota + re-call Perplexity every cycle. Add 'failed' lifecycle: DLQ storage marks failed; categorize/cron/trigger skip; replay resets to pending. (R2) |
| A7 | Atomic cron claim behavior change? | **CAUGHT** | Seeding with `now+2h` skips the first run on a fresh system; seed with epoch `'0'`. (R3) |
| A8 | Fail-closed API_KEY vs test fixtures | **HARDENED** | Fix fixtures, never weaken the check. (R6) |
| A9 | Additive response fields vs golden contract | **SURVIVES** | Consumer schemas strip, don't reject. |
| A10 | WS1+R2 interaction | **SURVIVES** | No circular dependency. |
| A11 | "Zero behavior change" refactor risk | **HARDENED** | Per-caller differences (ETag timing, cleanedCount, exclude_failures) stay at call sites. (R7) |
| A12 | Sequencing/blast radius | **SURVIVES** | Order stands; each WS lands green. |

---

## Part 3 — Independent agent review round

Verified against code: baseline 955-green (re-run), R1 boundary math
(`reserveCleanupQuotaBatch` correct at all boundaries incl. limit=0 and missing
row; race caveat acceptable — only writer is the enrichment consumer and
`max_concurrency: 1`), DLQ misroute mechanism (strip-mode zod; `source_queue`
exists; `storeDlqMessage` has `beerId`), 'failed' lifecycle blast radius
(`EnrichmentStatus` union has zero importers; cron/trigger/consumer all key on
'pending'; description-change path resurrects failed beers), timeout support
(compat date 2025-01-01; mocks tolerant; TimeoutError takes default retry),
BeerSelector consumer schemas strip-mode (additive fields pass), `createResponder`
dead, `/health` decision consistent with the golden contract.

**Blocking findings (all adopted):**

1. **WS1 test bootstrap broken (high):** `migrations/` starts at 0002 and 0002
   opens with `ALTER TABLE enriched_beers` — cannot bootstrap a fresh D1.
   `schema.sql` is stale (contains columns 0002/0004 add; missing
   `enrichment_status`, `store_taplist_cache`, 0008/0009 columns). Fix:
   idempotent `0001_create_base.sql`. `test/env.d.ts` must declare the new
   binding.
2. **Verification gate impossible (blocker):** `/Users/pete/claude/BeerSelector`
   already exists as a real sibling clone containing `src/contracts/`; the
   symlink was based on a false premise. Use the existing clone; no symlink.
3. **WS2 ordering pinned:** reset status to `'pending'` BEFORE the queue send.
   Reset-after-send failure = replayed message acked-and-dropped (consumer
   skips non-pending) while DLQ row says replayed. Reset-before-send failure
   self-heals via cron.
4. **WS6 cron claim breaks two test files:** `cron-schedule.test.ts` (RETURNING
   mock; seed INSERT breaks "no write when not due") and `scheduled.test.ts`
   (sequenced DB configs). Keep early-SELECT fast path; budget rewrites.

**Strongly advised (all adopted):** `cleanupTrigger.ts` has the same
mark-before-send bug with a worse failure mode (mode=missing eligibility rides
`queued_for_cleanup_at IS NULL` → indefinite stranding) — same reorder there;
WS5b guard `AND abv IS NULL` (redelivery cannot clobber replayed+enriched
beers); WS5b permanence tradeoff documented (monitor DLQ depth); missed
constant-drift site `db/helpers.ts:438`; enumerated test-mock updates
(`dlq.test.ts:83-84`, `beers.list.test.ts:38`, `cleanupTrigger.test.ts:19,171`,
`categorizeBeer.test.ts`, `enrichment-status.test.ts:72-79`); three
`queueBeersForCleanup` call sites; WS1 helper documents the
`max_concurrency: 1` dependency.

---

## Part 4 — Final executable plan (v3)

Order: WS1 → WS2 → WS5a → WS5b → WS3 → WS4 → WS6 → WS7 → gates.
Each workstream lands typecheck-clean and suite-green.

### WS1 — Quota reservation
`reserveEnrichmentSlot` in `src/db/quota.ts` (cleanupHelpers pattern; documented
concurrency dependency); consumer updated; idempotent
`migrations/0001_create_base.sql`; `REAL_MIGRATIONS` binding in
`vitest.config.mts` + `test/env.d.ts`; `test/quota.integration.test.ts`
(first-insert→allow, limit−1→allow, at-limit→reject, never-exceeds,
limit=0 fail-closed); suite green on config change before adding the test.

### WS2 — DLQ replay routing
`CleanupMessageSchema`; `source_queue` branch; enrichment-row replay resets
status to `'pending'` BEFORE the send; additive response
(`queued_counts: {enrichment, cleanup}`, `queued_to` omitted when mixed);
tests for routing/rollback/mixed/ordering.

### WS5a — Status-aware categorization
`enrichment_status` into SELECT + `ExistingBeerRow`; `unchanged` for
abv-null beers with status ∈ {not_found, skipped, failed}; queue only
pending/null; update `categorizeBeer.test.ts`.

### WS5b — `failed` lifecycle
`storeDlqMessage` marks `enrichment_status='failed' WHERE id=? AND abv IS NULL`
(enrichment-source rows only); DLQ depth = monitoring signal; update
`dlq.test.ts` call-count assertions.

### WS3 — Timeouts
`UPSTREAM_TAPLIST_TIMEOUT_MS=10s`, `PERPLEXITY_TIMEOUT_MS=30s`;
`AbortSignal.timeout` on beers.ts:161/:339 and perplexity.ts:47.

### WS4 — Send-then-mark reorder
`queueBeersForCleanup` → `{queued, queuedIds}` (per-chunk granularity);
reorder in BOTH `handleBeerSync` and `cleanupTrigger`; tests for
send-failure → no timestamps.

### WS6 — Minors
CORS `X-Admin-Secret`; fail-closed `API_KEY`; confidence constants at THREE
sites (enrichment.ts:143, cleanup.ts:594/:727, helpers.ts:438);
doc-comment fix; `/beers/batch` `requested_count`+`truncated`; NaN-guard DLQ
limit; remove `createResponder`; cron gate = early-SELECT fast path +
epoch-'0' seed + conditional `UPDATE...RETURNING` (rewrite
`cron-schedule.test.ts` / `scheduled.test.ts` mocks); `/health` decision
comment.

### WS7 — Dedup refactor (last)
Parameterized taplist core; shared pending→blocklist→queue helper; per-caller
differences stay at call sites; zero behavior change.

### Gates
Per-WS `npm run typecheck && npm run typecheck:test` + targeted tests;
final `npx vitest run` (955 + new); contract from `~/claude/ufobeer`:
`npm run typecheck:contract && npm run test:contract`.

Explicit non-changes: `/health` public quota fields (contract-pinned);
replayed-message staleness; WS4 crash-window duplicate cleanups (benign);
no commits unless requested.
