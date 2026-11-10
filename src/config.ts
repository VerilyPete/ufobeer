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
 * Enabled Flying Saucer store IDs
 * Starting with Sugar Land only - add more locations as needed
 */
export const ENABLED_STORE_IDS = new Set([
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
  "Pub 'n Pudding Pairing",
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
 * - "2026 Valentine's Day Glass SL", "Murray Christmas Mug 2025 + ..."
 * - "Oktoberfest Class SL 1", "Around the World Beer Class Chit 2"
 * - "Mystery Beer Cans (CAN)", "Underberg Bitter Add On"
 */
export const ENRICHMENT_BLOCKLIST_PATTERNS = [
  /\bflight\b/i,           // Any item containing "flight"
  /\broot beer\b/i,        // Root beer (non-alcoholic)
  /\bbeer and cheese\b/i,  // Beer and cheese pairings
  /\b(?:glass|mug)\b.*(?:\bSL\b|\bft\.|\bw\/|\+)/i, // Promo glassware: "Glass SL", "Glass ft. Guinness", "Mug 2025 + ..."
  /\bprize glass\b/i,      // Contest glassware
  /\bclass\s+(?:SL|chit)\b|\bbeer class\b/i, // Beer-class tickets: "Class SL 1", "Beer Class Chit 2" (not beers like "Class 5 Pale Ale")
  /\bmystery (?:beer|cans?)\b/i, // Blind cans: nothing identifiable to look up
  /\badd[- ]?on\b/i,       // Spirit add-ons such as Underberg
  /\bice cream float\b/i,  // Floats: "Russian Imperial Stout Ice Cream Float"
];

/**
 * Brewer values Flying Saucer uses for mixed pours, blends and flights.
 * Compared trimmed and case-insensitively; a blank brewer is not a signal,
 * because brewer is optional and `skipped` is terminal.
 */
export const PLACEHOLDER_BREWERS = new Set(['n/a', 'unassigned', 'various', 'flights']);

/**
 * Flying Saucer's own label for layered and blended pours ("Black & Pale"),
 * compared with case and spaces removed so "Brew Fusion" also counts.
 */
export const HOUSE_BLEND_BREWER = 'brewfusion';

/**
 * Non-beers whose names are also real beers elsewhere, so each is scoped to
 * the brewer it was seen with: Turk's Head makes a real "Dark Side of the
 * Moon" and Modist a real "Side by Side by Side".
 */
export const ENRICHMENT_BLOCKLIST_BY_BREWER: ReadonlyArray<{ readonly brewName: string; readonly brewer: string }> = [
  { brewName: 'Dark Side of the Moon', brewer: 'Guinness Ltd' },
  { brewName: 'Saint Arnold Anniversary Side By Side', brewer: 'Saint Arnold Brewing Co.' },
];

// ============================================================================
// Helper Functions
// ============================================================================

const normalize = (value: string): string => value.trim().toLowerCase();

/**
 * Check if a beer should be skipped for enrichment.
 *
 * Returns true if the beer:
 * - Has a blank name
 * - Exact match in ENRICHMENT_BLOCKLIST
 * - Pattern match in ENRICHMENT_BLOCKLIST_PATTERNS
 * - Has a placeholder or house-blend brewer
 * - Matches a name-plus-brewer entry in ENRICHMENT_BLOCKLIST_BY_BREWER
 */
export function shouldSkipEnrichment({
  brewName,
  brewer,
}: {
  readonly brewName: string;
  readonly brewer?: string | null | undefined;
}): boolean {
  if (brewName.trim() === '') {
    return true;
  }
  if (ENRICHMENT_BLOCKLIST.has(brewName)) {
    return true;
  }
  if (ENRICHMENT_BLOCKLIST_PATTERNS.some(pattern => pattern.test(brewName))) {
    return true;
  }
  const brewerKey = normalize(brewer ?? '');
  if (PLACEHOLDER_BREWERS.has(brewerKey)) {
    return true;
  }
  if (brewerKey.replace(/\s+/g, '') === HOUSE_BLEND_BREWER) {
    return true;
  }
  const nameKey = normalize(brewName);
  return ENRICHMENT_BLOCKLIST_BY_BREWER.some(
    entry => normalize(entry.brewName) === nameKey && normalize(entry.brewer) === brewerKey
  );
}
