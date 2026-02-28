/**
 * Store ID validation for Flying Saucer API requests.
 */

// Known valid store IDs from Flying Saucer
export const KNOWN_STORE_IDS = new Set([
  '13885',    // Little Rock
  '13888',    // Charlotte
  '13877',    // Raleigh
  '13883',    // Cordova
  '13881',    // Memphis
  '18686214', // Cypress Waters
  '13891',    // Fort Worth
  '13884',    // The Lake
  '18262641', // DFW Airport
  '13880',    // Houston
  '13882',    // San Antonio
  '13879',    // Sugar Land
]);

/**
 * Validate a store ID.
 * @param storeId - The store ID to validate
 * @param strictMode - If true, only allow known store IDs
 * @returns true if valid
 */
export function isValidStoreId(storeId: string, strictMode = false): boolean {
  // Must be non-empty
  if (!storeId || storeId.trim() === '') {
    return false;
  }

  // Must be numeric
  if (!/^\d+$/.test(storeId)) {
    return false;
  }

  // Optionally: check against known IDs
  if (strictMode) {
    return KNOWN_STORE_IDS.has(storeId);
  }

  return true;
}
