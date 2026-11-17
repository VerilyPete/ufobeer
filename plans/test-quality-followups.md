# Plan: Finish the test-quality audit

## Goal

Every rule the audit found guarded only by tests that echo a fake gains a real guard, and those tests are then deleted, so that no remaining test can pass while the code it names is broken.

## Background

On 2026-11-13, four reviewers scored the suite against Dave Farley's eight properties. They also broke about 30 production lines, one at a time, to see which tests failed. Database-backed tests scored 8–9 out of 10. Every change that survived was guarded only by tests that ran against a fake D1 or fake collaborator, or that restated a constant.

PR #84 (merged as `479cf99`) added real-D1 guards for:

| Area | Test |
|---|---|
| Cleanup hash write | `test/queue/cleanup-consumer.integration.test.ts:117–138` |
| `/admin/*` gate | `test/handlers/admin-auth.integration.test.ts` |
| Cron claim | `test/handlers/cron-schedule.integration.test.ts` |
| DLQ acknowledge and retention | `test/handlers/dlq-housekeeping.integration.test.ts` |
| Batch ID filtering | `test/handlers/beers.enrichmentSource.integration.test.ts:205–210` |
| Taplist cache | `test/db/cache.integration.test.ts` |
| Rate limiting | `test/rate-limit.integration.test.ts` |

This plan covers the rest. Line numbers are for `main` at `479cf99`.

## Ground rules

- **Evidence is a mutant, not a red test.** The behaviour already exists, so these steps follow the `refactoring` and `mutation-testing` skills, not test-first. Each new guard names the production line it protects. The step records that breaking that line makes the new test fail, then restores it.
- **A mutant that can't change behaviour is recorded as equivalent, not chased.** For example, removing a cap that request validation already enforces.
- **Map before deleting.** A deletion step starts by adding its rows to the replacement map (appendix):
  - the exact title of each old test;
  - what it protects;
  - the test that replaces it, or "keep" or "move";
  - the mutant that shows the replacement guards it.

  The step deletes only rows whose mutant fails without the old test. Three other outcomes are allowed, each recorded with a reason:
  - **not a contract**: what the test asserted isn't a promise the code makes;
  - **removed with an unused production feature** (step 16b);
  - **compiler guard**: the protection is a type check, recorded with the command and the type change that breaks it.
- **Using a fake isn't enough reason to delete a test.** Tests that check a real change to the data or an error branch are kept or moved, even when a fake supplies the input. Examples: audit status and outcome merging, target-ID truncation, health remaining-count flooring and query-failure handling, rate-limit null-count fallback, cleanup-trigger dry-run, cooldown and validation, and the cleanup producer-to-consumer seam and duplicate delivery.
- **Production changes.** Only step 16b removes production code: the unused `isValidStoreId` strict mode and `KNOWN_STORE_IDS`. Nothing else extracts, renames or adds production code.
- **Where tests run.** A new test that imports `cloudflare:test` is named `*.integration.test.ts`. A kept non-integration file must still run in Node under `vitest.unit.config.mts`.
- **Time is fixed.** Every new test that depends on time uses `vi.useFakeTimers({ toFake: ['Date'] })`, restored in `afterEach`. Backoff tests also fake `setTimeout`.
- **Commit gate.** Each step is one commit. Before committing, run:
  - `npm run test -- --run`
  - `npm run test:unit -- --run`
  - `npm run typecheck`
  - `npm run typecheck:test`
  - `npm run typecheck:contract` and `npm run test:contract`, with `BeerSelector` checked out next to this repo

  Steps group into four PRs, one per phase.

## Acceptance criteria

- [ ] Each mutant in the table fails at least one test, or is recorded as equivalent with a reason.
- [ ] No test asserts only a value the test supplied to a fake, or restates a constant's literal.
- [ ] The replacement map accounts for every deleted test.
- [ ] No test's result depends on an unfixed clock edge: minute, UTC day, month start, or a time limit. Harmless uses of `Date.now()`, such as a seed timestamp far from any edge, are listed in the appendix rather than changed.
- [ ] The commit gate passes at every step.

| # | Mutant (production line broken) | Guarded by step |
|---|---|---|
| M1 | `hashDescription` takes a different 16-byte slice (`src/utils/hash.ts:37`) | 1 |
| M2 | `buildCombinedEtag` changes separator or input order (`src/utils/hash.ts:72`) | 1 |
| M3 | Two blob or double slots swapped in any of the 9 trackers (`src/analytics.ts`). A swap is equivalent only if the two slots are equal for *every* valid input, for example `trackCron`'s empty blobs. Equal in one fixture doesn't count | 2 |
| M4 | A queue consumer's `max_retries` or `dead_letter_queue` changes, or a consumer is removed (`wrangler.jsonc:38–77`) | 3 |
| M5 | Audit `INSERT` column list reordered (`src/audit.ts:63–75`) | 4 |
| M6 | `getEnrichmentForBeerIds` stops chunking, or chunks above `D1_MAX_PARAMS_PER_STATEMENT` (`src/db/helpers.ts:70–90`) | 5 |
| M7 | `handleDlqStats` swaps or drops a status count, or the list cursor ignores the `id` tie-breaker (`src/handlers/dlq.ts:95–103, 203–277`) | 6 |
| M8 | Health daily quota query binds the month start (`src/handlers/health.ts:55–63`) | 8 |
| M9a | Enrichment trigger clamp `100 → 1` (`src/handlers/enrichment.ts:209`), and separately `:292`'s `100 → 1`. Removing `:292`'s cap is equivalent, because the schema rejects anything above 100 (`src/schemas/request.ts:81–85`) | 9b |
| M9b | Enrichment trigger ignores daily remaining, or monthly remaining (`:292`) | 9b |
| M10 | Cleanup trigger `MAX_LIMIT` clamp removed (`src/handlers/cleanupTrigger.ts:287`) | 9a |
| M11 | Perplexity 429 retried without `delaySeconds: 120` (`src/queue/enrichment.ts:165–168`) | 18 |
| M12 | Cleanup batch retry backoff set to 0 ms (`src/queue/cleanupHelpers.ts:38`) | 18 |
| M13 | `sendCleanupAndMark` marks before sending, or marks rows whose send failed (`src/queue/helpers.ts:206–209`) | 14 |
| M14 | `/beers` accepts an invalid store ID (`src/handlers/beers.ts:476–482`) | 12 |
| M15 | Enrichment consumer ignores a refused quota reservation (`src/queue/enrichment.ts:110–114`) | 11 |
| M16 | Perplexity result write binds `abv + 1` (`src/queue/enrichment.ts:133`) | 11 |

## Phase A: pin values that are contracts (PR 1)

### Step 1: Pin known outputs for `hashDescription` and `buildCombinedEtag`

**Test**: In `test/utils/hash.test.ts`, add fixed inputs and their exact expected strings, including non-ASCII text. Compute each expected value once from today's code. These hashes are stored in D1 and sent as ETags, so a change is a breaking change.
- `buildCombinedEtag`: one case with an enrichment hash, one with null, and one with the negotiated-source variant.

**Delete**: the "same input gives the same output" tests, which the fixed values make redundant. Add them to the replacement map.
**Done when**: M1 and M2 fail.

### Step 2: Whole-row assertions that separate every analytics slot

**Test**: In `test/analytics.test.ts`, give each of the 9 `track*` functions the fewest fully populated inputs needed to make every slot that can differ actually differ. Assert the complete `writeDataPoint` argument for each with `toEqual`.
- Use distinct sentinel values for every field the input controls, avoiding 0 and 1 for numbers.
- Fix the clock; the cron index uses the time (`src/analytics.ts:228,243`).
- Trackers that derive a double from success use both a successful and a failed input: `trackCron`, `trackAdminDlq`, `trackDlqConsumer` and `trackAdminTrigger` (`src/analytics.ts:254–262, 349–357, 383–391, 478–486`). A single input leaves a constant 0 or 1 slot equal to the derived one.
- The request and enrichment trackers get enough status and source combinations to tell their boolean slots apart.
- `trackUsageIngest` currently has no describe block; add one.
**Keep**: the default/omitted-field cases and the derived-field cases (status category, error type, precedence). One populated input can't cover them.
**Delete**: the per-slot pass-through tests and the `toBeDefined` shape tests that the whole-row checks replace, as listed in the map.
**Done when**: every distinguishable M3 swap fails, and any equivalent swaps are listed.

**Result (step 2)**: 470 pairwise swaps across all 9 trackers. All 395 swaps of differing expressions fail a test. The other 75 swap two identical literals (`''`, `0`, `1`, or a repeated name such as `'cron'`), so they are equivalent for every input.

### Step 3: Read the queue settings from `wrangler.jsonc` instead of restating them

**Mechanism**:
- Add a Node-side helper, `test/support/queueConsumers.mts`, that reads `wrangler.jsonc` with wrangler's `unstable_readConfig` and returns `{ queue, max_retries, dead_letter_queue }` for each consumer.
- Both `vitest.config.mts` and `vitest.unit.config.mts` pass that result in through `test.provide`.
- Declare its type for `inject` in `test/env.d.ts`.
- The test reads it with `inject('queueConsumers')`, so the same file runs in both runners.

**Test**: New `test/queue-config.test.ts` asserts the complete set of four consumers, in names, retry counts and exactly two DLQ destinations, against what the code assumes. For example, `MAX_DLQ_CONSUMER_ATTEMPTS` must match the DLQ consumers' `max_retries`. Assert the whole set with `toEqual`, so a missing consumer can't pass by producing an empty loop.
**Delete**: `test/constants.test.ts:102–108`, which claims to check `wrangler.jsonc` but never reads it.
**Done when**: M4 fails when you edit `wrangler.jsonc` and start a fresh Vitest run under both runners. A watch-mode rerun doesn't reload the config. If `unstable_readConfig` breaks after a wrangler upgrade, fall back to `experimental_readRawConfig`.

## Phase B: real-D1 guards, then delete the fakes they replace (PR 2)

### Step 4: Audit log rows against real D1

**Test**: New `test/audit.integration.test.ts`:
- `writeAuditLog` and `writeAdminAuditLog` write rows that read back column for column. Use distinct, non-null values for every field, including the optional ones.
- `reapOldAuditLog` deletes only rows past `AUDIT_RETENTION_DAYS`, under a fixed clock.

**Delete**: only the tests in `test/audit.test.ts` that check bind *positions*, as listed in the map. Keep the default and custom status, outcome-merging and target-ID truncation tests (`test/audit.test.ts:267–342`) unless the real-D1 file covers each one with its own mutant.
**Done when**: M5 fails in the new file.

### Step 5: Chunked enrichment lookup against real D1

**Test**: New `test/db/enrichmentLookup.integration.test.ts`:
- Wrap the real D1 binding in a forwarding database that records the number of bound parameters for each statement passed to `batch`, then runs those statements on real D1.
- Seed 181 beers plus one beer that isn't requested. Request the 181 IDs plus two unknown IDs.
- Assert the recorded parameter counts are `[90, 90, 3]`.
- Assert the returned keys are exactly the 181 requested beers that exist, with representative column values checked.

**Move**: the basic lookup case (`test/pipeline.integration.test.ts:177–213`) is replaced by the new real-D1 lookup test; give it a map row. Move the empty-input and batch-failure cases (`test/pipeline.integration.test.ts:215–218, 295–309`) into an honestly named unit file, `test/db/enrichmentLookup.test.ts`. Move any `extractABV` cases into `test/db/extractABV.test.ts`.
**Delete**: the remaining chunking test, the unused mocks, `createTestBeer` and the unused SELECT branch. Delete `test/pipeline.integration.test.ts` once it is empty.
**Done when**: M6 fails in both forms, and the map accounts for the old file.

### Step 6: DLQ stats and list against real D1

**Test**: Add to `test/handlers/dlq-housekeeping.integration.test.ts`. Do not add any new statistics.
- `handleDlqStats` returns what the endpoint really produces (`src/handlers/dlq.ts:203–277`):
  - a different positive count for each of the four statuses, including `replaying`;
  - zero for absent statuses, checked separately with a second set of rows that omits one or all statuses (`:265–268`);
  - the age of the oldest pending entry, under a fixed clock;
  - the top failing brewers;
  - repeat failures;
  - recent activity.
- The list filters by status and pages through entries that share a `failed_at`, so the `id` tie-breaker in the `(failed_at, id)` cursor decides the order. Assert there are no duplicates or gaps across pages, and that `has_more` is right.

**Delete**: the tests in `test/handlers/dlq.handler.test.ts` that #84 and this step cover, as listed in the map: the acknowledge echo tests, the SQL-substring tests, `typeof has_more`, and the `cleanupOldDlqMessages` substring and count tests. Keep the request-validation 400 tests.
**Done when**: M7 fails, and #84's acknowledge and retention mutants still fail without the deleted tests.

### Step 7: DLQ consumer storage against real D1

**Test**: New `test/queue/dlq-storage.integration.test.ts`:
- `storeDlqMessage` persists a complete row with a distinct value in every field.
- It also persists a row with optional fields absent, and one with them as empty strings; the old fixtures use empty strings (`test/queue/dlq.test.ts:213,228`).
- A second delivery of the same message updates only failed time, attempt count, raw body and status (`src/queue/dlq.ts:177–181`), not adding a row and leaving identifying fields unchanged.
- The parking guard still works.

**Delete**: the `toContain` bind-argument tests in `test/queue/dlq.test.ts:113–238`, including `toContain(null)`, and their duplicates, as listed in the map. Keep the tests for the ack, retry and exhaustion decisions.
**Done when**: mutants in the upsert's column mapping and in the parking guard fail in the new file.

### Step 8: Health quota windows against real D1

**Test**: Seed `enrichment_limits` rows with *different* counts for today, earlier this month and last month. Fix the clock mid-month; on the 1st of the month, today and the month start are the same day. Assert the daily and monthly figures returned by `/health`.
**Delete**: only the fake-DB quota-window tests in `test/handlers/health.test.ts`, as listed in the map, plus `handleLiveness.length`. Keep the remaining-count flooring, configuration-default and query-failure tests (`:184–215, :253–275`).
**Done when**: M8 fails.

### Step 9a: Cleanup trigger clamp against real D1

**Test**: In `test/handlers/cleanupTrigger.integration.test.ts`, seed 501 eligible rows and clear the cooldown. A run in `missing` mode with `limit: 1000` sends exactly 500 messages.
**Delete**: the tests in `test/handlers/cleanupTrigger.test.ts` that only exercised its fake, which picks rows by matching text in the SQL, as listed in the map. Keep or move the dry-run, cooldown, confirm-gate and validation tests (`:398–531`), and fix their leaked `queueBeersForCleanup` implementation with a per-test reset.
**Done when**: M10 fails.

### Step 9b: Enrichment trigger batch size against real D1

**Test**: New `test/handlers/enrichment-trigger.integration.test.ts`, with at least 101 eligible rows. Assert the number of messages sent:

| Case | Request limit | Daily remaining | Monthly remaining | Expected sent |
|---|---|---|---|---|
| Limit is the cap | 7 | 50 | 60 | 7 |
| Daily is the cap | 100 | 3 | 60 | 3 |
| Monthly is the cap | 100 | 50 | 4 | 4 |
| 100 is the cap | 100 | 150 | 200 | 100 |

Set each remaining figure by choosing the configured limit and the seeded `enrichment_limits` count. The request limit can't be more than 100.

Also assert that `limit: 101` returns 400.

**Delete**: from `test/handlers/enrichment.handler.test.ts`, the `prepare.calls.length >= 3`, `beers_queued > 0` and `enabled === true` tests (`:181, :268–291, :318`).
**Done when**: M9a's `100 → 1` mutants and both M9b mutants fail. The removal of `:292`'s cap is recorded as equivalent.

### Step 10: Cron unit tests

**Delete**: the claim test in `test/handlers/cron-schedule.test.ts` that only returns what its fake was told to. #84's real-D1 claim test covers it.
**Fix**:
- Rename the jitter tests that say 4h, 3h40m and 4h20m to match the 2-hour interval.
- Fix the clock for the real-time tests at `:113–139`.
- In `test/handlers/scheduled.test.ts:513`, compute the 90-day cutoff in UTC under a fixed clock, as production does.

### Step 11: Enrichment consumer quota and write against real D1

**Test**: Add to `test/queue/enrichment-exa.integration.test.ts` or a new real-D1 file. Run `handleEnrichmentBatch` with the daily quota at the limit, and again one below it. Assert:
- whether Perplexity is called;
- ack or retry;
- the stored counters;
- the stored ABV, source and confidence.

**Delete**: `test/queue/enrichment-status.test.ts`, once the map shows each of its tests replaced, including the boundary cases at `:155–170` and `:231–247`. Its stale-write warning case (`:183–225`) also needs a real-D1 replacement, or a move, before the file goes.
**Keep**: in `test/queue/cleanup-stale-binding.test.ts`, the duplicate-delivery, missing-hash, producer-to-consumer seam and stale-result logging tests (`:143–175, :210–232, :271–351`). Move each to real D1 where practical, or keep it as a focused unit test. Delete only the tests where the fake checks the hash itself.
**Done when**: M15 and M16 fail without `enrichment-status.test.ts`, and the stale-hash mutant from #84 still fails.

### Step 12: `/beers` list tests that check only a fake's answer

**Test**: In `test/handlers/beers.enrichmentSource.integration.test.ts`, add a router request with valid auth, an invalid non-empty `sid` and a stubbed upstream. Expect 400 with `INVALID_STORE_ID` (M14). The real 304 paths (live, cache hit and stale) already live in that file at `:116–159`; don't add them again.
**Delete**: the following, with each title in the map:
- tests that mock `checkConditionalRequest` and assert its answer (for example `:2320`, `:2496`);
- tests that assert `"mock-combined-etag"`;
- tests that assert call arguments to `buildCombinedEtag`, `shouldUpdateContent` or `getEnrichmentForBeerIds`;
- tests that assert `waitUntil` call counts;
- tests that only pass `insertPlaceholders` through.

**Fix**:
- `:1189` should assert the custom headers themselves.
- `:977–980` should await a deferred promise, not a 100 ms limit.
- `:1169` (`upstreamLatencyMs >= 0`) doesn't check the latency value. Start the clock at T, hold the upstream fetch on a deferred promise, set the clock to T+37 ms, release the fetch, and require a latency of exactly 37. Replacing the latency calculation with a literal 0 must fail this test.
- Remove the per-test `vi.clearAllMocks()` calls that repeat what `beforeEach` already does.

**Done when**: M14 fails, and the mutants recorded in the map for the deleted tests still fail.

### Step 13: Rate-limit unit tests that do arithmetic on a fake's count

**Delete**: as listed in the map, the tests in `test/rate-limit.test.ts` whose outcome follows from the count the fake returned, and the `prepare`-called-once tests. #84's `test/rate-limit.integration.test.ts` covers them.
**Keep**: the key-building tests (`getEndpointRateLimitKey` and the like), and the null or missing returned-count fallback tests (`:223–240`). #84 doesn't cover those.
**Done when**: #84's five rate-limit mutants still fail.

### Step 14: Send-then-mark ordering in `sendCleanupAndMark`

**Test**: First run both forms of M13 against the existing retry test (`test/handlers/beers.sync.description.integration.test.ts:268–281`):
- the mark moved before the send;
- rows marked even when their send failed.

For any form that survives, add a real-D1 test. Hold the send open on a deferred promise, check in D1 that `queued_for_cleanup_at` is still unset, then let the send succeed and check it is set.
If the "marked despite a failed send" form survives, add a real-D1 test where the send rejects or partly fails, and check which rows were marked.
**Done when**: both forms of M13 fail. Nothing is deleted.

## Phase C: delete tests that only restate a value (PR 3)

### Step 15: Constants used by behaviour (one commit per group)

**Inventory first**: before writing any test, add a row to the map for each constant in `test/constants.test.ts:40–132` and `:240–251`. Each row gives:
- the code that uses the constant;
- the contract it represents;
- the existing or new test;
- a mutation that raises the value and one that lowers it, or "not a contract" with the reason.

Existing coverage only counts if it fails for both mutations. For example, `MAX_BEER_ABV` is checked at 70 (accepted) and 75 (rejected) (`test/services/perplexity.test.ts:242–264`). That misses a change to 71, so add 70.1 (rejected).

**Commits**: one per related group:
- 15a: ABV and confidence values
- 15b: audit and rate-limit reaping
- 15c: payload and upstream size limits, including Perplexity
- 15d: D1 batching limits
- 15e: usage history and drop counters, which `test/db/usage-report.integration.test.ts:86–99` largely covers already

Each commit adds the group's boundary tests, then deletes that group's `expect(CONST).toBe(literal)` tests.
**Keep**: the fixtures that derive worst-case sizes, at `:134–238`.

### Step 16a: Type-check and helper tests that echo their input

**Delete**:
- the `toHaveProperty` block in `test/type-checks/interface-to-type.test.ts:38–70`. Keep the readonly `@ts-expect-error` checks (`:79–101`).
- the `asTypedRows` tests that echo their input (`test/db/helpers-typed.test.ts:20, :42`). Keep the null and undefined cases.

### Step 16b: Remove unused store-ID strict mode

**Change**: remove the `strictMode` parameter and `KNOWN_STORE_IDS` from `src/validation/storeId.ts`, and their tests (`test/validation/storeId.test.ts:23–34`).
**Evidence**: the only production caller is `isValidStoreId(storeId)` at `src/handlers/beers.ts:476`, which is not strict. Outside its own validator and tests, nothing reads `KNOWN_STORE_IDS`. Typecheck passes. This is the one production change in the plan.

## Phase D: tests that depend on the clock (PR 4)

### Step 17: Fix the clock for full-route usage and reports tests

**Fix**: In `test/handlers/usage.integration.test.ts` and `test/handlers/reports.integration.test.ts`, fix the clock at the top of each suite, with `vi.useFakeTimers({ toFake: ['Date'] })` and `setSystemTime` in `beforeEach` and restore in `afterEach`:
- mid-minute for the tests that send several requests against a rate limit (`reports:199–205` sends 61; `usage:395–407` sends 7; `usage:420–426` sends 30 posts and then a batch request);
- midday UTC for the default-range and `getToday()` tests (`reports:98–103`).

Then list in the appendix every other test that seeds data from `Date.now()`, for example `beers.enrichmentSource.integration:42,49` and `beers.list:1201`, and say for each whether it's harmless or fix it.
**Done when**: each file passes with the fixed time set to 11:59:59.900 into a minute and to 23:59:59.900 UTC, both forced through `setSystemTime` in a one-off local run.

### Step 18: Restore fakes, test retry delays, and drop config-echo tests

**Test**:
- In `test/queue/enrichment-exa.integration.test.ts`, a Perplexity 429 retries with exactly `{ delaySeconds: 120 }` (M11). Today `:151–157` checks only that it retried.
- `batchUpdateWithRetry` with fake `setTimeout` (M12):
  - after one failure there's no second attempt at 99 ms, and there is one at 100 ms;
  - after two failures there's no third attempt at 299 ms, and there is one at 300 ms;
  - it returns the batch's `D1Result[]`.

**Fix**: move the `fetch` restore in `test/services/perplexity.test.ts` and the `useRealTimers` call in `test/cleanupHelpers.test.ts` into `afterEach`.
**Delete**: as listed in the map, the Perplexity request tests that only repeat a constant (temperature, model, prompt text). Keep one test of the whole request shape.
**Done when**: M11 and M12 fail.

## Out of scope

- The `last_seen_at` throttle branch.
- Any new production behaviour, including per-queue DLQ statistics.
- The contract tests. The schema-only negative cases in `contract-test/goldenTaproom.contract.test.ts` (from `:480`) test BeerSelector's schema; flag them for the mobile repo, by test name.
- Raising Farley scores for their own sake.

## Appendix: replacement map

Filled in at the start of each deletion step, before anything is deleted.

| Step | Old test (file and exact title) | What it protects | Replaced by / keep / move | Mutant (fails without the old test) |
|---|---|---|---|---|
| 1 | `test/utils/hash.test.ts` hashDescription › returns a string of exactly 32 characters | 32-char output | fixed-value tests, `hashDescription` / `buildCombinedEtag` | M1 (`slice(1, 17)`): 7 fail |
| 1 | `test/utils/hash.test.ts` hashDescription › returns only lowercase hex characters [0-9a-f] | hex encoding | fixed-value tests, `hashDescription` / `buildCombinedEtag` | M1 |
| 1 | `test/utils/hash.test.ts` hashDescription › returns a deterministic result for the same input | determinism | fixed values imply it | not a contract beyond the fixed values |
| 1 | `test/utils/hash.test.ts` hashDescription › returns different hashes for different inputs | distinct inputs differ | fixed values for three inputs | M1 |
| 1 | `test/utils/hash.test.ts` hashDescription › handles an empty string input without throwing | empty input | fixed value for `''` | M1 |
| 1 | `test/utils/hash.test.ts` hashDescription › handles a very long string (10,000+ characters) without throwing | long input | not a contract: SHA-256 has no length branch | not a contract |
| 1 | `test/utils/hash.test.ts` hashDescription › returns 32 characters regardless of input length | fixed length | fixed values | M1 |
| 1 | `test/utils/hash.test.ts` hashDescription › produces different hashes for strings that differ by one character | sensitivity | not a contract: property of SHA-256 | not a contract |
| 1 | `test/utils/hash.test.ts` generateETag › produces a quoted 32-char hex output | ETag format | `generateETag` › quotes the description hash of the body | M1 |
| 1 | `test/utils/hash.test.ts` generateETag › produces different outputs for different inputs | distinct inputs differ | same | M1 |
| 1 | `test/utils/hash.test.ts` generateETag › output is always wrapped in double quotes | quoting | same | removing quotes fails it |
| 1 | `test/utils/hash.test.ts` generateETag › handles empty string and returns valid format | empty input | fixed value for `''` (shared hash) | M1 |
| 1 | `test/utils/hash.test.ts` generateETag › wraps the same hash that hashDescription produces | ETag = quoted hash | same | M1 |
| 1 | `test/utils/hash.test.ts` buildCombinedEtag › changes with the content hash when enrichment hash is null | content hash is an input | fixed value, null enrichment | M2 (order): 3 fail |
| 1 | `test/utils/hash.test.ts` buildCombinedEtag › returns a quoted hash when enrichment hash is null | format | fixed value, null enrichment | M2 |
| 1 | `test/utils/hash.test.ts` buildCombinedEtag › returns combined hash (quoted) when both hashes are present | format | fixed value, both hashes | M2 (separator): 3 fail |
| 1 | `test/utils/hash.test.ts` buildCombinedEtag › combined hash differs from content hash alone | enrichment hash is an input | fixed values, both and null | M2 |
| 1 | `test/utils/hash.test.ts` buildCombinedEtag › output is valid ETag format (matches "..." pattern) | quoting | fixed values | M2 |
| 1 | `test/utils/hash.test.ts` buildCombinedEtag › is deterministic for same inputs | determinism | fixed values imply it | not a contract beyond the fixed values |
| 1 | `test/utils/hash.test.ts` buildCombinedEtag › stops matching ETags issued before the current taplist format | format-version bump invalidates old ETags | keep | — |
| 2 | `test/analytics.test.ts` trackRequest › calls writeDataPoint once with the correct shape | not a contract: `toBeDefined` shape check | the full data point each tracker writes › trackRequest | not a contract |
| 2 | `test/analytics.test.ts` trackRequest › sets double6 (error_count) to 0 for status 200 | slot layout | the full data point each tracker writes › trackRequest | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackRequest › sets double7 (rate_limit_triggered) to 1 for status 429 | slot layout | the full data point each tracker writes › trackRequest | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackRequest › sets double7 (rate_limit_triggered) to 0 for status 200 | slot layout | the full data point each tracker writes › trackRequest | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackRequest › sets double3 (beers_returned) to the beersReturned value when provided | slot layout | the full data point each tracker writes › trackRequest | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackRequest › sets blob9 to cacheOutcome value when provided | slot layout | the full data point each tracker writes › trackRequest | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackRequest › tracks all four cache outcomes in blob9 | slot layout | the full data point each tracker writes › trackRequest | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackRequest › sets indexes[0] to "${clientId}:${endpoint}" | slot layout | the full data point each tracker writes › trackRequest | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackEnrichment › calls writeDataPoint once with correct shape | not a contract: `toBeDefined` shape check | the full data point each tracker writes › trackEnrichment | not a contract |
| 2 | `test/analytics.test.ts` trackEnrichment › sets blob4 to "2xx" when success is true | slot layout | the full data point each tracker writes › trackEnrichment | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackEnrichment › sets blob4 to "5xx" when success is false | slot layout | the full data point each tracker writes › trackEnrichment | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackEnrichment › sets blob5 to "success" when success is true | slot layout | the full data point each tracker writes › trackEnrichment | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackEnrichment › sets blob5 to "enrichment_fail" when success is false | slot layout | the full data point each tracker writes › trackEnrichment | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackEnrichment › sets blob8 (enrichment_source) to "perplexity" when source is "perplexity" | slot layout | the full data point each tracker writes › trackEnrichment | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackEnrichment › sets blob8 (enrichment_source) to "cache" when source is "cache" | slot layout | the full data point each tracker writes › trackEnrichment | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackEnrichment › sets double5 (cache_hit) to 1 when source is "cache" | slot layout | the full data point each tracker writes › trackEnrichment | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackEnrichment › sets double5 (cache_hit) to 0 when source is "perplexity" | slot layout | the full data point each tracker writes › trackEnrichment | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackEnrichment › sets double6 (error_count) to 0 when success is true | slot layout | the full data point each tracker writes › trackEnrichment | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackEnrichment › sets double6 (error_count) to 1 when success is false | slot layout | the full data point each tracker writes › trackEnrichment | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackEnrichment › sets indexes[0] to "enrichment:perplexity" for perplexity source | slot layout | the full data point each tracker writes › trackEnrichment | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackEnrichment › sets indexes[0] to "enrichment:cache" for cache source | slot layout | the full data point each tracker writes › trackEnrichment | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackCron › calls writeDataPoint once with correct shape | not a contract: `toBeDefined` shape check | the full data point each tracker writes › trackCron | not a contract |
| 2 | `test/analytics.test.ts` trackCron › sets double9 (daily_remaining) to the dailyRemaining value | slot layout | the full data point each tracker writes › trackCron | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackCron › sets double10 (monthly_remaining) to the monthlyRemaining value | slot layout | the full data point each tracker writes › trackCron | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackCron › sets double4 (beers_queued) to the beersQueued value | slot layout | the full data point each tracker writes › trackCron | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackCron › sets indexes[0] starting with "cron:" | slot layout | the full data point each tracker writes › trackCron | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackRateLimit › calls writeDataPoint once | not a contract: `toBeDefined` shape check | the full data point each tracker writes › trackRateLimit | not a contract |
| 2 | `test/analytics.test.ts` trackRateLimit › sets blob5 to "rate_limit" | slot layout | the full data point each tracker writes › trackRateLimit | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackRateLimit › sets blob4 to "4xx" | slot layout | the full data point each tracker writes › trackRateLimit | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackRateLimit › sets double7 (rate_limit_triggered) to 1 | slot layout | the full data point each tracker writes › trackRateLimit | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackRateLimit › sets double6 (error_count) to 1 | slot layout | the full data point each tracker writes › trackRateLimit | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackRateLimit › sets indexes[0] to "ratelimit:${clientId}" | slot layout | the full data point each tracker writes › trackRateLimit | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackRateLimit › sets blob1 (endpoint) to the provided endpoint string | slot layout | the full data point each tracker writes › trackRateLimit | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackAdminDlq › sets blob4 to "2xx" when success is true | slot layout | the full data point each tracker writes › trackAdminDlq | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackAdminDlq › sets blob4 to "5xx" when success is false | slot layout | the full data point each tracker writes › trackAdminDlq | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackAdminDlq › sets double4 (message_count) to the messageCount value | slot layout | the full data point each tracker writes › trackAdminDlq | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackAdminDlq › sets indexes[0] to "admin:${operation}" | slot layout | the full data point each tracker writes › trackAdminDlq | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackDlqConsumer › sets blob4 to "2xx" when success is true | slot layout | the full data point each tracker writes › trackDlqConsumer | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackDlqConsumer › sets blob4 to "5xx" when success is false | slot layout | the full data point each tracker writes › trackDlqConsumer | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackDlqConsumer › sets double4 (attempt count) to the attempts value | slot layout | the full data point each tracker writes › trackDlqConsumer | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackDlqConsumer › sets indexes[0] to "dlq_consumer:${sourceQueue}" | slot layout | the full data point each tracker writes › trackDlqConsumer | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackAdminTrigger › sets double9 to the dailyRemaining value | slot layout | the full data point each tracker writes › trackAdminTrigger | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackAdminTrigger › sets double10 to the monthlyRemaining value | slot layout | the full data point each tracker writes › trackAdminTrigger | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackAdminTrigger › sets double4 to the beersQueued value | slot layout | the full data point each tracker writes › trackAdminTrigger | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackAdminTrigger › sets indexes[0] to "admin:enrich_trigger" | slot layout | the full data point each tracker writes › trackAdminTrigger | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackCleanupTrigger › sets blob1 to the action value | slot layout | the full data point each tracker writes › trackCleanupTrigger | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackCleanupTrigger › sets blob2 to the mode value | slot layout | the full data point each tracker writes › trackCleanupTrigger | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackCleanupTrigger › sets double1 to the beersQueued value | slot layout | the full data point each tracker writes › trackCleanupTrigger | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackCleanupTrigger › sets double2 to 0 (reserved, formerly beers_skipped) | slot layout | the full data point each tracker writes › trackCleanupTrigger | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackCleanupTrigger › sets double3 to the beersReset value | slot layout | the full data point each tracker writes › trackCleanupTrigger | M3 swap of that slot (sweep below) |
| 2 | `test/analytics.test.ts` trackCleanupTrigger › sets double4 to the durationMs value | slot layout | the full data point each tracker writes › trackCleanupTrigger | M3 swap of that slot (sweep below) |

## Appendix: harmless uses of the real clock

Filled in at step 17.
