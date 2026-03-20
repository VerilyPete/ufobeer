/**
 * Cache Helper Pure Functions
 *
 * Decision logic for cache content updates.
 * Pure functions — no D1, no fetch, no side effects.
 *
 * @module utils/cache-helpers
 */

/**
 * Determine whether cached content should be replaced.
 *
 * @param newContentHash - Hash of the freshly fetched content
 * @param storedContentHash - Hash of the currently cached content (null if no cache or pre-migration)
 * @param newEnrichmentHash - Hash of fresh enrichment data (null if enrichment fetch failed — skip comparison)
 * @param storedEnrichmentHash - Hash of cached enrichment data (null if no cache or post-migration first request)
 * @returns true if the cache should be fully updated, false if only the timestamp needs refreshing
 */
export function shouldUpdateContent(
  newContentHash: string,
  storedContentHash: string | null,
  newEnrichmentHash: string | null,
  storedEnrichmentHash: string | null,
): boolean {
  if (storedContentHash === null || newContentHash !== storedContentHash) {
    return true;
  }
  // Content hashes match — check enrichment only if new enrichment hash is available
  if (newEnrichmentHash === null) {
    return false;
  }
  return storedEnrichmentHash === null || newEnrichmentHash !== storedEnrichmentHash;
}
