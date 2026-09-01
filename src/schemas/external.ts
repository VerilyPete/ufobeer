import { z } from 'zod';
import {
  MAX_FLYING_SAUCER_FIELD_LENGTH,
  MAX_FLYING_SAUCER_RESPONSE_ITEMS,
  MAX_FLYING_SAUCER_RECORD_SERIALIZED_BYTES,
} from '../constants';

// ============================================================================
// Bounds
// ============================================================================
//
// Upstream (Flying Saucer, Perplexity) responses are materialized fully
// before these schemas run, so the bounds below cap *content* shape, not
// wire bytes. See src/utils/bounded-response.ts for the byte-level cap
// applied before JSON.parse in src/services/perplexity.ts, and
// FLYING_SAUCER_RESPONSE_MAX_BYTES (src/constants.ts) for the equivalent
// streaming cap applied in src/handlers/beers.ts before the Flying Saucer
// response body is fully read.
//
// MAX_FLYING_SAUCER_FIELD_LENGTH, MAX_FLYING_SAUCER_RESPONSE_ITEMS, and
// MAX_FLYING_SAUCER_RECORD_SERIALIZED_BYTES now live in src/constants.ts
// (imported above) as part of the constants consolidation.

/**
 * Aggregate size guard for a single Flying Saucer beer record, covering
 * fields the schema does not enumerate via `.passthrough()`. Called
 * explicitly by callers after `FlyingSaucerBeerSchema.safeParse()`
 * succeeds — see `FlyingSaucerBeerSchema`'s doc comment for why it cannot
 * be embedded in the schema itself. Applied in `handlers/beers.ts`
 * immediately after the `isValidBeer` filter.
 */
export function isFlyingSaucerBeerRecordWithinSizeCap(beer: unknown): boolean {
  try {
    return JSON.stringify(beer).length <= MAX_FLYING_SAUCER_RECORD_SERIALIZED_BYTES;
  } catch {
    return false;
  }
}

export const PerplexityResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().optional(),
      }).optional(),
    })
  ).optional().default([]),
});

/**
 * `.passthrough()` is intentional, not an oversight: real Flying Saucer
 * responses nest stock/location data (e.g. `brewInStock`) that the app
 * reads via passthrough fields elsewhere (`types.ts`'s `hasBeerStock`,
 * `schemas/cache.ts`'s `CachedBeerSchema.extend(...)`). Dropping it would
 * break both. Known text fields are individually length-bounded below;
 * the aggregate record size (including passthrough fields) is bounded
 * separately via `isFlyingSaucerBeerRecordWithinSizeCap()` for the reason
 * documented on `MAX_FLYING_SAUCER_RECORD_SERIALIZED_BYTES`.
 */
export const FlyingSaucerBeerSchema = z.object({
  id: z.string().min(1).max(MAX_FLYING_SAUCER_FIELD_LENGTH),
  brew_name: z.string().max(MAX_FLYING_SAUCER_FIELD_LENGTH),
  brewer: z.string().max(MAX_FLYING_SAUCER_FIELD_LENGTH).optional(),
  brew_description: z.string().max(MAX_FLYING_SAUCER_FIELD_LENGTH).optional(),
  container_type: z.string().max(MAX_FLYING_SAUCER_FIELD_LENGTH).optional(),
}).passthrough();

/**
 * Applied in `handlers/beers.ts` to the extracted `brewInStock` array
 * (before the `isValidBeer` per-record filter runs), rejecting an
 * over-long array before it is iterated. Not applied to the outer
 * `[{...meta}, {brewInStock: [...]}]` envelope array itself, which is
 * always length 2 regardless of beer count.
 */
export const FlyingSaucerResponseSchema = z.array(z.unknown()).max(MAX_FLYING_SAUCER_RESPONSE_ITEMS);

export type PerplexityResponse = z.infer<typeof PerplexityResponseSchema>;
export type FlyingSaucerBeer = z.infer<typeof FlyingSaucerBeerSchema>;
