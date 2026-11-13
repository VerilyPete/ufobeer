# One write path for `enriched_beers`

Status: reviewed 2026-11-12, revision 6. Five Codex rounds, each in a fresh
session: rounds 1–4 `REQUEST CHANGES`, round 5 `APPROVE WITH NITS`; its one
minor finding and two clarifications are applied here. Implemented
2026-11-12 as stacked branches: slices 1–4, the slice 1 addendum, slice 5
step 1 (`feat/seen-write-metrics`) and step 2 (`feat/last-seen-throttle`,
held until a week of step 1's numbers clears the bar).

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
- **D9. One schema migration, `0015`,** adds two nullable DLQ claim columns
  (`replay_claim`, `replay_claimed_at`; slice 1 addendum). The deploy workflow
  applies it before the worker deploys. Nothing else changes the schema.
  Rollback is constrained; see Rollout.

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

### Slice 1, addendum: recover abandoned DLQ replay claims

Added after Codex round 4 on slice 1. A replay claims an entry by moving it
from `pending` to `replaying`; nothing ever moves it back if the request fails
between the claim and its release or finalize write (a failed D1 write, an
isolate killed mid-request). Claims require `pending`, so the entry can never be
replayed again. The gap predates this plan (any failed send plus a failed
rollback hits it); slice 1 adds one more way in (verification lands after the
claim, then the release write fails). Separately, `skipped_verified` is read in
a different statement from the claim, so verification changing between them
makes the response disagree with what was claimed.

Design:
- Migration `0015` adds two columns to `dlq_messages` (each `ALTER TABLE ADD
  COLUMN` commented NOT IDEMPOTENT, as AGENTS.md requires; `schema.sql`
  updated): `replay_claim TEXT`, a fresh `crypto.randomUUID()` per replay
  request that owns the claim, and `replay_claimed_at INTEGER`, used only for
  the lease's age. Ownership is never inferred from the timestamp.
- The claim is one `db.batch`: the verified-entry `SELECT`, then `UPDATE … SET
  status = 'replaying', replay_claim = ?, replay_claimed_at = ? … RETURNING id,
  raw_message, replay_count, source_queue`. A batch is one transaction, so
  `skipped_verified` and the claimed set come from one snapshot; the
  `RETURNING` rows replace the separate fetch of claimed entries.
- Ownership governs the paid side effect, not only the bookkeeping. The
  enrichment entry's beer reset is one statement guarded on the lease:
  `UPDATE enriched_beers SET enrichment_status = 'pending' … WHERE id = ? AND
  NOT_VERIFIED AND abv IS NULL AND enrichment_status IN ('pending', 'failed',
  'not_found') AND EXISTS (SELECT 1 FROM dlq_messages WHERE id = ? AND status =
  'replaying' AND replay_claim = ?)`. The send follows only if the reset
  applied, or the classification below says to. A request whose lease was
  reaped or taken over before its reset commits therefore resets nothing and
  sends nothing for that entry. Ownership fences D1 writes, not queue sends:
  if the lease is lost after the request's last successful lease check (the
  guarded reset, or the cleanup check below) but before its send, that send
  still goes out. That window is accepted; closing it would need deduplication
  in the consumers, which delivery already lacks (queues are at-least-once).
- The reset no longer re-opens a beer that already has an ABV or is
  `skipped`. Today a replay of an entry whose beer has since been enriched
  resets it to `pending` and pays for the lookup again; this is the
  ambiguous-recovery case (a send went out, its finalize failed, the consumer
  enriched the beer, the reaper released the entry, an admin replays it). Such
  an entry is returned to `pending` unsent and reported in a new response
  field, `skipped_resolved`, for the admin to acknowledge. When the guarded
  reset changes nothing, one read classifies the entry, lease first: lease
  lost → left alone, nothing sent (it belongs to whoever holds it now); beer
  missing → send (the consumer's preflight acks a missing row before any
  quota); verified → `skipped_verified`; ABV set or `skipped` →
  `skipped_resolved`; otherwise (a race) → `failed`.
- Cleanup entries have no reset: before sending one, the request checks it
  still holds the lease and stops otherwise. A duplicate cleanup message is
  safe for the description (deterministic, the write is guarded on the hash),
  but each copy can queue an enrichment message when the description has no
  ABV, so a duplicate can cost a repeated lookup if the first lookup's write
  fails. That is the same at-least-once cost as any queue redelivery, and is
  accepted here.
- The release (back to `pending`) and the finalize (to `replayed`) are guarded
  on `status = 'replaying' AND replay_claim = ?` and clear both columns.
- DLQ storage redelivery (`ON CONFLICT … SET status = 'pending'` in
  `src/queue/dlq.ts`) is unchanged: it ends the claim by status, and the old
  owner's guarded writes then match nothing. Stale claim columns on a
  `pending` row are inert; the next claim overwrites them.
- `releaseStaleReplayClaims(db, { now })` in `src/handlers/dlq.ts`:
  `UPDATE dlq_messages SET status = 'pending', replay_claim = NULL,
  replay_claimed_at = NULL WHERE status = 'replaying' AND (replay_claimed_at IS
  NULL OR replay_claimed_at <= ?)` with `now - DLQ_REPLAY_CLAIM_STALE_MS`
  (10 minutes, `src/constants.ts`). `NULL` covers entries stranded before the
  migration. A live request that outlives the lease loses it safely (above).
- It runs on every cron tick beside the other reapers, before the kill switch
  and operating-hours gates, in its own `try`/`catch`. A stranded entry is
  replayable again within 30 minutes (10-minute age plus a 20-minute tick).
  It only returns entries to `pending`; nothing is re-sent automatically.

RED, real D1, provider stubs counting calls and reservations where a consumer
runs:
- verification lands after the claim and the release write fails: 500, the
  entry stays `replaying`; after the flag is cleared and the reaper runs past
  the stale age, the same entry replays;
- the ambiguous recovery: send succeeds, finalize fails, the consumer enriches
  the beer, the reaper releases the entry, a second replay sends nothing,
  reserves no quota, reports the entry in `skipped_resolved` and leaves it
  `pending`; an entry whose beer is `skipped` likewise; `failed`, `pending`
  and `not_found` beers with a NULL ABV still replay;
- a lease lost mid-request, with several claimed entries: after the first
  send the lease is reaped and re-claimed by another request (different
  token); the first request resets no further beer, sends no further message
  (enrichment or cleanup), and its release and finalize change nothing;
- the lease lost after the guarded reset commits but before the send (the
  test holds the reset's response, re-claims the entry, then releases it): the
  send goes out once (the accepted window), and the first request's finalize
  and release don't touch the new claim;
- the lease lost, then a reset that changes nothing because the beer row is
  missing: nothing is sent;
- two requests with the same `Date.now()`: A claims, a DLQ redelivery returns
  the entry to `pending`, B claims it; A's finalize and release don't touch
  B's claim;
- reaper: a claim exactly `DLQ_REPLAY_CLAIM_STALE_MS` old is released, one a
  millisecond younger isn't; a `NULL` claim time is released; `pending`,
  `replayed` and `acknowledged` entries are untouched;
- verification changing in either direction just before and just after the
  claim (the hooked database flips it before and after the first database call
  of the request): an entry is never both reported skipped and replayed, and
  every claimed-or-skipped entry is either replayed or `pending` at the end.
  Against today's separate `SELECT` and `UPDATE`, the "after the first call"
  hook lands between them and fails; against the batch it lands after the
  claim and passes;
- the cron releases a stale claim with `ENRICHMENT_ENABLED=false` and outside
  operating hours.

Rollout: before deploying, count `SELECT COUNT(*) FROM dlq_messages WHERE
status = 'replaying'`; those entries return to `pending` on the first tick.

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
2. If shipped, the throttle skips only the timestamp: a beer whose stored
   `last_seen_at` is in the same `LAST_SEEN_REFRESH_MS` period (1 hour,
   epoch-aligned, so clock hours) gets no write, but its queue eligibility
   (pending enrichment, cleanup retry) is computed the same as without the
   throttle; renames, brewer changes and description changes still write.
   Seven-day windows may see a beer up to an hour late; accepted. Tests: null
   `last_seen_at`, the exact hour boundary, a clock that moved back,
   out-of-order sightings never moving `last_seen_at` backwards, a pending
   row still re-queued while throttled.

   Why fixed hours rather than "within an hour of the stored value" (changed
   after Codex review of the implementation): with a sliding window, step 1
   measures against a `last_seen_at` that every sighting still advances, while
   the throttle stops advancing it, so the step 1 count overstates the savings
   (about twice over for a beer seen every 30 minutes). With fixed hours a
   sighting is skipped exactly when an earlier one landed in the same hour,
   which step 1 can see, so `throttle_eligible` equals the writes the throttle
   would skip.

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
- If the audit ever finds a mismatch, what repairs it depends on the row
  (the admin trigger prepares the hash from the stored text before sending,
  slice 2):
  - a sync whose description differs from the stored original text repairs
    any row (slice 3);
  - never cleaned: the admin cleanup trigger, mode `missing`; from slice 4
    also any sighting of the row while it is uncleaned and not queued in 24
    hours (D7);
  - cleaned at an older `CLEANUP_VERSION`: mode `all`;
  - cleaned at the current version: no automatic path selects it. Mark it
    outdated, guarded on the hash the audit printed as `stored`, then run
    mode `all`, which re-cleans it without blanking the served text:
    `UPDATE enriched_beers SET cleanup_version = NULL WHERE id = '<id>' AND
    description_hash IS '<stored>'` (use `IS NULL` for a NULL hash).

  The audit keeps listing a row until it is repaired.
- `ENRICHMENT_ENABLED` does not stop cleanup's ABV writes; pausing the
  cleanup queue consumer does.
