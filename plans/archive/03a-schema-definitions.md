---
title: Add Zod schemas for all request and external API trust boundaries
implemented: 2026-02-26
commit: 4b35434
tags: [zod, schemas, validation, trust-boundary, runtime-safety, request-parsing]
---

## Problem

~16 `as` casts on `request.json()` and external API responses bypassed runtime validation at trust boundaries. Three manual validators (~180 lines total) duplicated validation logic without compile-time guarantees. Type guards in `types.ts` used intermediate `as` casts.

## Decision

Added Zod as a production dependency. Created two schema files:

- `src/schemas/request.ts`: 9 schemas for all request bodies (`BatchLookupRequest`, `SyncBeersRequest`/`SyncBeerItem`, `DlqReplayRequest`, `DlqAcknowledge`, `TriggerEnrichment`, `ForceEnrichment`/`Criteria`, `TriggerCleanup`, `EnrichmentMessage`)
- `src/schemas/external.ts`: `PerplexityResponse` and `FlyingSaucerBeer` schemas
- `src/schemas/errors.ts`: `mapZodIssueToErrorCode` + `extractZodErrorMessage` helpers

Types derived from schemas via `z.infer<typeof Schema>` — single source of truth. Error codes embedded as `CODE:human text` in `.message()` overrides on every constraint, so `mapZodIssueToErrorCode` can extract them by prefix matching.

`ForceEnrichmentRequestSchema` uses a single `z.object().refine()` for the XOR (beer_ids vs criteria) constraint rather than `z.union()` — unions produce confusing error messages from both failed branches.

`FlyingSaucerBeerSchema` uses `.passthrough()` so validated data retains all original fields (downstream code needs fields like `brewInStock` that aren't in the schema).

`brewer` is optional in `FlyingSaucerBeerSchema` despite the TypeScript type declaring it required — the `isValidBeer` type guard never checked it, and making it required would silently drop valid beers.

## Trade-offs

- `INVALID_BODY` (null/undefined/non-object body) handled at the integration layer in Phase 3b, not in schemas — `z.object().safeParse(null)` produces a generic `invalid_type` issue before any field-level validation fires.
- `SyncBeersRequestOuterSchema` added as a two-stage approach for `handleBeerSync` to preserve per-beer partial success behavior — outer schema validates top-level shape, `SyncBeerItemSchema` validates each beer individually.
- `extractZodErrorMessage` added beyond the plan to DRY up the inline `.slice(colonIdx + 1).trim()` pattern callers were using.
- Final export count: 9 schemas (not 7) plus `EnrichmentMessage` as a derived type.
