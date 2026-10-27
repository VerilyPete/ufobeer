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

  it('rejects changed punctuation that is not a permitted fix', () => {
    expect(check('Pours a bright, clear golden yellow! Nose is pineapple and citrus zest.')).toEqual({ ok: false, rule: 'R3' });
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

describe('cleanup guard: punctuation fixes (R3)', () => {
  it.each([
    ['a missing space after a full stop', 'Some bitterness.Medium body.', 'Some bitterness. Medium body.', 'bitterness.Medium', 'bitterness. Medium'],
    ['a missing space after a comma', 'Citra,Mosaic hops.', 'Citra, Mosaic hops.', 'Citra,Mosaic', 'Citra, Mosaic'],
    ['a missing final full stop', 'Very crisp', 'Very crisp.', 'crisp', 'crisp.'],
  ])('accepts %s and reports it in context', (_case, source, output, from, to) => {
    expect(check(output, { source })).toEqual({ ok: true, edits: [{ from, to }] });
  });

  it.each([
    ['a comma that reverses a statement', 'No alcohol is added.', 'No, alcohol is added.'],
    ['a full stop that changes scope', 'No coffee notes.', 'No. Coffee notes.'],
    ['an added comma', 'A crisp dry finish.', 'A crisp, dry finish.'],
    ['an added full stop', 'A clean lager. Nose of citrus.', 'A clean. Lager. Nose of citrus.'],
    ['a removed comma', 'A crisp, dry finish.', 'A crisp dry finish.'],
    ['a removed full stop', 'Crisp. Dry finish.', 'Crisp Dry finish.'],
    ['a comma swapped for a semicolon', 'A crisp, dry finish.', 'A crisp; dry finish.'],
    ['an added semicolon', 'A crisp dry finish.', 'A crisp; dry finish.'],
    ['an added colon', 'Notes of citrus pine.', 'Notes of: citrus pine.'],
    ['an added exclamation mark', 'A crisp dry finish.', 'A crisp! Dry finish.'],
    ['a changed final exclamation mark', 'A crisp finish!', 'A crisp finish.'],
    ['an added trailing comma', 'Very crisp', 'Very crisp,'],
    ['a straightened quote', 'A “crisp” finish.', 'A "crisp" finish.'],
    ['a split number', 'Over 1,000 kegs.', 'Over 1, 000 kegs.'],
    ['a split price', 'Only $5.00 today.', 'Only $5. 00 today.'],
    ['a split domain', 'See example.com today.', 'See example. com today.'],
    ['a split all-caps domain', 'See example.COM today.', 'See example. COM today.'],
    ['a split title-case domain', 'See example.Com today.', 'See example. Com today.'],
    ['a split title-case beer domain', 'Visit hops.Beer today.', 'Visit hops. Beer today.'],
    ['a final full stop appended to a path', 'Download /recipes/ipa', 'Download /recipes/ipa.'],
    ['a final full stop appended to a domain', 'Visit example.com', 'Visit example.com.'],
    ['a split email address', 'Mail sales.Example@example.com today.', 'Mail sales. Example@example.com today.'],
    ['a split dotted handle', 'Follow @brew.Example today.', 'Follow @brew. Example today.'],
    ['a split chained list', 'Notes of crisp,dry,clean malt.', 'Notes of crisp, dry,clean malt.'],
    ['a full stop added after a number', 'ABV 5', 'ABV 5.'],
    ['an added space before a comma', 'A crisp, dry finish.', 'A crisp , dry finish.'],
    ['a comma swapped for a full stop', 'Citra,Mosaic hops.', 'Citra. Mosaic hops.'],
    ['a space added after a comma before a number', 'Batch,2 today.', 'Batch, 2 today.'],
    ['a pair joined to a preceding word by a bracket', 'Malt(crisp,dry) ale.', 'Malt(crisp, dry) ale.'],
  ])('rejects %s', (_case, source, output) => {
    expect(check(output, { source })).toEqual({ ok: false, rule: 'R3' });
  });

  it('rejects punctuation edits beside a beer name or brewer', () => {
    expect(check('Brewed by Great Heights. Medium body.', { source: 'Brewed by Great Heights.Medium body.', protectedTerms: ['Great Heights'] }))
      .toEqual({ ok: false, rule: 'R3' });
    expect(check('Brewed by Great Heights.', { source: 'Brewed by Great Heights', protectedTerms: ['Great Heights'] }))
      .toEqual({ ok: false, rule: 'R3' });
    expect(check('A strong ale. Great Heights brews it.', { source: 'A strong ale.Great Heights brews it.', protectedTerms: ['Great Heights'] }))
      .toEqual({ ok: false, rule: 'R3' });
  });
});

describe('cleanup guard: capitalization (R4)', () => {
  it('accepts capitalizing a word after an existing sentence end', () => {
    expect(check('Some bitterness. Medium body.', { source: 'Some bitterness. medium body.' }))
      .toEqual({ ok: true, edits: [{ from: 'medium', to: 'Medium' }] });
  });

  it.each([
    ['capitalizing mid-sentence', 'A crisp dry finish.', 'A crisp Dry finish.'],
    ['lowercasing a word', 'The finish is dry.', 'the finish is dry.'],
    ['lowercasing after a sentence end', 'Dry. The finish.', 'Dry. the finish.'],
    ['capitalizing the first word', 'pours gold.', 'Pours gold.'],
    ['capitalizing inside a domain', 'See example.com today.', 'See example.Com today.'],
    ['changing more than the first letter after a sentence end', 'Dry. finish here.', 'Dry. FINISH here.'],
    ['capitalizing a unit after an abbreviation', 'Volumes use SI units, e.g. mL.', 'Volumes use SI units, e.g. ML.'],
    ['capitalizing a word after a short abbreviation', 'Sweet, e.g. caramel.', 'Sweet, e.g. Caramel.'],
    ['capitalizing a mixed-case word', 'A collaboration. iPhone users love it.', 'A collaboration. IPhone users love it.'],
  ])('rejects %s', (_case, source, output) => {
    expect(check(output, { source })).toEqual({ ok: false, rule: 'R4' });
  });

  it('accepts capitalizing a one-letter word after a sentence end', () => {
    expect(check('Dry finish. A hint of oak.', { source: 'Dry finish. a hint of oak.' }))
      .toEqual({ ok: true, edits: [{ from: 'a', to: 'A' }] });
  });

  it('rejects capitalizing a beer name or brewer', () => {
    expect(check('A collaboration. EBay supplied glasses.', { source: 'A collaboration. eBay supplied glasses.', protectedTerms: ['eBay'] }))
      .toEqual({ ok: false, rule: 'R4' });
  });
});

describe('cleanup guard: combined fixes', () => {
  it('reports spelling, punctuation and case edits in text order', () => {
    expect(check('A pleasant ale. Very crisp, dry finish.', { source: 'A pleasent ale. very crisp,dry finish' })).toEqual({
      ok: true,
      edits: [
        { from: 'pleasent', to: 'pleasant' },
        { from: 'very', to: 'Very' },
        { from: 'crisp,dry', to: 'crisp, dry' },
        { from: 'finish', to: 'finish.' },
      ],
    });
  });
});

describe('cleanup guard: edit budget (R5)', () => {
  it('accepts five permitted edits', () => {
    expect(check('A crisp, dry ale. Bright, fresh. Clean, smooth. Very pleasant.', { source: 'A crisp,dry ale. Bright,fresh. Clean,smooth. Very pleasent' }).ok)
      .toBe(true);
  });

  it('rejects six permitted edits', () => {
    expect(check('A crisp, dry ale. Bright, fresh. Clean, smooth. Light, airy. Very pleasant.', { source: 'A crisp,dry ale. Bright,fresh. Clean,smooth. Light,airy. Very pleasent' }))
      .toEqual({ ok: false, rule: 'R5' });
  });
});
