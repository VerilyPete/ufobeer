# One write path for `enriched_beers`

Status: reviewed 2026-11-12, revision 6. Five Codex rounds, each in a fresh
session: rounds 1–4 `REQUEST CHANGES`, round 5 `APPROVE WITH NITS`; its one
minor finding and two clarifications are applied here. Not yet implemented.

## Why

Beers reach `enriched_beers` through two producers that disagree about what a
change means:

| Path | Entry | Decides by | On conflict writes |
|---|---|---|---|
| Taplist refresh | `processBackgroundEnrichment` → `insertPlaceholders` (`src/db/helpers.ts`), after a successful live `GET /beers` fetch (cache hits and failed upstream fetches don't run it) | `categorizeBeer`, 8 declared cases | Per case; a description change replaces the original text, clears cleanup fields and resets status to `pending` |
| Mobile sync | `handleBeerSync` (`src/handlers/beers.ts`), `POST /beers/sync` | Nothing | `brew_name`, `brewer`, `description_hash`, `last_seen_at` only |

Both producers share the same downstream chain. A described beer goes to the
cleanup consumer, which extracts an ABV from the description (even for a
blocklisted beer: blocking stops paid lookups, not extraction) or, when there
is none and the beer isn't blocklisted, sends it straight to the enrichment
consumer (Perplexity, then Exa). That chain has no cron-hours or jitter gate;
it is bounded by `ENRICHMENT_ENABLED`, the status checks, the Perplexity
quota and the Exa cap. The cron separately picks up `pending` rows nobody
queued, and retries `not_found` rows after 24 h.

Problems, verified against the code on 2026-11-12 (each audited by Codex):

1. **A description change through `/beers/sync` is half-applied.** The sync
   upsert stores the new `description_hash` but keeps the old
   `brew_description_original` and, if the beer was already cleaned, the old
   `brew_description_cleaned`, and does not re-queue cleanup.
   `GET /beers` and `POST /beers/batch` serve the old cleaned text, and the
   taplist refresh, comparing hashes only, sees nothing to repair while the
   description stays the same. **No row is damaged today:** on 2026-11-12 a
   read-only audit found all 1,794 rows with a hash equal to
   `hashDescription(brew_description_original)` (the first 16 bytes of
   SHA-256, as 32 hex characters; `src/utils/hash.ts`). The audit was an
   ad hoc script; slice 3 commits it as `scripts/audit-description-hashes.mjs`.
   Equal hash and original is a necessary check, not proof that the cleaned
   text matches.
2. **Hand-verified rows are not protected.** One row is verified
   (`COUNT(*) WHERE is_verified = 1` = 1 on 2026-11-12). These writers can
   change its `abv`, `confidence`, `enrichment_source` or
   `enrichment_status`:
   - the taplist description-change upsert and blocked-beer upsert
     (`src/db/helpers.ts`), which reset status;
   - the cleanup consumer's ABV-present UPDATE (`src/queue/cleanup.ts`);
   - the enrichment consumer: Perplexity success, the `not_found` write and
     Exa success (`src/queue/enrichment.ts`); its preflight checks status
     only, and Exa's `isStillCurrent` doesn't check verification;
   - the cron's pending selector, its `not_found` retry claim and its
     blocklist skip mark (`src/handlers/enrichment.ts`);
   - skip recovery (`src/db/skipRecovery.ts`);
   - DLQ storage, which sets `failed` (`src/queue/dlq.ts`), and admin DLQ
     replay, which sets `pending` by id (`src/handlers/dlq.ts`).
3. **Work is queued for writes that failed, and providers spend on it.** Both
   producers build their queue lists before writing and never filter by
   outcome. The enrichment preflight skips only an existing non-`pending`
   row, so a missing row reaches Perplexity.
4. **Producers and consumers race.** Each producer reads, decides in JS, then
   writes blindly:
   - a stale description upsert can clear newer cleanup or enrichment work
     and reset the row to `pending`;
   - a stale blocked classification can mark `skipped` a row that cleanup
     enriched in the meantime;
   - an omitted brewer is resolved from the earlier read and can overwrite a
     newer brewer;
   - two first sightings of an id both `INSERT`, and the second aborts its
     whole batch;
   - Perplexity's success write isn't identity-guarded (Exa's and skip
     recovery's are);
   - the admin cleanup trigger (`src/handlers/cleanupTrigger.ts`) sends, then
     writes `description_hash` back by id with no guard, so it can restore an
     obsolete hash over a newer description.
5. **Sync's cleanup retry exists on one path only, and its mark is by id.**
   Sync re-queues a described beer with `description_cleaned_at IS NULL`
   once `queued_for_cleanup_at` is older than 24 h. The taplist path has no
   retry. A late mark for description A can suppress B's retry, and a
   description change never resets the marker.
6. **False or misleading comments.** `insertPlaceholders`'s doc says
   `INSERT OR IGNORE`. `handleBeerSync` (twice) and `cleanupTrigger.ts` say
   the description hash isn't forwarded to the cleanup queue; it is.
   `categorizeBeer`'s `new_with_abv` and `new_needs_cleanup` cases are
   unreachable for a described beer, which is `description_changed` on first
   sight (pinned by `test/db/categorizeBeer.test.ts`).
7. **Every taplist refresh writes one row per beer** (`last_seen_at` for
   unchanged beers). Unmeasured; see slice 5.

Known limitation, not fixed here: cleanup protects words from the message's
name and brewer, but its write checks only the hash. After a rename with an
unchanged description, a queued cleanup can use the old name's protected
terms. The effect is cosmetic, and it can persist on a cleaned row until
the next description change or admin re-clean; any later message uses the
then-current name.

## Decisions

- **D1. One module owns sightings.** `recordSeenBeers(db, beers, { now })` in
  `src/db/seenBeers.ts` replaces `insertPlaceholders` and the sync upsert,
  and owns sighting writes and queue eligibility. The cleanup consumer and
  admin trigger also write description state; slices 1 and 2 guard them.
- **D2. Queueing stays as today.** The taplist caller queues enrichment and
  cleanup; sync queues cleanup only and leaves undescribed `pending` rows to
  the cron. This keeps current behaviour; it is not a spending boundary.
- **D3. Canonical input.**
  - Validate each item first, as today (errors per invalid item, same 400
    cases and limits).
  - Collapse duplicate ids to the **last valid** occurrence; each surviving
    item's hash is computed from its own text.
  - An omitted or empty description keeps the stored text and hash.
  - An omitted brewer keeps the stored brewer, resolved in SQL
    (`COALESCE(excluded.brewer, enriched_beers.brewer)` at write time, not a
    value read earlier); an explicit empty brewer stays an explicit value,
    as today. Both producers repair a malformed stored brewer today
    (`cleanBeerNames`, pinned by `test/db/beer-names.integration.test.ts`);
    that stays, as a guarded write of the repaired value `WHERE brewer IS
    <observed stored brewer>`, so a newer brewer is never replaced. Queue
    messages use the brewer the write left, read back with `RETURNING`.
- **D4. Results per beer:** `written`, `unchanged`, `stale` (a guard refused
  the write: zero changes, not an error) or `failed` (the statement's batch
  threw; D1 rolls the whole batch back, so every beer in it is `failed`).
  Only `written` beers, and `unchanged` beers that are queue-eligible
  (pending enrichment, cleanup retry), are queued. Sync's `synced` counts
  valid input items whose surviving beer isn't `failed`: two valid duplicates
  count 2 and fail together. Sync's `errors` keep today's generic strings.
- **D5. Verified rows keep their protected fields.** For a row with
  `is_verified = 1`, `abv`, `confidence`, `enrichment_source` and
  `enrichment_status` change only through a human. Every automatic writer in
  problem 2 enforces this at write time against the live row:
  - row-level writes (provider results, `not_found`, claims, skip mark, skip
    recovery, DLQ `failed`) add `AND is_verified IS NOT 1` (NULL counts as
    unverified);
  - writes that also carry description fields (the producer upserts and the
    cleanup consumer) keep updating the description and use
    `CASE WHEN enriched_beers.is_verified IS 1 THEN <column> ELSE <new> END`
    per protected column, in one statement;
  - selectors (cron pending and `not_found` branches, skip recovery) exclude
    verified rows so no paid call is attempted;
  - admin DLQ replay of a verified row is refused and reported in the
    response as `skipped_verified`, and its DLQ entry returns from
    `replaying` to its prior state so it can be replayed once a human clears
    the flag.
- **D6. Guards on live state.**
  - Description change: `ON CONFLICT(id) DO UPDATE … WHERE
    enriched_beers.brew_description_original IS <original read> AND
    enriched_beers.description_hash IS <hash read>` (both bound as NULL when
    absent, never undefined), as slice 3 introduces.
  - Blocked beer: set `skipped` only `WHERE enrichment_status IS <status
    read> AND abv IS NULL AND is_verified IS NOT 1 AND <SAME_IDENTITY_SQL>`.
  - Name and brewer: written unconditionally from the sighting (the newest
    sighting names the beer); brewer omission handled in SQL (D3).
  - New rows: `ON CONFLICT(id) DO NOTHING`; zero changes is `stale`.
  - Perplexity success: adds `SAME_IDENTITY_SQL`.
  - Policy for overlapping snapshots: **first successful guarded write
    wins**; a writer whose guard fails is `stale` and its work is dropped. A
    later request that read the winner's state can replace it, even if its
    source data is older (sync has no freshness token). An A→B→A cycle is
    indistinguishable from no change; accepted.
- **D7. Cleanup retry on both paths, version-bound.** A sighting of a row
  with a stored description, `description_cleaned_at IS NULL` and
  `queued_for_cleanup_at` null or older than 24 h queues cleanup from the
  stored text and hash, whether or not the sighting carried a description,
  and independently of enrichment eligibility (a terminal row gets no
  enrichment dispatch but can still get cleanup). A row whose stored hash is
  NULL or doesn't match its stored text is first prepared as in D8 step 1,
  since the consumer only accepts a message whose hash matches the row. A description change sets
  `queued_for_cleanup_at = NULL`. After a successful send, the mark is
  `UPDATE … SET queued_for_cleanup_at = MAX(COALESCE(queued_for_cleanup_at,
  0), ?) WHERE id = ? AND description_hash IS ? AND description_cleaned_at
  IS NULL`. Delivery is at least once; the hash-guarded consumer makes a
  duplicate harmless.
- **D8. Admin cleanup trigger: prepare, send, mark.**
  1. Prepare: `UPDATE … SET description_hash = ? WHERE id = ? AND
     brew_description_original IS <original read>`; send only rows where this
     changed one row or the hash already matched.
  2. Send.
  3. Mark only sent rows, with D7's guarded, monotonic mark. Mode `all`
     keeps the served cleaned text, as today.
  A failed send leaves `queued_for_cleanup_at` untouched, so mode `missing`
  still finds the row. A consumer that runs before step 3 is accepted
  because step 1 already set the hash.
- **D9. No schema migration.** Rollback is constrained; see Rollout.

## Slices

Stacked PRs. Each is TDD against real D1 (`applyD1Migrations`, real
migration chain), Codex review/fix-looped until only nits remain, and passes
on its own: `npm run test`, `npm run test:unit`, `npm run typecheck`,
`npm run typecheck:test`, `npm run typecheck:contract` and
`npm run test:contract` against a pinned BeerSelector commit (recorded in the
PR). Tests that need a consumer's effect run the consumer explicitly; tests
of `GET /beers` force a live refresh past the cache TTL.

### Slice 1: verified rows and the enrichment preflight (D5, Perplexity identity guard)

RED, real consumers, provider stubs counting calls and reservations:
- already verified before dequeue: no quota reserved, no provider called;
- verified while Perplexity returns a value: final write refused;
- verified while Perplexity returns `unknown`: Exa's recheck refuses before
  reserving its slot, and the `not_found` write is refused;
- verified while an Exa call is in flight: final Exa write refused;
- `unknown` with no fallback available, row verified meanwhile: `not_found`
  refused;
- message for a missing row, or whose hash or identity no longer matches:
  no quota reserved, no provider called;
- rename between queueing and a Perplexity answer: answer discarded;
- cleanup of a verified row, new description with and without an ABV: the
  description is re-cleaned, the four protected fields are unchanged;
- taplist description change and blocked sighting on a verified row: status
  unchanged;
- cron pending and `not_found` selection, the retry claim, the skip mark and
  skip recovery: verified rows untouched, including verification landing
  between a selection and its write;
- DLQ storage: a verified NULL-ABV row isn't marked `failed`; DLQ replay of
  a verified row is refused and reported, its entry leaves `replaying`, and
  after the flag is cleared the same entry replays; mixed cleanup and
  enrichment replay counts are unchanged;
- `is_verified` 0, 1 and NULL; an ABV of 0.

GREEN: one shared preflight (missing, non-pending, verified, hash, identity)
used before Perplexity and, as `isStillCurrent`, before Exa; the guards and
CASE columns of D5.

### Slice 2: admin cleanup trigger (D8)

Lands before the shared writer: no deployment that changes how sightings
write descriptions ships with a writer that can restore an obsolete hash.

RED: admin reads A, a sighting stores B, admin prepares: refused and nothing
sent; full and partial send failure leaves `queued_for_cleanup_at` null and
mode `missing` finds the row on the next run; a successful send followed by a
fully rolled-back mark batch, and a failed mark batch after an earlier
batch committed, leave the row found by the next `missing` run while its
message is still unconsumed; once the consumer runs, the row is cleaned and
needs no retry; a prepared-but-unsent row is found by the
next run; a consumer that runs before the mark is accepted; a legacy row with
a NULL or wrong hash is prepared and sent; response counts equal rows sent.

### Slice 3: sync applies a description change in full (problem 1, minimal)

Inside the existing `handleBeerSync`, before any extraction. Duplicate ids
in a request collapse to the last valid occurrence here (D3), not in slice 4,
together with D4's count rule (two valid duplicates still count 2).
Each conflict takes one of two arms, and no arm assigns the hash alone:

- **Unchanged or omitted description:** assigns `last_seen_at`, name and
  brewer only. The existing `description_hash = COALESCE(…)` assignment is
  removed, so the live original/hash pair is never split.
- **Changed description** (the item's text differs from the stored
  `brew_description_original`, compared as text, so a damaged row whose hash
  already matches is caught too): guarded `WHERE
  enriched_beers.brew_description_original IS <original read> AND
  enriched_beers.description_hash IS <hash read>`, it sets the hash and `brew_description_original`, clears the four cleanup fields
and `queued_for_cleanup_at`, and (per D5's CASE) resets an unverified row to
`pending`; the beer is queued for cleanup only if the write changed a row
(read back with `RETURNING`). Small, so the rollback floor can include it
and no supported build ever writes a hash without its text.

RED: a cleaned beer, then `POST /beers/sync` with a new description: before
any consumer, `/beers/batch` serves the new raw text; after cleanup, the new
cleaned text; the next forced live `GET /beers` changes the ETag, and a
repeat gets 304 (fails today). A seeded damaged row (hash B, original A,
cleaned A) synced with B is repaired; two repair snapshots with cleanup
between them: the second, stale repair doesn't clear the new cleaned text. Sync reads A, another writer stores B,
then sync's unchanged-A conflict runs: the row keeps original B with hash(B).
One request carrying an existing id twice, B then A: one version is stored,
with its own hash, and only that version is queued. Sync's response and
retry behaviour are otherwise unchanged. Commits `scripts/audit-description-hashes.mjs` (read-only:
exports `id`, original and hash via `wrangler d1 execute --json` and recomputes
`hashDescription`).

### Slice 4: shared writer, sync switched over (D1–D4, D6, D7)

RED:
- slice 3's sync cases still pass through the shared writer;
- a seeded damaged row (hash B, original A, cleaned A) is repaired by the
  next sighting of B (fails today: the hash already equals B);
- sync's retry is kept, and the taplist path gains it; a description change
  resets the marker; a late mark for A doesn't suppress B's retry; a mark
  never moves `queued_for_cleanup_at` backwards; a row with a NULL or wrong
  stored hash is prepared before its retry is sent;
- a successful send followed by a failing mark batch (sync has one batch;
  the taplist path can also fail after an earlier batch committed): the
  marker is unchanged and the response is today's; a sighting before the
  message is consumed resends; after it is consumed the row is cleaned and
  ineligible;
- an omitted brewer with a malformed stored brewer is repaired; the same with
  a concurrent brewer change keeps the newer brewer;
- shared writer with more than 100 beers and a test-only trigger aborting one
  batch: that batch's beers are `failed` and queue nothing, the other batch
  queues; through the sync handler, a failed single batch queues nothing and
  returns today's response;
- races: concurrent first sightings (one `written`, one `stale`, no batch
  aborted); two writers reading A and proposing B and C (first wins, second
  `stale`); a duplicate A→B after B is cleaned is a no-op; cleanup of A
  before a legitimate A→B update still allows B; a blocked pending row
  enriched by cleanup before the producer writes stays enriched; an omitted
  brewer doesn't overwrite a newer one; an older sync arriving after a newer
  taplist description replaces it (documented policy);
- a pending row whose last enrichment send failed is re-queued by the next
  taplist sighting; terminal `not_found`, `skipped`, `failed` rows get no
  enrichment dispatch (cleanup retry still applies);
- input: duplicate ids (valid then invalid, valid then description omitted,
  two valid with different text), omitted and empty brewer and description,
  a Unicode name needing repair, an ABV of 0;
- blocked beers with and without a description, and with an ABV in it:
  same outcomes as today (extraction allowed, no paid lookup);
- sync response unchanged for an empty body, all invalid, partial invalid,
  a repeated unchanged sync and a total write failure.

GREEN: `recordSeenBeers` with one SQL builder in place of the seven
insert/upsert templates; both callers switched; unreachable categorizer
cases removed and their tests updated; problem 6's comments fixed;
AGENTS.md and
`.claude/api-endpoints.md` updated. One changed-description `/beers/sync`
case added to the Golden Taproom harness.

### Slice 5 (optional): throttle `last_seen_at`

1. Measure for a week: `recordSeenBeers` logs counts of `written`,
   `unchanged`, throttle-eligible beers, cleanup marks written and rows read.
   Ship only if net avoidable writes exceed 5,000 a day.
2. If shipped, the throttle skips only the timestamp: a beer seen within
   `LAST_SEEN_REFRESH_MS` (1 hour) gets no write, but its queue eligibility
   (pending enrichment, cleanup retry) is computed the same as without the
   throttle; renames, brewer changes and description changes still write.
   Seven-day windows may see a beer up to an hour late; accepted. Tests: null
   `last_seen_at`, the exact one-hour boundary, a clock that moved back,
   out-of-order sightings never moving `last_seen_at` backwards, a pending
   row still re-queued while throttled.

## Rollout

Deploy in order; each slice deploys alone.

- **Before slice 3:** run `scripts/audit-description-hashes.mjs` (committed in
  slice 3); expect 0 mismatches.
- **After slice 1:** the verified row's four protected fields are unchanged a
  day later.
- **After slices 3 and 4:** the audit still finds 0 mismatches after a day.
  Compare with the week before:
  - cleanup messages per day: expect a rise from the retry and description
    changes, no growth in queue age or DLQ count;
  - Perplexity and Exa calls per day;
  - `stale` and `failed` outcome counts from `recordSeenBeers` logs;
  - `beers.sync.complete` 200s and `synced` counts.
- **Rollback floors:**
  - never deploy below slice 3 once it is live: slices 1–3 together are the
    floor (verified rows, admin guards, sync writing text with its hash);
  - slice 4 and slice 5 can be reverted to slice 3;
  - the Exa source-negotiation floor in `plans/abv-untappd-fallback.md`
    still applies.
- If the audit ever finds a mismatch: at the slice-3 floor a sync repairs it
  only when its description differs from the stored original text; a row
  whose stored text is already current but whose hash is wrong or NULL needs
  the admin cleanup trigger (mode `all`), which prepares the hash from the
  stored text (slice 2). From slice 4, D7's preparation also repairs it on any
  sighting. A row
  never resynced or seen again keeps its old text, and the audit keeps
  listing it until repaired.
- `ENRICHMENT_ENABLED` does not stop cleanup's ABV writes; pausing the
  cleanup queue consumer does.
