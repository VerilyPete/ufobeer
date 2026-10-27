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
 * - R2: a changed word must be a permitted spelling fix
 * - R3: a changed gap between words must be a permitted punctuation fix
 */

import { ENGLISH_WORDS } from './dictionary/englishWords.generated';
import { BEER_TERMS } from './dictionary/beerTerms';

export type CleanupEdit = {
  readonly from: string;
  readonly to: string;
};

export type CleanupRule = 'R1' | 'R2' | 'R3';

export type CleanupVerdict =
  | { readonly ok: true; readonly edits: readonly CleanupEdit[] }
  | { readonly ok: false; readonly rule: CleanupRule };

type Tokens = {
  readonly words: readonly string[];
  readonly gaps: readonly string[];
};

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const TAG_PREFIX_PATTERN = /[#@]$/;

function tokenize(text: string): Tokens {
  return {
    words: text.match(WORD_PATTERN) ?? [],
    gaps: text.split(WORD_PATTERN),
  };
}

const lookupKey = (word: string): string => word.toLowerCase().replace(/’/g, "'");

// Built on first use: splitting ~90k words costs a few milliseconds, paid
// once per isolate rather than at module load for every request.
let knownWords: ReadonlySet<string> | undefined;
function isKnownWord(word: string): boolean {
  knownWords ??= new Set([...ENGLISH_WORDS.split('\n'), ...BEER_TERMS]);
  return knownWords.has(lookupKey(word));
}

type CaseShape = 'lower' | 'capitalized' | 'other';
function caseShape(word: string): CaseShape {
  if (word === word.toLowerCase()) return 'lower';
  const rest = word.slice(1);
  if (word[0] === word[0]?.toUpperCase() && rest === rest.toLowerCase()) return 'capitalized';
  return 'other';
}

const removeAt = (word: string, index: number): string => word.slice(0, index) + word.slice(index + 1);

// True when b is one insertion, deletion, substitution or adjacent
// transposition away from a.
function isOneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length !== longer.length) {
    return [...longer].some((_, index) => removeAt(longer, index) === shorter);
  }
  const mismatches = [...a].flatMap((char, index) => (char === b.charAt(index) ? [] : [index]));
  if (mismatches.length === 1) return true;
  const [first, second] = mismatches;
  return mismatches.length === 2 && first !== undefined && second === first + 1
    && a.charAt(first) === b.charAt(second) && a.charAt(second) === b.charAt(first);
}

function isPermittedSpellingFix(options: {
  readonly from: string;
  readonly to: string;
  readonly precedingGap: string;
  readonly protectedWords: ReadonlySet<string>;
}): boolean {
  const { from, to } = options;
  const shape = caseShape(from);
  if (shape === 'other' || caseShape(to) !== shape) return false;
  if (TAG_PREFIX_PATTERN.test(options.precedingGap)) return false;
  if (options.protectedWords.has(lookupKey(from))) return false;
  if (lookupKey(from)[0] !== lookupKey(to)[0]) return false;
  if (isKnownWord(from) || !isKnownWord(to)) return false;
  return isOneEditApart(lookupKey(from), lookupKey(to));
}

export function checkCleanup(options: {
  readonly source: string;
  readonly output: string;
  readonly protectedTerms: readonly string[];
}): CleanupVerdict {
  const source = tokenize(options.source);
  const output = tokenize(options.output);

  if (source.words.length !== output.words.length) return { ok: false, rule: 'R1' };

  const protectedWords = new Set(
    options.protectedTerms.flatMap(term => tokenize(term).words.map(lookupKey)),
  );
  const changed = source.words
    .map((from, index) => ({ from, to: output.words[index] ?? '', precedingGap: source.gaps[index] ?? '' }))
    .filter(({ from, to }) => from !== to);
  if (!changed.every(edit => isPermittedSpellingFix({ ...edit, protectedWords }))) {
    return { ok: false, rule: 'R2' };
  }

  if (source.gaps.some((gap, index) => gap !== output.gaps[index])) return { ok: false, rule: 'R3' };

  return { ok: true, edits: changed.map(({ from, to }) => ({ from, to })) };
}
