/**
 * Tests for extractABV against description shapes seen on the Sugar Land
 * taplist. Every miss here sends a beer to paid Perplexity enrichment even
 * though the brewer already printed the ABV.
 *
 * @module test/db/extractABV.test
 */

import { describe, it, expect } from 'vitest';
import { extractABV } from '../../src/db/helpers';

describe('extractABV', () => {
  it.each([
    ['IPA 6.5% ABV', 6.5],
    ['ABV: 5.2%', 5.2],
    ['ABV 5.2', 5.2],
    ['7% alcohol by volume', 7],
    ['<p>Crisp lager.<br>4.8%</p>', 4.8],
  ])('reads %j as %d', (description, expected) => {
    expect(extractABV(description)).toBe(expected);
  });

  it('reads an ABV that follows an ingredient percentage', () => {
    expect(extractABV('Our Original Ranch Water hard seltzer made with 100% organic agave and natural lime juice. 4.0% ABV')).toBe(4);
  });

  it('reads an ABV that follows an in-range ingredient percentage', () => {
    expect(extractABV('Oatmeal stout brewed with 10% flaked oats. 6.2% ABV')).toBe(6.2);
  });

  it.each([
    ['This beer is a powerhouse at 11.3 percent alcohol.', 11.3],
    ['The Imperial Brown Winter Ale sits at 7 percent ABV with 22 IBUs', 7],
    ['the heat coming from the 9.5 percent ABV', 9.5],
  ])('reads a spelled-out percentage in %j', (description, expected) => {
    expect(extractABV(description)).toBe(expected);
  });

  it.each([
    ['At 21% abv and 120 IBU\'s, you can see why', 21],
    ['Triple oaked. 20.09% ABV $$$', 20.09],
  ])('reads a stated strong-beer ABV above 20 in %j', (description, expected) => {
    expect(extractABV(description)).toBe(expected);
  });

  it('ignores an ingredient percentage that is not labelled as alcohol', () => {
    expect(extractABV('This blend uses Merlot (55%), Grenache Noir (35%), and Syrah (10%) grapes')).toBeNull();
  });

  it('ignores an unlabelled percentage above 20', () => {
    expect(extractABV('Made with 100% fresh-pressed apples')).toBeNull();
  });

  it('ignores an implausible labelled ABV', () => {
    expect(extractABV('Proof that 75% ABV is too much')).toBeNull();
  });

  it('returns null when the description only describes strength in words', () => {
    expect(extractABV('Dark lager with a malty aroma; high alcohol content.')).toBeNull();
  });
});
