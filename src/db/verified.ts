/**
 * A hand-verified row (`is_verified = 1`) keeps its abv, confidence,
 * enrichment_source and enrichment_status: only a human changes them.
 * NULL counts as unverified.
 */

/** Row-level guard for writes that touch only protected fields. */
export const NOT_VERIFIED_SQL = 'enriched_beers.is_verified IS NOT 1';

/**
 * SET expression for a protected column in a write that also carries other
 * fields (a description, names): the live row decides, inside the statement.
 */
export function unlessVerified(column: string, value: string): string {
  return `CASE WHEN enriched_beers.is_verified IS 1 THEN enriched_beers.${column} ELSE ${value} END`;
}
