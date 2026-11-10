/**
 * Strict matching of Untappd search results to a Flying Saucer beer.
 *
 * Exa returns Untappd pages for a query; these pure functions decide which
 * result is the same beer and read its ABV. Every rule refuses rather than
 * guesses: a wrong ABV is worse than none, and the experiment showed looser
 * matching accepts the Double Pecan Porter for the plain Pecan Porter.
 *
 * The page structure (heading, brewery line, style, counters, then the ABV
 * and IBU fields) comes from recorded responses in test/fixtures/exa/.
 */

import { MAX_BEER_ABV, MIN_BEER_ABV } from '../constants';

export type UntappdTitle = { readonly beer: string; readonly brewery: string };
export type OurBeer = { readonly ourName: string; readonly ourBrewer: string };

// Generic words dropped before brewery identity is compared. Anything else is
// identity: "Acme Other Brewing" is not "Acme Brewing".
const BREWERY_FILLER: ReadonlySet<string> = new Set([
  'brewing', 'brewery', 'brewers', 'brew', 'co', 'company', 'brouwerij', 'brasserie', 'beers',
]);
const NAME_FILLER: ReadonlySet<string> = new Set(['the', 'ale', 'beer', 'brewing', 'co', 'company']);
const CONTAINER_TAG = /\s*\((?:CAN|BTL|NITRO|DRAFT|CROWLER|CAN\/BTL)\)\s*$/i;
const UNTAPPD_HOSTS: ReadonlySet<string> = new Set(['untappd.com', 'www.untappd.com']);

const ABV_FIELD = /^(N\/A|\d+(?:\.\d+)?%) ABV$/;
const IBU_FIELD = /^(?:N\/A|\d+(?:\.\d+)?) IBU$/;
const COUNT = String.raw`[\d.,]+[KM]?\+?`;
const CHECK_IN_COUNTERS: readonly RegExp[] = ['Total \\(\\?\\)', 'Unique \\(\\?\\)', 'Monthly \\(\\?\\)', 'You']
  .map(label => new RegExp(`^${label} ${COUNT}$`));
const VINTAGE_LINE = /^Vintage of .+$/;
const PAGE_SUFFIXES: ReadonlySet<string> = new Set(['untappd', 'variants']);
const ABV_FIELD_WINDOW = 600;

// Folds accents on Latin letters only ("Kölsch" is "Kolsch"). Marks on any
// other script carry identity and are kept: "й" is not "и", "का" is not "कि".
function foldLatinAccent(letter: string): string {
  const decomposed = letter.normalize('NFD');
  return /^[a-z]\p{M}+$/u.test(decomposed) ? decomposed.charAt(0) : letter;
}

function tokens(text: string): readonly string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/\p{L}/gu, foldLatinAccent)
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(token => token !== '');
}

function breweryWords(brewery: string): readonly string[] {
  return tokens(brewery).filter(token => !BREWERY_FILLER.has(token));
}

function sameBrewery(ours: string, theirs: string): boolean {
  const a = new Set(breweryWords(ours));
  const b = new Set(breweryWords(theirs));
  return a.size > 0 && a.size === b.size && [...a].every(token => b.has(token));
}

const startsWith = (words: readonly string[], prefix: readonly string[]): boolean =>
  prefix.every((word, i) => word === words[i]);

/**
 * Drops the brewer's complete name from the front of a beer name, once:
 * "Avery Kaiser" by Avery is "Kaiser", and the "(512)" tag of "(512) 18th
 * Anniversary" by (512) Brewing goes too. A partial brewer name is kept:
 * "Double IPA" by Double Mountain stays "Double IPA".
 */
function coreName(name: string, brewer: string): readonly string[] {
  const words = tokens(name.replace(CONTAINER_TAG, ''));
  const brewerName = breweryWords(brewer);
  const own = startsWith(words, brewerName) ? words.slice(brewerName.length) : words;
  return own.filter(word => !NAME_FILLER.has(word));
}

const sameSequence = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((word, i) => word === b[i]);

/**
 * "<Beer> - <Brewery>[ - Variants][ - Untappd]", with any " | Photos"-style suffix. The
 * last " - " part is the brewery, so a beer name may itself contain " - ".
 */
export function parseUntappdTitle(title: string): UntappdTitle | null {
  const parts = (title.split(' | ')[0] ?? '').split(' - ').map(part => part.trim());
  const lastNamed = parts.findLastIndex(part => !PAGE_SUFFIXES.has(part.toLowerCase()));
  const named = parts.slice(0, lastNamed + 1);
  if (named.length < 2) return null;
  const brewery = named[named.length - 1] ?? '';
  const beer = named.slice(0, -1).join(' - ');
  return beer === '' || brewery === '' ? null : { beer, brewery };
}

/** Only https untappd.com/b/ beer pages; brewery, venue, shop and other subdomains never count. */
export function isUntappdBeerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && UNTAPPD_HOSTS.has(parsed.hostname) && parsed.pathname.startsWith('/b/');
  } catch {
    return false;
  }
}

/**
 * Same brewery (equal sets of non-generic brewery words) and the same beer
 * (equal ordered core words, never empty).
 */
export function matchesBeer({ ourName, ourBrewer }: OurBeer, { beer, brewery }: UntappdTitle): boolean {
  if (!sameBrewery(ourBrewer, brewery)) return false;
  const ours = coreName(ourName, ourBrewer);
  const theirs = coreName(beer, brewery);
  return ours.length > 0 && sameSequence(ours, theirs);
}

type Line = { readonly text: string; readonly offset: number };

function contentLines(text: string): readonly Line[] {
  return [...text.matchAll(/[^\n]+/g)]
    .map(match => ({ text: match[0].trim(), offset: match.index ?? 0 }))
    .filter(line => line.text !== '');
}

const normalizeHeading = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Reads the ABV from the matched beer's own stats block, or null whenever
 * that block's ownership can't be established. The text must open with the
 * matched beer's heading (after at most the page-title line), then an
 * optional "Vintage of …" line and its brewery, then an optional style line
 * and the four check-in counters, then the ABV field and an IBU field. Never falls back to any
 * other "% ABV" on the page.
 */
export function abvFromPage(text: string, matched: UntappdTitle): number | null {
  const lines = contentLines(text);
  const headingIndex = lines.findIndex(line => line.text.startsWith('# '));
  if (headingIndex === -1 || headingIndex > 1) return null;

  const heading = lines[headingIndex]?.text.slice(2) ?? '';
  const vintageLines = VINTAGE_LINE.test(lines[headingIndex + 1]?.text ?? '') ? 1 : 0;
  const breweryIndex = headingIndex + 1 + vintageLines;
  const breweryLine = lines[breweryIndex]?.text ?? '';
  if (normalizeHeading(heading) !== normalizeHeading(matched.beer)) return null;
  if (normalizeHeading(breweryLine) !== normalizeHeading(matched.brewery)) return null;

  const afterBrewery = lines.slice(breweryIndex + 1);
  const first = afterBrewery[0]?.text ?? '';
  if (first.startsWith('#')) return null;
  const styleLines = CHECK_IN_COUNTERS[0]?.test(first) ? 0 : 1;
  const counters = afterBrewery.slice(styleLines, styleLines + CHECK_IN_COUNTERS.length);
  const hasCounters = CHECK_IN_COUNTERS.every((pattern, i) => pattern.test(counters[i]?.text ?? ''));
  if (!hasCounters) return null;

  const [abvLine, ibuLine] = afterBrewery.slice(styleLines + CHECK_IN_COUNTERS.length);
  if (abvLine === undefined || ibuLine === undefined) return null;
  if (abvLine.offset >= ABV_FIELD_WINDOW || !IBU_FIELD.test(ibuLine.text)) return null;

  const abvField = ABV_FIELD.exec(abvLine.text)?.[1];
  if (abvField === undefined) return null;
  const abv = Number.parseFloat(abvField);
  // An N/A field parses to NaN and fails the range check.
  return abv >= MIN_BEER_ABV && abv <= MAX_BEER_ABV ? abv : null;
}
