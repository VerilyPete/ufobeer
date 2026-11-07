# Usage telemetry: `POST /usage`

## Goal

During the beta, BeerSelector reports daily per-install counts of feature use
across the whole app. They are used for diagnostics and to decide where to
focus effort: which features each install uses and how often across its
sessions, how heavy users ("whales") differ from typical ones, and how often
Apple Intelligence falls back.

Each install has a **random install ID**. It is not tied to the Flying Saucer
member ID, the device or any account. The server assigns the day, and the
client sends no timestamps.

The API key ships inside the app, so anyone can post and install IDs can be
invented. Counts are **unverified**. They are good for diagnostics, trends and
ratios across real installs, not for exact figures.

## Decisions

| Topic | Decision |
|---|---|
| Identity | Random UUID per install, generated on first launch and kept in app storage (not Keychain), so a reinstall gets a new ID. Never sent with or derived from the member ID. |
| Storage | D1 table `usage_daily`, one row per (day, install, event, dimensions), atomic upsert |
| Sending | Batched counts, flushed when the app goes to the background |
| Duplicates | Each flush carries a random `batch_id`; a resent batch is ignored (see Client protocol) |
| Unknown input | Parse, don't validate: drop unknown events and fields, never 400 the batch for them |
| Device class | `ai_status` (Apple Intelligence compatibility, see below) + `os_major` (integer) |
| Day | UTC (all users are in US Central for now) |
| Rate limit | Per IP under its own key, outside the shared per-API-key bucket (see Rate limiting) |
| Growth budget | At most 500 new installs per UTC day and 2,000 accepted posts per UTC day (see Growth budget) |
| Audit log | Normal auditing (existing 30-day retention) |
| Retention | Per-install rows kept 180 days during beta (see Retention) |
| Session | Roughly one taproom visit; a new session after 3+ hours in the background, across cold launches (see Session rule) |
| Schemas | Zod, in `src/schemas/request.ts` |

## Events

Coarse feature counters, enough to build a per-install profile ("41 sessions,
88 list views, 23 check-ins queued, 2 rewards queued, 17 suggestion opens")
and to see what share of installs use each feature. This is not fine-grained
tracing: no beer IDs, no search terms, no timings.

Each event fires **once per user action** (unit: one action), from the user
action itself, never from view lifecycle hooks. `RootView` keeps every tab's
screen mounted and hides inactive ones with opacity (`RootView.swift:48-52`),
so `onAppear` would count invisible screens.

| Event | Fires when |
|---|---|
| `session_started` | A session starts (see Session rule) |
| `view_home` | `model.tab` changes to `.home` |
| `view_all_beers` | `model.tab` changes to `.all` |
| `view_beerfinder` | `model.tab` changes to `.finder` |
| `view_tasted` | `model.tab` changes to `.tasted` |
| `view_rewards` | `showRewards` becomes true |
| `view_queue` | `showQueue` becomes true |
| `view_pending_operations` | `showOperations` becomes true |
| `view_missed_credit` | The missed-credit screen is opened by the user |
| `checkin_queued` | A check-in is saved locally by `checkIn` (see Check-ins below) |
| `checkin_from_suggestion` | Same, when `recommendation == true` (also counted in `checkin_queued`) |
| `queue_entry_deleted` | A delete request is accepted (see Rewards and queue below) |
| `operation_retried` | The user retries a pending operation |
| `reward_queued` | A reward-queue request is accepted (see Rewards and queue below); queued, not confirmed redeemed |
| `rewards_refreshed_manual` | The user pulls to refresh or taps Refresh on rewards. Not the automatic load when the screen opens. |
| `beer_rated` | `setBeerRating` is called by the user |
| `missed_credit_resolved` | The user dismisses or resolves a missed credit |
| `untappd_opened` | `openUntappd` is called |
| `suggestions_opened` | `showRecommendations` becomes true |
| `apple_intelligence_used` | Suggestions from the on-device model are published to the screen |
| `local_matching_used` | Local-matching suggestions are published to the screen, whether chosen up front or as a fallback |
| `fallback_deadline_expired` | Apple Intelligence was attempted, failed with `deadlineExpired`, and local results were published |
| `fallback_provider_failure` | Same, with `providerFailure` (includes the model becoming unavailable mid-request) |
| `fallback_invalid_output` | Same, with `invalidOutput` |
| `fallback_context_budget` | Same, with `contextBudgetExhausted` |

**Suggestion outcomes:** the fallback events map one-to-one to
`RecommendationController`'s failure cases. A device on which
`SuggestionMode.resolve` picks local matching up front (no Apple Intelligence)
is **not** a fallback. It shows up as an `ai_status` other than
`apple_intelligence` together with `local_matching_used`. Outcomes are counted only when results are actually
published. Requests that are cancelled or superseded as stale count nothing.
If the controller gains a new failure case, it gets a new event.

**`ai_status`** is the device's `RecommendationCompatibility.current` at the
time the event was recorded (see Client protocol for how dimensions are
attached), mapped one-to-one:

| `RecommendationCompatibility` | `ai_status` |
|---|---|
| `.appleIntelligence` | `apple_intelligence` |
| `.requiresNewerOS` | `requires_newer_os` (hardware capability unknown) |
| `.deviceNotEligible` | `device_not_eligible` |
| `.notEnabled` | `not_enabled` |
| `.modelNotReady` | `model_not_ready` (capable, model still downloading) |
| `.unsupportedLocale` | `unsupported_locale` |
| `.unavailable` | `unavailable` |

This keeps "capable but not ready yet" apart from "not capable", which a
yes/no flag would merge. "Capable devices" in queries means
`apple_intelligence`, `model_not_ready`, `not_enabled` and
`unsupported_locale`. A test on the app side covers every case of the
mapping, so a new case cannot be silently mislabelled.

**Check-ins:** `checkin_queued` counts once, immediately after
`db.enqueue(type:"CHECK_IN_BEER", …)` succeeds inside `checkIn`, whatever
happens to delivery afterwards (`.added`, `.savedForRetry`, `.needsReview`,
or a later reload error). `checkin_from_suggestion` counts at the same point
when `recommendation == true`. Later delivery by `processOperations`,
including automatic retries, counts nothing; a user-initiated retry counts
only `operation_retried`. Confirmed remote delivery is not measured.

**Rewards and queue:** `queueReward` and `deleteQueueEntry` return nothing,
swallow errors, and return quietly when a guard rejects the action, so
"the method returned" is not a success signal. Each counter fires at one
internal point: immediately after `api.request(…)` returns without throwing
**and** the following `guard token == epoch` passes. In `queueReward` that is
where `rewardsNotice` is set; in `deleteQueueEntry` it is just before the
missed-credit check. That means **Flying Saucer accepted the HTTP
submission**. It does not mean the queue change was confirmed: neither
method inspects the response body, and a later `refreshQueue` or `refresh`
failure does not undo the count. Tests: guard exit (no count), transport
error (no count), epoch change during the request (no count), success
followed by a refresh failure (one count).

Each "fires when" row must be confirmed against the app code before the app
slice. Where a row names a method, count on the user-initiated path only.

**Adding an event:** the known-event list lives in one constant in this repo.
The app may ship a new event before the worker knows it. Until the worker is
deployed with it, the event is dropped (see Parsing rules) and nothing breaks.

### Session rule (client)

A session is roughly one taproom visit. The app persists one value,
`lastActiveAt`: the last moment the app is known to have been in use **in the
foreground**. It is written when the app moves to the background, when an
event is recorded **while the scene phase is `.active`**, and at most once a
minute while the app is active. Events that complete while the app is not
active, such as a suggestion request, `queueReward` or `deleteQueueEntry`
finishing after the user has left, are still counted but never touch
`lastActiveAt`. Because it is refreshed
while active, a crash or force-quit loses at most about a minute of it.

The session decision runs on exactly two occasions:

- **Process launch** (cold start), once, from the launch path.
- **Becoming active after a background** within a running process.

iOS reports a warm return as `.background → .inactive → .active`, so the app
cannot just compare adjacent phases. It keeps an in-memory latch,
`pendingDecision`:

- Set to true at process launch and on every `.background`.
- Left unchanged by `.inactive`.
- On `.active`: if true, run the decision and set it to false; if false, do
  nothing.

A Control Center or incoming-call interruption (`.active → .inactive →
.active`) never sets the latch, so it never starts a session. The launch path
and the first `.active` after launch share the same latch, so they decide
once between them.

The decision runs **before** anything else touches `lastActiveAt` on that
transition. Events recorded and the once-a-minute refresh wait until it has
run, so they cannot shorten the measured gap.

The decision:

- No stored `lastActiveAt` (first launch ever): start a session.
- Now minus `lastActiveAt` is 3 hours or more: start a session.
- Otherwise: continue the current session.

Starting a session increments `session_started` once and writes
`lastActiveAt = now` in the same atomic write. Because the rule also runs on a
cold launch and uses `lastActiveAt` rather than a background timestamp:

- iOS killing the app during a 60-minute trivia break does not split the
  visit.
- A crash while active, followed by a reopen the next day, starts a new
  session instead of continuing yesterday's.

The 3-hour gap is one constant; tune it if visits look split or merged.

Client tests: warm and cold return within 3 hours (no new session); warm and
cold return after 3 hours (one new session), driving the full
`.background → .inactive → .active` sequence; first launch; launch followed by
the initial `.active` (one session, not two); repeated `.active → .inactive →
.active` interruptions (no extra sessions); an event recorded at the moment of
return (does not hide a 3-hour gap); an operation that completes 20 seconds
after backgrounding, followed by a return 3 hours after backgrounding (new
session); a crash while active, then a reopen after 3
hours (new session) and within 3 hours (same session).

## Wire shape

```json
{
  "install_id": "3f2b8c1e-5d4a-4e7b-9c0f-1a2b3c4d5e6f",
  "batch_id": "9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  "app_version": "2.4.0",
  "ai_status": "apple_intelligence",
  "os_major": 26,
  "events": [
    { "name": "suggestions_opened", "count": 3 },
    { "name": "fallback_deadline_expired", "count": 1 }
  ]
}
```

Response: `204` in every accepted case: recorded, duplicate batch,
`USAGE_ENABLED` off, every event dropped, or growth budget exhausted.

### Body size

Read the body with `readBoundedJson(request, SMALL_JSON_BODY_MAX_BYTES)` from
`src/utils/body.ts`, the same as other body-bearing routes. It enforces the
byte limit while reading, so a missing or false `Content-Length` cannot get
round it. Oversized or non-JSON bodies get the existing
`boundedJsonErrorResponse`. A dedicated, smaller `USAGE_BODY_MAX_BYTES` is
optional; if added, derive it from a worst-case fixture in
`test/constants.test.ts` as the others are.

### Parsing rules

Two layers, following the outer-envelope / per-item pattern used by
`SyncBeersRequestOuterSchema` + `SyncBeerItemSchema`:

**Envelope (strict, the only source of 400):**

- `install_id`, `batch_id`: UUID strings, normalised to lower case.
- `app_version`: string matching `^\d{1,2}\.\d{1,3}\.\d{1,3}$`.
- `ai_status`: string. Known values (see Events) are stored as-is. Any other
  string, of any length, is stored as `other`, so a new app-side case never
  causes a 400. A non-string is a 400. The body-size limit bounds its length.
- `os_major`: integer (`z.number().int()`, no coercion), 13–99.
- `events`: array of `unknown`, at most 40 items (room for every known event
  plus a few the worker doesn't know yet).
- Unknown top-level fields are ignored. This differs from the `.strict()` used
  elsewhere in `request.ts`, and it is deliberate.

**Each event item (lenient, dropped on failure, never a 400):**

- Unknown fields on an item are stripped, not rejected. The item schema must
  **not** use `.strict()`, unlike `SyncBeerItemSchema`.

- `name` must be one of the known events. Unknown names are dropped.
- `count` must be an integer (`z.number().int()`, no coercion) in 1–500.
  `1.5`, `"3"`, `null`, `0`, negative, missing and non-object items are all
  dropped.

**After per-item parsing:**

- Repeated names are summed, then **clamped to 500 per event per post**.
- The result is a domain type: envelope fields plus only known events with
  final counts. A dropped-item count is logged and never stored.
- If no events survive, return 204 without writing to the usage tables.

## Client protocol (BeerSelector)

The server deduplicates on `(install_id, batch_id)`. That is only correct if
the client follows these rules:

1. **Live counters** accumulate events and are persisted, keyed by their
   **dimension tuple** (`app_version`, `ai_status`, `os_major`) as it was when
   each event was recorded. An app upgrade or a change in Apple Intelligence
   status starts a new tuple; old counts keep the tuple they were recorded
   under.
2. **Freezing a batch:** on flush, if there is no pending batch, take the
   tuple with the oldest unsent counts and create a **pending batch** for it,
   with a new `batch_id` and `created_at`. A batch carries exactly one tuple,
   which becomes the envelope's `app_version`, `ai_status` and `os_major`. For
   each event it takes `min(live count, 500)` and leaves the remainder in the
   live counters,
   so no event is ever sent above the server's per-item limit. Creating the
   pending batch and subtracting from the live counters is **one atomic
   write**: a single transaction, or a single persisted state snapshot. A
   crash at any point leaves either the old state or the new one, never the
   same events in both places. The pending batch is never changed after this.
3. **Sending:** send the pending batch exactly as frozen. On `204`, delete it.
   On any other outcome (error, timeout, app killed mid-request), keep it and
   resend the **same** payload and `batch_id` at the next flush. Never resend
   immediately.
4. **New events during an outstanding batch** go into the live counters,
   never into the pending batch. Only one pending batch exists at a time; the
   live counters become the next batch once it is acknowledged.
5. **Expiry:** delete a pending batch whose `created_at` is more than 7 days
   old, measured from when it was frozen, not from the last attempt.
6. **One flush at a time:** freezing, sending and handling the response are
   serialised (a single actor or queue). A second flush while one is in
   flight does nothing.
7. **Draining the backlog:** after a `204`, if unsent counts remain (another
   dimension tuple, or excess carried over the 500 limit), the same flush
   freezes and sends the next batch straight away, up to **5 batches per
   flush**. This is not a retry: it only continues after a success. Any
   failure ends the flush, and the next flush resumes from the persisted
   state. The flush runs inside an iOS background-task assertion, so going to
   the background does not cut it short.
8. **When flushes run:** on moving to the background, and when a new session
   starts. Leftover work is attempted on the next visit and continues over
   later flushes. More than 5 waiting batches, or a 429, can spread delivery
   over several flushes.

Client tests: response lost after the server commits (same batch resent,
counted once); app killed mid-request; app killed at each persistence step of
freezing and of deleting after a 204 (no event lost, none sent twice); events
recorded while a batch is outstanding (they arrive in the next batch, not
lost or merged); events recorded before and after an app upgrade (sent in
separate batches, each with its own `app_version`); counts of 500, 501 and a long offline period (excess carried
forward and sent by the same flush's drain, nothing dropped); two tuples
after an upgrade both reaching the server in one flush; more than 5 waiting
batches (5 sent, the rest on the next flush); a failure mid-drain
(remaining batches wait for the next flush, nothing resent immediately);
overlapping flush triggers; expiry at 7 days. The
request contract (slice 7) cannot catch these; they belong in the app's own
tests.

## Rate limiting

After auth, `src/index.ts` rewrites `clientIdentifier` to the API-key hash,
and every install shares one key. The shared post-auth limiter
(`RATE_LIMIT_RPM`, 60/min) is therefore **fleet-wide**, not per user. A tight
per-key limit on `/usage` would reject real users as soon as a handful
background the app in the same minute, and `/usage` traffic would eat into the
budget `/beers` depends on.

So `/usage`:

- Is still covered by the existing pre-auth per-IP limiter (`preauth:{ip}`).
- Is routed **after auth but before the shared per-key limiter**, so it never
  consumes the `/beers` budget.
- Gets its own per-IP bucket, `usage:{ip}`, from `requestContext` (not
  `authedContext`), with a small limit (e.g. 6/min; normal clients send about
  one post per session).
- Is **not** limited by `install_id`, since it is client-chosen and free to
  invent.
- Maps a degraded limiter to 503 like other routes. The client already never
  retries immediately.

Tests must include several installations sharing one API key from different
IPs, all accepted, while one IP over its limit gets a 429.

## Growth budget

The per-IP limit bounds request rate, not storage. One IP posting six times a
minute with a new invented install ID each time could otherwise create about
200,000 `usage_daily` rows a day. Two daily budgets, both constants in
`src/constants.ts`, cap that:

- **New installs:** at most 500 install IDs first seen per UTC day. A post
  from an unknown install ID after the cap is reached is dropped. Installs
  already known keep counting.
- **Accepted posts:** at most 2,000 posts written per UTC day across all
  installs. After the cap, posts are dropped until the next UTC day.

Dropped posts still get a 204, so clients don't retry. Each drop is logged
and counted in Analytics Engine with its reason (`new_install_cap`,
`daily_post_cap`), so an attack, or real growth past the caps, shows up. Under
sustained abuse, real users lose data for the rest of that day. That is
acceptable during beta. Worst case is 2,000 posts × the number of known events (25 today) = 50,000 rows a day.

Both limits are enforced inside the same transaction as the write (see
Tables), so they hold under concurrent posts.

A row-count alert on `usage_daily` is part of slice 6 (docs and monitoring).

## Tables (migration 0012)

```sql
CREATE TABLE IF NOT EXISTS usage_daily (
  day         TEXT    NOT NULL,  -- YYYY-MM-DD, UTC
  install_id  TEXT    NOT NULL,
  event       TEXT    NOT NULL,
  app_version TEXT    NOT NULL,
  ai_status   TEXT    NOT NULL,
  os_major    INTEGER NOT NULL,
  count       INTEGER NOT NULL,
  PRIMARY KEY (day, install_id, event, app_version, ai_status, os_major)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_install ON usage_daily (install_id, day);

CREATE TABLE IF NOT EXISTS usage_installs (
  install_id     TEXT NOT NULL PRIMARY KEY,
  first_seen_day TEXT NOT NULL,
  last_seen_day  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_installs_first_seen ON usage_installs (first_seen_day);
CREATE INDEX IF NOT EXISTS idx_usage_installs_last_seen  ON usage_installs (last_seen_day);

CREATE TABLE IF NOT EXISTS usage_batches (
  install_id  TEXT    NOT NULL,
  batch_id    TEXT    NOT NULL,
  request_id  TEXT    NOT NULL,  -- the request that admitted this batch
  received_at INTEGER NOT NULL,  -- unix ms
  PRIMARY KEY (install_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_batches_received ON usage_batches (received_at);

CREATE TABLE IF NOT EXISTS usage_ingest_daily (
  day   TEXT    NOT NULL PRIMARY KEY,  -- YYYY-MM-DD, UTC
  posts INTEGER NOT NULL
);
```

### Write: budgeted, deduplicated and atomic

One `DB.batch()`, which D1 runs as a single transaction; D1 executes writes
for a database one at a time, so concurrent posts see each other's committed
results. The handler computes `day` (UTC) once and passes the same value to
every statement, so a post straddling midnight is charged to one day.

The admission decision is made **once**, by step 2, and carried through the
rest of the batch by the `request_id` it writes (`requestContext.requestId`,
a fresh `crypto.randomUUID()` per request). Nothing is counted against a
budget unless the post was admitted.

1. **Admit or touch the install**, only if the post is new and today's post
   budget is not spent:

   ```sql
   INSERT INTO usage_installs (install_id, first_seen_day, last_seen_day)
   SELECT :install, :day, :day
   WHERE NOT EXISTS (SELECT 1 FROM usage_batches WHERE install_id = :install AND batch_id = :batch)
     AND COALESCE((SELECT posts FROM usage_ingest_daily WHERE day = :day), 0) < :post_cap
     AND (EXISTS (SELECT 1 FROM usage_installs WHERE install_id = :install)
          OR (SELECT COUNT(*) FROM usage_installs WHERE first_seen_day = :day) < :install_cap)
   ON CONFLICT (install_id) DO UPDATE SET last_seen_day = excluded.last_seen_day;
   ```

2. **Admit the post** by recording the batch with this request's ID, only if
   the install exists and the budget is not spent. A duplicate hits the
   primary key and does nothing.

   ```sql
   INSERT INTO usage_batches (install_id, batch_id, request_id, received_at)
   SELECT :install, :batch, :request, :now
   WHERE EXISTS (SELECT 1 FROM usage_installs WHERE install_id = :install)
     AND COALESCE((SELECT posts FROM usage_ingest_daily WHERE day = :day), 0) < :post_cap
   ON CONFLICT (install_id, batch_id) DO NOTHING;
   ```

3. **Count the events**, one upsert per event, only if step 2 admitted this
   request:

   ```sql
   INSERT INTO usage_daily (day, install_id, event, app_version, ai_status, os_major, count)
   SELECT :day, :install, :event, :version, :ai, :os, :count
   WHERE EXISTS (SELECT 1 FROM usage_batches
                 WHERE install_id = :install AND batch_id = :batch AND request_id = :request)
   ON CONFLICT DO UPDATE SET count = count + excluded.count;
   ```

4. **Charge the budget**, under the same guard:

   ```sql
   INSERT INTO usage_ingest_daily (day, posts)
   SELECT :day, 1
   WHERE EXISTS (SELECT 1 FROM usage_batches
                 WHERE install_id = :install AND batch_id = :batch AND request_id = :request)
   ON CONFLICT (day) DO UPDATE SET posts = posts + 1;
   ```

(D1 binds positional `?` parameters; named ones are shown for readability.)

Boundaries are exclusive before charging: at most `post_cap` posts and at
most `install_cap` new installs are admitted per day. Outcomes:

| Post | Result |
|---|---|
| New batch, known install, budget left | Counted; budget charged once |
| Duplicate batch | Nothing written; budget not charged |
| New install, install cap reached | Nothing written; budget not charged |
| Previously unseen batch, post budget spent | Nothing written; batch not recorded. A compliant client deletes it on the 204, so it is lost. It counts the next day only if a resend happens anyway, e.g. after a lost response. |
| Write fails | Transaction rolls back; nothing recorded; a later resend still counts |

5. **Classify the outcome** with a final `SELECT` in the same batch, so it
   sees the same transaction state as the writes. First match wins:

   | Condition | Outcome |
   |---|---|
   | A batch row exists for (`install`, `batch`) with this `request_id` | `admitted` |
   | A batch row exists for (`install`, `batch`) with another `request_id` | `duplicate` |
   | Today's `posts` is at or above `post_cap` | `daily_post_cap` |
   | No `usage_installs` row for `install` | `new_install_cap` |

   The handler logs this and sends it to Analytics Engine. No read outside
   the batch is used, so concurrent posts cannot make the reported reason
   wrong.

Slice 2's tests cover every row of both tables, each cap exactly at its
boundary, a duplicate replayed while the budget is at its cap (no charge), an
existing install still counting after the install cap is reached, and the
same `batch_id` from a different install counting separately.

Counts are integers by the time they reach the helper; the helper's types
should not accept anything else.

## Retention

Cleanup jobs follow the existing pattern in `src/handlers/scheduled.ts`
(`reapOldRateLimits`) and `src/audit.ts` (`DELETE ... WHERE ... LIMIT ?`):

- They run on **every** cron tick, **before** the enrichment kill-switch,
  operating-hours and schedule checks, so they keep running while enrichment
  is paused.
- Each one is bounded by a `*_REAP_LIMIT` constant and wrapped in its own
  try/catch, so one failure doesn't block the others or enrichment.
- Each uses an index on its cutoff column (shown above).

| Table | Deleted when | Index |
|---|---|---|
| `usage_batches` | `received_at` older than 8 days | `idx_usage_batches_received` |
| `usage_daily` | `day` older than 180 days | primary key (leading `day`) |
| `usage_installs` | `last_seen_day` older than 180 days | `idx_usage_installs_last_seen` |
| `usage_ingest_daily` | `day` older than 30 days | primary key |

**Throughput:** cleanup must remove rows faster than they can arrive. At the
growth budget, `usage_daily` gains at most 2,000 × (known events) rows a
day, 50,000 with today's 25 events. The cron runs 72 times a day, so each tick
must delete at least about 700 rows to keep up. Recompute this whenever events
are added. Each reap limit is set to **5,000 rows per tick** (about 360,000 a
day), several times the worst-case ingest, so a backlog from about a day of
missed ticks drains within a day. Longer outages take proportionally longer. `usage_batches` gains at most 2,000 rows a day and
`usage_installs` at most 500, so the same limit is ample. Slice 6's monitoring
reports the age of the oldest row past its retention window. If that exceeds
a day, cleanup is falling behind.

The 8-day deduplication window covers clients that follow the protocol (they
delete batches after 7 days). It does not prove that an older replay can't
arrive. A resend after 8 days would be counted again; that is acceptable for
unverified counts.

Tests cover each window at its boundary, the reap limit, and the cleanup
running while `ENRICHMENT_ENABLED=false` and outside operating hours.

## Example questions the data answers

- **Per-install profile:** for one `install_id` over 30 days, the total of
  `session_started` and of each other event, for example "41 sessions, 88
  list views, 23 check-ins queued, 2 rewards queued, 17 suggestion opens".
- **Where to focus:** for each event, the share of active installs that used
  it at least once in 30 days, and the average count per session among those
  that did.
- Whales vs typical users: installs bucketed by sessions or check-ins over
  30 days, with each bucket's feature mix.
- Fallback rate per install, by `ai_status`.
- Installs reporting per day: distinct `install_id` per `day`. `day` is the
  UTC day the server **received** the counts, not when they happened. An
  install that was offline uploads old counts on the day it reconnects, so
  daily figures are receipt-day totals.
- Diagnostics: one install's events by day and app version, when a user
  reports a problem and shares their install ID. This needs the app to show
  its install ID somewhere, such as an About screen.

## Slices (TDD, each one shippable)

Ingestion is not switched on until retention exists. `USAGE_ENABLED` defaults
to `false` until slice 5 ships.

1. **Schema + parser.** Pure function from `unknown` to the parsed report or
   an envelope error. Tests cover every parsing rule, including: bad or
   missing UUIDs are a 400; IDs are lower-cased; non-integer, string, `null`
   and missing counts are dropped; duplicates are summed and clamped to 500;
   unknown names and top-level fields are ignored; an all-dropped batch gives
   an empty event list.
2. **Migration + write helper.** All four tables and the budgeted,
   deduplicated write, tested against D1 in the Workers pool (cases listed
   under Write), plus accumulation across posts, separate rows per install
   and dimension, and the UTC day boundary.
3. **Retention.** The four cleanup jobs in the cron, as above.
4. **Handler + route, switched off.** `readBoundedJson`, auth, the `/usage`
   per-IP limiter placed before the shared per-key limiter, the
   `USAGE_ENABLED` kill switch (default `false`), 204 for every accepted case
   (no writes to the four usage tables when disabled or when nothing
   survives; rate limiting and audit logging still run as on every route, so
   full-route tests must not assert zero D1 writes), drop-reason
   analytics, and a CORS preflight entry if needed. Tests: oversized body with
   a missing or false `Content-Length` is rejected; installs sharing a key are
   not throttled together; a `/usage` flood does not consume the shared
   post-auth API-key bucket (`RATE_LIMIT_RPM`) that `/beers` uses. `/usage`
   **does** share the pre-auth `preauth:{ip}` bucket with every route, so 30
   `/usage` posts in a minute from one IP will 429 that IP's `/beers` calls.
   That is intended, and a test documents it.
5. **Switch on.** Set `USAGE_ENABLED=true` once slices 1–4 are deployed.
   This is safe before any app sends telemetry; nothing arrives until the app
   ships it.
6. **Docs + monitoring.** `.claude/api-endpoints.md` and AGENTS.md (endpoint,
   tables, env var, per-IP limit, growth budgets, retention, counts are
   unverified). Sample `wrangler d1 execute` queries for the example
   questions. A `usage_daily` row-count alert, a check on the drop-reason
   analytics, and the oldest-expired-row age for each usage table.
7. **Request contract.** Agree the mechanism with BeerSelector **before**
   starting this slice. **The telemetry-sending app build must not be
   released until this contract passes**: a 204 makes the app delete its
   batch, so an encoder mismatch would otherwise lose beta data silently.
   The server slices do not depend on it. Acceptance: a canonical payload produced by the app's
   real encoder is run through this repo's real parser, and the test asserts
   the **resulting events and counts**, not just that the envelope is
   accepted, so a misspelled name or string count fails the build instead of
   being silently dropped. A JSON Schema export (`z.toJSONSchema`) can
   document the shape but cannot be the only check, since the event items are
   deliberately lenient.

The BeerSelector side (install ID, event triggers, session rule, client
protocol and their tests) is planned in that repo.

## Privacy label

This is not anonymous. Every retained field is mapped to Apple's categories by
what it is used for:

| Data | Where kept | Used for | Apple category |
|---|---|---|---|
| Install ID | `usage_daily`, `usage_installs`, `usage_batches` | Joining one install's usage | Identifiers → Device ID |
| Feature counts | `usage_daily` | Prioritising features | Usage Data → Product Interaction |
| App version, `ai_status`, OS major | `usage_daily` | Diagnosing fallbacks by device | Diagnostics → Other Diagnostic Data |
| Client IP | `audit_log` (30 days), Analytics Engine `client_id` (~3 months), `rate_limits` keys (short-lived) | Security, abuse prevention, debugging | Classify with Apple's guidance on IP addresses; most likely Diagnostics if retained for debugging |
| User agent, timing, status, errors | `audit_log` (30 days) | Debugging and abuse prevention | Diagnostics → Performance Data / Other Diagnostic Data |

Purposes: **Analytics** and **App Functionality**. Linked to the user via the
install ID. **Not used for tracking**: never shared with third parties or
combined with other companies' data.

The IP row needs checking against Apple's current guidance
(<https://developer.apple.com/app-store/app-privacy-details/>) before
submission. It is not settled here.

## Later

- Add `GET /admin/usage` if ad-hoc queries become repetitive.
- Reassess the stable ID, retention and growth budgets when the app leaves
  beta.
- Separately from this plan: the shared post-auth limiter is fleet-wide for
  `/beers` too (all installs share one 60/min bucket).
