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
    ['pleasent', 'pleasant'],
    ['noticable', 'noticeable'],
    ['alchohol', 'alcohol'],
    ['marshmellows', 'marshmallows'],
    ['Ballanced', 'Balanced'],
  ])('accepts the reviewed correction %s -> %s and reports the edit', (from, to) => {
    expect(spelling(from, to)).toEqual({ ok: true, edits: [{ from, to }] });
  });

  it.each([
    ['a real word swapped for another', 'dank', 'dark'],
    ['a real word swapped for another', 'form', 'from'],
    ['a real word inflected', 'crisp', 'crispy'],
    ['a beer word missing from the dictionary', 'hoppier', 'happier'],
    ['a hop variety', 'Loral', 'Local'],
    ['a beer style that looks like a misspelling', 'tripel', 'triple'],
    ['an inflected beer style', 'tripels', 'triples'],
    ['an ingredient name', 'Hass', 'Hash'],
    ['intentional wording', 'folx', 'folks'],
    ['a fragment of a non-ASCII word', 'caf', 'calf'],
    ['a common typo that has not been reviewed', 'teh', 'the'],
    ['a plausible fix that has not been reviewed', 'hopy', 'hoppy'],
    ['an all-caps word', 'ALCHOHOL', 'ALCOHOL'],
    ['a capitalization change', 'pleasent', 'Pleasant'],
  ])('rejects %s (%s -> %s)', (_case, from, to) => {
    expect(spelling(from, to)).toEqual({ ok: false, rule: 'R2' });
  });

  it('rejects a fix to a word in the beer name or brewer', () => {
    expect(spelling('Pleasent', 'Pleasant', ['Pleasent Valley Ale', 'Great Heights'])).toEqual({ ok: false, rule: 'R2' });
    expect(spelling('Pleasent', 'Pleasant')).toEqual({ ok: true, edits: [{ from: 'Pleasent', to: 'Pleasant' }] });
  });

  it('rejects a fix inside a hashtag or handle', () => {
    expect(check('Tag #pleasant now', { source: 'Tag #pleasent now' })).toEqual({ ok: false, rule: 'R2' });
    expect(check('Tag @pleasant now', { source: 'Tag @pleasent now' })).toEqual({ ok: false, rule: 'R2' });
  });

  it.each([
    ['French', 'Un jaune brillant.', 'Un jaune brilliant.'],
    ['German', 'Im Stil eines Pilsners.', 'Im Still eines Pilsners.'],
  ])('rejects changing a valid %s word', (_language, source, output) => {
    expect(check(output, { source })).toEqual({ ok: false, rule: 'R2' });
  });

  it.each([
    ['an email address', 'Mail pleasent@example.com now', 'Mail pleasant@example.com now'],
    ['a URL path', 'See www.example.com/pleasent-ale now', 'See www.example.com/pleasant-ale now'],
    ['a dotted handle', 'Follow @brew.pleasent now', 'Follow @brew.pleasant now'],
    ['a hyphenated compound', 'A pleasent-tasting ale', 'A pleasant-tasting ale'],
    ['a slash-joined word', 'Malt/pleasent finish', 'Malt/pleasant finish'],
    ['a word followed by a symbol', 'A pleasent* finish', 'A pleasant* finish'],
    ['a word joined by a bracket', 'Malt(pleasent) finish', 'Malt(pleasant) finish'],
    ['a comma with no following space', 'A pleasent,dry finish', 'A pleasant,dry finish'],
  ])('rejects a fix inside %s', (_case, source, output) => {
    expect(check(output, { source })).toEqual({ ok: false, rule: 'R2' });
  });

  it.each([
    ['comma', 'A pleasent, dry finish.', 'A pleasant, dry finish.'],
    ['brackets', 'A (pleasent) finish.', 'A (pleasant) finish.'],
    ['quotes', 'A "pleasent" finish.', 'A "pleasant" finish.'],
    ['sentence end', 'Very pleasent.', 'Very pleasant.'],
    ['first word', 'Pleasent aroma.', 'Pleasant aroma.'],
    ['last word without punctuation', 'Very pleasent', 'Very pleasant'],
    ['first word after an opening quote', '"Pleasent" aroma.', '"Pleasant" aroma.'],
  ])('accepts a fix next to ordinary punctuation (%s)', (_case, source, output) => {
    expect(check(output, { source }).ok).toBe(true);
  });

  it('protects the bare form of a possessive beer name or brewer', () => {
    expect(check('Pleasant brews this ale.', { source: 'Pleasent brews this ale.', protectedTerms: ["Pleasent's Brewing"] })).toEqual({ ok: false, rule: 'R2' });
    expect(check('Pleasant brews this ale.', { source: 'Pleasent brews this ale.', protectedTerms: ['Pleasent’s Brewing'] })).toEqual({ ok: false, rule: 'R2' });
  });

  it('rejects a fix anywhere inside an underscored hashtag, handle or identifier', () => {
    expect(check('Tag #so_pleasant now', { source: 'Tag #so_pleasent now' })).toEqual({ ok: false, rule: 'R2' });
    expect(check('Tag @pleasant_brewers now', { source: 'Tag @pleasent_brewers now' })).toEqual({ ok: false, rule: 'R2' });
    expect(check('Tag pleasant_ipa now', { source: 'Tag pleasent_ipa now' })).toEqual({ ok: false, rule: 'R2' });
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
