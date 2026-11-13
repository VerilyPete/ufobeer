/**
 * Matches a row's brew_name and brewer to the values a reader saw, treating
 * NULL, '' and whitespace alike: queue messages carry brewer '' where the row
 * stores NULL, and SQLite's `NULL IS ''` is false. Binds name, then brewer.
 */
export const SAME_IDENTITY_SQL =
  `NULLIF(TRIM(brew_name), '') IS NULLIF(TRIM(?), '') AND NULLIF(TRIM(brewer), '') IS NULLIF(TRIM(?), '')`;

/**
 * The row an enrichment message was produced for is still the row it
 * describes: pending, not hand-verified, same description hash, same name and
 * brewer. Binds stillCurrentArgs(message). Used by the consumer's preflight
 * and guarded writes, and by DLQ storage before parking the row as failed.
 */
export const STILL_CURRENT_SQL =
  `id = ? AND enrichment_status = 'pending' AND is_verified IS NOT 1 AND description_hash IS ? AND ${SAME_IDENTITY_SQL}`;

export function stillCurrentArgs(body: {
  readonly beerId: string;
  readonly beerName: string;
  readonly brewer: string;
  readonly descriptionHash?: string | null | undefined;
}): readonly (string | null)[] {
  return [body.beerId, body.descriptionHash ?? null, body.beerName, body.brewer];
}
