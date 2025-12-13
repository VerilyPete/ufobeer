/**
 * Database helper functions for beer enrichment.
 * Extracted from index.ts as part of Phase 6 refactoring.
 */

/**
 * Result of inserting placeholder records for beers.
 * Used to track which beers need Perplexity enrichment.
 */
export interface InsertPlaceholdersResult {
  totalSynced: number;
  withAbv: number;
  needsEnrichment: Array<{
    id: string;
    brew_name: string;
    brewer: string;
  }>;
}

/**
 * Extract ABV percentage from beer description HTML.
 * Returns null if no valid ABV found.
 *
 * Supports two patterns:
 * 1. Percentage notation: "5.2%" or "8%"
 * 2. ABV keyword: "5.2 ABV", "ABV 5.2", "ABV: 5.2"
 *
 * Max 20% to filter out unrelated percentages.
 */
export function extractABV(description: string | undefined): number | null {
  if (!description) return null;

  // Strip HTML tags to get plain text
  const plainText = description.replace(/<[^>]*>/g, '');

  // Pattern 1: Look for percentage pattern (e.g., "5.2%" or "8%")
  // Max 20% - higher values are likely unrelated percentages (e.g., "100% satisfaction")
  const percentageMatch = plainText.match(/\b(\d+(?:\.\d+)?)\s*%/);
  if (percentageMatch && percentageMatch[1]) {
    const abv = parseFloat(percentageMatch[1]);
    if (!isNaN(abv) && abv >= 0 && abv <= 20) {
      return abv;
    }
  }

  // Pattern 2: Look for "ABV" near a number (e.g., "5.2 ABV", "ABV 5.2", "ABV: 5.2")
  // Max 20% - higher values are implausible for beer, let Perplexity handle those
  const abvPattern = /(?:ABV[:\s]*\b(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s*ABV)/i;
  const abvMatch = plainText.match(abvPattern);

  if (abvMatch) {
    // Match could be in group 1 (ABV first) or group 2 (number first)
    const abvString = abvMatch[1] || abvMatch[2];
    if (abvString) {
      const abv = parseFloat(abvString);
      if (!isNaN(abv) && abv >= 0 && abv <= 20) {
        return abv;
      }
    }
  }

  return null;
}

/**
 * Insert placeholder records for beers that need enrichment.
 * Uses INSERT OR IGNORE so existing beers are not overwritten.
 * Uses chunking to respect D1's parameter limits.
 *
 * IMPORTANT: Extracts ABV from brew_description when available.
 * Only beers where ABV couldn't be parsed will have NULL abv and
 * be candidates for Perplexity enrichment.
 *
 * This syncs beers from Flying Saucer to our enriched_beers table,
 * enabling the trigger endpoint and cron to find beers to enrich.
 */
export async function insertPlaceholders(
  db: D1Database,
  beers: Array<{ id: string; brew_name: string; brewer: string; brew_description?: string }>,
  requestId: string
): Promise<InsertPlaceholdersResult> {
  if (beers.length === 0) {
    return { totalSynced: 0, withAbv: 0, needsEnrichment: [] };
  }

  const CHUNK_SIZE = 25; // D1 has limits on batched operations
  const now = Date.now();

  let withAbv = 0;
  const needsEnrichment: Array<{ id: string; brew_name: string; brewer: string }> = [];

  for (let i = 0; i < beers.length; i += CHUNK_SIZE) {
    const chunk = beers.slice(i, i + CHUNK_SIZE);
    // Use INSERT ... ON CONFLICT UPDATE to:
    // 1. Always update last_seen_at when beer is seen (for cleanup tracking)
    // 2. Only set ABV/confidence/source if currently NULL (preserve Perplexity data)
    const stmt = db.prepare(`
      INSERT INTO enriched_beers (id, brew_name, brewer, abv, confidence, enrichment_source, updated_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        -- Only update ABV/confidence/source if we have a parsed ABV from description
        -- (don't overwrite Perplexity data with NULL)
        abv = CASE
          WHEN enriched_beers.enrichment_source = 'perplexity' THEN enriched_beers.abv
          WHEN excluded.abv IS NOT NULL THEN excluded.abv
          ELSE enriched_beers.abv
        END,
        confidence = CASE
          WHEN enriched_beers.enrichment_source = 'perplexity' THEN enriched_beers.confidence
          WHEN excluded.abv IS NOT NULL THEN excluded.confidence
          ELSE enriched_beers.confidence
        END,
        enrichment_source = CASE
          WHEN enriched_beers.enrichment_source = 'perplexity' THEN 'perplexity'
          WHEN excluded.abv IS NOT NULL THEN 'description'
          ELSE enriched_beers.enrichment_source
        END
    `);
    const batch = chunk.map(b => {
      const abv = extractABV(b.brew_description);
      if (abv !== null) {
        withAbv++;
      } else {
        needsEnrichment.push({ id: b.id, brew_name: b.brew_name, brewer: b.brewer });
      }
      // Confidence 0.9 for description-extracted ABV (reliable but not verified)
      // NULL confidence for beers needing enrichment
      const confidence = abv !== null ? 0.9 : null;
      // Source: 'description' for parsed ABV, NULL for beers needing enrichment
      // (Perplexity consumer will set 'perplexity' when it enriches)
      const source = abv !== null ? 'description' : null;
      // last_seen_at = now for both insert and update
      return stmt.bind(b.id, b.brew_name, b.brewer, abv, confidence, source, now, now);
    });

    try {
      await db.batch(batch);
    } catch (error) {
      console.error(`[insertPlaceholders] Error inserting chunk ${i / CHUNK_SIZE + 1}:`, error);
      // Continue with next chunk - don't fail the entire operation
    }
  }

  console.log(`[insertPlaceholders] Synced ${beers.length} beers (${withAbv} with ABV, ${needsEnrichment.length} need enrichment), requestId=${requestId}`);

  return { totalSynced: beers.length, withAbv, needsEnrichment };
}
