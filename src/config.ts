/**
 * Configuration and constants for the UFO Beer enrichment service.
 *
 * This module contains:
 * - Valid Flying Saucer store IDs
 * - Enrichment blocklist (exact matches)
 * - Enrichment blocklist patterns (regex)
 * - Helper function to check if a beer should be skipped
 */

// ============================================================================
// Store IDs
// ============================================================================

/**
 * Valid Flying Saucer store IDs
 * Starting with Sugar Land only - add more locations as needed
 */
export const VALID_STORE_IDS = new Set([
  '13879',    // Sugar Land
]);

// Future locations (uncomment when ready to expand):
// '13885',    // Little Rock
// '13888',    // Charlotte
// '13877',    // Raleigh
// '13883',    // Cordova
// '13881',    // Memphis
// '18686214', // Cypress Waters
// '13891',    // Fort Worth
// '13884',    // The Lake
// '18262641', // DFW Airport
// '13880',    // Houston
// '13882',    // San Antonio

// ============================================================================
// Enrichment Blocklist
// ============================================================================

/**
 * Blocklist of brew names to skip during enrichment.
 * These are flights, mixed drinks, non-alcoholic items, etc.
 *
 * For exact string matches only. For pattern-based matches, see
 * ENRICHMENT_BLOCKLIST_PATTERNS.
 */
export const ENRICHMENT_BLOCKLIST = new Set([
  'Black Velvet',
  'Build Your Flight',
  'Cheeky Monkey',
  'Chocolate Banana',
  "Dealer's Choice Flight",
  'Hop Head Flight',
  'Hummingbird H20',
  'Irish Car Bomb',
  'Michelada',
  'Texas Flight',
]);

/**
 * Patterns to match for blocklist (case-insensitive).
 *
 * Matches items like:
 * - "Fall Favorites Flight SL 2025"
 * - "Sour Flight"
 * - "Root Beer"
 * - "Beer and Cheese Pairing"
 */
export const ENRICHMENT_BLOCKLIST_PATTERNS = [
  /\bflight\b/i,           // Any item containing "flight"
  /\broot beer\b/i,        // Root beer (non-alcoholic)
  /\bbeer and cheese\b/i,  // Beer and cheese pairings
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a beer name should be skipped for enrichment.
 *
 * Returns true if the beer matches:
 * - Exact match in ENRICHMENT_BLOCKLIST
 * - Pattern match in ENRICHMENT_BLOCKLIST_PATTERNS
 *
 * @param brewName - The name of the beer to check
 * @returns true if the beer should be skipped, false otherwise
 */
export function shouldSkipEnrichment(brewName: string): boolean {
  // Check exact matches
  if (ENRICHMENT_BLOCKLIST.has(brewName)) {
    return true;
  }
  // Check patterns
  return ENRICHMENT_BLOCKLIST_PATTERNS.some(pattern => pattern.test(brewName));
}
