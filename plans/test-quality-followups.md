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

**Review fix (step 2)**: Codex found that one input per tracker let a pass-through slot be replaced by the fixture's own value (for example the DLQ consumer index hard-coded to `beer-enrichment`). Every row now uses its own value for every input, and the cron rows run at different dates. Replacing each of the 35 inputs with the first row's value fails a test.

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

**Result (step 4)**: 16 mutants in `src/audit.ts`, each run against `test/audit.integration.test.ts` alone in a fresh run; all killed. Request insert: column swaps `client_ip, user_agent` (M5) and `method, path` (M5), `error || ''`, response time 0, status fixed at 200, `.run()` removed. Admin insert: column swap `client_ip, user_agent` (M5), `'ADMIN'` → `'GET'`, operation → `'admin'`, admin hash → `ctx.apiKeyHash`, `enrichedDetails` → `details`, response time 0, `options?.statusCode ?? 200` → `200`. Reaper: `<` → `<=`, retention days + 1, limit + 1. No equivalents. 15 tests deleted from `test/audit.test.ts`; the error-branch and options-merging tests are kept.

### Step 5: Chunked enrichment lookup against real D1

**Test**: New `test/db/enrichmentLookup.integration.test.ts`:
- Wrap the real D1 binding in a forwarding database that records the number of bound parameters for each statement passed to `batch`, then runs those statements on real D1.
- Seed 181 beers plus one beer that isn't requested. Request the 181 IDs plus two unknown IDs.
- Assert the recorded parameter counts are `[90, 90, 3]`.
- Assert the returned keys are exactly the 181 requested beers that exist, with representative column values checked.

**Move**: the basic lookup case (`test/pipeline.integration.test.ts:177–213`) is replaced by the new real-D1 lookup test; give it a map row. Move the empty-input and batch-failure cases (`test/pipeline.integration.test.ts:215–218, 295–309`) into an honestly named unit file, `test/db/enrichmentLookup.test.ts`. Move any `extractABV` cases into `test/db/extractABV.test.ts`.
**Delete**: the remaining chunking test, the unused mocks, `createTestBeer` and the unused SELECT branch. Delete `test/pipeline.integration.test.ts` once it is empty.
**Done when**: M6 fails in both forms, and the map accounts for the old file.

**Result (step 5)**: 6 mutants, all killed, each in a fresh run. M6 no-chunk (`[[183]]`), M6 over-limit (`[[91, 91, 1]]`), last chunk dropped (`[[90, 90]]`), `source` mapped to null (Map mismatch) fail `test/db/enrichmentLookup.integration.test.ts`; removed empty-input return and rethrow in `catch` fail `test/db/enrichmentLookup.test.ts`. No equivalents. `test/pipeline.integration.test.ts` deleted (10 tests: 2 replaced, 2 moved to the unit file, 6 extractABV tests moved to `test/db/extractABV.test.ts`); its `createMockD1`, `createTestBeer`, `shouldSkipEnrichment`/`hashDescription` mocks and the unused `description_hash` SELECT branch went with it. The forwarding database is a `Proxy` over `env.DB`, following the precedent in `test/db/usage-health.integration.test.ts`; the unit file's fake is a fully typed `D1Database` (no assertion).

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

**Result (step 6)**: 41 mutants in `src/handlers/dlq.ts`, each run against `test/handlers/dlq-housekeeping.integration.test.ts` alone in a fresh run.

- Stats (M7), 18 mutants, all killed: pending ↔ replayed count swap, replaying count dropped, `|| 0` dropped, oldest pending `ASC` → `DESC`, no-pending fallback `0` → `-1`, rounding removed, top brewers without the status filter / without `brewer IS NOT NULL` / ascending, last-24h status conditions dropped (replayed, acknowledged), `>` → `>=` (replayed, failed), window 24 h → 25 h, `replayed_24h` ↔ `acknowledged_24h` swapped, repeat failures without the status filter / `>= 0` / ascending.
- List (M7), 13 mutants, all killed: `include_raw` forced on; cursor `id < ?` → `id <= ?`, → `id > ?`, tie-breaker ignored (`? IS NULL`); `id DESC` → `id ASC`; `has_more` `>` → `>=` (survived the first fixture of 10 entries, since no page ended exactly at the limit; the fixture became 9 entries with limit 3 and it now fails); default status `'all'`; `status=all` ignored; beer filter ignored; count query ignoring status; `include_raw` ignored; `replayed_at`/`acknowledged_at` swapped; default limit 50 → 49; next cursor taken from the first row instead of the last.
- #84 acknowledge and retention, after deleting the fake-D1 tests, 9 mutants: `AND status = 'pending'` removed from the acknowledge UPDATE, `failedCount = requestedCount`, each retention loop `while (false)` (killed by the new 1,001-row test), 30 → 32 days, `acknowledged_at <` → `>`, `replayed_at <` → `>`: all killed. `while (changes === batchLimit)` → `while (changes > 0)` survives and is equivalent: it adds one empty DELETE and deletes the same rows.

18 tests deleted from `test/handlers/dlq.handler.test.ts` (9 list, 5 acknowledge, 4 cleanup), plus the now-unused `getMockDlqRow`, and the unused `Mock` and `cleanupOldDlqMessages` imports. Request-validation, cursor-400 and DB-500 tests are kept.

### Step 7: DLQ consumer storage against real D1

**Test**: New `test/queue/dlq-storage.integration.test.ts`:
- `storeDlqMessage` persists a complete row with a distinct value in every field.
- It also persists a row with optional fields absent, and one with them as empty strings; the old fixtures use empty strings (`test/queue/dlq.test.ts:213,228`).
- A second delivery of the same message updates only failed time, attempt count, raw body and status (`src/queue/dlq.ts:177–181`), not adding a row and leaving identifying fields unchanged.
- The parking guard still works.

**Delete**: the `toContain` bind-argument tests in `test/queue/dlq.test.ts:113–238`, including `toContain(null)`, and their duplicates, as listed in the map. Keep the tests for the ack, retry and exhaustion decisions.
**Done when**: mutants in the upsert's column mapping and in the parking guard fail in the new file.

**Result (step 7)**: 25 mutants in `storeDlqMessage` (`src/queue/dlq.ts`), each run against `test/queue/dlq-storage.integration.test.ts` alone in a fresh run; all killed.

- Insert column mapping: `beer_name, brewer`, `message_id, beer_id`, `failed_at, failure_count` and `source_queue, raw_message` swapped; `|| ''` for beer name and for brewer; `attempts + 1`; source queue fixed to `'beer-enrichment'`; raw body `JSON.stringify(body.beerId)`; `now = 0`.
- Upsert: each of `failed_at`, `failure_count`, `raw_message` and `status = 'pending'` dropped from the update; `beer_id`, `beer_name`, `source_queue` added to it; `replay_count = 0` added to it; `DO NOTHING`.
- Parking guard: `AND abv IS NULL` dropped, `STILL_CURRENT_SQL` reduced to `id = ?`, status `'pending'` instead of `'failed'`, `updated_at` bound `now + 1`, parking disabled (`WHERE 0 AND …`), description hash ignored.

No equivalents. 11 tests deleted from `test/queue/dlq.test.ts` (the whole `storeDlqMessage` block) and the `storeDlqMessage` import. The ack, retry and exhaustion tests for both batch handlers are kept.

Deviation: the plan asks for a row "with optional fields absent". `EnrichmentMessage` declares `beerName`, `brewer` and `descriptionHash` as required, so an absent field needs a type assertion. The test covers the empty-string case (stored as NULL), which is the case the old fixtures used, plus `descriptionHash: null`.

### Step 8: Health quota windows against real D1

**Test**: Seed `enrichment_limits` rows with *different* counts for today, earlier this month and last month. Fix the clock mid-month; on the 1st of the month, today and the month start are the same day. Assert the daily and monthly figures returned by `/health`.
**Delete**: only the fake-DB quota-window tests in `test/handlers/health.test.ts`, as listed in the map, plus `handleLiveness.length`. Keep the remaining-count flooring, configuration-default and query-failure tests (`:184–215, :253–275`).
**Done when**: M8 fails.

**Result (step 8)**: 7 mutants against `src/handlers/health.ts`, all killed by the one real-D1 test in fresh runs: M8 (daily binds `monthStart`), monthly start bound to `today`, monthly lower bound removed, monthly upper bound removed, `dailyUsed = 0`, daily remaining ignores used, monthly remaining ignores used. Clock fixed at 2026-03-17T15:20Z; seeded rows 2026-02-28 (307), 03-01 (11), 03-04 (41), 03-17 (23), 04-01 (509); expected daily 23, monthly 75, limits 700/2300 so remaining 677/2225. Deleted 5 tests from `test/handlers/health.test.ts` (4 quota-window, 1 arity; the arity test is a compiler guard, checked with a `handleLiveness(env: Env)` edit and `npm run typecheck`). Kept: status/database/enabled, limit parsing, flooring, default limits, SELECT 1 failure (503 bodies), quota-query failure, header tests.

### Step 9a: Cleanup trigger clamp against real D1

**Test**: In `test/handlers/cleanupTrigger.integration.test.ts`, seed 501 eligible rows and clear the cooldown. A run in `missing` mode with `limit: 1000` sends exactly 500 messages.
**Delete**: the tests in `test/handlers/cleanupTrigger.test.ts` that only exercised its fake, which picks rows by matching text in the SQL, as listed in the map. Keep or move the dry-run, cooldown, confirm-gate and validation tests (`:398–531`), and fix their leaked `queueBeersForCleanup` implementation with a per-test reset.
**Done when**: M10 fails.

**Result (step 9a).** New `describe("cleanup trigger mode 'missing' (real D1)")` in `test/handlers/cleanupTrigger.integration.test.ts`, clock fixed at 2026-11-17T15:42:07Z: 5 tests (6 cases). Mutants run against `src/handlers/cleanupTrigger.ts` (plus `DEFAULT_LIMIT` in `src/types.ts`), one at a time, file restored after each:

- M10 (`MAX_LIMIT` clamp removed): killed, 1 test (501 sent, expected 500).
- `NEVER_CLEANED` without `brew_description_cleaned IS NULL`: killed, 2. Without `queued_for_cleanup_at IS NULL`: killed, 2.
- Dry-run `beers_reset` spread always / never: killed, 1 each. Final-response spread always: killed, 3.
- `skip_reason` changed: killed, 1. Flight names filtered before queueing: killed, 1.
- Hash computed from `brew_name`: killed, 2. Mark every prepared row, not only sent ones: killed, 1.
- `operation_id` prefix changed: killed, 6. `DEFAULT_LIMIT 500 → 1`: killed, 2.
- Confirm gate ignores `confirm`: killed, 7. Preview total forced to 0: killed, 1 (existing test).
- Equivalent: dropping `descriptionHash` from the beers handed to `queueBeersForCleanup`, because that function recomputes the same hash from the same `brew_description`.

17 unit tests deleted (1 of them moved to real D1). Kept tests now reset the `queueBeersForCleanup` mock in a `beforeEach`.

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

**Result (step 9b).** New `test/handlers/enrichment-trigger.integration.test.ts`: 120 pending rows; `enrichment_limits` seeded with 12 today (2026-11-17), 30 on 2026-11-04 and 977 on 2026-10-31 (last month, which must not count); clock fixed at 2026-11-17T15:42:07Z. The plan's four cases assert both the messages sent and the whole `data` (quota used, limit and remaining). `limit: 101` returns 400 and sends nothing. Mutants against `src/handlers/enrichment.ts`, one at a time:

- M9a `:209` clamp `100 → 1`: killed, 4. M9a `:292` cap `100 → 1`: killed, 4.
- M9b daily remaining dropped from the min: killed, 1 (sends 60, expected 3). M9b monthly remaining dropped: killed, 1 (sends 50, expected 4).
- `enabled` forced false: killed, 4. Success-path `beers_queued` forced to 0: killed, 4. Schema `.max(100)` removed (`src/schemas/request.ts:82`): killed, 1.
- Equivalent: removing `:292`'s cap, because `:209` and the schema (`.max(100)`) already cap the request limit at 100. Removing `:209`'s cap alone is equivalent too, because `:292` still caps at 100. The plan names only the first.

3 unit tests deleted.

### Step 10: Cron unit tests

**Delete**: the claim test in `test/handlers/cron-schedule.test.ts` that only returns what its fake was told to. #84's real-D1 claim test covers it.
**Fix**:
- Rename the jitter tests that say 4h, 3h40m and 4h20m to match the 2-hour interval.
- Fix the clock for the real-time tests at `:113–139`.
- In `test/handlers/scheduled.test.ts:513`, compute the 90-day cutoff in UTC under a fixed clock, as production does.

**Result (step 10)**: Deleted 2 fake-echo claim tests from `test/handlers/cron-schedule.test.ts` (the plan says "the claim test"; both the "claim succeeds → true" and "RETURNING empty → false" tests only return what the fake was told, and each has a real-D1 replacement shown by a mutant, so both went). Renamed the three `computeNextCronTime` tests from 4h / 3h40m / 4h20m to 2h / 1h40m / 2h20m. Fixed the clock (2026-03-01T18:00Z) for the whole `checkAndAdvanceCronSchedule` describe, which covers `:113–139` and the other `Date.now()` uses; the claim-bind test now asserts the whole bind list `[String(NOW + CRON_INTERVAL_MS + CRON_JITTER_MS / 2), NOW, CRON_SCHEDULE_KEY, NOW]` with `random = 0.75` instead of a lower bound (killed: claim binds a fixed 0.5 jitter instead of `random`; the old 0.5/`>=` version let it survive). In `test/handlers/scheduled.test.ts` the 90-day reap test now fixes the clock at 2026-06-15T12:00Z and expects the literal cutoff `'2026-03-17'` for both tables (killed: `- 90` → `- 89`); it passes under TZ Pacific/Kiritimati, Pacific/Honolulu and America/Chicago. Production still uses local `setDate` then UTC formatting; noon UTC keeps that from crossing a date in any zone. Mutants: 4 run, 4 killed.

### Step 11: Enrichment consumer quota and write against real D1

**Test**: Add to `test/queue/enrichment-exa.integration.test.ts` or a new real-D1 file. Run `handleEnrichmentBatch` with the daily quota at the limit, and again one below it. Assert:
- whether Perplexity is called;
- ack or retry;
- the stored counters;
- the stored ABV, source and confidence.

**Delete**: `test/queue/enrichment-status.test.ts`, once the map shows each of its tests replaced, including the boundary cases at `:155–170` and `:231–247`. Its stale-write warning case (`:183–225`) also needs a real-D1 replacement, or a move, before the file goes.
**Keep**: in `test/queue/cleanup-stale-binding.test.ts`, the duplicate-delivery, missing-hash, producer-to-consumer seam and stale-result logging tests (`:143–175, :210–232, :271–351`). Move each to real D1 where practical, or keep it as a focused unit test. Delete only the tests where the fake checks the hash itself.
**Done when**: M15 and M16 fail without `enrichment-status.test.ts`, and the stale-hash mutant from #84 still fails.

**Result (step 11).** New `test/queue/enrichment-quota.integration.test.ts` (a new file rather than adding to `enrichment-exa.integration.test.ts`, whose tests run on the real clock): daily limit 37, clock fixed at 2026-11-17T15:42:07Z, Exa off. It has 3 tests: at the limit (37 used), one below it (36 used), and a description change during the Perplexity call. Each asserts Perplexity calls, ack or retry, the `enrichment_limits` rows, and the whole stored row (ABV, confidence, source, status, hash, `updated_at`). Mutants were run with `enrichment-status.test.ts` excluded (the new file plus `enrichment-exa.integration.test.ts`), one at a time:

- M15 (`src/queue/enrichment.ts:110`, refused reservation ignored): killed, 1.
- M16 (`:133`, `abv + 1`): killed, 2.
- The Perplexity write guard (`:132`) reduced to `id` only: killed, 1. No stale warning (`changes === 0` → `=== -1`): killed, 1. Status written as `'pending'`: killed, 1. The `not_found` write sets `'skipped'`: killed, 16 (the existing exa file).
- Quota boundary in `src/db/quota.ts`: `+ 1 <= ?` → `< ?` killed, 1; `new_count > previousCount` → `>=` killed, 1.
- Stale-hash mutant from #84 (`src/queue/cleanup.ts:201` and `:215`, `description_hash = ?` → `(description_hash = ? OR 1)`): each alone kills 1 case of `cleanup-consumer.integration.test.ts` › leaves a row alone when its description changed after the message was sent. Both together still kill 2 after the deletions. `cleanup-stale-binding.test.ts` passes under this mutant, because its fake checks the hash itself.
- Dropping the stale filter on Perplexity forwarding (`cleanup.ts:368`): killed, 1 (same integration test).
- No equivalents.

Deleted all of `test/queue/enrichment-status.test.ts` (5 tests) and 3 tests from `test/queue/cleanup-stale-binding.test.ts`, 8 in total. The duplicate-delivery, missing-hash and both seam tests stay as focused unit tests. The deterministic-cleanup tests in the same file check cleaned text, not the hash, so they were left alone.

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

**Result (step 12).** 17 tests deleted from `test/handlers/beers.list.test.ts` (map rows above), the per-test `vi.clearAllMocks()` calls removed (62 in the old file, 54 of them in tests that stay; `beforeEach` already resets every mock), and the empty `handleBeerList — stale fallback ETag with enrichment hash` describe removed.

**M14 is equivalent through the router.** `src/index.ts:419` rejects every `sid` not in `ENABLED_STORE_IDS` (only `13879`) with `{ error: 'Invalid store ID', requestId }` before `handleBeerList` runs, so a router request can't reach `src/handlers/beers.ts:476–490`, and the plan's expected `INVALID_STORE_ID` body never comes back through the router. Two tests were added instead:
- `GET /beers store ID checks › rejects a store that is not enabled before anything reaches upstream`: the router request the plan asked for, asserting the router's real body. It still passes with M14 applied (equivalent).
- `› has the handler itself reject a malformed store ID without fetching upstream`: calls `handleBeerList` directly against real D1 with `sid=abc` and a stubbed upstream. M14 (`!isValidStoreId(storeId)` → `false`) makes it fail (200 from upstream instead of 400).

**New guards in `test/handlers/beers.enrichmentSource.integration.test.ts`** (clock fixed with `vi.useFakeTimers({ toFake: ['Date'] })`): pinned cache-hit and stale ETags from stored hashes (literals from `test/utils/hash.test.ts`); live ETag and `Cache-Control` equal those served next from the cache row the live request wrote; an enrichment-only change rewrites the cache; a 304 on each path is recorded in analytics as `conditional` with 0 beers.

**Fixes in `beers.list.test.ts`:** `:1189` now asserts the custom headers; `:977–980` became two ordered-event tests with the sighting and cache write held on deferreds (no time limit); `:1169` now requires a latency of exactly 37 ms.

**Mutants run** (each against `beers.list.test.ts` + `beers.enrichmentSource.integration.test.ts`, fresh run, `src/` restored after each): all killed.
- M14 `:476` → `false`: 1 fails (handler test); the router test passes, as expected.
- `:263` latency → `0`: 1 fails.
- `:344` IDs → `[]`: 4 fail.
- `:396` sighting `void (…)`: 1 fails. `await (…)`: 2 fail.
- `:376` cache write `void (…)`: 1 fails. `await (…)`: 2 fail.
- `:508` cache-hit conditional → `if (false)`: 3 fail. `:514` beersReturned `0` → `1`: 1 fails. `:516` `'conditional'` → `'hit'`: 1 fails. `:510` header copy removed: 1 fails.
- `:525` cache-hit ETag dropped: 6 fail. `:506` enrichment hash → `null`: 2 fail. `:506` content-only ETag when null: 1 fails.
- `:568` live enrichment hash → `null`: 1 fails. `:599` ETag dropped: 4 fail. `:599` Cache-Control dropped: 1 fails. `:599` base headers dropped: 2 fail.
- `:361` always hash: 3 fail. `:373` new enrichment hash → `null`: 1 fails (newly guarded: before this step no test exercised an enrichment-only change against a real comparison).
- `:171` stale enrichment hash → `null`: 1 fails. `:171` content-only when null: 1 fails. `:185` stale `'conditional'` → `'stale'`: 1 fails. `:588` live `'conditional'` → `'miss'`: 1 fails.

**Kept, deliberately:** tests that drive a real branch through a fake (for example `calls updateCacheTimestamp when …` with `shouldUpdateContent` returning false, `setCachedTaplist` argument tests, `passes correct data to recordSeenBeers`, the queueing tests that check `recordSeenBeers` output reaches `sendCleanupAndMark` / `queueBeersForEnrichment`, `hashes the exact bytes read …`). No `insertPlaceholders` pass-through tests remain in the file (the function is gone), so that bullet had nothing to delete. `does not trigger background enrichment on cache hit` asserts `waitUntil` was not called, but it also checks no sighting is recorded, so it stays.

**Noticed, not changed:** `does not queue when no beers need processing` asserts `queueBeersForCleanup` was not called, but production never calls `queueBeersForCleanup` directly (it calls `sendCleanupAndMark`), so that line is vacuous. Several kept tests still set `checkConditionalRequest` to `null`, repeating the `beforeEach` default.

### Step 13: Rate-limit unit tests that do arithmetic on a fake's count

**Delete**: as listed in the map, the tests in `test/rate-limit.test.ts` whose outcome follows from the count the fake returned, and the `prepare`-called-once tests. #84's `test/rate-limit.integration.test.ts` covers them.
**Keep**: the key-building tests (`getEndpointRateLimitKey` and the like), and the null or missing returned-count fallback tests (`:223–240`). #84 doesn't cover those.
**Done when**: #84's five rate-limit mutants still fail.

**Result (step 13)**: Deleted 22 tests from `test/rate-limit.test.ts` (count-from-fake arithmetic, `prepare`-called-once, and identifier pass-through). Kept: all key-building tests (`getPreAuthRateLimitKey`, `getEndpointRateLimitKey`), the null and missing `request_count` fallback tests, the fail-closed error tests, the `reapOldRateLimits` bind/limit and rejection tests, and the `resetAt` tests (including "should maintain same minute bucket within same minute", which checks `resetAt`, not a count). #84's five mutants, re-derived from `test/rate-limit.integration.test.ts`, all still fail after the deletions (fresh Workers-pool runs of both files): limit `>` → `>=` (1 real-D1 fails); bind `'all-clients'` for the client key (1); hour bucket instead of minute (1); fail-closed `allowed: true` (1 real-D1 + 2 unit) and `degraded: false` (1 real-D1 + 2 unit); reaper cutoff `- 61` (1 real-D1 + 1 unit). Extra mutants: success `degraded: true` (2 fail), `remaining: limitPerMinute` (5 fail), rejected `remaining: 1` (1 fails). Equivalent: removing `Math.max(0, …)` on the allowed branch, because that branch only runs when count ≤ limit; the deleted "never goes negative" test didn't reach it either (its count took the rejection branch).

### Step 14: Send-then-mark ordering in `sendCleanupAndMark`

**Test**: First run both forms of M13 against the existing retry test (`test/handlers/beers.sync.description.integration.test.ts:268–281`):
- the mark moved before the send;
- rows marked even when their send failed.

For any form that survives, add a real-D1 test. Hold the send open on a deferred promise, check in D1 that `queued_for_cleanup_at` is still unset, then let the send succeed and check it is set.
If the "marked despite a failed send" form survives, add a real-D1 test where the send rejects or partly fails, and check which rows were marked.
**Done when**: both forms of M13 fail. Nothing is deleted.

**Result (step 14).** No map rows: nothing deleted, and no test added, because both M13 forms already fail the existing tests in `test/handlers/beers.sync.description.integration.test.ts` (fresh run of that file, `src/` restored after each). The cited lines are current: `src/queue/helpers.ts:206–209`, retry test at `:268–281`.
- **Mark moved before the send** (`markCleanupQueued(env.DB, work, { now })` before `queueBeersForCleanup`, in-try mark removed): 2 fail. `cleanup retry after a description change › resets the queued marker, so a failed send is retried by the next sync` fails because the row is marked although the send rejected, so the next sync queues nothing. `cleanup mark and repeat syncs › returns 500 when the mark fails after a send, …` also fails: the mark now throws before any send, so `sendBatch` is never called.
- **Rows marked even when their send failed** (`work.filter(item => sent.has(item.id))` → `work`, `:209`): 1 fails, the same retry test, for the same reason.

The real-D1 deferred-send test in the plan was conditional on a form surviving, so it wasn't written.

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

**Found in step 12**: the router (`src/index.ts:419`) rejects every `sid` except `13879` before `handleBeerList` runs, so the handler's store-ID check can't be reached through the router today. M14 is guarded by a direct `handleBeerList` call against real D1. Account for this when removing strict mode.

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
| 3 | `test/constants.test.ts` DLQ consumer constants › should set MAX_DLQ_CONSUMER_ATTEMPTS to 3, matching wrangler.jsonc max_retries | DLQ retry count matches config | `test/queue-config.test.ts` › retries each work queue, then dead-letters it… | M4 (DLQ `max_retries` 3 → 4) |
| 4 | `test/audit.test.ts` writeAuditLog › records the request in the audit log | the insert runs | `test/audit.integration.test.ts` writeAuditLog › stores every request field in its own column | `.run()` removed from the request insert: 2 fail |
| 4 | `test/audit.test.ts` writeAuditLog › passes ctx.requestId in the bound values | request ID column | same | M5 (`client_ip, user_agent` swapped: 1 fails; `method, path` swapped: 2 fail) |
| 4 | `test/audit.test.ts` writeAuditLog › passes ctx.startTime in the bound values | timestamp column | same | M5 |
| 4 | `test/audit.test.ts` writeAuditLog › passes the provided method in the bound values | method column | same | M5 (`method, path` swapped): 2 fail |
| 4 | `test/audit.test.ts` writeAuditLog › passes the provided path in the bound values | path column | same | M5 (`method, path` swapped): 2 fail |
| 4 | `test/audit.test.ts` writeAuditLog › passes the provided statusCode in the bound values | status column | same, and › stores a request without an error, key, IP or user agent as nulls | status bound as `200`: 2 fail |
| 4 | `test/audit.test.ts` writeAuditLog › passes null for error when no error is provided | absent error stored as NULL | `test/audit.integration.test.ts` writeAuditLog › stores a request without an error, key, IP or user agent as nulls | `error \|\| null` → `error \|\| ''`: 1 fails |
| 4 | `test/audit.test.ts` writeAuditLog › passes the error string when provided | error column | `test/audit.integration.test.ts` writeAuditLog › stores every request field in its own column | M5 |
| 4 | `test/audit.test.ts` writeAuditLog › passes a non-negative responseTimeMs in the bound values | response time = now − start | both writeAuditLog tests (fixed clock, exact 37 ms) | `responseTimeMs = 0`: 2 fail |
| 4 | `test/audit.test.ts` reapOldAuditLog › deletes rows older than AUDIT_RETENTION_DAYS, bounded by AUDIT_REAP_LIMIT | retention cutoff and per-call limit | `test/audit.integration.test.ts` reapOldAuditLog › deletes only rows older than the retention window; › deletes at most AUDIT_REAP_LIMIT rows per call | `<` → `<=`: 1 fails; retention days + 1: 2 fail; limit + 1: 1 fails |
| 4 | `test/audit.test.ts` writeAdminAuditLog › records the admin operation in the audit log | the admin insert runs | `test/audit.integration.test.ts` writeAdminAuditLog › stores an admin entry with the operation as path, the admin hash as key, and every option in the details | M5 (admin `client_ip, user_agent` swapped): 1 fails |
| 4 | `test/audit.test.ts` writeAdminAuditLog › passes "ADMIN" as the method value | method is `ADMIN` | same | `'ADMIN'` → `'GET'`: 1 fails |
| 4 | `test/audit.test.ts` writeAdminAuditLog › passes the operation string as the path value | operation stored as path | same | `operation` → `'admin'`: 1 fails |
| 4 | `test/audit.test.ts` writeAdminAuditLog › passes the adminSecretHash as the api_key_hash value | admin hash stored as key hash | same | `adminSecretHash` → `ctx.apiKeyHash`: 1 fails |
| 4 | `test/audit.test.ts` writeAdminAuditLog › passes JSON.stringify(details) as the error slot | details JSON in `error` | same | `JSON.stringify(enrichedDetails)` → `JSON.stringify(details)`: 1 fails |
| 4 | `test/audit.test.ts` writeAuditLog › does not throw when db.prepare().bind().run() rejects | error branch swallowed | keep | — |
| 4 | `test/audit.test.ts` writeAuditLog › never issues a second (cleanup) prepare call regardless of Math.random — row-growth cleanup moved to the cron reaper | no cleanup in the request path | keep | — |
| 4 | `test/audit.test.ts` reapOldAuditLog › propagates a rejection when the delete fails (no swallow — the cron handler decides how to handle it) | error branch propagates | keep | — |
| 4 | `test/audit.test.ts` reapOldAuditLog › runs successfully even when a prior writeAuditLog insert on the same db failed — no shared try/catch anymore | error branch isolation | keep | — |
| 4 | `test/audit.test.ts` writeAdminAuditLog › does not throw when db.prepare().bind().run() rejects | error branch swallowed | keep | — |
| 4 | `test/audit.test.ts` writeAdminAuditLog › with structured outcome options › all seven tests (default status, custom status, outcome merging, denied, attempted, truncation, no truncation flag) | status default and details merging | keep (plan keeps them unless each gets its own real-D1 mutant) | — |
| 5 | `test/pipeline.integration.test.ts` Pipeline Integration › getEnrichmentForBeerIds › should fetch enrichment data for beer IDs | row mapping; missing IDs omitted | `test/db/enrichmentLookup.integration.test.ts` getEnrichmentForBeerIds (real D1) › sends 183 IDs as one batch of 90, 90 and 3 parameters and returns only the requested beers that exist | `source: row.enrichment_source` → `source: null` (`src/db/helpers.ts`): 1 fails |
| 5 | `test/pipeline.integration.test.ts` Pipeline Integration › getEnrichmentForBeerIds › should handle empty beer ID array | empty input skips D1 | move: `test/db/enrichmentLookup.test.ts` getEnrichmentForBeerIds edge branches › returns an empty result without sending a batch when no IDs are requested | early `return` for `beerIds.length === 0` removed: 1 fails |
| 5 | `test/pipeline.integration.test.ts` Pipeline Integration › getEnrichmentForBeerIds › should handle large ID arrays with chunking | chunking | `test/db/enrichmentLookup.integration.test.ts` (same test as row 1) | M6 no chunking (`CHUNK_SIZE = beerIds.length` → `[[183]]`) and M6 over limit (`D1_MAX_PARAMS_PER_STATEMENT + 1` → `[[91, 91, 1]]`); last chunk dropped (`i + CHUNK_SIZE < length` → `[[90, 90]]`): 1 fails each |
| 5 | `test/pipeline.integration.test.ts` Pipeline Integration › extractABV › should extract ABV from percentage notation | `%` notation | move: `test/db/extractABV.test.ts` extractABV basic notations › reads %j as %d | moved verbatim; same inputs and expected values |
| 5 | `test/pipeline.integration.test.ts` Pipeline Integration › extractABV › should extract ABV from ABV keyword notation | `ABV` keyword | move: `test/db/extractABV.test.ts` extractABV basic notations › reads %j as %d | moved verbatim |
| 5 | `test/pipeline.integration.test.ts` Pipeline Integration › extractABV › should reject ABV values above 20% | unlabelled >20% ignored | move: `test/db/extractABV.test.ts` extractABV basic notations › returns null for %j | moved verbatim |
| 5 | `test/pipeline.integration.test.ts` Pipeline Integration › extractABV › should handle HTML tags in description | HTML stripped | move: `test/db/extractABV.test.ts` extractABV basic notations › reads %j as %d | moved verbatim |
| 5 | `test/pipeline.integration.test.ts` Pipeline Integration › extractABV › should return null for descriptions without ABV | no ABV → null | move: `test/db/extractABV.test.ts` extractABV basic notations › returns null for %j; › returns null when there is no description | moved verbatim |
| 5 | `test/pipeline.integration.test.ts` Pipeline Integration › extractABV › should handle edge cases | 0, 20, 21 bounds | move: `test/db/extractABV.test.ts` extractABV basic notations › reads %j as %d; › returns null for %j | moved verbatim |
| 5 | `test/pipeline.integration.test.ts` Pipeline Integration › error handling › should handle getEnrichmentForBeerIds errors gracefully | batch failure → empty map, logged | move: `test/db/enrichmentLookup.test.ts` getEnrichmentForBeerIds edge branches › returns an empty result and logs the failure when the batch fails | `throw error` added in the `catch`: 1 fails |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqList › returns a Response with status 200 on success | list succeeds | `test/handlers/dlq-housekeeping.integration.test.ts` handleDlqList › lists pending entries by default, newest failure first, without the raw message | `replayed_at`/`acknowledged_at` swapped in the message mapping: 1 fails |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqList › response body has success true | not a contract: echoes a literal over a fake's empty result | same (whole body via `toEqual` on `data`) | not a contract |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqList › response body has data.messages as an array | not a contract: shape check | same | not a contract |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqList › response body has data.total_count | total for the filtered status | same; › filters by status and beer ID, and status=all lists every status | count query ignores the status filter: 3 fail |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqList › response body has data.has_more | not a contract: `typeof has_more` | › pages through entries that share a failure time in id order, with no duplicates or gaps | M7 (`results.length > limit` → `>=`): 1 fails |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqList › does NOT include raw_message in message objects by default | raw message omitted by default | › lists pending entries by default, newest failure first, without the raw message | `include_raw` check → `true`: 1 fails |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqList › includes raw_message in message objects when include_raw=true | raw message on request | › includes the raw message when include_raw=true | `include_raw` check → `false`: 1 fails |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqList › defaults to status=pending filter when no status param provided | SQL substring | › lists pending entries by default, newest failure first, without the raw message | default status `'pending'` → `'all'`: 3 fail |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqList › accepts status=all to remove status filter | SQL substring | › filters by status and beer ID, and status=all lists every status | `status !== 'all'` check removed from the list query: 1 fails |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqAcknowledge › returns 200 with acknowledged_count on success | echoes the fake's `changes` | `test/handlers/dlq-housekeeping.integration.test.ts` acknowledges only the requested pending entries and reports the rest as not acknowledged (#84) | `failedCount = requestedCount`: 1 fails |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqAcknowledge › only acknowledges messages with status pending | echoes the fake's `changes` | same (#84) | `AND status = 'pending'` removed from the acknowledge UPDATE: 1 fails |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqAcknowledge › includes requested_count and failed_count alongside acknowledged_count on a full success | count arithmetic | same (#84: 5 requested, 1 acknowledged, 4 failed) | `failedCount = requestedCount`: 1 fails |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqAcknowledge › reports a nonzero failed_count when fewer rows change than were requested (partial acknowledge) | count arithmetic | same (#84) | `failedCount = requestedCount`: 1 fails |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqAcknowledge › reports failed_count equal to requested_count when nothing matches | count arithmetic | same (#84) | `failedCount = requestedCount`: 1 fails |
| 6 | `test/handlers/dlq.handler.test.ts` cleanupOldDlqMessages › calls delete for acknowledged messages older than 30 days | SQL substring | `test/handlers/dlq-housekeeping.integration.test.ts` deletes acknowledged and replayed entries older than 30 days and keeps everything else (#84) | `acknowledged_at < ?` → `>`: 2 fail; 30 → 32 days: 2 fail |
| 6 | `test/handlers/dlq.handler.test.ts` cleanupOldDlqMessages › calls delete for replayed messages older than 30 days | SQL substring | same (#84) | `replayed_at < ?` → `>`: 2 fail |
| 6 | `test/handlers/dlq.handler.test.ts` cleanupOldDlqMessages › loops if a batch deletes exactly batchLimit records (continues deleting) | batch loop continues | `test/handlers/dlq-housekeeping.integration.test.ts` keeps deleting past the 1,000-row batch until every old acknowledged and replayed entry is gone | acknowledged loop `while (false)`: 1 fails; replayed loop `while (false)`: 1 fails |
| 6 | `test/handlers/dlq.handler.test.ts` cleanupOldDlqMessages › stops looping when a batch deletes fewer than batchLimit records | exact prepare-call count | same | not a contract: `=== batchLimit` → `> 0` adds one empty DELETE and leaves the same rows (survives, equivalent) |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqList › returns status 400 when cursor param is malformed | request validation | keep | — |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqList › returns status 400 when cursor base64 decodes but fails schema | request validation | keep | — |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqList › returns status 500 when DB throws | error branch | keep | — |
| 6 | `test/handlers/dlq.handler.test.ts` handleDlqAcknowledge › rejects a request with more than 100 IDs, accepts exactly 100, returns 400 when ids missing, returns 500 when DB throws | request validation and error branch | keep | — |
| 7 | `test/queue/dlq.test.ts` storeDlqMessage › stores a failed message in the dead letter queue and parks the beer as failed | SQL substrings (`INSERT INTO dlq_messages`, `enrichment_status = 'failed'`, `abv IS NULL`) | `test/queue/dlq-storage.integration.test.ts` stores a complete pending entry for a new message; parks only the beer the message still describes, and only while it has no ABV | parking sets `'pending'`: 1 fails; `AND abv IS NULL` removed: 1 fails; parking `WHERE 0 AND …`: 1 fails |
| 7 | `test/queue/dlq.test.ts` storeDlqMessage › binds the beer ID to the failed-status parking statement | parking targets the message's beer | › parks only the beer the message still describes, and only while it has no ABV | `STILL_CURRENT_SQL` replaced by `id = ?`: 1 fails; hash bound wrong: 1 fails; `updated_at` bound `now + 1`: 1 fails |
| 7 | `test/queue/dlq.test.ts` storeDlqMessage › persists the message ID | `toContain` bind | › stores a complete pending entry for a new message | `message_id, beer_id` column swap: 3 fail |
| 7 | `test/queue/dlq.test.ts` storeDlqMessage › persists the beer ID of the failed message | `toContain` bind | same | `message_id, beer_id` column swap: 3 fail |
| 7 | `test/queue/dlq.test.ts` storeDlqMessage › persists the beer name of the failed message | `toContain` bind | same | `beer_name, brewer` column swap: 2 fail |
| 7 | `test/queue/dlq.test.ts` storeDlqMessage › persists the brewer of the failed message | `toContain` bind | same | `beer_name, brewer` column swap: 2 fail |
| 7 | `test/queue/dlq.test.ts` storeDlqMessage › persists the attempt count of the failed message | `toContain` bind | same | `failed_at, failure_count` column swap: 3 fail; `message.attempts + 1`: 3 fail |
| 7 | `test/queue/dlq.test.ts` storeDlqMessage › persists the source queue name | `toContain` bind | same | `source_queue, raw_message` column swap: 3 fail; source queue bound as `'beer-enrichment'`: 3 fail |
| 7 | `test/queue/dlq.test.ts` storeDlqMessage › persists the raw message body as JSON | `toContain` bind | same | `JSON.stringify(body)` → `JSON.stringify(body.beerId)`: 3 fail |
| 7 | `test/queue/dlq.test.ts` storeDlqMessage › uses null for beerName when body.beerName is not provided | `toContain(null)` (passes on any null bind) | › stores an empty beer name and brewer as NULL | `body.beerName \|\| ''`: 1 fails |
| 7 | `test/queue/dlq.test.ts` storeDlqMessage › uses null for brewer when body.brewer is not provided | `toContain(null)` (passes on any null bind) | same | `body.brewer \|\| ''`: 1 fails |
| 7 | `test/queue/dlq.test.ts` handleDlqBatch › all tests (ack, retry, analytics, batch continues, -dlq suffix, retry exhaustion) | ack, retry and exhaustion decisions | keep | — |
| 7 | `test/queue/dlq.test.ts` handleCleanupDlqBatch › all tests (ack, does not park, retry, analytics, retry exhaustion) | ack, retry and exhaustion decisions | keep | — |
| 8 | `test/handlers/health.test.ts` handleHealthCheck › response body has enrichment daily used matching the DB result | daily used comes from today's row | `test/handlers/health.integration.test.ts` handleHealthCheck quota windows (real D1) › reports today alone as daily use and this month alone as monthly use | M8 (daily query binds `monthStart`); `dailyUsed = 0`: 1 fails each |
| 8 | `test/handlers/health.test.ts` handleHealthCheck › response body has enrichment daily remaining as limit minus used | daily remaining = limit − used | same | `Math.max(0, dailyLimit)` (used dropped): 1 fails |
| 8 | `test/handlers/health.test.ts` handleHealthCheck › response body has enrichment monthly used matching the DB result | monthly used sums this month only | same | monthly binds `today` as start; lower bound dropped; upper bound dropped (counts next month's row): 1 fails each |
| 8 | `test/handlers/health.test.ts` handleHealthCheck › response body has enrichment monthly remaining as limit minus used | monthly remaining = limit − used | same | `Math.max(0, monthlyLimit)` (used dropped): 1 fails |
| 8 | `test/handlers/health.test.ts` handleLiveness › takes no Env parameter — structurally cannot issue a D1 query | `/livez` can't reach D1 | compiler guard | `handleLiveness(env: Env)` breaks `npm run typecheck`: `src/index.ts(223,14): TS2554 Expected 1 arguments, but got 0`. An optional parameter would type-check but `src/index.ts:223` passes nothing, so it still can't reach `env.DB` |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › validation › clamps limit to valid range (1-500) | `MAX_LIMIT` clamp (asserted only status 200, so guarded nothing) | `cleanupTrigger.integration.test.ts` mode 'missing' › sends at most 500 beers however large the requested limit | M10 (`Math.min(…, MAX_LIMIT)` removed): 1 fails |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › send-then-mark ordering › does not write queued_for_cleanup_at when the queue send delivered nothing | a failed send leaves the row unmarked | move: `cleanupTrigger.integration.test.ts` mode 'missing' › leaves a beer unmarked when its send fails, so the next run finds it again | mark every prepared row, not just sent ones (`prepared.filter(…sentSet…)` → `prepared`): 1 fails |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › mode: missing › selects only beers with NULL brew_description_cleaned | `NEVER_CLEANED` skips cleaned rows | mode 'missing' › queues every never-cleaned, unqueued beer, flights included, with the hash it stores | drop `AND brew_description_cleaned IS NULL`: 2 fail |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › mode: missing › does not include beers_reset in response | no `beers_reset` outside mode 'all' | mode 'missing' › reports what a dry run in mode 'missing' would queue, without sending or marking (whole `data`), and › queues every never-cleaned… (non-dry run) | dry-run spread always adds `beers_reset`: 1 fails; final spread always adds it: 3 fail |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › mode: missing › returns no_eligible_beers when all have cleaned descriptions | cleaned rows are not eligible; skip reason | mode 'missing' › reports no eligible beers, sending nothing, when every description is cleaned or already queued | drop `AND brew_description_cleaned IS NULL`: 2 fail |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › mode: missing › does not return beers with queued_for_cleanup_at already set | `NEVER_CLEANED` skips queued rows | mode 'missing' › queues every never-cleaned, unqueued beer… | drop `AND queued_for_cleanup_at IS NULL`: 2 fail |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › mode: missing › returns no_eligible_beers when all missing beers are already queued | queued rows are not eligible; skip reason | mode 'missing' › reports no eligible beers… | drop `AND queued_for_cleanup_at IS NULL`: 2 fail |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › mode: all › includes preview counts in CONFIRMATION_REQUIRED response | preview count (asserted only `toBeDefined`) | existing mode 'all' › previews only the descriptions that would be re-cleaned | preview total forced to 0: 1 fails |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › mode: all › succeeds with confirm: true | `confirm: true` passes the gate | existing mode 'all' › re-cleans only descriptions from an older cleanup version (and 2 other mode 'all' tests) | gate ignores `confirm` (`mode === 'all' && !confirm` → `true`): 7 fail, incl. the 3 mode 'all' sends |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › mode: all › includes beers_reset in response | `beers_reset` in mode 'all' dry run | mode 'missing' › reports what a dry run in mode 'all' would queue, without sending or marking | dry-run spread never adds `beers_reset`: 1 fails |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › no daily limit › queues every eligible beer with no daily limit | default limit queues all eligible beers; no `quota` in `data` | mode 'missing' › queues every never-cleaned, unqueued beer… (whole `data`) | `DEFAULT_LIMIT: 500 → 1`: 2 fail |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › no daily limit › reports no quota when nothing is eligible | skip reason; no `quota` | mode 'missing' › reports no eligible beers… (whole `data`) | `skip_reason` changed: 1 fails |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › blocklist does not filter cleanup › queues blocklisted beers for cleanup (flights) | blocklist does not apply to cleanup | mode 'missing' › queues every never-cleaned, unqueued beer, flights included… | drop names containing "Flight" before queueing: 1 fails |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › blocklist does not filter cleanup › queues all beers even if all would have been blocklisted | same | same | same mutant: 1 fails |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › operation tracking › includes operation_id in response | `operation_id` format | every mode 'missing' test asserts `cleanup-trigger-<fixed ms>` in whole `data` | prefix changed to `cleanup-`: 6 fail |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › empty results handling › handles empty database gracefully | no rows → `no_eligible_beers` | mode 'missing' › reports no eligible beers… | `skip_reason` changed: 1 fails |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › descriptionHash on beers handed to queueBeersForCleanup › attaches the same descriptionHash used for the D1 write to every queued beer, for mode: missing | message hash = stored hash = hash of description | mode 'missing' › queues every never-cleaned, unqueued beer… (whole messages and stored `description_hash`) | hash computed from `brew_name`: 2 fail. Dropping `descriptionHash` from `beersToQueue` is equivalent: `queueBeersForCleanup` recomputes the same hash from the same text |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › validation › returns INVALID_MODE when mode is missing / when mode is invalid | validation | keep | — |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › mode: all › returns CONFIRMATION_REQUIRED without confirm: true; allows mode: all with dry_run without confirm | confirm gate | keep | — |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › cooldown › (all 4) | cooldown | keep | — |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › dry run › (all 3) | dry run | keep; leaked `queueBeersForCleanup` result fixed by a `beforeEach` reset | — |
| 9a | `test/handlers/cleanupTrigger.test.ts` handleCleanupTrigger › Invalid request body › (all 4); bounded body guard › (both) | validation | keep | — |
| 9b | `test/handlers/enrichment.handler.test.ts` handleEnrichmentTrigger › returns 200 with beers_queued > 0 when eligible beers are found and queued | `beers_queued` reports what was sent (asserted only `> 0`) | `test/handlers/enrichment-trigger.integration.test.ts` enrichment trigger batch size (real D1) › sends as many beers as %s allows (whole `data`, 4 cases) | `beers_queued` forced to 0 on the success path: 4 fail |
| 9b | `test/handlers/enrichment.handler.test.ts` handleEnrichmentTrigger › respects limit param and clamps to max 100 | batch size is min(limit, daily, monthly, 100) (asserted only `prepare.calls.length >= 3`) | same, 4 cases, plus › rejects a request limit above 100 without sending anything | M9a `:209` `100 → 1`: 4 fail; M9a `:292` `100 → 1`: 4 fail; M9b daily dropped: 1 fails; M9b monthly dropped: 1 fails; schema `.max(100)` removed: 1 fails |
| 9b | `test/handlers/enrichment.handler.test.ts` handleEnrichmentTrigger › response data.enabled is true when ENRICHMENT_ENABLED is not false | `enabled` flag | same (whole `data` has `enabled: true`) | `enabled` forced to `false`: 4 fail |
| 10 | `test/handlers/cron-schedule.test.ts` checkAndAdvanceCronSchedule › returns true when scheduled time is in the past and the claim succeeds | a due schedule is claimed | `test/handlers/cron-schedule.integration.test.ts` checkAndAdvanceCronSchedule (real D1) › claims an existing schedule that is %s and advances it with jitter (2 cases); › claims a fresh schedule once and then reports not due | `return claim !== null` → `return false`: 6 fail (5 real-D1, 1 kept unit) |
| 10 | `test/handlers/cron-schedule.test.ts` checkAndAdvanceCronSchedule › returns false when a concurrent caller already claimed (RETURNING empty) | a lost claim returns false | `test/handlers/cron-schedule.integration.test.ts` checkAndAdvanceCronSchedule (real D1) › refuses the claim on %s when another caller claimed between the read and the write (2 cases) | `return claim !== null` → `return true`: 2 fail |
| 11 | `test/queue/enrichment-status.test.ts` handleEnrichmentBatch — enrichment_status › sets enrichment_status to enriched when ABV is found | Perplexity ABV write: status, source, confidence, value | `test/queue/enrichment-quota.integration.test.ts` enrichment consumer quota and Perplexity write (real D1) › spends the day's last slot on Perplexity and stores its ABV (whole row) | M16 (`abv + 1`): 2 fail (this and exa › keeps the Perplexity ABV and never calls Exa); status written as `'pending'`: 1 fails |
| 11 | `test/queue/enrichment-status.test.ts` handleEnrichmentBatch — enrichment_status › sets enrichment_status to not_found when ABV is null | Perplexity unknown → `not_found`, ack | existing `test/queue/enrichment-exa.integration.test.ts` when the fallback never runs › takes the ordinary miss path with %s: not_found, acknowledged, no slot, no Exa call (5 cases) | `not_found` write sets `'skipped'`: 16 fail |
| 11 | `test/queue/enrichment-status.test.ts` handleEnrichmentBatch — enrichment_status › acks without an API call when the daily limit is reached (counter parked at limit) | refused reservation acks with no Perplexity call; boundary at the limit | enrichment consumer quota… › acknowledges without calling Perplexity once the daily quota is used up (calls, ack, counter, whole row) | M15 (`if (!reservation.reserved)` → `if (false)`): 1 fails; `reserved: new_count >= previousCount` (`src/db/quota.ts`): 1 fails |
| 11 | `test/queue/enrichment-status.test.ts` handleEnrichmentBatch — enrichment_status › logs a stale-result warning and does not treat the write as successful when the row changed status before the write | the Perplexity write is guarded on the live row; a refused write warns and still acks | enrichment consumer quota… › discards the ABV and warns when the description changes during the Perplexity call (row changed inside the stubbed Perplexity call) | write guard reduced to `id` only (`:132`): 1 fails; warning condition `changes === 0` → `=== -1`: 1 fails |
| 11 | `test/queue/enrichment-status.test.ts` handleEnrichmentBatch — enrichment_status › reserves the limit-th slot when the counter is at limit - 1 | the limit-th call is allowed | enrichment consumer quota… › spends the day's last slot on Perplexity and stores its ABV (counter goes 36 → 37) | `request_count + 1 <= ?` → `< ?` (`src/db/quota.ts`): 1 fails |
| 11 | `test/queue/cleanup-stale-binding.test.ts` consumer-side stale-result binding › acks without writing when the message descriptionHash does not match the current row | cleanup write guarded on `description_hash` (the fake checked the hash itself) | existing `test/queue/cleanup-consumer.integration.test.ts` description cleanup consumer (real D1) › leaves a row alone when its description changed after the message was sent, %s | `description_hash = ?` → `(description_hash = ? OR 1)`: with-ABV write (`cleanup.ts:201`) 1 fails, plain write (`:215`) 1 fails, both 2 fail; the fake-D1 file passes under all three |
| 11 | `test/queue/cleanup-stale-binding.test.ts` consumer-side stale-result binding › acks without writing when a DLQ-replayed message is older than the current row | same guard, for a replayed message | same | same mutants |
| 11 | `test/queue/cleanup-stale-binding.test.ts` Perplexity forwarding after a stale write › does not enqueue Perplexity work for a beer whose write was stale | a stale cleanup write forwards nothing to Perplexity | same, without an ABV (asserts `sendBatch` not called) | stale filter `!staleBeerIds.has(…)` → `true` (`cleanup.ts:368`): 1 fails |
| 11 | `test/queue/cleanup-stale-binding.test.ts` consumer-side stale-result binding › writes exactly once (idempotently) across a duplicate delivery of the same message | duplicate delivery | keep | — |
| 11 | `test/queue/cleanup-stale-binding.test.ts` consumer-side stale-result binding › acks without writing, and without an in-flight drop mislabeling it, when the message has no descriptionHash at all | missing hash | keep | — |
| 11 | `test/queue/cleanup-stale-binding.test.ts` producer -> consumer seam › (both tests) | producer-to-consumer seam | keep | — |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList › enrichment merging › passes correct beer IDs to getEnrichmentForBeerIds | the taplist's IDs are the ones looked up | `beers.enrichmentSource.integration` › GET /beers live path › hides exa without the header and shows it with the header, ABV and confidence intact (and 3 other live-path tests) | `getEnrichmentForBeerIds(env.DB, [], requestId)` (`src/handlers/beers.ts:344`): 4 fail |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList › background task queueing › verifies waitUntil is called for non-blocking background tasks | cache write and sighting work are registered with `waitUntil` | handleBeerList › background task queueing › answers before background work finishes, and holds the context open until the $last finishes too (both orders) | sighting run as `void (…)` instead of `ctx.waitUntil(…)` (`:396`): 1 fails; cache write as `void (…)` (`:376`): 1 fails |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList › cache miss › triggers background enrichment on live fetch | background work registered on a live fetch | same as above | sighting `void (…)` (`:396`): 1 fails |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList › force refresh (fresh=true) › triggers background enrichment on force refresh | background work registered on `fresh=true` (same core as a miss) | same as above | sighting `void (…)` (`:396`) and cache write `void (…)` (`:376`): 1 fails each |
| 12 | `test/handlers/beers.list.test.ts` refreshTaplistForStore › calls ctx.waitUntil for cache write and enrichment | the cron refresh registers both writes (same core function) | same as above | sighting `void (…)` (`:396`) and cache write `void (…)` (`:376`): 1 fails each |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList — ETag support › returns 304 when cache is fresh and If-None-Match matches | cache-hit 304, `cacheOutcome: 'conditional'`, no beers counted (the 304 itself was the fake's answer) | `beers.enrichmentSource.integration` › GET /beers cache hit path › sends Vary… on 200 and 304; › gives each variant its own stable ETag with a working 304 round trip; GET /beers cache hit path 304 analytics › records a 304 as a conditional answer with no beers returned | `if (false)` for the cache-hit conditional (`:508`): 3 fail; `'conditional'` → `'hit'` (`:516`): 1 fails; `beersReturned: 0` → `1` (`:514`): 1 fails |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList — ETag support › returns 200 with ETag when cache is fresh but no If-None-Match | cache hit sends an ETag | GET /beers cache hit ETag › is built from the stored content hash and enrichment hash def456 / null | drop `responseHeaders['ETag'] = cachedEtag` (`:525`): 6 fail |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList — ETag support › 304 response includes the supplied passthrough and X-Request-ID headers | the caller's headers are copied onto a cache-hit 304 | GET /beers cache hit path › sends Vary: X-Enrichment-Sources on 200 and 304 | delete the header copy in the cache-hit 304 loop (`:510`): 1 fails |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList — ETag support › returns ETag on 200 from live fetch | live 200 sends ETag and `Cache-Control: private, max-age=300` | GET /beers live path ETag and cache write › serves the same ETag and cache headers live as from the cache row it writes | drop `'ETag': etag` (`:599`): 4 fail; drop `'Cache-Control'` (`:599`): 1 fails |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList — ETag support › ETag on cache-hit uses combined content + enrichment hash | cache-hit ETag includes the stored enrichment hash | GET /beers cache hit ETag › is built from the stored content hash and enrichment hash def456 | `null` for `cachedRow.enrichment_hash` (`:506`): 2 fail |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList — ETag support › cache-hit returns 200 when client ETag matches old content-only hash but enrichment changed | not a contract: the 200 and the ETag were both the fakes' answers | real property (an old content-only ETag no longer matches) is GET /beers cache hit ETag › … enrichment hash null | not a contract; content-only ETag when enrichment hash is null (`:506`) fails 1 |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList — ETag support › cache-hit ETag falls back to content_hash alone when enrichment_hash is null | cache-hit ETag when the row has no enrichment hash | GET /beers cache hit ETag › is built from the stored content hash and enrichment hash null | `enrichment_hash === null ? "${content_hash}" : …` (`:506`): 1 fails |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList — ETag support › ETag uses combined content + enrichment hash on live fetch | live ETag includes the fresh enrichment hash | GET /beers live path ETag and cache write › serves the same ETag and cache headers live as from the cache row it writes | `null` for `result.enrichmentHash` (`:568`): 1 fails |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList — ETag support › passes null enrichment hash to shouldUpdateContent when enrichment map is empty but beers exist | no enrichment hash when no beer has enrichment | keep: handleBeerList › cache miss › writes response to cache after successful live fetch (and 2 other kept `setCachedTaplist` tests); new: GET /beers live path ETag and cache write › rewrites the cache when only enrichment changed… | always compute the hash (`:361` condition → `false`): 3 fail; pass `null` as the new enrichment hash (`:373`): 1 fails |
| 12 | `test/handlers/beers.list.test.ts` refreshTaplistForStore — enrichment hash › passes null as newEnrichmentHash to shouldUpdateContent when enrichment map is empty but beers exist | same, cron path (same core function) | same as above | same as above |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList — stale fallback ETag with enrichment hash › stale fallback ETag uses combined hash when enrichment_hash is present | stale ETag includes the stored enrichment hash | GET /beers stale fallback ETag › is built from the stored content hash and enrichment hash def456 | `null` for `fallbackRow.enrichment_hash` (`:171`): 1 fails |
| 12 | `test/handlers/beers.list.test.ts` handleBeerList — stale fallback ETag with enrichment hash › stale fallback ETag falls back to content_hash alone when enrichment_hash is null | stale ETag when the row has no enrichment hash | GET /beers stale fallback ETag › is built from the stored content hash and enrichment hash null | `enrichment_hash === null ? "${content_hash}" : …` (`:171`): 1 fails |
| 13 | `test/rate-limit.test.ts` checkRateLimit › basic functionality › should allow requests under limit | allowed + remaining below the limit | `test/rate-limit.integration.test.ts` checkRateLimit (real D1) › allows a client up to the limit in one minute, then refuses until the next minute | `remaining: limitPerMinute` (count ignored): 5 fail |
| 13 | `test/rate-limit.test.ts` checkRateLimit › basic functionality › should reject requests over limit | rejected over the limit | same | limit comparison `>` → `>=`: 1 fails; rejected `remaining: 0` → `1`: 1 fails |
| 13 | `test/rate-limit.test.ts` checkRateLimit › basic functionality › should track remaining count correctly | remaining = limit − count | same | `remaining: limitPerMinute`: 5 fail |
| 13 | `test/rate-limit.test.ts` checkRateLimit › basic functionality › should use a different rate limit bucket when the minute changes | new minute, new count | `test/rate-limit.integration.test.ts` checkRateLimit (real D1) › starts a new count when the clock minute changes, even seconds later | bucket bound as `Math.floor(now / 3600000)` (hour): 1 fails |
| 13 | `test/rate-limit.test.ts` checkRateLimit › edge cases › should allow request exactly at limit (count === limit) | count = limit is allowed | `test/rate-limit.integration.test.ts` checkRateLimit (real D1) › allows a client up to the limit … (3rd result) | `>` → `>=`: 1 fails |
| 13 | `test/rate-limit.test.ts` checkRateLimit › edge cases › should reject request one over limit (count === limit + 1) | limit + 1 rejected | same (4th result) | `>` → `>=`; rejected `remaining: 1`: 1 fails each |
| 13 | `test/rate-limit.test.ts` checkRateLimit › edge cases › should handle first request (count = 1) | first request remaining | same (1st result) | `remaining: limitPerMinute`: 5 fail |
| 13 | `test/rate-limit.test.ts` checkRateLimit › edge cases › should handle limit of 1 | count 1, limit 1 allowed | same (count = limit case, limit 3) | `>` → `>=`: 1 fails |
| 13 | `test/rate-limit.test.ts` checkRateLimit › edge cases › should reject second request when limit is 1 | limit + 1 rejected | same | `>` → `>=`: 1 fails |
| 13 | `test/rate-limit.test.ts` checkRateLimit › edge cases › should handle very high request count (far over limit) | far over limit rejected | same | not a contract beyond `count > limit`: no branch on magnitude; `>` → `>=` fails 1 |
| 13 | `test/rate-limit.test.ts` checkRateLimit › edge cases › should handle very high limit | arithmetic at a large limit | same | not a contract beyond `limit − count`: no branch on magnitude; `remaining: limitPerMinute` fails 5 |
| 13 | `test/rate-limit.test.ts` checkRateLimit › edge cases › should ensure remaining never goes negative | remaining floored at 0 | same (4th result, remaining 0) | rejected `remaining: 0` → `1`: 1 fails. The test's count (200) takes the rejection branch, so it never reached `Math.max`; removing `Math.max` is equivalent (that branch has count ≤ limit) and survived the old test too |
| 13 | `test/rate-limit.test.ts` checkRateLimit › minute boundary transitions › should use different minute buckets across minute boundary | new minute, new count (bucket computed in the test) | `test/rate-limit.integration.test.ts` checkRateLimit (real D1) › starts a new count when the clock minute changes, even seconds later | hour-bucket bind: 1 fails |
| 13 | `test/rate-limit.test.ts` checkRateLimit › database error handling (fail closed) › returns degraded: false on successful check | success is not degraded | `test/rate-limit.integration.test.ts` checkRateLimit (real D1) › allows a client up to the limit …; › starts a new count … | success `degraded: true`: 2 fail |
| 13 | `test/rate-limit.test.ts` checkRateLimit › per-endpoint isolation › should maintain separate limits for different endpoints | endpoints counted separately | `test/rate-limit.integration.test.ts` checkRateLimit (real D1) › counts each client separately; key-building tests kept (`getEndpointRateLimitKey` › endpoint isolation) | bind `'all-clients'` instead of `clientIdentifier`: 1 fails |
| 13 | `test/rate-limit.test.ts` checkRateLimit › per-endpoint isolation › should track each endpoint independently | endpoints counted separately | same | bind `'all-clients'`: 1 fails |
| 13 | `test/rate-limit.test.ts` checkRateLimit › cleanup logic › never issues a second (cleanup) prepare call regardless of Math.random | no inline cleanup | not a contract: `prepare`-call count; rows are reaped by `reapOldRateLimits` (real-D1 reaper test) | not a contract |
| 13 | `test/rate-limit.test.ts` checkRateLimit › cleanup logic › still computes the correct allowed/remaining result now that cleanup is out-of-band | allowed/remaining + one prepare | `test/rate-limit.integration.test.ts` checkRateLimit (real D1) › allows a client up to the limit … | `remaining: limitPerMinute`: 5 fail; prepare count not a contract |
| 13 | `test/rate-limit.test.ts` checkRateLimit › cleanup logic › does not issue a cleanup prepare call when the request is rejected | no inline cleanup on reject | not a contract: `prepare`-call count | not a contract |
| 13 | `test/rate-limit.test.ts` checkRateLimit › special client identifiers › should handle client identifiers with special characters | identifier passed through | not a contract: the identifier is only a bound parameter; no code inspects it. Allowed path covered by `test/rate-limit.integration.test.ts` checkRateLimit (real D1) › allows a client up to the limit … | not a contract |
| 13 | `test/rate-limit.test.ts` checkRateLimit › special client identifiers › should handle very long client identifiers | same | same | not a contract |
| 13 | `test/rate-limit.test.ts` checkRateLimit › special client identifiers › should handle empty client identifier | same | same | not a contract |

## Appendix: harmless uses of the real clock

Filled in at step 17.
