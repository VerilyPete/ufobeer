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
 * - R3: a changed gap between words must be a permitted punctuation fix:
 *       only adding a missing comma, full stop, or space after one
 * - R4: a case change must be capitalizing a word after a sentence-ending ". "
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

// Gap fixes are only ever additions of a missing comma, full stop or space,
// and only between plain words: never inside numbers, prices, domains or
// identifiers, and never removing or swapping existing punctuation.
const PLAIN_WORD = /^[\p{L}'’]+$/u;
const CAPITALIZED_WORD = /^\p{Lu}/u;
const SENTENCE_END = '. ';

function isPermittedGapFix(options: {
  readonly from: string;
  readonly to: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
}): boolean {
  const { from, to, before, after } = options;
  if (before === undefined || !PLAIN_WORD.test(before)) return false;
  if (after === undefined) return from === '' && to === '.';
  if (!PLAIN_WORD.test(after)) return false;
  if (from === ' ') return to === ', ' || to === SENTENCE_END;
  if (from === ',') return to === ', ';
  if (from === '.') return to === SENTENCE_END && CAPITALIZED_WORD.test(after);
  return false;
}

// R3 has already verified every ". " in the output: it was in the source or
// replaced a space, so only the following word's first letter may change.
function isPermittedCaseFix(options: {
  readonly from: string;
  readonly to: string;
  readonly outputGap: string;
}): boolean {
  const { from, to } = options;
  return to === from.charAt(0).toUpperCase() + from.slice(1) && options.outputGap.endsWith(SENTENCE_END);
}

const isCaseOnly = (from: string, to: string): boolean => from !== to && from.toLowerCase() === to.toLowerCase();

export function checkCleanup(options: {
  readonly source: string;
  readonly output: string;
  readonly protectedTerms: readonly string[];
}): CleanupVerdict {
  const source = tokenize(options.source);
  const output = tokenize(options.output);

  if (source.words.length !== output.words.length) return { ok: false, rule: 'R1' };

  const protectedWords = new Set(
    options.protectedTerms
      .flatMap(term => tokenize(term).words.map(lookupKey))
      .flatMap(word => [word, word.replace(/'s$/, '')]),
  );
  const words = source.words.map((from, index) => ({
    index,
    from,
    to: output.words[index] ?? '',
    precedingGap: source.gaps[index] ?? '',
    followingGap: source.gaps[index + 1] ?? '',
    isFirst: index === 0,
    isLast: index === source.words.length - 1,
  }));
  const spellingFixes = words.filter(({ from, to }) => from !== to && !isCaseOnly(from, to));
  if (!spellingFixes.every(edit => isPermittedSpellingFix({ ...edit, protectedWords }))) {
    return { ok: false, rule: 'R2' };
  }

  const gaps = source.gaps.map((from, index) => ({
    index,
    from,
    to: output.gaps[index] ?? '',
    before: source.words[index - 1],
    after: source.words[index],
  }));
  const gapFixes = gaps.filter(({ from, to }) => from !== to);
  if (!gapFixes.every(isPermittedGapFix)) return { ok: false, rule: 'R3' };

  const caseFixes = words.filter(({ from, to }) => isCaseOnly(from, to));
  const casePermitted = caseFixes.every(({ index, from, to }) =>
    isPermittedCaseFix({ from, to, outputGap: output.gaps[index] ?? '' }));
  if (!casePermitted) return { ok: false, rule: 'R4' };

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
  if (edits.length > MAX_CLEANUP_GUARD_EDITS) return { ok: false, rule: 'R5' };

  return {
    ok: true,
    edits: [...edits].sort((a, b) => a.position - b.position).map(({ from, to }) => ({ from, to })),
  };
}
