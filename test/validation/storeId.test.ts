import { describe, it, expect } from 'vitest';
import { isValidStoreId } from '../../src/validation/storeId';

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
});
