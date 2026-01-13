/**
 * Database helper functions for beer enrichment.
 * Extracted from index.ts as part of Phase 6 refactoring.
 */

import { hashDescription } from '../utils/hash';
import { shouldSkipEnrichment } from '../config';
import { D1_MAX_PARAMS_PER_STATEMENT, D1_MAX_STATEMENTS_PER_BATCH } from '../constants';

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

  // D1 has a 100 parameter limit - use constant for safety margin
  const CHUNK_SIZE = D1_MAX_PARAMS_PER_STATEMENT;

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
  /** Beers that failed to process during placeholder insertion */
  failed: Array<{
    id: string;
    error: string;
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
 * Uses batched queries to respect D1's parameter limits and minimize round trips.
 *
 * IMPORTANT: Now implements description change detection.
 * - If description changed (hash mismatch): Queue for cleanup, NOT Perplexity
 * - If description unchanged AND ABV missing: Queue for Perplexity
 * - Cleanup consumer is responsible for ABV extraction and Perplexity fallback
 *
 * This syncs beers from Flying Saucer to our enriched_beers table,
 * enabling the trigger endpoint and cron to find beers to enrich.
 *
 * Performance: Uses batched queries instead of N+1 pattern.
 * - Pre-calculates all hashes in parallel
 * - Batches SELECT queries (90 params per statement, D1 limit)
 * - Batches INSERT/UPDATE statements (100 statements per batch, D1 limit)
 * - Reduces from O(2n) to O(4) database round trips
 */
export async function insertPlaceholders(
  db: D1Database,
  beers: Array<{ id: string; brew_name: string; brewer: string; brew_description?: string }>,
  requestId: string
): Promise<InsertPlaceholdersResult> {
  if (beers.length === 0) {
    return { totalSynced: 0, withAbv: 0, needsEnrichment: [], needsCleanup: [], failed: [] };
  }

  const now = Date.now();

  let withAbv = 0;
  const needsEnrichment: Array<{ id: string; brew_name: string; brewer: string }> = [];
  const needsCleanup: Array<{ id: string; brew_name: string; brewer: string; brew_description: string }> = [];
  const failed: Array<{ id: string; error: string }> = [];

  // ============================================================================
  // Step 1: Pre-calculate all description hashes in parallel
  // ============================================================================
  const hashPromises = beers.map(async (beer) => ({
    id: beer.id,
    hash: beer.brew_description ? await hashDescription(beer.brew_description) : null,
  }));
  const beerHashes = await Promise.all(hashPromises);
  const hashMap = new Map(beerHashes.map((h) => [h.id, h.hash]));

  // ============================================================================
  // Step 2: Batch SELECT queries for existing records
  // Reuses the chunking pattern from getEnrichmentForBeerIds
  // ============================================================================
  const CHUNK_SIZE = D1_MAX_PARAMS_PER_STATEMENT; // D1 has 100 param limit
  const existingMap = new Map<string, { description_hash: string | null; abv: number | null }>();
  const selectStatements: D1PreparedStatement[] = [];

  for (let i = 0; i < beers.length; i += CHUNK_SIZE) {
    const chunk = beers.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    selectStatements.push(
      db
        .prepare(`SELECT id, description_hash, abv FROM enriched_beers WHERE id IN (${placeholders})`)
        .bind(...chunk.map((b) => b.id))
    );
  }

  try {
    const selectResults = await db.batch(selectStatements);
    for (const result of selectResults) {
      const rows = result.results as
        | Array<{ id: string; description_hash: string | null; abv: number | null }>
        | undefined;
      if (rows) {
        for (const row of rows) {
          existingMap.set(row.id, { description_hash: row.description_hash, abv: row.abv });
        }
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'insertPlaceholders.select.failed',
        error: error instanceof Error ? error.message : String(error),
        requestId,
        beerCount: beers.length,
      })
    );
    throw error;
  }

  // ============================================================================
  // Step 3: Build all INSERT/UPDATE statements based on existing data
  // ============================================================================
  const writeStatements: D1PreparedStatement[] = [];
  // Track which beer ID corresponds to each statement (for failure tracking)
  const statementToBeerIdMap: string[] = [];

  for (const beer of beers) {
    const descriptionHash = hashMap.get(beer.id) ?? null;
    const existing = existingMap.get(beer.id);
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
      writeStatements.push(
        db
          .prepare(
            `INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash, brew_description_cleaned, last_seen_at, updated_at)
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
             updated_at = excluded.updated_at`
          )
          .bind(beer.id, beer.brew_name, beer.brewer, beer.brew_description, descriptionHash, now, now)
      );
      statementToBeerIdMap.push(beer.id);
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
      writeStatements.push(
        db
          .prepare(
            `INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash, last_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             last_seen_at = excluded.last_seen_at`
          )
          .bind(beer.id, beer.brew_name, beer.brewer, beer.brew_description || null, descriptionHash, now, now)
      );
      statementToBeerIdMap.push(beer.id);
    } else if (existing === undefined) {
      // New beer - try to extract ABV from description
      const abv = extractABV(beer.brew_description);
      if (abv !== null) {
        withAbv++;
        writeStatements.push(
          db
            .prepare(
              `INSERT INTO enriched_beers (id, brew_name, brewer, abv, confidence, enrichment_source, brew_description_original, description_hash, last_seen_at, updated_at)
             VALUES (?, ?, ?, ?, 0.9, 'description', ?, ?, ?, ?)`
            )
            .bind(beer.id, beer.brew_name, beer.brewer, abv, beer.brew_description || null, descriptionHash, now, now)
        );
        statementToBeerIdMap.push(beer.id);
      } else if (beer.brew_description) {
        // New beer with description but no ABV - queue for cleanup
        needsCleanup.push({
          id: beer.id,
          brew_name: beer.brew_name,
          brewer: beer.brewer,
          brew_description: beer.brew_description,
        });
        writeStatements.push(
          db
            .prepare(
              `INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash, last_seen_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(beer.id, beer.brew_name, beer.brewer, beer.brew_description, descriptionHash, now, now)
        );
        statementToBeerIdMap.push(beer.id);
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
        writeStatements.push(
          db
            .prepare(
              `INSERT INTO enriched_beers (id, brew_name, brewer, last_seen_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`
            )
            .bind(beer.id, beer.brew_name, beer.brewer, now, now)
        );
        statementToBeerIdMap.push(beer.id);
      }
    } else {
      // Description unchanged and ABV exists - just update last_seen_at
      writeStatements.push(db.prepare(`UPDATE enriched_beers SET last_seen_at = ? WHERE id = ?`).bind(now, beer.id));
      statementToBeerIdMap.push(beer.id);
    }
  }

  // ============================================================================
  // Step 4: Execute write statements in batches (D1 limit)
  // Track individual failures instead of throwing on batch error
  // ============================================================================
  const WRITE_BATCH_SIZE = D1_MAX_STATEMENTS_PER_BATCH;
  for (let i = 0; i < writeStatements.length; i += WRITE_BATCH_SIZE) {
    const batchEnd = Math.min(i + WRITE_BATCH_SIZE, writeStatements.length);
    try {
      await db.batch(writeStatements.slice(i, batchEnd));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          event: 'insertPlaceholders.write.failed',
          error: errorMessage,
          requestId,
          batchIndex: i,
          batchSize: batchEnd - i,
        })
      );
      // Track all beers in this batch as failed
      for (let j = i; j < batchEnd; j++) {
        const beerId = statementToBeerIdMap[j];
        if (beerId) {
          failed.push({ id: beerId, error: errorMessage });
        }
      }
    }
  }

  console.log(
    JSON.stringify({
      event: 'insertPlaceholders.complete',
      totalSynced: beers.length,
      withAbv,
      needsEnrichment: needsEnrichment.length,
      needsCleanup: needsCleanup.length,
      failed: failed.length,
      selectBatches: selectStatements.length,
      writeBatches: Math.ceil(writeStatements.length / WRITE_BATCH_SIZE),
      requestId,
    })
  );

  return { totalSynced: beers.length, withAbv, needsEnrichment, needsCleanup, failed };
}
