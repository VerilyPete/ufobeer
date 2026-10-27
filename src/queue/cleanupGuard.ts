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
 * - R2: a changed word must be an approved misspelling -> correction pair
 * - R3: a changed gap between words must be a permitted punctuation fix
 */

import { SPELLING_CORRECTIONS } from './dictionary/spellingCorrections.generated';
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
// A word joined to a tag marker or underscore is part of a hashtag, handle or
// identifier (#fresh_pinapple, pinapple_ipa) and is never edited.
const TAG_BEFORE_PATTERN = /[#@_]$/;
const TAG_AFTER_PATTERN = /^_/;

function tokenize(text: string): Tokens {
  return {
    words: text.match(WORD_PATTERN) ?? [],
    gaps: text.split(WORD_PATTERN),
  };
}

const lookupKey = (word: string): string => word.toLowerCase().replace(/’/g, "'");

// A word absent from a dictionary is not necessarily misspelled ("hoppier",
// the "Loral" hop), so the guard never infers a correction. It accepts only
// pairs from an approved list whose misspellings are not real words; see
// scripts/generate-spelling-corrections.mjs. Beer vocabulary is excluded
// again here because the general list does not know it ("tripel").
// Built on first use, once per isolate.
let corrections: ReadonlyMap<string, string> | undefined;
function approvedCorrection(misspelling: string): string | undefined {
  corrections ??= new Map(
    SPELLING_CORRECTIONS.split('\n')
      .map(line => line.split(' '))
      .flatMap(([from, to]): [string, string][] => (from && to && !BEER_TERMS.includes(from) ? [[from, to]] : [])),
  );
  return corrections.get(misspelling);
}

type CaseShape = 'lower' | 'capitalized' | 'other';
function caseShape(word: string): CaseShape {
  if (word === word.toLowerCase()) return 'lower';
  const rest = word.slice(1);
  if (word[0] === word[0]?.toUpperCase() && rest === rest.toLowerCase()) return 'capitalized';
  return 'other';
}

function isPermittedSpellingFix(options: {
  readonly from: string;
  readonly to: string;
  readonly precedingGap: string;
  readonly followingGap: string;
  readonly protectedWords: ReadonlySet<string>;
}): boolean {
  const { from, to } = options;
  const shape = caseShape(from);
  if (shape === 'other' || caseShape(to) !== shape) return false;
  if (TAG_BEFORE_PATTERN.test(options.precedingGap) || TAG_AFTER_PATTERN.test(options.followingGap)) return false;
  if (options.protectedWords.has(lookupKey(from))) return false;
  return approvedCorrection(lookupKey(from)) === lookupKey(to);
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
    .map((from, index) => ({ from, to: output.words[index] ?? '', precedingGap: source.gaps[index] ?? '', followingGap: source.gaps[index + 1] ?? '' }))
    .filter(({ from, to }) => from !== to);
  if (!changed.every(edit => isPermittedSpellingFix({ ...edit, protectedWords }))) {
    return { ok: false, rule: 'R2' };
  }

  if (source.gaps.some((gap, index) => gap !== output.gaps[index])) return { ok: false, rule: 'R3' };

  return { ok: true, edits: changed.map(({ from, to }) => ({ from, to })) };
}
