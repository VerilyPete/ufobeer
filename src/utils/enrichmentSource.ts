/**
 * Per-request labelling of `enrichment_source`.
 *
 * The database stores the provider that answered. Older app builds reject any
 * source outside the original four, so a newer source is shown only to a
 * client that lists it in `X-Enrichment-Sources`; everyone else gets `null`
 * with the ABV and confidence unchanged. A new source is therefore hidden by
 * default and needs no change here, only a client that asks for it.
 */

export const ENRICHMENT_SOURCES_HEADER = 'X-Enrichment-Sources';

const ALWAYS_VISIBLE_SOURCES: ReadonlySet<string> = new Set([
  'description',
  'description-fallback',
  'perplexity',
  'manual',
]);

const MAX_HEADER_LENGTH = 256;
const MAX_ACCEPTED_SOURCES = 8;
const SOURCE_TOKEN = /^[a-z][a-z0-9-]{0,31}$/;

export type AcceptedSources = ReadonlySet<string>;

/**
 * Parses the client-controlled header: comma-separated, trimmed, lower-cased
 * and deduplicated. Malformed tokens and always-visible sources are dropped,
 * so they never split the ETag. An oversized header is ignored entirely.
 */
export function parseAcceptedSources(header: string | null): AcceptedSources {
  if (header === null || header.length > MAX_HEADER_LENGTH) return new Set();
  const tokens = header
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(token => SOURCE_TOKEN.test(token) && !ALWAYS_VISIBLE_SOURCES.has(token));
  return new Set([...new Set(tokens)].slice(0, MAX_ACCEPTED_SOURCES));
}

export function wireEnrichmentSource(stored: string | null, accepted: AcceptedSources): string | null {
  if (stored === null || ALWAYS_VISIBLE_SOURCES.has(stored) || accepted.has(stored)) return stored;
  return null;
}

export function relabelEnrichmentSources<T extends { readonly enrichment_source?: unknown }>(
  beers: readonly T[],
  accepted: AcceptedSources
): T[] {
  return beers.map(beer => ({
    ...beer,
    enrichment_source: wireEnrichmentSource(
      typeof beer.enrichment_source === 'string' ? beer.enrichment_source : null,
      accepted
    ),
  }));
}

/** Stable key for the accepted set: '' when nothing extra is accepted. */
export function acceptedSourcesKey(accepted: AcceptedSources): string {
  return [...accepted].sort().join(',');
}
