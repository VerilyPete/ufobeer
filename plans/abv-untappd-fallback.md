# ABV lookup: Untappd fallback via Exa, and a wider enrichment skip list

Status: planned, 2026-11-10. Not started. Reviewed with Codex over 9 fresh-session rounds; round 9 found only nits, applied.

## Why

`(512) 18th Anniversary` (id `22212289`) went on tap with no ABV in its
description. Perplexity answered `unknown`, so the row was marked `not_found`.
Its Untappd page already showed 8% ABV. Someone had to set it by hand.

Experiments on 2026-11-10 (scripts and raw results were kept in the session
scratchpad, not in the repo) showed:

- **The query is not the problem.** A sharper Perplexity prompt (prefix
  stripped, Flying Saucer style and brewery location added, domains limited to
  Untappd/BeerAdvocate/RateBeer) still answered `unknown` 9 times out of 9.
  `search_recency_filter`, `search_after_date_filter` and `sonar-pro` did no
  better. Asked to list its sources, Perplexity had the festival beer list and
  an old copy of (512)'s Untappd brewery page, but never the beer's own page.
  Its index had not picked the page up yet.
- **Exa search, limited to `untappd.com` and with live crawling, finds the
  page.** It returned 8% on 3 of 3 runs. On 20 controls whose ABV was known
  from their descriptions, with a strict title match, it got 10 right, 8 "no
  answer" and 2 that disagree with the description. Both of those disagree for
  Perplexity too: Avery Kaiser came back as 8 against 9.3, and Boulevard Cellar
  Key as 13.8 against 13. They look like vintage changes, not lookup errors.
  Cost was about $0.007 per lookup. Leaving the style out of the query changed
  nothing.
- **Exa's `/answer` endpoint said `unknown`**, like Perplexity. Only search
  plus our own matching works.
- **Combined result on the same set:** Perplexity first, then Exa on a
  Perplexity `unknown`, gives 17 of 20 controls plus the target.

Of the 15 recent `not_found` rows, the 18th Anniversary was the only real
beer. The other 14 are blends, flights, pairings and mixed drinks, which have
no ABV to find. Each one costs a Perplexity lookup every day while it is on
tap.

## Decisions (all settled 2026-11-10)

1. **`enrichment_source` names the provider that answered (decided
   2026-11-10).** An ABV found by the fallback is `exa`. One Perplexity
   found stays `perplexity`. Name the provider, not the site it read.
   - The app's decoder throws `BeerError.invalidResponse` for any value
     outside `description`, `description-fallback`, `perplexity` and
     `manual` (BeerSelector `native-ios/Core/EnrichmentService.swift:200`),
     and BeerSelector's TS contracts (`src/contracts/enrichment.ts`) pin the
     same set.
   - **Compatibility by negotiation (decided 2026-11-10).** The database
     always stores `exa`. The response carries `exa` only when the request
     has `X-Enrichment-Sources: exa`. Without the header it carries `null`,
     which every build accepts, with the ABV and confidence unchanged.
     - New builds send the header and decode `exa`. Old builds never see
       it, so there's no adoption tracking and no flip date.
     - The app change (accept `exa`, send the header) is handed off in
       `plans/handoff-beerselector-accept-exa-source.md`. It can ship
       whenever it suits.
     - AGENTS.md "Golden Taproom Contracts" still applies: the cases with
       the header need BeerSelector's merged schema.
2. **Confidence (decided 2026-11-10): 0.8** for an exact Untappd title
   match, as a new `ABV_CONFIDENCE_FROM_EXA`. That sits between Perplexity
   (0.7) and description ABVs (0.9). The app only stores and passes
   confidence through and never branches on it (checked on BeerSelector
   `main`, 2026-11-10).
3. **Terms (decided 2026-11-10): approved.** We read Untappd content
   through Exa's index and live crawler, and never fetch Untappd ourselves.

## Slice 1: skip list covers blends, flights and pairings (no new dependency)

`shouldSkipEnrichment(brewName)` (`src/config.ts`) becomes
`shouldSkipEnrichment({ brewName, brewer })`. It has six call sites, and
each one already has the brewer:
- `src/queue/helpers.ts`;
- `src/queue/cleanup.ts`;
- `src/db/helpers.ts`, twice in `categorizeBeer`;
- `src/handlers/enrichment.ts`, twice (`:81` filters the eligible rows and
  `:103` picks the rows to mark skipped).

Both sweep calls must pass the brewer. If only one does, filtering and skip
marking disagree.

New rules, each with a test:

- **Placeholder brewers.** Skip when the trimmed brewer, ignoring case, is
  exactly `n/a`, `unassigned`, `various` or `flights`. Seen on Flying
  Saucer: `Snake Bite`/`unassigned`, `Half and Half`/`Various`,
  `Black Velvet`/`Various`, `The Dark Side Flight`/`n/a`.
  - A blank or missing brewer is **not** a skip signal. The brewer is
    optional in Flying Saucer data (`src/schemas/request.ts:31`).
  - `skipped` is terminal: `categorizeBeer` returns `unchanged` for it
    (`src/db/helpers.ts:238`), so a real beer that arrived without a brewer
    would never be looked up again. (Codex review, 2026-11-10.)
- **Flying Saucer's in-house blends.** `Brewfusion` as a brewer (its
  `Black & Pale`, `Black & Red`, `Black & White`, `Chocolate Covered
  Strawberry`). Confirmed 2026-11-10 that Brewfusion is the Saucer's own
  label for layered and blended pours, not a brewery. The stored
  descriptions are "Guinness layered on top of a pale ale" and "A
  brewfusion of Samuel Smith … and Great Divide …". The style field shows
  `Brew Fusion` for `Black Velvet`, and TapHunter lists a "Flying Saucer
  Flights/Brew Fusions" menu. Match it ignoring case and spaces, so
  `Brew Fusion` and `Brewfusion` both count.
- **Pairings.** `Saint Arnold Anniversary Side By Side`, scoped to its
  brewer `Saint Arnold Brewing Co.` (name plus brewer, not a pattern).
  Modist Brewing makes a real beer called "Side by Side by Side", so a
  `side by side` pattern would skip it for good (Codex review round 4).
  Tests: the Saint Arnold pairing is skipped, and Modist's beer is still
  looked up.
- **Name plus brewer** for what's left: `Dark Side of the Moon` only when
  the brewer is `Guinness Ltd` (a mixed pour). Turk's Head Brewery makes a
  real schwarzbier with the same name, so a name-only rule would skip it for
  good (Codex review round 3). Exact-name additions are scoped to the brewer
  they were seen with unless the name can't be a real beer.
- `Russian Imperial Stout Ice Cream Float`: extend the root beer float rule
  to `/\bice cream float\b/i`.
- Tests: the Guinness pour is skipped, and Turk's Head's `Dark Side of the
  Moon` is still looked up.

Counter-examples that must still be looked up (tests):

- A real beer with `&` in its name from a real brewer.
- `Class 5 Pale Ale`, already guarded by the class-ticket pattern.
- A beer whose brewer merely contains "various" as part of a word.
- A real beer with an omitted, null or blank brewer: still looked up.

Recovering skipped rows (Codex review rounds 2 and 4). `skipped` is
terminal today (`src/db/helpers.ts:238`).
- **The problem.** A real beer first seen under a placeholder brewer, or
  caught by a rule that is later narrowed, would stay skipped for good.
  Watching for a brewer *change* isn't enough: `/beers/sync` overwrites the
  brewer without touching the status (`src/handlers/beers.ts:908`), so a
  taplist refresh would never see a difference.
- **The fix: re-check by rule, not by change.** A separate recovery scan
  runs from the cron next to `selectAndQueuePendingEnrichment`, never
  inside its query (Codex review round 5). That query has an unordered
  `LIMIT` (`src/handlers/enrichment.ts:69`), so still-blocklisted rows mixed
  into it could fill that limit every day and starve real work.
  - The scan visits **every** recently seen skipped row on each run,
    reading pages of 200 ordered by `id` with a keyset cursor
    (`WHERE id > ?`), until none are left (Codex review round 6). A fixed
    newest-200 window could keep missing a corrected row behind 200
    frequently refreshed blocked ones.
  - Hard cap: 2,000 rows per run. If it's reached, `console.error` (the
    error-alerts tail worker emails it), and the next run starts again from
    the beginning. Production has about 42 skipped rows, so the cap means
    something is wrong.
  - It loads `skipped` rows with `abv IS NULL` seen in the last 7 days
    (`ABV_LOOKUP_RECENTLY_SEEN_MS`), and runs `shouldSkipEnrichment` on
    their current name and brewer.
  - Rows that still match are left untouched; nothing is written for them.
  - A row that no longer matches goes back to `pending`, and is queued
    through the existing quota-checked path.
  - The write is guarded:
    `WHERE id = ? AND enrichment_status = 'skipped'` plus the normalized
    name and brewer comparison described in slice 4.
- **The skip write gets the same guard.** The sweep's existing
  `UPDATE … SET enrichment_status = 'skipped' WHERE id = ?`
  (`src/handlers/enrichment.ts:108`) becomes conditional on the status,
  name and brewer it selected. Otherwise a brewer fixed between the select
  and the write would be overwritten with a permanent skip.
- **Tests:**
  - Skipped under `unassigned`, `/beers/sync` corrects the brewer, the next
    sweep sets `pending` and queues the row.
  - A rule removed from the list releases the rows it had skipped.
  - The brewer changes between the sweep's select and its skip write: the
    row stays eligible.
  - The re-check only considers recently seen rows.
  - With more still-blocklisted rows than one page, pending work is still
    queued by the normal sweep in the same run.
  - A corrected row placed after 200+ still-blocked rows is recovered in
    the same run.

Existing `not_found` rows need no migration. The cron sweep
(`selectAndQueuePendingEnrichment`) reselects `not_found` rows once a day and
already marks blocklisted ones `skipped`. Verify that with a test on a
`not_found` row that the new rules match.

Out of scope: Flying Saucer's `brew_style` (`Mix`, `Flight`) would be a
cleaner signal, but it is not stored in `enriched_beers` and is dropped
before `insertPlaceholders`. Storing it needs a migration and plumbing.
Revisit if the name and brewer rules keep missing things.

## Slice 2: Untappd title matching (pure module, no network)

`src/services/untappdMatch.ts`, pure functions tested with the real titles
from the experiment:

- `parseUntappdTitle(title)`. Drop any ` | Photos`-style suffix and a
  trailing ` - Untappd`. The last ` - ` part is the brewery and everything
  before it is the beer, so `D'Or - Tropical Fruit Beer - Brouwerij
  Lindemans` keeps its name.
- `isUntappdBeerUrl(url)`: `untappd.com/b/` only. Brewery, venue and
  `business.untappd.com` pages never count.
- `matchesBeer({ ourName, ourBrewer }, { beer, brewery })`:
  - **Brewery identity.** Take each side's brewery words, dropping generic
    words (`brewing`, `brewery`, `brewers`, `brew`, `co`, `company`,
    `brouwerij`, `brasserie`, `beers`). The two sets must be **equal**.
    (Tightened from "the smaller set contained in the larger" in Codex review
    of slice 2: containment accepted `Acme Other Brewing` for `Acme Brewing`.)
    - `(512) Brewing Co.` → {512} = `(512) Brewing Company` → {512}.
    - `Eureka Heights` = `Eureka Heights Brew Co`.
    - `Traquair` does **not** match `Traquair House Brewery`, and `Lone Star`
      does not match `Lone Pint`.
    - Either side empty after filler means no match.
  - **Beer name.** The core tokens must be *equal as an ordered sequence*.
    No set or subset comparison, so `Double Double IPA` is not
    `Double IPA` (Codex review round 2). Drop:
    - container tags (`(CAN)`, `(BTL)`, …);
    - a leading parenthetical, but only when its tokens are the brewer's
      own tag (the `(512)` in `(512) 18th Anniversary` by `(512) Brewing
      Co.`). Any other parenthetical, such as a vintage `(2024)` or a
      variant, is kept as part of the name.
    - the brewer's *complete* name (its identity words, in order) as a
      leading prefix of the name, once, applied identically to both sides
      (`Avery Kaiser` → `Kaiser`, `Sierra Nevada Pale Ale` → `Pale Ale`).
      A partial brewer name or a brewer word in the middle or at the end is
      kept: `Double IPA` by Double Mountain stays `Double IPA` (Codex review
      round 3, and slice 2 review);
    - filler (`the`, `ale`, `beer`, `brewing`, `co`, `company`). Keep `x`
      and Roman numerals as real words: `Reserve X` is not `Reserve`.
      Collaboration names (`Other Half x Parish x …`) don't match Untappd's
      shorter titles anyway, and the matcher refuses them.
  - An empty core on either side is never a match.
- `abvFromPage(text, matchedBeerName)`: read the ABV only from the stats
  block that belongs to the matched beer, and return null whenever
  ownership can't be established.
  - **Ownership.** The stats block is an ABV field (`<number>% ABV` or
    `N/A ABV`) next to an IBU field. Being adjacent proves nothing on its
    own: a related beer's full block could come first (Codex review round
    3). The page text must open with the matched beer's own heading (its
    name, then brewery), and the block must sit in that heading's section,
    before any related-beer, review or check-in section begins.
  - **Exact boundaries come from the recordings.** Define the heading and
    the section boundary from the recorded fixtures below, not from this
    description.
  - If that block's ABV is `N/A`, or the block isn't found inside the
    beer's own section, return null.
  - Never fall back to any other `% ABV` on the page.
  - The value must be inside `MIN_BEER_ABV`..`MAX_BEER_ABV`.
- **Fixtures first.** Before writing `abvFromPage`, record real Exa
  `/search` responses (title, URL, text) for the 18th Anniversary and a few
  controls, and commit them as test fixtures. This costs a few cents.
  Define the ownership rule from them. If the recorded text doesn't let
  ownership be established reliably, the fallback returns null, and slice
  4 doesn't ship until it can.

Required test cases:

| Ours | Untappd title | Expect |
|---|---|---|
| `(512) 18th Anniversary` / `(512) Brewing Co.` | `18th Anniversary - (512) Brewing Company \| Photos` | match |
| same | `17th Anniversary - (512) Brewing Company - Untappd` | no match |
| same | `Hazy Double IPA - (512) Brewing Company - Untappd` | no match |
| `(512) Whiskey Barrel Aged Pecan Porter` | `(512) Whiskey Barrel Aged Double Pecan Porter - (512) Brewing Company - Untappd` | no match (different beer) |
| `Avery Kaiser (CAN)` / `Avery Brewing Co.` | `The Kaiser - Avery Brewing Co. - Untappd` | match |
| `Firestone Walker Pivo Pilsner` | `Pivo Pils - Firestone Walker Brewing Company - Untappd` | no match (refuse rather than guess) |
| any | `(512) Brewing Company - Austin, TX - Beers and Ratings \| Untappd` (brewery page) | rejected by URL |
| `(2024) Reserve` / `Acme Brewing` | `(2025) Reserve - Acme Brewing - Untappd` | no match (vintage kept) |
| `Light` / `Lone Star Brewing` | `Light - Lone Pint Brewery - Untappd` | no match (brewery not contained) |
| `Traquair House (BTL)` / `Traquair` | `House Ale - Traquair House Brewery - Untappd` | no match (brewery sets differ) |

| `Double IPA` / `Acme Brewing` | `Double Double IPA - Acme Brewing - Untappd` | no match (ordered sequence) |
| `Reserve` / `Acme Brewing` | `Reserve X - Acme Brewing - Untappd` | no match (`x` kept) |
| `Reserve` / `X Brewing` | `Reserve X - X Brewing - Untappd` | no match (brewer word not at the start is kept) |

`abvFromPage` cases:
- `… 8% ABV 30 IBU …` gives 8.
- `… N/A ABV N/A IBU … Similar beers … 8% ABV` gives null.
- No stats block for the target (its ABV is missing), but a related beer's
  `8% ABV` appears early, gives null.
- The target's stats are absent and a related beer's *complete* block
  (`Other Beer … 8% ABV 30 IBU`) appears inside the window, gives null.
- Text that doesn't open with the matched beer's heading gives null.
- No ABV field in the first 600 characters gives null.
- An out-of-range value gives null.

## Slice 3: choose the `enrichment_source` label per request

This must be deployed before slice 4 writes the first `exa` row. Otherwise
that row reaches old builds and they reject the response. It doesn't wait
on the app: until the app sends the header, every client gets `null` for
`exa` rows.

- **One pure function**, `wireEnrichmentSource(stored, acceptedSources)`.
  - `description`, `perplexity`, `manual`, `null` and the legacy
    `description-fallback` pass through unchanged.
  - Any other stored value becomes `null` unless `acceptedSources` contains
    it. Today that only affects `exa`.
  - New sources are therefore safe by default. Adding one later needs no
    change here, only a client that asks for it.
- **`acceptedSources`** is parsed from `X-Enrichment-Sources`: a
  comma-separated list, trimmed and lower-cased, ignoring unknown tokens.
  It is capped in size, because the header is client-controlled.
- **Apply it where each response is serialized, never before caching.**
  That covers the live `/beers` merge (`src/handlers/beers.ts`, around
  `enrichment_source: enrichment?.source`), cache hits and the stale
  fallback served from `store_taplist_cache`, and `/beers/batch`.
  - The cache keeps the stored value (`exa`).
  - Check every place that emits `enrichment_source` with a grep, and test
    each one.
- **ETag and caching.**
  - Fold the normalized accepted-source set into `buildCombinedEtag`'s
    input for `/beers`, including the cached and stale-fallback paths.
    Otherwise an app that upgrades gets `304`s that pin its old `null`
    labels.
  - Send `Vary: X-Enrichment-Sources` on `/beers` and `/beers/batch`.
  - Headerless clients keep today's ETag. Clients sending the header get a
    one-time full response.
- **CORS:** none. The worker rejects every `OPTIONS` request
  (`src/index.ts:158`), and the native app doesn't preflight. A browser
  client sending this header would need its own CORS design.
- **Contract tests:**
  - Seed `exa` rows in `contract-test/fixtures.ts` and the Golden Taproom
    live and batch seeds.
  - Without the header, assert source `null` with the ABV intact. That
    passes against BeerSelector's current schema, so it lands now.
  - With the header, assert source `exa` and confidence `0.8`. That lands
    once BeerSelector's change is on its `main`.

Tests:
- Pass-through for each known value.
- `exa` becomes `null` without the header and stays `exa` with it.
- Header parsing: spacing, case, duplicates, junk tokens, oversized input.
- Each response path (live, cache hit, stale, batch).
- ETag differs between headerless and header-sending requests, is stable
  within each, and a `304` round trip works for both.
- Cross-variant conditionals, on the live, cached and stale paths (the
  conditional checks happen before serialization, `src/handlers/beers.ts:169`
  and `:500`):
  - a headerless ETag sent *with* the header returns `200` and `exa`;
  - a header-variant ETag sent *without* the header returns `200` and
    `null`.
- `Vary: X-Enrichment-Sources` is present on `200` and `304` responses.

## Slice 4: Exa fallback in the enrichment consumer

Prerequisite: slice 3 is deployed. Decisions 1 to 3 are settled. The app
change doesn't block this slice, because slice 3 keeps `exa` away from
builds that can't decode it.

- **`src/services/exa.ts`: `fetchAbvFromUntappd(env, beerName, brewer)`.**
  - Request: `POST https://api.exa.ai/search` with `x-api-key`. Body: the
    query `"<brewer> <name without leading (…) tag or container tag>"`,
    `type: 'auto'`, `numResults: 8`, `includeDomains: ['untappd.com']`, and
    `contents: { text: { maxCharacters: 1500 }, livecrawl: 'preferred' }`.
  - Response handling: timeout and a byte cap like the Perplexity client,
    with a Zod schema for the response. Return the first result that passes
    `isUntappdBeerUrl` and `matchesBeer` and has an `abvFromPage`, otherwise
    null.
  - Never log page text. Log only the outcome and the candidate count.
- **Where it runs.** In `handleEnrichmentBatch`
  (`src/queue/enrichment.ts`), only when Perplexity returns a clean `null`
  (its explicit `unknown`). It never runs on a Perplexity error, because
  those already retry.
  - Before reserving an Exa slot, re-read the row. It must exist, still be
    `pending`, still carry the message's `description_hash`, and match the
    message's name and brewer (Codex review round 8). Cleanup can write an
    ABV and set `enriched` while Perplexity is running
    (`src/queue/cleanup.ts:187`), and a description change can replace the
    hash. Without this check, a stale message spends a paid Exa call whose
    result the guarded write then has to discard.
    - If any of these fails, don't call Exa: acknowledge the stale
      message and leave the row as it is. That is whatever state cleanup, a
      description change or a newer message gave it, and the sweep or that
      newer message handles it. Tests prove these stale cases reserve no Exa
      slot and make no Exa request.
  - **One normalization for identity everywhere** (Codex review round 7).
    The pre-check and every guarded write compare
    `NULLIF(TRIM(brew_name), '') IS NULLIF(TRIM(?), '')` and
    `NULLIF(TRIM(brewer), '') IS NULLIF(TRIM(?), '')`. A plain `IS` won't
    do: SQLite treats `NULL IS ''` as false, and production already mixes
    the two, because a new beer's queue message carries `brewer: ''`
    (`src/db/helpers.ts:517`) while the row stores `NULL` (`:524`).
  - **Every terminal write after the fallback carries the identity guard.**
    That covers the ABV write, the miss's `not_found` and the error's
    `not_found`: all bind `brew_name IS ? AND brewer IS ?` to the message's
    values with the normalized comparison above, in addition to the
    status and hash. A brewer corrected while
    Exa was running therefore never ends up `not_found` from the old
    identity's lookup (Codex review round 6).
  - Exa finds an ABV: write it with the Perplexity write's stale-result
    guard (`enrichment_status = 'pending' AND description_hash IS ?`)
    **plus** `AND brew_name IS ? AND brewer IS ?`, bound to the message's
    values (Codex review round 5).
    - Exa's strict match was made against that name and brewer, and
      `/beers/sync` can change both without touching the status or the
      description hash (`src/handlers/beers.ts:908`).
    - Set `enrichment_source = 'exa'` and the confidence from decision 2.
    - Zero changed rows is logged as a stale result, the same as the
      Perplexity path.
  - Exa misses: mark `not_found` as today. The 24-hour retry then runs
    Perplexity and Exa again.
  - Exa errors (timeout, 429, 5xx, invalid response): log it and mark
    `not_found`, as for a miss. Don't retry the message, because a retry
    would repeat the Perplexity call that already answered cleanly.
    - Acknowledge the message only after the `not_found` write succeeds. If
      that D1 write throws, retry the message, as the consumer's catch
      block does today.
    - **Limits of the daily retry** (Codex review, 2026-11-10). The sweep
      only reselects `not_found` rows with `abv IS NULL`
      (`src/handlers/enrichment.ts:60`), and nothing sweeps while the
      monthly Perplexity limit has stopped the cron
      (`src/handlers/scheduled.ts:210`).
      - A beer that already had an ABV and went back to `pending` because
        its description changed keeps that ABV after a miss or an Exa
        error, and isn't looked up again. That matches what a Perplexity
        miss does today, and nothing is lost.
      - We accept these limits rather than add a separate "Exa failed"
        state.
- **Cost controls:**
  - `EXA_API_KEY` is an optional secret. Unlike a missing Perplexity key,
    which throws and retries the message (`src/services/perplexity.ts:106`),
    a missing Exa key is treated as "fallback unavailable". The beer takes
    the ordinary Perplexity-miss path: the guarded `not_found` write, then
    acknowledge, with no Exa slot reserved and no retry. The kill switch
    and an exhausted cap behave the same way (Codex review round 8).
  - `ABV_FALLBACK_ENABLED` is a kill switch var, ingesting only when exactly
    `"true"` like `USAGE_ENABLED`.
  - A daily cap, `EXA_DAILY_LIMIT` (proposed 50), is reserved atomically
    before the call. It uses a new
    `abv_fallback_limits (date PK, request_count, last_updated)` table from
    migration 0013, retained 90 days like `enrichment_limits`.
    - **Don't copy `reserveEnrichmentSlot`** (Codex review round 8). It
      reads the count and then increments separately
      (`src/db/quota.ts:57`, `:62`), so two callers can both win the last
      slot.
    - Grant a slot only from one conditional statement: upsert the day's
      row, then
      `UPDATE … SET request_count = request_count + 1 WHERE date = ? AND request_count < ? RETURNING request_count`.
      A returned row means reserved, and no row means the cap is reached.
    - If the reservation write throws, Exa is not called.
    - Tests: the last slot is contested by concurrent callers and exactly
      one wins; a reservation write failure means no Exa call.
- **Analytics.** `trackEnrichment` with `source: 'exa'`, success or failure,
  and duration.
- **Docs.** Update the `AGENTS.md` ABV pipeline section, the environment
  variables and the secrets list. Add the `.dev.vars.example` entry.

Tests: the consumer calls Exa only after a Perplexity `unknown`, never after
an error, with no key, with the kill switch off, or past the cap. A match
writes the ABV, and a stale row is not overwritten. A miss marks
`not_found`. Exa timeouts, 429s, 5xx and invalid responses all mark
`not_found` and acknowledge without a second Perplexity call. A D1 failure
on the `not_found` write retries the message. A name-only or brewer-only
change between the message and the write (status and hash unchanged)
discards Exa's result, for a find, a miss or a timeout alike. A mismatch
found before the call skips Exa and leaves the row `pending`. In every case
the row's current pending work is still processed. A real-D1 test: the
stored brewer is `NULL` and the message's is `''`. An Exa miss reaches
`not_found` and acknowledges, while a real brewer change still rejects the
stale write. The Exa client is driven through a stubbed `fetch` with
recorded response shapes.

## Rollout

1. Slice 1 ships alone: tests, PR, deploy. Then check that the 14 non-beer
   `not_found` rows become `skipped` after the next sweep.
2. Hand `plans/handoff-beerselector-accept-exa-source.md` to the app side
   any time. Its build can ship whenever it suits, independent of the
   worker.
3. Slice 3 ships next. With no `exa` rows yet it changes nothing visible:
   headerless ETags stay the same, and header-sending clients get one full
   refresh.
4. Slice 2 ships with slice 4, or before it on its own. It is unused code
   until slice 4.
5. Slice 4: run `wrangler secret put EXA_API_KEY`, deploy with
   `ABV_FALLBACK_ENABLED` off, then turn it on. Watch the first week of
   `source: 'exa'` analytics for matches, misses and cost.
6. Once BeerSelector's change is on its `main`, add the Golden Taproom
   cases with the header (slice 3, contract tests).

**Rollback floor (Codex review round 2).** Once the first `exa` row is
written, the deployed slice 3 is the oldest version we can roll back to.
An older worker emits the stored source directly in the live merge, cached
taplist JSON and `/beers/batch` (`src/handlers/beers.ts:353`, `:524`,
`:695`), and that would break old app builds.
- To back out the fallback, set `ABV_FALLBACK_ENABLED` to anything but
  `"true"` and keep slice 3 deployed.
- Rolling back below slice 3 first requires rewriting `exa` to `null` in
  `enriched_beers` and clearing `store_taplist_cache`.

## Not doing (yet)

- **The existing `reserveEnrichmentSlot` race** (read, then a separate
  increment, `src/db/quota.ts:57`): queue concurrency 1
  (`wrangler.jsonc`) covers it today. Fix it separately with the same
  conditional-increment pattern, if concurrency is ever raised.

- **Retrying new beers sooner** (#2 from the discussion): parked. With the
  fallback in place, the daily retry runs both providers.
- **Fetching Untappd directly:** possibly against Untappd's terms, and
  fragile.
- **Looser name matching** (subsets, edit distance): the experiment showed
  it would accept the Double Pecan Porter for the plain Pecan Porter.
  Revisit only with evidence from real misses.
