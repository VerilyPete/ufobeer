/**
 * Store ID validation for Flying Saucer API requests.
 */

/**
 * Validate a store ID: a non-empty string of digits.
 * @param storeId - The store ID to validate
 * @returns true if valid
 */
export function isValidStoreId(storeId: string): boolean {
  // Must be non-empty
  if (!storeId || storeId.trim() === '') {
    return false;
  }

  // Must be numeric
  return /^\d+$/.test(storeId);
}
