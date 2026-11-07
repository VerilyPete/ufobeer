import { repairMojibake } from '../queue/mojibake';

const MAX_REPAIR_PASSES = 4;

function repairPass(name: string): string {
  return repairMojibake(name)
    .replace(/\\+(['"])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function settle(original: string, current: string, passesLeft: number): string {
  const next = repairPass(current);
  if (next === current) return current;
  return passesLeft > 1 ? settle(original, next, passesLeft - 1) : original;
}

/**
 * Repair a Flying Saucer beer name or brewer for display: mojibake,
 * backslash-escaped quotes ("Dragon\'s") and stray whitespace. Never
 * changes spelling or wording. Passes repeat until the name is stable, so
 * cleaning again is a no-op; a name still changing after MAX_REPAIR_PASSES
 * (more layers than real data has) is returned exactly as sent.
 */
export function cleanBeerName(name: string): string {
  return settle(name, name, MAX_REPAIR_PASSES);
}

/** Apply cleanBeerName to a beer's name and, when present, its brewer. */
export function cleanBeerNames<T extends { readonly brew_name: string; readonly brewer?: string | null | undefined }>(beer: T): T {
  return {
    ...beer,
    brew_name: cleanBeerName(beer.brew_name),
    ...(typeof beer.brewer === 'string' ? { brewer: cleanBeerName(beer.brewer) } : {}),
  };
}
