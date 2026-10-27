import { describe, it, expect } from 'vitest';
import { checkCleanup } from '../../src/queue/cleanupGuard';

const source = 'Pours a bright, clear golden yellow. Nose is pineapple and citrus zest.';

const check = (output: string, overrides: { source?: string; protectedTerms?: readonly string[] } = {}) =>
  checkCleanup({ source: overrides.source ?? source, output, protectedTerms: overrides.protectedTerms ?? [] });

const spelling = (from: string, to: string, protectedTerms: readonly string[] = []) =>
  check(`A ${to} finish.`, { source: `A ${from} finish.`, protectedTerms });

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

  it('rejects any changed punctuation until punctuation fixes are permitted', () => {
    expect(check('Pours a bright, clear golden yellow! Nose is pineapple and citrus zest.').ok).toBe(false);
  });
});

describe('cleanup guard: spelling fixes (R2)', () => {
  it.each([
    ['teh', 'the'],
    ['recieve', 'receive'],
    ['pinapple', 'pineapple'],
    ['seperate', 'separate'],
    ['Teh', 'The'],
  ])('accepts the approved correction %s -> %s and reports the edit', (from, to) => {
    expect(spelling(from, to)).toEqual({ ok: true, edits: [{ from, to }] });
  });

  it.each([
    ['a real word swapped for another', 'dank', 'dark'],
    ['a real word swapped for another', 'form', 'from'],
    ['a real word inflected', 'crisp', 'crispy'],
    ['a beer word missing from the dictionary', 'hoppier', 'happier'],
    ['a hop variety', 'Loral', 'Local'],
    ['a beer style that looks like a misspelling', 'tripel', 'triple'],
    ['a plausible fix that is not an approved pair', 'hopy', 'hoppy'],
    ['an all-caps word', 'TEH', 'THE'],
    ['a capitalization change', 'teh', 'The'],
  ])('rejects %s (%s -> %s)', (_case, from, to) => {
    expect(spelling(from, to)).toEqual({ ok: false, rule: 'R2' });
  });

  it('rejects a fix to a word in the beer name or brewer', () => {
    expect(spelling('Pinapple', 'Pineapple', ['Pinapple Express', 'Great Heights'])).toEqual({ ok: false, rule: 'R2' });
    expect(spelling('Pinapple', 'Pineapple')).toEqual({ ok: true, edits: [{ from: 'Pinapple', to: 'Pineapple' }] });
  });

  it('rejects a fix inside a hashtag or handle', () => {
    expect(check('Tag #the now', { source: 'Tag #teh now' })).toEqual({ ok: false, rule: 'R2' });
    expect(check('Tag @the now', { source: 'Tag @teh now' })).toEqual({ ok: false, rule: 'R2' });
  });

  it('rejects a fix anywhere inside an underscored hashtag, handle or identifier', () => {
    expect(check('Tag #fresh_pineapple now', { source: 'Tag #fresh_pinapple now' })).toEqual({ ok: false, rule: 'R2' });
    expect(check('Tag @the_brewers now', { source: 'Tag @teh_brewers now' })).toEqual({ ok: false, rule: 'R2' });
    expect(check('Tag pineapple_ipa now', { source: 'Tag pinapple_ipa now' })).toEqual({ ok: false, rule: 'R2' });
  });

  it.each([
    ['a possessive of a protected name', "Loral's aroma.", "Local's aroma.", ['Loral']],
    ['a possessive with a curly apostrophe', 'Loral’s aroma.', 'Local’s aroma.', ['Loral']],
    ['a word containing digits', 'Contains co2.', 'Contains cow.', []],
    ['a chemical formula', 'Pure H2 here.', 'Pure He here.', []],
    ['a non-ASCII letter that hides an extra edit', 'A t𐐨 finish.', 'A the finish.', []],
  ])('rejects %s', (_case, from, to, protectedTerms) => {
    expect(check(to, { source: from, protectedTerms })).toEqual({ ok: false, rule: 'R2' });
  });

  it('rejects reordered words even when each is a real word', () => {
    expect(check('Pours a clear, bright golden yellow. Nose is pineapple and citrus zest.')).toEqual({ ok: false, rule: 'R2' });
  });
});
