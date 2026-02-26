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
    expect(shouldSkipEnrichment('Black Velvet')).toBe(true);
  });

  it('returns true for exact blocklist match "Texas Flight"', () => {
    expect(shouldSkipEnrichment('Texas Flight')).toBe(true);
  });

  it('returns true for exact blocklist match "Michelada"', () => {
    expect(shouldSkipEnrichment('Michelada')).toBe(true);
  });

  it('returns true for exact blocklist match "Build Your Flight"', () => {
    expect(shouldSkipEnrichment('Build Your Flight')).toBe(true);
  });

  // ========================================================================
  // Pattern matches — flight (case-insensitive)
  // ========================================================================

  it('returns true for brew name containing "flight" (lowercase)', () => {
    expect(shouldSkipEnrichment('Sour Flight')).toBe(true);
  });

  it('returns true for brew name containing "FLIGHT" (uppercase)', () => {
    expect(shouldSkipEnrichment('HOP HEAD FLIGHT 2025')).toBe(true);
  });

  it('returns true for brew name containing "Flight" (mixed case)', () => {
    expect(shouldSkipEnrichment('Fall Favorites Flight SL 2025')).toBe(true);
  });

  // ========================================================================
  // Pattern matches — root beer (case-insensitive)
  // ========================================================================

  it('returns true for brew name containing "root beer" (lowercase)', () => {
    expect(shouldSkipEnrichment('Old Fashion Root Beer')).toBe(true);
  });

  it('returns true for brew name containing "Root Beer"', () => {
    expect(shouldSkipEnrichment('Root Beer')).toBe(true);
  });

  // ========================================================================
  // Pattern matches — beer and cheese (case-insensitive)
  // ========================================================================

  it('returns true for brew name containing "beer and cheese"', () => {
    expect(shouldSkipEnrichment('Beer and Cheese Pairing')).toBe(true);
  });

  // ========================================================================
  // Non-matching cases
  // ========================================================================

  it('returns false for a normal beer name', () => {
    expect(shouldSkipEnrichment('Sierra Nevada Pale Ale')).toBe(false);
  });

  it('returns false for "Budweiser"', () => {
    expect(shouldSkipEnrichment('Budweiser')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(shouldSkipEnrichment('')).toBe(false);
  });

  it('returns false for a brew name containing "light" but not "flight"', () => {
    expect(shouldSkipEnrichment('Bud Light Lime')).toBe(false);
  });

  it('returns false for "Dealership IPA" (no exact or pattern match)', () => {
    expect(shouldSkipEnrichment('Dealership IPA')).toBe(false);
  });

  // ========================================================================
  // Combined exact + pattern match
  // ========================================================================

  it('returns true for "Dealer\'s Choice Flight" (exact match and pattern match)', () => {
    expect(shouldSkipEnrichment("Dealer's Choice Flight")).toBe(true);
  });
});
