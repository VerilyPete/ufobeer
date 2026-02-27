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
  GetBeersResult,
} from '../types';
import { isValidBeer, hasBeerStock, SYNC_CONSTANTS } from '../types';
import { insertPlaceholders, getEnrichmentForBeerIds } from '../db';
import { queueBeersForEnrichment, queueBeersForCleanup } from '../queue';
import { getCachedTaplist, setCachedTaplist, parseCachedBeers } from '../db/cache';
import type { CachedTaplistRow } from '../db/cache';
import type { CachedBeer } from '../schemas/cache';
import { hashDescription } from '../utils/hash';
import { isValidStoreId } from '../validation/storeId';
import { logError, logWithContext } from '../utils/log';
import { CACHE_TTL_MS } from '../constants';
import {
  BatchLookupRequestSchema,
  SyncBeersRequestOuterSchema,
  SyncBeerItemSchema,
} from '../schemas/request';

// ============================================================================
// Background Enrichment Processing
// ============================================================================

/**
 * Process background enrichment tasks after responding to the client.
 * This runs in waitUntil to avoid blocking the response.
 */
async function processBackgroundEnrichment(
  env: Env,
  beers: ReadonlyArray<{ readonly id: string; readonly brew_name: string; readonly brewer: string; readonly brew_description?: string | undefined }>,
  requestId: string
): Promise<void> {
  try {
    const result = await insertPlaceholders(env.DB, beers, requestId);

    if (result.needsCleanup.length > 0) {
      await queueBeersForCleanup(env, result.needsCleanup, requestId);
    }

    if (result.needsEnrichment.length > 0) {
      await queueBeersForEnrichment(env, result.needsEnrichment, requestId);
    }

    logWithContext(requestId, 'background.enrichment.complete', {
      cleanup: result.needsCleanup.length,
      enrichment: result.needsEnrichment.length,
      failed: result.failed?.length ?? 0,
    });
  } catch (error) {
    logError('background.enrichment.failed', error, { requestId });
  }
}

// ============================================================================
// Stale Fallback Helper
// ============================================================================

async function resolveStaleRow(
  db: D1Database,
  cachedRow: CachedTaplistRow | null,
  cacheReadSucceeded: boolean,
  storeId: string,
): Promise<CachedTaplistRow | null> {
  if (cachedRow) return cachedRow;
  if (!cacheReadSucceeded) return null;
  try {
    return await getCachedTaplist(db, storeId);
  } catch {
    return null;
  }
}

function serveStaleFallback(
  fallbackRow: CachedTaplistRow,
  staleBeers: readonly CachedBeer[],
  storeId: string,
  reqCtx: RequestContext,
  headers: Record<string, string>,
  upstreamLatencyMs: number,
): GetBeersResult {
  return {
    response: Response.json({
      beers: staleBeers,
      storeId,
      requestId: reqCtx.requestId,
      source: 'stale',
      cached_at: new Date(fallbackRow.cached_at).toISOString(),
    }, { headers }),
    beersReturned: staleBeers.length,
    upstreamLatencyMs,
    cacheOutcome: 'stale',
  };
}

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
  storeId: string,
  freshRequested = false
): Promise<GetBeersResult> {
  const upstreamStartTime = Date.now();

  // Validate store ID format
  if (!isValidStoreId(storeId)) {
    return {
      response: new Response(JSON.stringify({
        error: 'Invalid store ID format',
        code: 'INVALID_STORE_ID',
        requestId: reqCtx.requestId
      }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' }
      }),
      beersReturned: 0,
      upstreamLatencyMs: 0,
      cacheOutcome: 'miss',
    };
  }

  // Check cache (skip on force refresh)
  let cachedRow: CachedTaplistRow | null = null;
  let cacheReadSucceeded = true;
  if (!freshRequested) {
    try {
      cachedRow = await getCachedTaplist(env.DB, storeId);
    } catch (err) {
      cacheReadSucceeded = false;
      logError('cache.read.failed', err, { requestId: reqCtx.requestId, storeId });
    }
    if (cachedRow && Date.now() - cachedRow.cached_at < CACHE_TTL_MS) {
      const cachedBeers = parseCachedBeers(cachedRow.response_json);
      if (cachedBeers) {
        return {
          response: Response.json({
            beers: cachedBeers,
            storeId,
            requestId: reqCtx.requestId,
            source: 'cache',
            cached_at: new Date(cachedRow.cached_at).toISOString(),
          }, { headers }),
          beersReturned: cachedBeers.length,
          upstreamLatencyMs: 0,
          cacheOutcome: 'hit',
        };
      }
    }
  }

  try {
    // 1. Fetch from Flying Saucer
    const fsUrl = `${env.FLYING_SAUCER_API_BASE}?sid=${storeId}`;
    const fsResp = await fetch(fsUrl, {
      headers: { 'User-Agent': 'BeerSelector/1.0' }
    });

    const upstreamLatencyMs = Date.now() - upstreamStartTime;

    if (!fsResp.ok) {
      logError('upstream.flying_saucer.error', `HTTP ${fsResp.status}`, {
        requestId: reqCtx.requestId,
        storeId,
        status: fsResp.status,
      });

      // Stale fallback: serve cached data when upstream fails
      const fallbackRow = await resolveStaleRow(env.DB, cachedRow, cacheReadSucceeded, storeId);
      if (fallbackRow) {
        const staleBeers = parseCachedBeers(fallbackRow.response_json);
        if (staleBeers) return serveStaleFallback(fallbackRow, staleBeers, storeId, reqCtx, headers, upstreamLatencyMs);
      }

      return {
        response: new Response(JSON.stringify({ error: 'Upstream Error' }), {
          status: 502,
          headers: { ...headers, 'Content-Type': 'application/json' }
        }),
        beersReturned: 0,
        upstreamLatencyMs,
        cacheOutcome: 'miss',
      };
    }

    const fsData: unknown = await fsResp.json();

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
      if (enrichment?.brew_description_cleaned) cleanedCount++;
      return {
        ...beer,
        // Use cleaned description if available, otherwise keep original from Flying Saucer
        brew_description: enrichment?.brew_description_cleaned ?? beer.brew_description,
        enriched_abv: enrichment?.abv ?? null,
        enrichment_confidence: enrichment?.confidence ?? null,
        enrichment_source: enrichment?.source ?? null,
      };
    });

    logWithContext(reqCtx.requestId, 'beers.merge.complete', {
      totalBeers: rawBeers.length,
      cleanedDescriptions: cleanedCount,
      enrichmentRecords: enrichmentMap.size,
      storeId,
    });

    // 5. Write cache (non-blocking)
    ctx.waitUntil(
      setCachedTaplist(env.DB, storeId, enrichedBeers).catch((err) => {
        logError('cache.write.failed', err, { requestId: reqCtx.requestId, storeId });
      })
    );

    // 6. Sync beers to enriched_beers table (background task)
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
      processBackgroundEnrichment(env, beersForPlaceholders, reqCtx.requestId)
    );

    return {
      response: Response.json({
        beers: enrichedBeers,
        storeId,
        requestId: reqCtx.requestId,
        source: 'live',
        cached_at: new Date().toISOString(),
      }, { headers }),
      beersReturned: enrichedBeers.length,
      upstreamLatencyMs,
      cacheOutcome: freshRequested ? 'bypass' : 'miss',
    };

  } catch (error) {
    logError('beers.list.error', error, { requestId: reqCtx.requestId, storeId });

    // Stale fallback: serve cached data when upstream throws
    const fallbackRow = await resolveStaleRow(env.DB, cachedRow, cacheReadSucceeded, storeId);
    if (fallbackRow) {
      const staleBeers = parseCachedBeers(fallbackRow.response_json);
      if (staleBeers) return serveStaleFallback(fallbackRow, staleBeers, storeId, reqCtx, headers, Date.now() - upstreamStartTime);
    }

    return {
      response: new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { ...headers, 'Content-Type': 'application/json' }
      }),
      beersReturned: 0,
      upstreamLatencyMs: Date.now() - upstreamStartTime,
      cacheOutcome: 'miss',
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
    const parseResult = BatchLookupRequestSchema.safeParse(await request.json());
    if (!parseResult.success) {
      return Response.json(
        { error: 'ids array required', requestId: reqCtx.requestId },
        { status: 400, headers }
      );
    }
    const { ids } = parseResult.data;

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
    logError('beers.batch.error', error, { requestId: reqCtx.requestId });
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
 * Result of batch sync operation with failure handling.
 */
export type SyncBatchResult = {
  readonly succeeded: number;
  readonly failed: number;
  readonly errors: readonly string[];
};

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
      if (!result) continue;
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
    const outerParse = SyncBeersRequestOuterSchema.safeParse(await request.json());
    if (!outerParse.success) {
      return Response.json(
        { error: 'beers array required', requestId: reqCtx.requestId },
        { status: 400, headers }
      );
    }

    if (outerParse.data.beers.length === 0) {
      return Response.json(
        { synced: 0, queued_for_cleanup: 0, requestId: reqCtx.requestId },
        { headers }
      );
    }

    // Limit batch size
    const beers = outerParse.data.beers.slice(0, SYNC_CONSTANTS.MAX_BATCH_SIZE);
    const validationErrors: string[] = [];
    const validBeers: Array<{
      id: string;
      brew_name: string;
      brewer: string | null;
      brew_description: string | null;
    }> = [];

    // Validate each beer individually (preserves per-beer partial success)
    for (let i = 0; i < beers.length; i++) {
      const beer = beers[i];
      const beerParse = SyncBeerItemSchema.safeParse(beer);
      if (!beerParse.success) {
        validationErrors.push(`Beer ${i}: ${beerParse.error.issues[0]?.message ?? 'invalid'}`);
      } else {
        validBeers.push({
          id: beerParse.data.id,
          brew_name: beerParse.data.brew_name,
          brewer: beerParse.data.brewer ?? null,
          brew_description: beerParse.data.brew_description ?? null,
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

      // Queue for cleanup if description exists, not already cleaned, and not recently queued
      const existing = existingMap.get(beer.id);
      if (beer.brew_description &&
          !existing?.description_cleaned_at &&
          (!existing?.queued_for_cleanup_at ||
           now - existing.queued_for_cleanup_at > SYNC_CONSTANTS.REQUEUE_COOLDOWN_MS)) {
        needsCleanup.push({
          id: beer.id,
          brew_name: beer.brew_name,
          brewer: beer.brewer || '',
          brew_description: beer.brew_description, // TS narrows to string here
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

    logWithContext(reqCtx.requestId, 'beers.sync.complete', {
      synced: syncResult.succeeded,
      queuedForCleanup: needsCleanup.length,
      validationErrors: validationErrors.length,
    });

    return Response.json({
      synced: syncResult.succeeded,
      queued_for_cleanup: needsCleanup.length,
      requestId: reqCtx.requestId,
      ...(allErrors.length > 0 && { errors: allErrors }),
    }, { headers });

  } catch (error) {
    logError('beers.sync.error', error, { requestId: reqCtx.requestId });
    return Response.json(
      { error: 'Internal Server Error', requestId: reqCtx.requestId },
      { status: 500, headers }
    );
  }
}
