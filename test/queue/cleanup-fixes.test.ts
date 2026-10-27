import { describe, it, expect } from 'vitest';
import { applyCleanupFixes, checkCleanup } from '../../src/queue/cleanupGuard';

const fix = (source: string, protectedTerms: readonly string[] = []) => applyCleanupFixes({ source, protectedTerms });

describe('applyCleanupFixes', () => {
  it.each([
    ['a reviewed misspelling', 'A pleasent finish.', 'A pleasant finish.'],
    ['a capitalized reviewed misspelling', 'Pleasent finish.', 'Pleasant finish.'],
    ['a missing space after a comma', 'Citra,Mosaic hops.', 'Citra, Mosaic hops.'],
    ['a missing space between a percentage and ABV', 'Strong at 9.2%ABV today.', 'Strong at 9.2% ABV today.'],
    ['a missing final full stop', 'A crisp finish', 'A crisp finish.'],
    ['a missing final full stop after a percentage', 'Bright and dry at 4.7%', 'Bright and dry at 4.7%.'],
    ['every fix at once', 'A pleasent ale with Citra,Mosaic hops at 9.2%ABV', 'A pleasant ale with Citra, Mosaic hops at 9.2% ABV.'],
  ])('applies %s', (_case, source, expected) => {
    expect(fix(source)).toBe(expected);
  });

  it.each([
    ['an unreviewed misspelling', 'A teh finish.'],
    ['a word in the beer name or brewer', 'Brewed by Pleasent Valley.'],
    ['a hashtag', 'Tag #pleasent today.'],
    ['an email address', 'Mail pleasent@example.com today.'],
    ['a number', 'Over 1,000 kegs.'],
    ['a chained list', 'Notes of crisp,dry,clean malt.'],
    ['a full stop between words', 'Some bitterness.Medium body.'],
    ['an all-caps misspelling', 'A PLEASENT finish.'],
    ['text ending in punctuation', 'A crisp finish!'],
    ['text ending in a path', 'Download /recipes/ipa'],
  ])('leaves %s unchanged', (_case, source) => {
    expect(fix(source, ['Pleasent Valley Brewing'])).toBe(source);
  });

  const sources = [
    'This IPA is out of this world piney, citrusy, and well-ballanced. Chinook, Amarillo, and Citra hops at 8.5% ABV',
    "Martin House Brewing Company's Imperial Stout with Graham Crackers, Chocolate, Marshmellows, & Lactose. 9.2%ABV",
    'Pours a deep indigo. Aromas of juicy blueberries,straw and wheat. Medium light body. 5.4% ABV',
    'INtial bite is pleasent with a slighty dry fnish, noticable but not enought to distract',
    'A pleasent ale, crisp,dry,clean. See example.com or mail pleasent@example.com #pleasent 1,000 kegs at $5.00',
    '',
  ];

  it.each(sources)('produces output the guard accepts, whatever the number of edits: %s', source => {
    const output = fix(source, ['Leo Carillo', 'Great Heights']);
    expect(checkCleanup({ source, output, protectedTerms: ['Leo Carillo', 'Great Heights'], maxEdits: Number.POSITIVE_INFINITY }).ok).toBe(true);
  });

  it.each(sources)('is idempotent: %s', source => {
    expect(fix(fix(source))).toBe(fix(source));
  });
});

describe('checkCleanup edit limit', () => {
  it('defaults to the model edit budget but accepts an explicit limit', () => {
    const source = 'A crisp,dry ale. Bright,fresh. Clean,smooth. Light,airy. Very pleasent';
    const output = 'A crisp, dry ale. Bright, fresh. Clean, smooth. Light, airy. Very pleasant.';
    expect(checkCleanup({ source, output, protectedTerms: [] })).toEqual({ ok: false, rule: 'R5' });
    expect(checkCleanup({ source, output, protectedTerms: [], maxEdits: 6 }).ok).toBe(true);
  });
});
