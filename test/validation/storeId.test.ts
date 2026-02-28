import { describe, it, expect } from 'vitest';
import { isValidStoreId, KNOWN_STORE_IDS } from '../../src/validation/storeId';

describe('isValidStoreId', () => {
  it('should accept valid numeric store IDs', () => {
    expect(isValidStoreId('13885')).toBe(true);
    expect(isValidStoreId('18686214')).toBe(true);
    expect(isValidStoreId('12345')).toBe(true);
  });

  it('should reject non-numeric store IDs', () => {
    expect(isValidStoreId('abc')).toBe(false);
    expect(isValidStoreId('123abc')).toBe(false);
    expect(isValidStoreId('12.34')).toBe(false);
    expect(isValidStoreId('12-34')).toBe(false);
  });

  it('should reject empty store IDs', () => {
    expect(isValidStoreId('')).toBe(false);
    expect(isValidStoreId('   ')).toBe(false);
  });

  it('should validate against known IDs in strict mode', () => {
    expect(isValidStoreId('13885', true)).toBe(true);
    expect(isValidStoreId('13880', true)).toBe(true);
    expect(isValidStoreId('99999', true)).toBe(false);
    expect(isValidStoreId('12345', true)).toBe(false);
  });

  it('should have all known store IDs in KNOWN_STORE_IDS set', () => {
    expect(KNOWN_STORE_IDS.has('13885')).toBe(true); // Little Rock
    expect(KNOWN_STORE_IDS.has('18686214')).toBe(true); // Cypress Waters
    expect(KNOWN_STORE_IDS.has('18262641')).toBe(true); // DFW Airport
  });
});
