/**
 * Database helper functions for beer enrichment.
 * Extracted from index.ts as part of Phase 6 refactoring.
 */

import { hashDescription } from '../utils/hash';
import { shouldSkipEnrichment } from '../config';

// ============================================================================
// Enrichment Data Types
// ============================================================================

/**
 * Enrichment data for a single beer, returned by getEnrichmentForBeerIds.
 */
export interface BeerEnrichmentData {
  abv: number | null;
  confidence: number;
  source: string | null;
  brew_description_cleaned: string | null;
}

// ============================================================================
// Bounded Query Helper
// ============================================================================

/**
 * Fetch enrichment data for a list of beer IDs, respecting D1's 100 parameter limit.
 * Uses db.batch() for single round-trip performance.
 *
 * This replaces unbounded SELECT queries that load the entire enriched_beers table,
 * which could OOM the Worker as the table grows (128MB memory limit).
 *
 * @param db - D1 database instance
 * @param beerIds - Array of beer IDs to fetch enrichment for
 * @param requestId - Request ID for logging
 * @returns Map of beer ID to enrichment data
 */
export async function getEnrichmentForBeerIds(
  db: D1Database,
  beerIds: string[],
  requestId: string
): Promise<Map<string, BeerEnrichmentData>> {
  const enrichmentMap = new Map<string, BeerEnrichmentData>();

  if (beerIds.length === 0) {
    return enrichmentMap;
  }

  // D1 has a 100 parameter limit - use 90 for safety margin
  const CHUNK_SIZE = 90;

  // Build batch of prepared statements
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < beerIds.length; i += CHUNK_SIZE) {
    const chunk = beerIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    statements.push(
      db
        .prepare(
          `SELECT id, abv, confidence, enrichment_source, brew_description_cleaned
           FROM enriched_beers WHERE id IN (${placeholders})`
        )
        .bind(...chunk)
    );
  }

  try {
    // Execute all chunks in parallel (single round trip to D1)
    const batchResults = await db.batch(statements);

    for (const result of batchResults) {
      if (result.results) {
        for (const row of result.results as Array<{
          id: string;
          abv: number | null;
          confidence: number;
          enrichment_source: string | null;
          brew_description_cleaned: string | null;
        }>) {
          enrichmentMap.set(row.id, {
            abv: row.abv,
            confidence: row.confidence,
            source: row.enrichment_source,
            brew_description_cleaned: row.brew_description_cleaned,
          });
        }
      }
    }

    console.log(
      JSON.stringify({
        event: 'enrichment_fetch',
        requestedIds: beerIds.length,
        foundRecords: enrichmentMap.size,
        chunks: statements.length,
        requestId,
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'enrichment_fetch_error',
        error: String(error),
        requestId,
      })
    );
    // Return partial results (empty map) rather than failing completely
  }

  return enrichmentMap;
}

/**
 * Result of inserting placeholder records for beers.
 * Used to track which beers need enrichment or cleanup.
 */
export interface InsertPlaceholdersResult {
  totalSynced: number;
  withAbv: number;
  needsEnrichment: Array<{
    id: string;
    brew_name: string;
    brewer: string;
  }>;
  needsCleanup: Array<{
    id: string;
    brew_name: string;
    brewer: string;
    brew_description: string;
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
 * Insert placeholder records for beers that need enrichment or cleanup.
 * Uses INSERT OR IGNORE so existing beers are not overwritten.
 * Uses chunking to respect D1's parameter limits.
 *
 * IMPORTANT: Now implements description change detection.
 * - If description changed (hash mismatch): Queue for cleanup, NOT Perplexity
 * - If description unchanged AND ABV missing: Queue for Perplexity
 * - Cleanup consumer is responsible for ABV extraction and Perplexity fallback
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
    return { totalSynced: 0, withAbv: 0, needsEnrichment: [], needsCleanup: [] };
  }

  const now = Date.now();

  let withAbv = 0;
  const needsEnrichment: Array<{ id: string; brew_name: string; brewer: string }> = [];
  const needsCleanup: Array<{ id: string; brew_name: string; brewer: string; brew_description: string }> = [];

  // Process each beer individually to handle hash comparison
  for (const beer of beers) {
    const descriptionHash = beer.brew_description
      ? await hashDescription(beer.brew_description)
      : null;

    try {
      // Check if description changed
      const existing = await db.prepare(
        'SELECT description_hash, abv FROM enriched_beers WHERE id = ?'
      ).bind(beer.id).first<{ description_hash: string | null; abv: number | null }>();

      const descriptionChanged = descriptionHash !== existing?.description_hash;

      if (descriptionChanged && beer.brew_description) {
        // Description changed - queue for cleanup, invalidate old cleaned version
        needsCleanup.push({
          id: beer.id,
          brew_name: beer.brew_name,
          brewer: beer.brewer,
          brew_description: beer.brew_description,
        });

        // Update DB: store original description, hash, null out cleaned
        await db.prepare(`
          INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash, brew_description_cleaned, last_seen_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            brew_name = excluded.brew_name,
            brewer = excluded.brewer,
            brew_description_original = excluded.brew_description_original,
            description_hash = excluded.description_hash,
            brew_description_cleaned = NULL,
            description_cleaned_at = NULL,
            cleanup_source = NULL,
            last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at
        `).bind(beer.id, beer.brew_name, beer.brewer, beer.brew_description, descriptionHash, now, now).run();

      } else if (existing?.abv === null) {
        // Description unchanged (or new beer without description), but ABV still missing
        // Queue for Perplexity (cleanup already done or not needed)
        // Skip blocklisted beers (flights, root beer, etc.)
        if (!shouldSkipEnrichment(beer.brew_name)) {
          needsEnrichment.push({
            id: beer.id,
            brew_name: beer.brew_name,
            brewer: beer.brewer,
          });
        }

        // Just update last_seen_at for existing beers, or insert new placeholder
        await db.prepare(`
          INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash, last_seen_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at
        `).bind(beer.id, beer.brew_name, beer.brewer, beer.brew_description || null, descriptionHash, now, now).run();

      } else if (existing === null) {
        // New beer - try to extract ABV from description
        const abv = extractABV(beer.brew_description);
        if (abv !== null) {
          withAbv++;
          await db.prepare(`
            INSERT INTO enriched_beers (id, brew_name, brewer, abv, confidence, enrichment_source, brew_description_original, description_hash, last_seen_at, updated_at)
            VALUES (?, ?, ?, ?, 0.9, 'description', ?, ?, ?, ?)
          `).bind(beer.id, beer.brew_name, beer.brewer, abv, beer.brew_description || null, descriptionHash, now, now).run();
        } else if (beer.brew_description) {
          // New beer with description but no ABV - queue for cleanup
          needsCleanup.push({
            id: beer.id,
            brew_name: beer.brew_name,
            brewer: beer.brewer,
            brew_description: beer.brew_description,
          });
          await db.prepare(`
            INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash, last_seen_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(beer.id, beer.brew_name, beer.brewer, beer.brew_description, descriptionHash, now, now).run();
        } else {
          // New beer without description - queue for Perplexity
          // Skip blocklisted beers (flights, root beer, etc.)
          if (!shouldSkipEnrichment(beer.brew_name)) {
            needsEnrichment.push({
              id: beer.id,
              brew_name: beer.brew_name,
              brewer: beer.brewer,
            });
          }
          await db.prepare(`
            INSERT INTO enriched_beers (id, brew_name, brewer, last_seen_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
          `).bind(beer.id, beer.brew_name, beer.brewer, now, now).run();
        }
      } else {
        // Description unchanged and ABV exists - just update last_seen_at
        await db.prepare(`
          UPDATE enriched_beers SET last_seen_at = ? WHERE id = ?
        `).bind(now, beer.id).run();
      }
    } catch (error) {
      console.error(`[insertPlaceholders] Error processing beer ${beer.id}:`, error);
      // Continue with next beer - don't fail the entire operation
    }
  }

  console.log(`[insertPlaceholders] Synced ${beers.length} beers (${withAbv} with ABV, ${needsEnrichment.length} need enrichment, ${needsCleanup.length} need cleanup), requestId=${requestId}`);

  return { totalSynced: beers.length, withAbv, needsEnrichment, needsCleanup };
}
