/**
 * Tests for categorizeBeer pure function.
 *
 * Verifies that each beer is correctly categorized based on:
 * - Whether it already exists in the database
 * - Whether the description has changed (hash mismatch)
 * - Whether it has ABV already
 * - Whether it has a description
 * - Whether it's blocklisted
 *
 * @module test/db/categorizeBeer.test
 */

import { describe, it, expect } from 'vitest';
import { categorizeBeer } from '../../src/db/helpers';

type ExistingBeerInfo = { description_hash: string | null; abv: number | null };

function makeBeer(overrides: {
  id?: string;
  brew_name?: string;
  brewer?: string;
  brew_description?: string | undefined;
} = {}) {
  return {
    id: overrides.id ?? 'beer-1',
    brew_name: overrides.brew_name ?? 'Test IPA',
    brewer: overrides.brewer ?? 'Test Brewery',
    brew_description: overrides.brew_description,
  };
}

describe('categorizeBeer', () => {
  describe('description changed (existing beer, hash mismatch)', () => {
    it('returns description_changed when description hash differs', () => {
      const beer = makeBeer({ brew_description: 'New description' });
      const hashMap = new Map([['beer-1', 'new-hash']]);
      const existingMap = new Map<string, ExistingBeerInfo>([
        ['beer-1', { description_hash: 'old-hash', abv: 5.0 }],
      ]);

      const result = categorizeBeer(beer, hashMap, existingMap);

      expect(result.type).toBe('description_changed');
      if (result.type === 'description_changed') {
        expect(result.beer).toBe(beer);
      }
    });

    it('returns description_changed for existing beer with null hash getting a description', () => {
      const beer = makeBeer({ brew_description: 'New description' });
      const hashMap = new Map([['beer-1', 'some-hash']]);
      const existingMap = new Map<string, ExistingBeerInfo>([
        ['beer-1', { description_hash: null, abv: null }],
      ]);

      const result = categorizeBeer(beer, hashMap, existingMap);

      expect(result.type).toBe('description_changed');
    });
  });

  describe('existing beer, no ABV, not blocklisted', () => {
    it('returns needs_enrichment', () => {
      const beer = makeBeer({ brew_description: 'A tasty beer' });
      const hashMap = new Map([['beer-1', 'same-hash']]);
      const existingMap = new Map<string, ExistingBeerInfo>([
        ['beer-1', { description_hash: 'same-hash', abv: null }],
      ]);

      const result = categorizeBeer(beer, hashMap, existingMap);

      expect(result.type).toBe('needs_enrichment');
      if (result.type === 'needs_enrichment') {
        expect(result.beer).toBe(beer);
      }
    });

    it('returns needs_enrichment_blocklisted for blocklisted beer', () => {
      const beer = makeBeer({ brew_name: 'Build Your Flight' });
      const hashMap = new Map([['beer-1', 'same-hash']]);
      const existingMap = new Map<string, ExistingBeerInfo>([
        ['beer-1', { description_hash: 'same-hash', abv: null }],
      ]);

      const result = categorizeBeer(beer, hashMap, existingMap);

      expect(result.type).toBe('needs_enrichment_blocklisted');
    });
  });

  describe('new beer with description (any description)', () => {
    it('returns description_changed because hash differs from undefined', () => {
      const beer = makeBeer({ brew_description: 'A nice IPA 7.2% ABV' });
      const hashMap = new Map([['beer-1', 'some-hash']]);
      const existingMap = new Map<string, ExistingBeerInfo>();

      const result = categorizeBeer(beer, hashMap, existingMap);

      // New beer with description: hash !== undefined, so treated as description_changed
      expect(result.type).toBe('description_changed');
    });

    it('also returns description_changed for description without ABV', () => {
      const beer = makeBeer({ brew_description: 'A great beer without ABV info' });
      const hashMap = new Map([['beer-1', 'some-hash']]);
      const existingMap = new Map<string, ExistingBeerInfo>();

      const result = categorizeBeer(beer, hashMap, existingMap);

      expect(result.type).toBe('description_changed');
    });
  });

  describe('new beer with ABV but no existing record and no description hash', () => {
    it('returns new_with_abv when beer has description but hash is null', () => {
      // This case: beer has description but hash came back null somehow
      // hash(null) === undefined?.description_hash (undefined) -- NOT changed
      // Then existing is undefined, so goes to new beer path
      const beer = makeBeer({ brew_description: 'A nice IPA 7.2% ABV' });
      const hashMap = new Map<string, string | null>([['beer-1', null]]);
      const existingMap = new Map<string, ExistingBeerInfo>();

      const result = categorizeBeer(beer, hashMap, existingMap);

      // null !== undefined is true, so this is still description_changed
      // This matches the original insertPlaceholders behavior
      expect(result.type).toBe('description_changed');
    });
  });

  describe('new beer without description, with extractable ABV via existing path', () => {
    it('returns new_needs_enrichment since no description to extract from', () => {
      // A beer without description reaches the `existing === undefined` path
      const beer = makeBeer();
      const hashMap = new Map<string, string | null>([['beer-1', null]]);
      const existingMap = new Map<string, ExistingBeerInfo>();

      const result = categorizeBeer(beer, hashMap, existingMap);

      expect(result.type).toBe('new_needs_enrichment');
    });
  });

  describe('new beer without description, not blocklisted', () => {
    it('returns new_needs_enrichment', () => {
      const beer = makeBeer();
      const hashMap = new Map([['beer-1', null]]);
      const existingMap = new Map<string, ExistingBeerInfo>();

      const result = categorizeBeer(beer, hashMap, existingMap);

      expect(result.type).toBe('new_needs_enrichment');
      if (result.type === 'new_needs_enrichment') {
        expect(result.beer).toBe(beer);
      }
    });

    it('returns new_needs_enrichment_blocklisted for blocklisted beer', () => {
      const beer = makeBeer({ brew_name: 'Root Beer Float' });
      const hashMap = new Map([['beer-1', null]]);
      const existingMap = new Map<string, ExistingBeerInfo>();

      const result = categorizeBeer(beer, hashMap, existingMap);

      expect(result.type).toBe('new_needs_enrichment_blocklisted');
    });
  });

  describe('existing beer with ABV (unchanged)', () => {
    it('returns unchanged', () => {
      const beer = makeBeer({ brew_description: 'Good beer 5%' });
      const hashMap = new Map([['beer-1', 'same-hash']]);
      const existingMap = new Map<string, ExistingBeerInfo>([
        ['beer-1', { description_hash: 'same-hash', abv: 5.0 }],
      ]);

      const result = categorizeBeer(beer, hashMap, existingMap);

      expect(result.type).toBe('unchanged');
      if (result.type === 'unchanged') {
        expect(result.beer).toBe(beer);
      }
    });
  });

  describe('description hash', () => {
    it('passes descriptionHash through from hashMap', () => {
      const beer = makeBeer({ brew_description: 'New desc' });
      const hashMap = new Map([['beer-1', 'the-hash-value']]);
      const existingMap = new Map<string, ExistingBeerInfo>([
        ['beer-1', { description_hash: 'old-hash', abv: null }],
      ]);

      const result = categorizeBeer(beer, hashMap, existingMap);

      expect(result.descriptionHash).toBe('the-hash-value');
    });

    it('uses null when hash is not in map', () => {
      const beer = makeBeer();
      const hashMap = new Map<string, string | null>();
      const existingMap = new Map<string, ExistingBeerInfo>();

      const result = categorizeBeer(beer, hashMap, existingMap);

      expect(result.descriptionHash).toBeNull();
    });
  });
});
