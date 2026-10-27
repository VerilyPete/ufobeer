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

function tokenize(text: string): Tokens {
  return {
    words: text.match(WORD_PATTERN) ?? [],
    gaps: text.split(WORD_PATTERN),
  };
}

export function checkCleanup(options: {
  readonly source: string;
  readonly output: string;
  readonly protectedTerms: readonly string[];
}): CleanupVerdict {
  const source = tokenize(options.source);
  const output = tokenize(options.output);

  if (source.words.length !== output.words.length) return { ok: false, rule: 'R1' };
  if (source.words.some((word, index) => word !== output.words[index])) return { ok: false, rule: 'R2' };
  if (source.gaps.some((gap, index) => gap !== output.gaps[index])) return { ok: false, rule: 'R3' };

  return { ok: true, edits: [] };
}
