/**
 * Beer Handlers
 *
 * Endpoints for fetching and querying beer data.
 * Includes:
 * - handleBeerList() - GET /beers?sid= - Fetch beers from Flying Saucer and merge enrichment
 * - handleBatchLookup() - POST /beers/batch - Batch lookup enrichment data by beer IDs
 * - handleBeerSync() - POST /beers/sync - Sync missing beers from mobile client
 *
 * Extracted from index.ts as part of Phase 7 refactoring.
 */

import type {
  Env,
  RequestContext,
  FlyingSaucerBeer,
  GetBeersResult,
  SyncBeersRequest,
} from '../types';
import { isValidBeer, hasBeerStock, SYNC_CONSTANTS } from '../types';
import { insertPlaceholders, getEnrichmentForBeerIds } from '../db';
import { queueBeersForEnrichment, queueBeersForCleanup } from '../queue';
import { hashDescription } from '../utils/hash';

// ============================================================================
// Beer List Handler (GET /beers)
// ============================================================================

/**
 * GET /beers?sid= - Fetch beers from Flying Saucer and merge with enrichment data
 *
 * Returns GetBeersResult containing:
 * - response: The HTTP Response to return
 * - beersReturned: Count of beers for analytics
 * - upstreamLatencyMs: Flying Saucer API latency for analytics
 */
export async function handleBeerList(
  env: Env,
  ctx: ExecutionContext,
  headers: Record<string, string>,
  reqCtx: RequestContext,
  storeId: string
): Promise<GetBeersResult> {
  const upstreamStartTime = Date.now();

  try {
    // 1. Fetch from Flying Saucer
    const fsUrl = `${env.FLYING_SAUCER_API_BASE}?sid=${storeId}`;
    const fsResp = await fetch(fsUrl, {
      headers: { 'User-Agent': 'BeerSelector/1.0' }
    });

    const upstreamLatencyMs = Date.now() - upstreamStartTime;

    if (!fsResp.ok) {
      console.error(`Flying Saucer API error: ${fsResp.status}`);
      return {
        response: new Response(JSON.stringify({ error: 'Upstream Error' }), {
          status: 502,
          headers: { ...headers, 'Content-Type': 'application/json' }
        }),
        beersReturned: 0,
        upstreamLatencyMs,
      };
    }

    const fsData = await fsResp.json() as unknown[];

    // 2. Parse response with type guards
    // Flying Saucer API returns: [{...}, {brewInStock: [...]}]
    let rawBeersUnvalidated: unknown[] = [];

    if (Array.isArray(fsData)) {
      const stockObject = fsData.find(hasBeerStock);
      if (stockObject) {
        rawBeersUnvalidated = stockObject.brewInStock;
      }
    }

    // Filter to only valid beer objects
    const rawBeers = rawBeersUnvalidated.filter(isValidBeer);

    // 3. Fetch enrichment data from D1 (bounded query with chunking)
    // This replaces the previous unbounded SELECT that loaded the entire table
    const beerIds = rawBeers.map(b => b.id);
    const enrichmentMap = await getEnrichmentForBeerIds(env.DB, beerIds, reqCtx.requestId);

    // 4. Merge data (use cleaned description if available, otherwise keep original)
    let cleanedCount = 0;
    const enrichedBeers = rawBeers.map(beer => {
      const enrichment = enrichmentMap.get(beer.id);
      const useCleanedDesc = enrichment?.brew_description_cleaned ? true : false;
      if (useCleanedDesc) cleanedCount++;
      return {
        ...beer,
        // Use cleaned description if available, otherwise keep original from Flying Saucer
        brew_description: enrichment?.brew_description_cleaned || beer.brew_description,
        enriched_abv: enrichment?.abv ?? null,
        enrichment_confidence: enrichment?.confidence ?? null,
        enrichment_source: enrichment?.source ?? null,
      };
    });

    console.log(`[beers] Merged ${rawBeers.length} beers: ${cleanedCount} with cleaned descriptions, ${enrichmentMap.size} found in enrichment DB`);

    // 5. Sync beers to enriched_beers table (background task)
    // This populates the table so cron/trigger can find beers to enrich.
    // Pipeline: Description cleanup (LLM) -> ABV extraction -> Perplexity fallback
    // - If description changed: Queue for cleanup (LLM will clean and extract ABV)
    // - If description unchanged AND ABV missing: Queue for Perplexity
    const beersForPlaceholders = rawBeers.map(beer => ({
      id: beer.id,
      brew_name: beer.brew_name,
      brewer: beer.brewer,
      brew_description: beer.brew_description,
    }));
    ctx.waitUntil(
      insertPlaceholders(env.DB, beersForPlaceholders, reqCtx.requestId)
        .then(async result => {
          // Queue for cleanup (these will NOT be queued for Perplexity yet)
          // Cleanup consumer handles ABV extraction and Perplexity fallback
          if (result.needsCleanup.length > 0) {
            await queueBeersForCleanup(env, result.needsCleanup, reqCtx.requestId);
          }

          // Queue for Perplexity (only beers that don't need cleanup)
          if (result.needsEnrichment.length > 0) {
            await queueBeersForEnrichment(env, result.needsEnrichment, reqCtx.requestId);
          }
        })
        .catch(err => {
          console.error(JSON.stringify({
            event: 'background_enrichment_error',
            requestId: reqCtx.requestId,
            error: err instanceof Error ? err.message : String(err),
          }));
        })
    );

    return {
      response: Response.json({
        beers: enrichedBeers,
        storeId,
        requestId: reqCtx.requestId
      }, { headers }),
      beersReturned: enrichedBeers.length,
      upstreamLatencyMs,
    };

  } catch (error) {
    console.error('Error in handleBeerList:', error);
    return {
      response: new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { ...headers, 'Content-Type': 'application/json' }
      }),
      beersReturned: 0,
      upstreamLatencyMs: Date.now() - upstreamStartTime,
    };
  }
}

// ============================================================================
// Batch Lookup Handler (POST /beers/batch)
// ============================================================================

/**
 * POST /beers/batch - Batch lookup enrichment data by beer IDs
 *
 * Request body: { ids: string[] }
 * Returns enrichment data for up to 100 beer IDs, including:
 * - enrichments: Map of beer ID to enrichment data (ABV, confidence, source, etc.)
 * - missing: Array of IDs that were not found in the enriched_beers table
 * - brew_description_cleaned: Cleaned description if available
 */
export async function handleBatchLookup(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  try {
    const body = await request.json() as { ids?: string[] };
    const ids = body.ids;

    // Validate input
    if (!Array.isArray(ids) || ids.length === 0) {
      return Response.json(
        { error: 'ids array required', requestId: reqCtx.requestId },
        { status: 400, headers }
      );
    }

    // Limit batch size to 100
    const limitedIds = ids.slice(0, 100);

    // Build parameterized query - includes both description fields for merging
    const placeholders = limitedIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, abv, confidence, enrichment_source, is_verified, brew_description_original, brew_description_cleaned
       FROM enriched_beers
       WHERE id IN (${placeholders})`
    ).bind(...limitedIds).all<{
      id: string;
      abv: number | null;
      confidence: number;
      enrichment_source: string | null;
      is_verified: number;
      brew_description_original: string | null;
      brew_description_cleaned: string | null;
    }>();

    // Track which IDs were found
    const foundIds = new Set(results.map(r => r.id));
    const missing = limitedIds.filter(id => !foundIds.has(id));

    // Format response with merged descriptions (consistent with GET /beers behavior)
    // Field names aligned with mobile app expectations: enriched_abv, enrichment_confidence
    // brew_description: Prefer cleaned description, fall back to original (like GET /beers)
    // has_cleaned_description: Flag indicating if cleaned version was used
    const enrichmentData: Record<string, {
      enriched_abv: number | null;
      enrichment_confidence: number;
      enrichment_source: string | null;
      is_verified: boolean;
      brew_description: string | null;
      has_cleaned_description: boolean;
    }> = {};

    for (const row of results) {
      enrichmentData[row.id] = {
        enriched_abv: row.abv,
        enrichment_confidence: row.confidence,
        enrichment_source: row.enrichment_source,
        is_verified: Boolean(row.is_verified),
        // Prefer cleaned description, fall back to original (matches GET /beers behavior)
        brew_description: row.brew_description_cleaned ?? row.brew_description_original ?? null,
        has_cleaned_description: row.brew_description_cleaned !== null,
      };
    }

    return Response.json({
      enrichments: enrichmentData,
      missing,
      requestId: reqCtx.requestId
    }, { headers });

  } catch (error) {
    console.error('Error in handleBatchLookup:', error);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' }
    });
  }
}

// ============================================================================
// Beer Sync Handler (POST /beers/sync)
// ============================================================================

/**
 * Validation result for beer input in sync request.
 */
export interface BeerValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a single beer object from sync request.
 * Checks required fields and length constraints.
 */
export function validateBeerInput(beer: unknown): BeerValidationResult {
  if (!beer || typeof beer !== 'object') {
    return { valid: false, error: 'Beer must be an object' };
  }

  const b = beer as Record<string, unknown>;

  // id validation
  if (typeof b.id !== 'string' || b.id.length === 0 || b.id.length > SYNC_CONSTANTS.MAX_ID_LENGTH) {
    return { valid: false, error: `id must be a non-empty string with max ${SYNC_CONSTANTS.MAX_ID_LENGTH} characters` };
  }

  // brew_name validation
  if (typeof b.brew_name !== 'string' || b.brew_name.length === 0) {
    return { valid: false, error: 'brew_name is required and must be a non-empty string' };
  }
  if (b.brew_name.length > SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH) {
    return { valid: false, error: `brew_name exceeds max length of ${SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH} characters` };
  }

  // brew_description validation
  if (b.brew_description !== undefined && typeof b.brew_description === 'string') {
    if (b.brew_description.length > SYNC_CONSTANTS.MAX_DESC_LENGTH) {
      return { valid: false, error: `brew_description exceeds max length of ${SYNC_CONSTANTS.MAX_DESC_LENGTH} characters` };
    }
  }

  return { valid: true };
}

/**
 * Result of batch sync operation with failure handling.
 */
export interface SyncBatchResult {
  succeeded: number;
  failed: number;
  errors: string[];
}

/**
 * Execute batch of D1 statements with individual failure tracking.
 * Unlike simple db.batch(), this reports per-statement success/failure.
 */
export async function syncBeersWithBatchHandling(
  db: D1Database,
  statements: D1PreparedStatement[]
): Promise<SyncBatchResult> {
  const errors: string[] = [];
  let succeeded = 0;
  let failed = 0;

  try {
    const results = await db.batch(statements);

    // Check each result for success/failure
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.success) {
        succeeded++;
      } else {
        failed++;
        errors.push(`Statement ${i} failed: ${result.error || 'Unknown error'}`);
      }
    }
  } catch (error) {
    // Total batch failure - all statements failed
    failed = statements.length;
    errors.push(`Batch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { succeeded, failed, errors };
}

/**
 * POST /beers/sync - Sync missing beers from mobile client
 *
 * Request body: { beers: Array<{ id, brew_name, brewer?, brew_description? }> }
 * Returns: { synced, queued_for_cleanup, requestId, errors? }
 *
 * This endpoint allows the mobile client to sync beers that were missing
 * from the enriched_beers table (identified via the batch lookup endpoint).
 * Beers are synced with ON CONFLICT DO UPDATE to update last_seen_at.
 * Beers with descriptions are queued for cleanup.
 */
export async function handleBeerSync(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  try {
    const body = await request.json() as SyncBeersRequest;

    // Validate request structure
    if (!body.beers || !Array.isArray(body.beers)) {
      return Response.json(
        { error: 'beers array required', requestId: reqCtx.requestId },
        { status: 400, headers }
      );
    }

    if (body.beers.length === 0) {
      return Response.json(
        { synced: 0, queued_for_cleanup: 0, requestId: reqCtx.requestId },
        { headers }
      );
    }

    // Limit batch size
    const beers = body.beers.slice(0, SYNC_CONSTANTS.MAX_BATCH_SIZE);
    const validationErrors: string[] = [];
    const validBeers: Array<{
      id: string;
      brew_name: string;
      brewer: string | null;
      brew_description: string | null;
    }> = [];

    // Validate each beer
    for (let i = 0; i < beers.length; i++) {
      const beer = beers[i];
      const validation = validateBeerInput(beer);
      if (!validation.valid) {
        validationErrors.push(`Beer ${i}: ${validation.error}`);
      } else {
        validBeers.push({
          id: beer.id,
          brew_name: beer.brew_name,
          brewer: beer.brewer || null,
          brew_description: beer.brew_description || null,
        });
      }
    }

    if (validBeers.length === 0) {
      return Response.json(
        { error: 'No valid beers in request', errors: validationErrors, requestId: reqCtx.requestId },
        { status: 400, headers }
      );
    }

    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    const needsCleanup: Array<{
      id: string;
      brew_name: string;
      brewer: string;
      brew_description: string;
    }> = [];

    // Check existing records to determine queueing behavior
    const existingIds = validBeers.map(b => b.id);
    const placeholders = existingIds.map(() => '?').join(',');
    const { results: existingRecords } = await env.DB.prepare(
      `SELECT id, description_cleaned_at, queued_for_cleanup_at
       FROM enriched_beers
       WHERE id IN (${placeholders})`
    ).bind(...existingIds).all<{
      id: string;
      description_cleaned_at: number | null;
      queued_for_cleanup_at: number | null;
    }>();

    const existingMap = new Map(existingRecords.map(r => [r.id, r]));

    // Build statements and determine cleanup needs
    for (const beer of validBeers) {
      const descriptionHash = beer.brew_description
        ? await hashDescription(beer.brew_description)
        : null;

      // Use ON CONFLICT DO UPDATE to properly update last_seen_at
      // Note: is_verified defaults to 0 on INSERT but is NOT updated on conflict
      // to preserve manual verifications
      statements.push(
        env.DB.prepare(`
          INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash, last_seen_at, updated_at, is_verified)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            brew_name = COALESCE(excluded.brew_name, enriched_beers.brew_name),
            brewer = COALESCE(excluded.brewer, enriched_beers.brewer)
        `).bind(beer.id, beer.brew_name, beer.brewer, beer.brew_description, descriptionHash, now, now)
      );

      // Determine if we should queue for cleanup
      // Skip if already cleaned or recently queued (within cooldown period)
      const existing = existingMap.get(beer.id);
      const shouldQueue = beer.brew_description &&
        !existing?.description_cleaned_at &&
        (!existing?.queued_for_cleanup_at ||
         now - existing.queued_for_cleanup_at > SYNC_CONSTANTS.REQUEUE_COOLDOWN_MS);

      if (shouldQueue) {
        needsCleanup.push({
          id: beer.id,
          brew_name: beer.brew_name,
          brewer: beer.brewer || '',
          brew_description: beer.brew_description!,
        });
      }
    }

    // Execute batch insert/update
    const syncResult = await syncBeersWithBatchHandling(env.DB, statements);

    // Mark queued beers and update queued_for_cleanup_at timestamps
    if (needsCleanup.length > 0) {
      const updateStatements = needsCleanup.map(beer =>
        env.DB.prepare(
          `UPDATE enriched_beers SET queued_for_cleanup_at = ? WHERE id = ?`
        ).bind(now, beer.id)
      );
      await env.DB.batch(updateStatements);

      // Queue for cleanup
      await queueBeersForCleanup(env, needsCleanup, reqCtx.requestId);
    }

    // Combine errors
    const allErrors = [...validationErrors, ...syncResult.errors];

    console.log(`[sync] Synced ${syncResult.succeeded} beers, queued ${needsCleanup.length} for cleanup, requestId=${reqCtx.requestId}`);

    return Response.json({
      synced: syncResult.succeeded,
      queued_for_cleanup: needsCleanup.length,
      requestId: reqCtx.requestId,
      ...(allErrors.length > 0 && { errors: allErrors }),
    }, { headers });

  } catch (error) {
    console.error('Error in handleBeerSync:', error);
    return Response.json(
      { error: 'Internal Server Error', requestId: reqCtx.requestId },
      { status: 500, headers }
    );
  }
}
