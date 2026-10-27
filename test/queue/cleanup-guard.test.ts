import { describe, it, expect } from 'vitest';
import { checkCleanup } from '../../src/queue/cleanupGuard';

const source = 'Pours a bright, clear golden yellow. Nose is pineapple and citrus zest.';

const check = (output: string, overrides: { source?: string } = {}) =>
  checkCleanup({ source: overrides.source ?? source, output, protectedTerms: [] });

describe('cleanup guard: word sequence (R1)', () => {
  it('accepts output identical to the source with no edits', () => {
    expect(check(source)).toEqual({ ok: true, edits: [] });
  });

  it.each([
    ['an added word', 'Pours a bright, clear golden yellow. Nose is juicy pineapple and citrus zest.'],
    ['a removed word', 'Pours a bright, clear yellow. Nose is pineapple and citrus zest.'],
    ['a merged word', 'Pours a bright, clear golden yellow. Nose is pineapple and citruszest.'],
    ['a split word', 'Pours a bright, clear golden yellow. Nose is pine apple and citrus zest.'],
    ['added commentary', 'Here you go: Pours a bright, clear golden yellow. Nose is pineapple and citrus zest.'],
    ['an appended sentence', 'Pours a bright, clear golden yellow. Nose is pineapple and citrus zest. Enjoy it.'],
    ['an empty output', ''],
  ])('rejects %s', (_case, output) => {
    expect(check(output)).toEqual({ ok: false, rule: 'R1' });
  });

  it('rejects reordered words', () => {
    expect(check('Pours a clear, bright golden yellow. Nose is pineapple and citrus zest.').ok).toBe(false);
  });

  it('treats in-word apostrophes as part of the word', () => {
    const withApostrophes = "Fireman's 4 is bigger than you'd expect.";
    expect(check(withApostrophes, { source: withApostrophes })).toEqual({ ok: true, edits: [] });
    expect(check("Fireman s 4 is bigger than you d expect.", { source: withApostrophes })).toEqual({ ok: false, rule: 'R1' });
  });

  it('rejects any changed word until spelling fixes are permitted', () => {
    expect(check('Pours a bright, clear golden yellow. Nose is pineapple and citrus zesty.').ok).toBe(false);
  });

  it('rejects any changed punctuation until punctuation fixes are permitted', () => {
    expect(check('Pours a bright, clear golden yellow! Nose is pineapple and citrus zest.').ok).toBe(false);
  });
});
