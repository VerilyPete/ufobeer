/**
 * Database helper functions for beer enrichment.
 * Extracted from index.ts as part of Phase 6 refactoring.
 */

import { D1_MAX_PARAMS_PER_STATEMENT } from '../constants';

// ============================================================================
// Enrichment Data Types
// ============================================================================

/**
 * Enrichment data for a single beer, returned by getEnrichmentForBeerIds.
 */
export type BeerEnrichmentData = {
  readonly abv: number | null;
  readonly confidence: number;
  readonly source: string | null;
  readonly brew_description_cleaned: string | null;
};

// ============================================================================
// D1 Row Types
// ============================================================================

type EnrichmentRow = {
  readonly id: string;
  readonly abv: number | null;
  readonly confidence: number;
  readonly enrichment_source: string | null;
  readonly brew_description_cleaned: string | null;
};

/**
 * D1 batch results are untyped (D1Result<unknown>); this cast is safe because
 * the SQL query shape matches the target type.
 */
export function asTypedRows<T>(results: unknown): readonly T[] {
  return (results ?? []) as readonly T[];
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
  beerIds: readonly string[],
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
      for (const row of asTypedRows<EnrichmentRow>(result.results)) {
        enrichmentMap.set(row.id, {
          abv: row.abv,
          confidence: row.confidence,
          source: row.enrichment_source,
          brew_description_cleaned: row.brew_description_cleaned,
        });
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

// ============================================================================
// ABV Extraction
// ============================================================================

/**
 * Extract ABV percentage from beer description HTML.
 * Returns null if no valid ABV found.
 *
 * Prefers a number labelled as alcohol anywhere in the text, so ingredient
 * percentages ("100% agave", "10% oats") ahead of the ABV cannot hide or
 * replace it. Strongest form first:
 * 1. Percentage then label: "5.2% ABV", "11.3 percent alcohol"
 * 2. Label then percentage: "ABV: 5.2%", "Alcohol: 4.0%", "ABV - 4.0%"
 * 3. Bare number beside ABV: "ABV 5.2", then "5.2 ABV"
 * 4. Otherwise the first bare percentage: "5.2%" or "8%"
 *
 * Labelled values up to 30% are accepted (strong ales are printed as
 * "21% abv"); a bare percentage above 20% is treated as unrelated.
 */
export function extractABV(description: string | undefined): number | null {
  if (!description) return null;

  const plainText = description.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ');

  // A number must be a whole token: ".5", "5,2" and "0,5" never read as 5, 2 or 0.
  // A sentence-ending period does not count: "balanced beer.11.8% abv" is 11.8.
  const num = String.raw`(?<!\d)(?<!(?:^|[^A-Za-z])[.,])(\d+(?:\.\d+)?)(?![.,]\d)`;
  const percent = String.raw`(?:%|percent\b|per cent\b)`;
  const label = String.raw`(?:ABV\b|alc\b|alcohol\b(?![\s\-–—]*free))`;
  const labelled = [
    new RegExp(String.raw`${num}\s*${percent}\s*${label}`, 'gi'),
    new RegExp(String.raw`${label}[:\s\-–]*${num}\s*${percent}`, 'gi'),
    new RegExp(String.raw`\bABV[:\s\-–]*${num}`, 'gi'),
    new RegExp(String.raw`${num}\s*ABV\b`, 'gi'),
  ];
  for (const pattern of labelled) {
    for (const match of plainText.matchAll(pattern)) {
      const abv = parseFloat(match[1] ?? '');
      if (!isNaN(abv) && abv >= 0 && abv <= 30) {
        return abv;
      }
    }
  }

  const percentageMatch = plainText.match(new RegExp(String.raw`${num}\s*%`));
  if (percentageMatch && percentageMatch[1]) {
    const abv = parseFloat(percentageMatch[1]);
    if (!isNaN(abv) && abv >= 0 && abv <= 20) {
      return abv;
    }
  }

  return null;
}
