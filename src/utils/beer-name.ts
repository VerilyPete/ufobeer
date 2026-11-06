import { repairMojibake } from '../queue/mojibake';

/**
 * Repair a Flying Saucer beer name or brewer for display: mojibake,
 * backslash-escaped quotes ("Dragon\'s") and stray whitespace. Never
 * changes spelling or wording.
 */
export function cleanBeerName(name: string): string {
  return repairMojibake(name)
    .replace(/\\(['"])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
