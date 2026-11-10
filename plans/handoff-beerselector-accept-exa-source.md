# Handoff to BeerSelector: accept `enrichment_source: "exa"`, and say so in a header

From: the ufobeer API (Cloudflare Worker that enriches Flying Saucer beers).
Date: 2026-11-10.
Related ufobeer plan: `plans/abv-untappd-fallback.md`, slices 3 (per-request label) and 4 (Exa fallback).

## What and why

The API is adding a second ABV lookup provider. When Perplexity answers
"unknown", the worker asks **Exa** (a search API) and accepts an ABV only
from an exact title match on the beer's Untappd page. Such ABVs carry:

```json
{ "enriched_abv": 8, "enrichment_confidence": 0.8, "enrichment_source": "exa" }
```

`enrichment_source` names the **provider that answered**: `"exa"` or
`"perplexity"`. It never names the site the provider read, so the value is
not `"untappd"`.

Today the app rejects any source outside
`description | description-fallback | perplexity | manual`. A response
carrying `"exa"` would be thrown out as invalid. To keep every existing
build working, the worker **only sends `"exa"` to clients that say they
accept it**:

- **A request with `X-Enrichment-Sources: exa`** gets `"enrichment_source": "exa"`.
- **A request without the header** (every build in the field today) gets
  the same ABV and confidence with `"enrichment_source": null`. All builds
  already accept null, so nothing breaks.
  - One known limitation for those old builds: when merging, the app
    keeps a beer's previous source if the incoming one is null
    (`EnrichmentService.swift:177`).
  - So if Exa replaces an ABV that Perplexity found earlier, an old build
    can show the new ABV still labelled `perplexity`. This is rare: it
    needs a previously enriched beer whose description changed, then a
    Perplexity miss.
  - Nothing in the app branches on the source, and new builds receive
    `"exa"`, so this needs no app change.

So this change has two parts, and they ship together in one build:

1. Accept `"exa"` wherever the allowed set is pinned.
2. Send `X-Enrichment-Sources: exa` on every request made through
   `EnrichmentService.call`: `/beers`, `/beers/batch`, `/beers/sync` and
   `/health`. `/usage` goes through `UsageTransport` instead and doesn't
   need it, because its responses carry no enrichment rows.

**Don't send the header without the decoders accepting `"exa"`.** The
header is a promise that the build can decode it.

There's no adoption tracking and no expiry deadline. Old builds keep
getting `null`, and new builds get `"exa"` as soon as they install.

## What to change

### 1. Accept `"exa"`

The field shape, nullability and the `description-fallback` →
`description` normalization all stay the same.

**Native (Swift):**
- `native-ios/Core/EnrichmentService.swift:200`: the batch enrichment row
  decoder's allowed list
  `["description","description-fallback","perplexity","manual"]`.
- `native-ios/Core/EnrichmentService.swift:275`: the second decoder (the
  `/beers` row) with the same list.
- Consider making those two lists one shared constant, so they can't drift
  again. Optional, your call.

**TypeScript contracts (used by ufobeer's Golden Taproom contract run):**
- `src/contracts/enrichment.ts:8`: `z.enum(['description', 'perplexity', 'manual'])`
  becomes `z.enum(['description', 'perplexity', 'manual', 'exa'])`.
- `src/types/beer.ts:10`: add `'exa'` to `EnrichmentSource`, and add a line
  to the doc comment above it (around line 6), such as
  `'exa': ABV found by the Exa search fallback (exact Untappd page match)`.

**Confidence:** Exa uses `0.8`, which is already a supported value (the
TypeScript contract tests already accept it, at
`src/contracts/__tests__/enrichment.test.ts:136`). The Swift decoders check
only that confidence is finite (`EnrichmentService.swift:199`, `:274`), and
the merge checks only that it is present (`:176`). Nothing compares it to a
threshold or maps it to UI, so no confidence change is needed.

### 2. Send the capability header

- `native-ios/Core/EnrichmentService.swift:49`, in `call(...)`, which
  handles `/beers`, `/beers/batch`, `/beers/sync` and `/health`. Today it
  builds `var headers = ["X-API-Key":key]`. Add
  `"X-Enrichment-Sources":"exa"` there. `/usage`
  (`UsageTransport.swift:26`) is separate and stays as it is.
- Existing tests already read outgoing headers
  (`native-ios/Tests/NetworkTests.swift:827`), so copy that pattern for the
  header test.
- Format: a comma-separated list of the *extra* sources this build accepts
  beyond the original four. Today that's just `exa`. A later provider would
  make it `exa, newthing`. Don't list the original four.
- TypeScript: nothing calls the API. `src/` holds only the contracts,
  `enrichmentAdapter.ts`, which passes `enrichment_source` through
  unchanged, and `types/beer.ts`. So there's no header change in TS.

## Tests to add (TDD: write these first, watch them fail)

**Swift: decoding**
- A mocked `/beers/batch` response row with `"enrichment_source":"exa"` and
  `"enrichment_confidence":0.8` decodes through `EnrichmentService.enrich`
  and keeps the ABV, `"exa"` and `0.8`. Follow the `exercisePostSync`
  pattern at `native-ios/Tests/NetworkTests.swift:828-840`.
- A mocked `/beers` taplist row with `"exa"` decodes through
  `EnrichmentService.taplist` the same way. Follow the
  `live`/`cache`/`stale` loop at `NetworkTests.swift:103-115`.
- After a refresh, the stored beer reloads from the database with the ABV,
  `"exa"` and `0.8` intact.
- A row with an ABV, confidence `0.8` and `"enrichment_source": null` still
  decodes and keeps its ABV. That's what pre-header builds will see, and
  this build too if the header is ever lost.
- Don't copy the `"perplexity"` round trip at `NetworkTests.swift:619-632`
  as your only test. It sets the source directly on a `Beer`, so it never
  runs the decoder and would pass without the fix.
- **An unknown source is still rejected** (for example `"untappd"` or
  `"bogus"`), so the guard isn't loosened to accept anything.

**Swift: header**
- The mocked transport records the outgoing request for `/beers`,
  `/beers/batch` and `/beers/sync`. Each carries
  `X-Enrichment-Sources: exa` alongside `X-API-Key`, and the conditional
  `/beers` request still carries `If-None-Match`.

**TypeScript:**
- `src/contracts/__tests__/enrichment.test.ts:46`: add `'exa'` to the
  accepted-source `it.each`.
- Keep or add a case showing an unknown source (`'untappd'`) is still
  rejected.

## Done when

1. The above is on BeerSelector `main` with all three CI checks green:
   Native iOS Tests, Enrichment Contract Tests (which runs the TypeScript
   typecheck and Vitest suite), and the Golden Taproom Contract.
2. Tell the ufobeer side it's merged. The worker's contract run then adds
   its `"exa"` cases (see below).
3. Ship a TestFlight build containing it whenever suits you. There's no
   need to expire older builds for this change, because they never receive
   `"exa"`.

## Not your concern (ufobeer does these)

- **The Exa fallback in the worker**, with its kill switch, secret and
  daily cap.
- **Choosing the label per request.** The worker stores `exa` and decides
  `exa` or `null` when it builds each response, including cached, stale
  fallback and `/beers/batch` responses.
- **Cache safety.** The worker puts the label choice into the `ETag` and
  sends `Vary: X-Enrichment-Sources`. That way an upgraded build never gets
  a `304` that pins an old `null`, and no shared cache hands one client's
  version to another.
- **Producer-side contract coverage.** `"exa"` seeds go into ufobeer's
  `contract-test/fixtures.ts` (cached payloads) and the Golden Taproom
  suite's live `/beers` and `/beers/batch` seeds
  (`contract-test/goldenTaproom.contract.test.ts:83`, `:102`, `:353`).
  Assertions:
  - with the header, cached, live and batch responses keep source `"exa"`
    and confidence `0.8`;
  - without it, the same rows come back with source `null` and their ABV
    intact.

  The cases with the header need your merged schema. The cases without it
  pass against today's.
