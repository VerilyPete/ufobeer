/**
 * Unit tests for configuration and enrichment blocklist.
 *
 * @module test/config.test
 */

import { describe, it, expect } from 'vitest';
import { shouldSkipEnrichment } from '../src/config';

describe('shouldSkipEnrichment', () => {
  // ========================================================================
  // Exact blocklist matches
  // ========================================================================

  it('returns true for exact blocklist match "Black Velvet"', () => {
    expect(shouldSkipEnrichment({ brewName: 'Black Velvet' })).toBe(true);
  });

  it('returns true for exact blocklist match "Texas Flight"', () => {
    expect(shouldSkipEnrichment({ brewName: 'Texas Flight' })).toBe(true);
  });

  it('returns true for exact blocklist match "Michelada"', () => {
    expect(shouldSkipEnrichment({ brewName: 'Michelada' })).toBe(true);
  });

  it('returns true for exact blocklist match "Build Your Flight"', () => {
    expect(shouldSkipEnrichment({ brewName: 'Build Your Flight' })).toBe(true);
  });

  // ========================================================================
  // Pattern matches — flight (case-insensitive)
  // ========================================================================

  it('returns true for brew name containing "flight" (lowercase)', () => {
    expect(shouldSkipEnrichment({ brewName: 'Sour Flight' })).toBe(true);
  });

  it('returns true for brew name containing "FLIGHT" (uppercase)', () => {
    expect(shouldSkipEnrichment({ brewName: 'HOP HEAD FLIGHT 2025' })).toBe(true);
  });

  it('returns true for brew name containing "Flight" (mixed case)', () => {
    expect(shouldSkipEnrichment({ brewName: 'Fall Favorites Flight SL 2025' })).toBe(true);
  });

  // ========================================================================
  // Pattern matches — root beer (case-insensitive)
  // ========================================================================

  it('returns true for brew name containing "root beer" (lowercase)', () => {
    expect(shouldSkipEnrichment({ brewName: 'Old Fashion Root Beer' })).toBe(true);
  });

  it('returns true for brew name containing "Root Beer"', () => {
    expect(shouldSkipEnrichment({ brewName: 'Root Beer' })).toBe(true);
  });

  // ========================================================================
  // Pattern matches — beer and cheese (case-insensitive)
  // ========================================================================

  it('returns true for brew name containing "beer and cheese"', () => {
    expect(shouldSkipEnrichment({ brewName: 'Beer and Cheese Pairing' })).toBe(true);
  });

  // ========================================================================
  // Non-matching cases
  // ========================================================================

  it('returns false for a normal beer name', () => {
    expect(shouldSkipEnrichment({ brewName: 'Sierra Nevada Pale Ale' })).toBe(false);
  });

  it('returns false for "Budweiser"', () => {
    expect(shouldSkipEnrichment({ brewName: 'Budweiser' })).toBe(false);
  });

  it.each(['', '   '])('returns true for a blank name %j (nothing to look up)', (name) => {
    expect(shouldSkipEnrichment({ brewName: name })).toBe(true);
  });

  // ========================================================================
  // Non-beer taplist items that production paid Perplexity for
  // ========================================================================

  it.each([
    "2026 Valentine's Day Glass SL",
    "St Patrick's Day Glass ft. Guinness SL",
    '2026 420 Glass w/ Equal Parts Mr. Nice Guy',
    'World Cup Grand Prize Glass',
    'Murray Christmas Mug 2025 + Galveston Island Coastal Christmas Ale',
    'Around the World Beer Class SL Chit 1',
    'Oktoberfest Class SL 2',
    "Pub 'n Pudding Pairing",
    'Mystery Beer Cans (CAN)',
    'Underberg Bitter Add On',
    '$5 Mystery Can (CAN)',
    'Mystery Beer (CAN/BTL)',
    'Around the World Beer Class Chit 1',
  ])('returns true for non-beer item %j', (name) => {
    expect(shouldSkipEnrichment({ brewName: name })).toBe(true);
  });

  it.each([
    'Clausthaler Classic N/A (BTL)',
    'Glasstown Pale Ale',
    'World Class IPA',
    'Hopadillo Glass Half Full',
    'Saint Arnold Pumpkinator 2026 Glass Night',
    'Good Society Mystery Made IPA',
    'Dogfish Head The Perfect Pairing',
    'Alaskan Class 5 Pale Ale',
    'Banded Peak Class 5 DIPA',
  ])('returns false for beer %j that only resembles a non-beer word', (name) => {
    expect(shouldSkipEnrichment({ brewName: name })).toBe(false);
  });

  it('returns false for a brew name containing "light" but not "flight"', () => {
    expect(shouldSkipEnrichment({ brewName: 'Bud Light Lime' })).toBe(false);
  });

  it('returns false for "Dealership IPA" (no exact or pattern match)', () => {
    expect(shouldSkipEnrichment({ brewName: 'Dealership IPA' })).toBe(false);
  });

  // ========================================================================
  // Combined exact + pattern match
  // ========================================================================

  it('returns true for "Dealer\'s Choice Flight" (exact match and pattern match)', () => {
    expect(shouldSkipEnrichment({ brewName: "Dealer's Choice Flight" })).toBe(true);
  });

  // ========================================================================
  // Brewer-aware rules
  // ========================================================================

  it.each([
    ['Snake Bite', 'unassigned'],
    ['Half and Half', 'Various'],
    ['Black Velvet', 'Various'],
    ['The Dark Side Flight', 'n/a'],
    ['Some Pour', '  FLIGHTS  '],
    ['Some Pour', ' N/A '],
  ])('returns true for %j under placeholder brewer %j', (brewName, brewer) => {
    expect(shouldSkipEnrichment({ brewName, brewer })).toBe(true);
  });

  it.each([
    ['Black & Pale', 'Brewfusion'],
    ['Black & Red', 'Brewfusion'],
    ['Chocolate Covered Strawberry', 'brewfusion'],
    ['Black & White', 'Brew Fusion'],
  ])('returns true for Flying Saucer in-house blend %j by %j', (brewName, brewer) => {
    expect(shouldSkipEnrichment({ brewName, brewer })).toBe(true);
  });

  it('returns true for the Saint Arnold anniversary pairing', () => {
    expect(shouldSkipEnrichment({
      brewName: 'Saint Arnold Anniversary Side By Side',
      brewer: 'Saint Arnold Brewing Co.',
    })).toBe(true);
  });

  it('returns false for Modist "Side by Side by Side", a real beer', () => {
    expect(shouldSkipEnrichment({
      brewName: 'Side by Side by Side',
      brewer: 'Modist Brewing',
    })).toBe(false);
  });

  it('returns true for the Guinness "Dark Side of the Moon" mixed pour', () => {
    expect(shouldSkipEnrichment({ brewName: 'Dark Side of the Moon', brewer: 'Guinness Ltd' })).toBe(true);
  });

  it('returns false for Turk\'s Head "Dark Side of the Moon", a real schwarzbier', () => {
    expect(shouldSkipEnrichment({ brewName: 'Dark Side of the Moon', brewer: "Turk's Head Brewery" })).toBe(false);
  });

  it('returns true for an ice cream float', () => {
    expect(shouldSkipEnrichment({ brewName: 'Russian Imperial Stout Ice Cream Float', brewer: 'Flying Saucer' })).toBe(true);
  });

  it.each([
    ['Smoke & Mirrors', 'Prairie Artisan Ales'],
    ['Alaskan Class 5 Pale Ale', 'Alaskan Brewing Co.'],
    ['Pale Ale', 'Variousity Brewing'],
    ['Pale Ale', 'Unassigned Brewing'],
  ])('returns false for real beer %j by %j', (brewName, brewer) => {
    expect(shouldSkipEnrichment({ brewName, brewer })).toBe(false);
  });

  it.each([undefined, null, '', '   '])('returns false for a real beer with brewer %j (missing brewer is not a skip signal)', (brewer) => {
    expect(shouldSkipEnrichment({ brewName: '18th Anniversary', brewer })).toBe(false);
  });
});
