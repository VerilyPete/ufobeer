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
 * @param newHash - Hash of the freshly fetched content
 * @param storedHash - Hash of the currently cached content (null if no cache or pre-migration)
 * @returns true if the cache should be fully updated, false if only the timestamp needs refreshing
 */
export function shouldUpdateContent(newHash: string, storedHash: string | null): boolean {
  return storedHash === null || newHash !== storedHash;
}
