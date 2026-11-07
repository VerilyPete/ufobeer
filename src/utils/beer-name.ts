import { repairMojibake } from '../queue/mojibake';

/**
 * Repair a Flying Saucer beer name or brewer for display: mojibake,
 * backslash-escaped quotes ("Dragon\'s") and stray whitespace. Never
 * changes spelling or wording.
 */
export function cleanBeerName(name: string): string {
  const cleaned = repairMojibake(name)
    .replace(/\\+(['"])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // Repeat until nothing changes, so double-encoded mojibake is fully
  // repaired and cleaning an already-clean name is a no-op. Each changing
  // pass shortens the name or normalizes whitespace, so this terminates.
  return cleaned === name ? name : cleanBeerName(cleaned);
}

/** Apply cleanBeerName to a beer's name and, when present, its brewer. */
export function cleanBeerNames<T extends { readonly brew_name: string; readonly brewer?: string | null | undefined }>(beer: T): T {
  return {
    ...beer,
    brew_name: cleanBeerName(beer.brew_name),
    ...(typeof beer.brewer === 'string' ? { brewer: cleanBeerName(beer.brewer) } : {}),
  };
}
