/**
 * Enrichment Hash Utilities
 *
 * Generates a stable, order-independent hash of enrichment data for cache
 * invalidation. Changes to any enrichment field (ABV, confidence, source,
 * cleaned description) or addition/removal of enriched beers will produce
 * a different hash.
 *
 * @module utils/enrichment-hash
 */

import type { BeerEnrichmentData } from '../db/helpers';
import { hashDescription } from './hash';

/**
 * Compute a deterministic hash of the entire enrichment dataset.
 *
 * Entries are sorted by beer ID before serialization so that Map insertion
 * order does not affect the result. Fields within each entry are enumerated
 * in a fixed order for the same reason.
 *
 * @param enrichmentMap - Map of beer IDs to enrichment data
 * @returns 32-char hex hash string
 */
export async function computeEnrichmentHash(
  enrichmentMap: ReadonlyMap<string, BeerEnrichmentData>,
): Promise<string> {
  const sorted = Array.from(enrichmentMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, d]) => [
      id,
      {
        abv: d.abv,
        confidence: d.confidence,
        source: d.source,
        brew_description_cleaned: d.brew_description_cleaned,
      },
    ]);
  return hashDescription(JSON.stringify(sorted));
}
