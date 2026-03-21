---
title: Integrate Zod schemas into handlers, replace manual validators and as-casts
implemented: 2026-02-26
commit: 4c957e5
tags: [zod, schemas, handlers, validation, as-cast-removal, trust-boundary]
---

## Problem

Handler files still used `as` casts on `request.json()` despite schemas existing (Phase 3a). Three manual validators (`validateBeerInput`, `validateForceEnrichmentRequest`, `validateCleanupTriggerRequest`) remained. Type guards in `types.ts` used intermediate `as` casts.

## Decision

Replaced all trust-boundary `as` casts with `Schema.safeParse()` calls. Handlers now return 400 on parse failure rather than silently accepting invalid input.

`handleBeerSync` uses a two-stage approach: `SyncBeersRequestOuterSchema` for top-level validation, then `SyncBeerItemSchema.safeParse()` per item in the loop — preserving the partial success contract (valid beers sync, invalid ones collect errors).

`handleEnrichmentTrigger` keeps `.catch(() => ({}))` for malformed JSON (existing behavior), but now rejects non-empty bodies with invalid fields (previously they silently fell through to defaults).

Manual validators replaced by thin wrappers that call `Schema.safeParse()` and convert Zod errors to the existing `{ valid, error, errorCode }` return type — callers unchanged.

`isValidBeer` rewritten as `FlyingSaucerBeerSchema.safeParse(beer).success`. `hasBeerStock` rewritten with an inline `BeerStockSchema`.

DLQ `raw_message` re-parsing (`JSON.parse(row.raw_message)`) hardened with `EnrichmentMessageSchema.safeParse()` — corrupt rows logged and skipped.

DLQ cursor (`JSON.parse(atob(cursorParam))`) hardened with an inline `CursorSchema` — cursor fields are `{ id: number, failed_at: number }` (plan showed `created_at`; implementation used correct field names).

Queue object literal casts replaced with `satisfies` (`{ ... } satisfies EnrichmentMessage`).

Left unchanged (not trust boundaries):
- Queue routing casts (`batch as MessageBatch<T>`) — CF runtime guarantees
- Admin response re-parsing casts — internal responses wrapped in try/catch

## Trade-offs

- `validateForceEnrichmentRequest` and `validateCleanupTriggerRequest` kept as named wrapper functions (not inlined) — callers depend on the `{ valid, error, errorCode }` shape and clients may depend on the specific error codes.
- `BeerStockSchema` defined inline in `types.ts` rather than in a schema file — localized use doesn't warrant a separate export.
- Net: ~180 lines of manual validation removed, ~120 lines of Zod schemas added, ~16 `as` casts eliminated from trust boundaries.
