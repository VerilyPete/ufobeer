/**
 * Decide whether a model's cleanup of a beer description may be persisted.
 *
 * Cleanup may fix spelling and punctuation; it may never editorialize. The
 * guard compares the normalized source and model output token by token and
 * accepts only differences it can prove are permitted fixes. Anything it
 * cannot prove falls back to deterministic cleanup.
 *
 * Rules (see plans/pr44-review-fixes.md):
 * - R1: the word sequence is unchanged — no word added, removed, merged or split
 * - R2: a changed word must be a reviewed misspelling -> correction pair
 * - R3: a changed gap must only add a missing space after an existing comma
 *       or between a percentage and ABV, or a final full stop
 * - R4: capitalization never changes
 * - R5: at most MAX_CLEANUP_GUARD_EDITS edits in total
 */

import { APPROVED_SPELLING_CORRECTIONS } from './dictionary/spellingCorrections';
import { MAX_CLEANUP_GUARD_EDITS } from '../constants';

export type CleanupEdit = {
  readonly from: string;
  readonly to: string;
};

export type CleanupRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export type CleanupVerdict =
  | { readonly ok: true; readonly edits: readonly CleanupEdit[] }
  | { readonly ok: false; readonly rule: CleanupRule };

type Tokens = {
  readonly words: readonly string[];
  readonly gaps: readonly string[];
};

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
// Only a word standing alone between spaces, with at most ordinary
// punctuation or brackets beside it, is correctable. Anything joined to it
// makes it part of a hashtag, handle, email, URL, path, identifier or
// compound (#so_pleasent, pleasent@example.com, pleasent-tasting).
const OPENING_PUNCTUATION = /^[("'“‘[]*$/;
const CLOSING_PUNCTUATION = /^[)"'”’\].,;:!?]*$/;

function tokenize(text: string): Tokens {
  return {
    words: text.match(WORD_PATTERN) ?? [],
    gaps: text.split(WORD_PATTERN),
  };
}

const lookupKey = (word: string): string => word.toLowerCase().replace(/’/g, "'");

type CaseShape = 'lower' | 'capitalized' | 'other';
function caseShape(word: string): CaseShape {
  if (word === word.toLowerCase()) return 'lower';
  const rest = word.slice(1);
  if (word[0] === word[0]?.toUpperCase() && rest === rest.toLowerCase()) return 'capitalized';
  return 'other';
}

function standsAlone(options: {
  readonly precedingGap: string;
  readonly followingGap: string;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}): boolean {
  const before = (options.isFirst ? /(?:^|\s)(\S*)$/ : /\s(\S*)$/).exec(options.precedingGap)?.[1];
  const after = (options.isLast ? /^(\S*)(?:\s|$)/ : /^(\S*)\s/).exec(options.followingGap)?.[1];
  return before !== undefined && after !== undefined
    && OPENING_PUNCTUATION.test(before) && CLOSING_PUNCTUATION.test(after);
}

// A word absent from a dictionary is not necessarily misspelled ("hoppier",
// the "Loral" hop, the "tripel" style), so the guard never infers a
// correction. It accepts only pairs a person has reviewed.
function isPermittedSpellingFix(options: {
  readonly from: string;
  readonly to: string;
  readonly precedingGap: string;
  readonly followingGap: string;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly protectedWords: ReadonlySet<string>;
}): boolean {
  const { from, to } = options;
  const shape = caseShape(from);
  if (shape === 'other' || caseShape(to) !== shape) return false;
  if (!standsAlone(options)) return false;
  if (options.protectedWords.has(lookupKey(from))) return false;
  return APPROVED_SPELLING_CORRECTIONS.get(lookupKey(from)) === lookupKey(to);
}

// Gap fixes never add, remove or swap punctuation, since a new comma or full
// stop can reverse meaning ("No alcohol is added" -> "No, alcohol is
// added"). Only a missing space after an existing comma, or a final full
// stop (also after a closing "4.7%"), may be added, plus the space in
// "9.2%ABV" -> "9.2% ABV". A missing
// space after a full stop is never fixed: it
// cannot be told apart from a dotted name (example.Com, Menu.Pdf, U.S). The
// comma pair must be two plain words standing alone, so numbers, lists and
// identifiers are never split, and a final full stop is only appended to a
// standalone word, never to a path or address.
const PLAIN_WORD = /^[\p{L}'’]+$/u;
const NUMBER = /^\p{N}+$/u;

function isPermittedGapFix(options: {
  readonly from: string;
  readonly to: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
  readonly outerBefore: string;
  readonly outerAfter: string;
  readonly beforeIsFirst: boolean;
  readonly afterIsLast: boolean;
  readonly protectedWords: ReadonlySet<string>;
}): boolean {
  const { from, to, before, after, protectedWords } = options;
  if (from === '%') {
    const afterNumber = before !== undefined && NUMBER.test(before);
    return afterNumber && (after === undefined ? to === '%.' : to === '% ' && after.toLowerCase() === 'abv');
  }
  if (before === undefined || !PLAIN_WORD.test(before) || protectedWords.has(lookupKey(before))) return false;
  if (after === undefined) {
    const lastWordStandsAlone = standsAlone({ precedingGap: options.outerBefore, followingGap: '', isFirst: options.beforeIsFirst, isLast: true });
    const endsWithPercentAbv = options.outerBefore === '%' && before.toLowerCase() === 'abv';
    return from === '' && to === '.' && (lastWordStandsAlone || endsWithPercentAbv);
  }
  if (!PLAIN_WORD.test(after) || protectedWords.has(lookupKey(after))) return false;
  const pairStandsAlone = standsAlone({
    precedingGap: options.outerBefore,
    followingGap: options.outerAfter,
    isFirst: options.beforeIsFirst,
    isLast: options.afterIsLast,
  });
  if (!pairStandsAlone) return false;
  return from === ',' && to === ', ';
}

const isCaseOnly = (from: string, to: string): boolean => from !== to && from.toLowerCase() === to.toLowerCase();

function protectedWordsOf(terms: readonly string[]): ReadonlySet<string> {
  return new Set(
    terms
      .flatMap(term => tokenize(term).words.map(lookupKey))
      .flatMap(word => [word, word.replace(/'s$/, '')]),
  );
}

function wordContext(source: Tokens, index: number) {
  return {
    precedingGap: source.gaps[index] ?? '',
    followingGap: source.gaps[index + 1] ?? '',
    isFirst: index === 0,
    isLast: index === source.words.length - 1,
  };
}

function gapContext(source: Tokens, index: number) {
  return {
    before: source.words[index - 1],
    after: source.words[index],
    outerBefore: source.gaps[index - 1] ?? '',
    outerAfter: source.gaps[index + 1] ?? '',
    beforeIsFirst: index - 1 === 0,
    afterIsLast: index === source.words.length - 1,
  };
}

export function checkCleanup(options: {
  readonly source: string;
  readonly output: string;
  readonly protectedTerms: readonly string[];
  readonly maxEdits?: number;
}): CleanupVerdict {
  const source = tokenize(options.source);
  const output = tokenize(options.output);

  if (source.words.length !== output.words.length) return { ok: false, rule: 'R1' };

  const protectedWords = protectedWordsOf(options.protectedTerms);
  const words = source.words.map((from, index) => ({ index, from, to: output.words[index] ?? '', ...wordContext(source, index) }));
  const spellingFixes = words.filter(({ from, to }) => from !== to && !isCaseOnly(from, to));
  if (!spellingFixes.every(edit => isPermittedSpellingFix({ ...edit, protectedWords }))) {
    return { ok: false, rule: 'R2' };
  }

  const gaps = source.gaps.map((from, index) => ({ index, from, to: output.gaps[index] ?? '', ...gapContext(source, index) }));
  const gapFixes = gaps.filter(({ from, to }) => from !== to);
  if (!gapFixes.every(gap => isPermittedGapFix({ ...gap, protectedWords }))) return { ok: false, rule: 'R3' };

  // A full stop after an abbreviation ("Inc. added", "vol. ml") cannot be told
  // from a sentence end, and capitalizing a unit changes its meaning (ml -> Ml),
  // so capitalization is never changed.
  if (words.some(({ from, to }) => isCaseOnly(from, to))) return { ok: false, rule: 'R4' };

  const edits = [
    ...gapFixes.map(({ index, from, to, before = '', after = '' }) => ({
      position: index * 2,
      from: before + from + after,
      to: before + to + after,
    })),
    ...words
      .filter(({ from, to }) => from !== to)
      .map(({ index, from, to }) => ({ position: index * 2 + 1, from, to })),
  ];
  if (edits.length > (options.maxEdits ?? MAX_CLEANUP_GUARD_EDITS)) return { ok: false, rule: 'R5' };

  return {
    ok: true,
    edits: [...edits].sort((a, b) => a.position - b.position).map(({ from, to }) => ({ from, to })),
  };
}

const GAP_FIXES: Readonly<Record<string, string>> = { ',': ', ', '%': '% ' };
const FINAL_GAP_FIXES: Readonly<Record<string, string>> = { '': '.', '%': '%.' };

const matchCase = (word: string, correction: string): string =>
  caseShape(word) === 'capitalized' ? correction.charAt(0).toUpperCase() + correction.slice(1) : correction;

/**
 * Apply every fix the guard permits, deterministically: reviewed spelling
 * pairs, a missing space after a comma or between a percentage and ABV, and a
 * missing final full stop. Each candidate is judged by the same rules as
 * model output, so the result always passes checkCleanup (without the model
 * edit budget, which exists to catch a model rewriting, not fixing).
 */
export function applyCleanupFixes(options: {
  readonly source: string;
  readonly protectedTerms: readonly string[];
}): string {
  const source = tokenize(options.source);
  const protectedWords = protectedWordsOf(options.protectedTerms);

  const words = source.words.map((from, index) => {
    const correction = APPROVED_SPELLING_CORRECTIONS.get(lookupKey(from));
    if (correction === undefined) return from;
    const to = matchCase(from, correction);
    return isPermittedSpellingFix({ from, to, ...wordContext(source, index), protectedWords }) ? to : from;
  });
  const gaps = source.gaps.map((from, index) => {
    const to = index === source.words.length ? FINAL_GAP_FIXES[from] : GAP_FIXES[from];
    if (to === undefined) return from;
    return isPermittedGapFix({ from, to, ...gapContext(source, index), protectedWords }) ? to : from;
  });

  return gaps.map((gap, index) => gap + (words[index] ?? '')).join('');
}
