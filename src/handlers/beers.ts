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
// queueBeersForCleanup (src/queue/helpers.ts) attaches descriptionHash onto
// the CleanupMessage it sends, computing one from brew_description when the
// caller doesn't supply it -- so this file's cleanup-message producers
// (handleBeerSync's needsCleanup, and processBackgroundEnrichment's use of
// insertPlaceholders's needsCleanup) reach the queue correctly bound. See
// the security review's "stale-result binding" remediation.
import { queueBeersForEnrichment, queueBeersForCleanup } from '../queue';
import { getCachedTaplist, setCachedTaplist, updateCacheTimestamp, parseCachedBeers } from '../db/cache';
import type { CachedTaplistRow } from '../db/cache';
import type { CachedBeer } from '../schemas/cache';
import { hashDescription, buildCombinedEtag } from '../utils/hash';
import { checkConditionalRequest } from '../utils/conditional';
import { shouldUpdateContent } from '../utils/cache-helpers';
import { computeEnrichmentHash } from '../utils/enrichment-hash';
import { isValidStoreId } from '../validation/storeId';
import { logError, logWithContext } from '../utils/log';
import { readBoundedJson, boundedJsonErrorResponse } from '../utils/body';
import { readBoundedText, ResponseTooLargeError } from '../utils/bounded-response';
import { CACHE_TTL_MS, UPSTREAM_TAPLIST_TIMEOUT_MS, SYNC_BODY_MAX_BYTES, SMALL_JSON_BODY_MAX_BYTES, FLYING_SAUCER_RESPONSE_MAX_BYTES } from '../constants';
import { FlyingSaucerResponseSchema, isFlyingSaucerBeerRecordWithinSizeCap } from '../schemas/external';
import {
  BatchLookupRequestSchema,
  SyncBeersRequestOuterSchema,
  SyncBeerItemSchema,
} from '../schemas/request';

// ============================================================================
// Flying Saucer Origin Allowlist
// ============================================================================

/**
 * Allowlisted Flying Saucer upstream origins. `env.FLYING_SAUCER_API_BASE`
 * is a Worker secret (set via `wrangler secret put`, not attacker
 * controlled) but was previously trusted indefinitely and interpolated
 * directly into a fetch URL by string concatenation. This allowlist fails
 * closed on a misconfigured, unexpected, or non-HTTPS origin instead of
 * fetching it.
 *
 * - `https://fsbs.beerknurd.com` is the real production Flying Saucer host.
 *   Confirmed from `.dev.vars.example` (`FLYING_SAUCER_API_BASE=https://
 *   fsbs.beerknurd.com`) and `plans/cache-research-api.md` (which records
 *   the full production base as `https://fsbs.beerknurd.com/bk-store-json.php`).
 * - `https://flying-saucer.golden-taproom.test` is used exclusively by the
 *   golden contract test (`contract-test/goldenTaproom.contract.test.ts`,
 *   not owned by this change -- see its `TEST_ORIGIN` constant) to exercise
 *   this exact fetch path end to end against a Miniflare `fetchMock`
 *   double. `.test` is an IANA-reserved TLD (RFC 2606) that never resolves
 *   on the public internet, so allowlisting it adds no real attack surface
 *   even if it somehow reached a production configuration.
 */
const ALLOWED_FLYING_SAUCER_ORIGINS = new Set([
  'https://fsbs.beerknurd.com',
  'https://flying-saucer.golden-taproom.test',
]);

type FlyingSaucerUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Build the Flying Saucer taplist URL from the configured base and store
 * ID, using the `URL` API (not string interpolation) and validating the
 * base's origin against the allowlist above. Preserves whatever path the
 * configured base carries (e.g. `/bk-store-json.php`) -- only the origin is
 * validated, since the path is part of the trusted configuration, not
 * attacker input.
 */
function buildFlyingSaucerUrl(base: string, storeId: string): FlyingSaucerUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return { ok: false, reason: 'FLYING_SAUCER_API_BASE is not a valid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'FLYING_SAUCER_API_BASE must use HTTPS' };
  }
  if (!ALLOWED_FLYING_SAUCER_ORIGINS.has(parsed.origin)) {
    return { ok: false, reason: 'FLYING_SAUCER_API_BASE origin is not allowlisted' };
  }
  parsed.searchParams.set('sid', storeId);
  return { ok: true, url: parsed.toString() };
}

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

async function serveStaleFallback(
  request: Request | null,
  fallbackRow: CachedTaplistRow,
  staleBeers: readonly CachedBeer[],
  storeId: string,
  reqCtx: RequestContext,
  headers: Record<string, string>,
  upstreamLatencyMs: number,
): Promise<GetBeersResult> {
  const responseHeaders = { ...headers };
  if (fallbackRow.content_hash) {
    const etag = await buildCombinedEtag(fallbackRow.content_hash, fallbackRow.enrichment_hash);
    responseHeaders['ETag'] = etag;
    responseHeaders['Cache-Control'] = 'private, max-age=300';

    if (request) {
      const conditionalResponse = checkConditionalRequest(request, etag);
      if (conditionalResponse) {
        for (const [key, value] of Object.entries(responseHeaders)) {
          conditionalResponse.headers.set(key, value);
        }
        return {
          response: conditionalResponse,
          beersReturned: 0,
          upstreamLatencyMs,
          cacheOutcome: 'conditional',
        };
      }
    }
  }

  return {
    response: Response.json({
      beers: staleBeers,
      storeId,
      requestId: reqCtx.requestId,
      source: 'stale',
      cached_at: new Date(fallbackRow.cached_at).toISOString(),
    }, { headers: responseHeaders }),
    beersReturned: staleBeers.length,
    upstreamLatencyMs,
    cacheOutcome: 'stale',
  };
}

// ============================================================================
// Shared Taplist Core (used by GET /beers live path and cron refresh)
// ============================================================================

/**
 * Result of the shared fetch-merge-cache taplist core.
 *
 * ok=false means the upstream returned a non-2xx (upstreamStatus set).
 * Exceptions propagate to the caller: handleBeerList converts them to a
 * stale-cache fallback or 500; refreshTaplistForStore logs and reports
 * failure. Response construction, conditional-request handling, and the
 * per-caller merge logging stay at the call sites.
 */
export type TaplistCoreResult =
  | {
      readonly ok: true;
      readonly enrichedBeers: readonly Record<string, unknown>[];
      readonly cleanedCount: number;
      readonly enrichmentRecords: number;
      readonly upstreamLatencyMs: number;
      readonly etag: string;
    }
  | {
      readonly ok: false;
      readonly upstreamLatencyMs: number;
      readonly upstreamStatus: number;
    };

/**
 * Fetch a live taplist from Flying Saucer, validate it, merge enrichment
 * data, write the store cache (full write or timestamp-only based on content
 * hashes), and queue background enrichment — the pipeline shared by the
 * GET /beers live path and the cron taplist refresh.
 */
async function fetchMergeAndCacheTaplist(
  env: Env,
  ctx: ExecutionContext,
  storeId: string,
  requestId: string,
  startTime: number
): Promise<TaplistCoreResult> {
  // 1. Validate the configured upstream origin and build the URL with the
  // `URL` API (not string interpolation) before fetching. Fails closed on a
  // misconfigured, unexpected, or non-HTTPS FLYING_SAUCER_API_BASE, distinct
  // in the logs (`config_error`) from an actual upstream outage below.
  const urlResult = buildFlyingSaucerUrl(env.FLYING_SAUCER_API_BASE, storeId);
  if (!urlResult.ok) {
    logError('upstream.flying_saucer.config_error', urlResult.reason, { requestId, storeId });
    return { ok: false, upstreamLatencyMs: Date.now() - startTime, upstreamStatus: 0 };
  }

  // 2. Fetch from Flying Saucer (timeout guards against a hung upstream)
  const fsResp = await fetch(urlResult.url, {
    headers: { 'User-Agent': 'BeerSelector/1.0' },
    signal: AbortSignal.timeout(UPSTREAM_TAPLIST_TIMEOUT_MS),
  });

  const upstreamLatencyMs = Date.now() - startTime;

  if (!fsResp.ok) {
    logError('upstream.flying_saucer.error', `HTTP ${fsResp.status}`, {
      requestId,
      storeId,
      status: fsResp.status,
    });
    return { ok: false, upstreamLatencyMs, upstreamStatus: fsResp.status };
  }

  // 3. Read the body with a hard byte cap while streaming (before it is
  // fully buffered), so a compromised or misbehaving upstream cannot force
  // an unbounded amount of memory to be materialized. On an oversized body,
  // fail this fetch the same way an upstream outage does (stale-cache
  // fallback at the call site), distinct in the logs.
  let rawResponseBody: string;
  try {
    rawResponseBody = await readBoundedText(fsResp, FLYING_SAUCER_RESPONSE_MAX_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      logError('upstream.flying_saucer.oversized', error, {
        requestId,
        storeId,
        maxBytes: FLYING_SAUCER_RESPONSE_MAX_BYTES,
      });
      return { ok: false, upstreamLatencyMs, upstreamStatus: fsResp.status };
    }
    throw error;
  }

  // Hash the bounded bytes already read above rather than re-stringifying a
  // parsed object graph -- avoids holding both a full parsed object graph
  // AND a second full JSON serialization in memory solely to compute a
  // hash. NOTE: this changes the hash's input from `JSON.stringify(parsed)`
  // to the raw upstream bytes; see the security review report for the
  // one-time cache-invalidation consequence of that change.
  const rawHash = await hashDescription(rawResponseBody);

  // 4. Parse response with type guards
  // Flying Saucer API returns: [{...}, {brewInStock: [...]}]
  let fsData: unknown;
  try {
    fsData = JSON.parse(rawResponseBody);
  } catch (error) {
    logError('upstream.flying_saucer.invalid_json', error, { requestId, storeId });
    return { ok: false, upstreamLatencyMs, upstreamStatus: fsResp.status };
  }

  let rawBeersUnvalidated: unknown[] = [];
  if (Array.isArray(fsData)) {
    const stockObject = fsData.find(hasBeerStock);
    if (stockObject) {
      rawBeersUnvalidated = stockObject.brewInStock;
    }
  }

  // Reject an over-long beer array before iterating it, rather than relying
  // solely on per-record validation below.
  const arrayCheck = FlyingSaucerResponseSchema.safeParse(rawBeersUnvalidated);
  if (!arrayCheck.success) {
    logError('upstream.flying_saucer.oversized_array', 'brewInStock exceeds MAX_FLYING_SAUCER_RESPONSE_ITEMS', {
      requestId,
      storeId,
      length: rawBeersUnvalidated.length,
    });
    return { ok: false, upstreamLatencyMs, upstreamStatus: fsResp.status };
  }

  // isValidBeer is a FlyingSaucerBeerSchema.safeParse() type guard (the
  // "successful per-record safeParse" that isFlyingSaucerBeerRecordWithinSizeCap
  // must follow -- see its doc comment in schemas/external.ts); chaining the
  // aggregate size cap after it drops an oversized record (including
  // passthrough fields the schema itself can't bound) before hashing/caching.
  const rawBeers = rawBeersUnvalidated
    .filter(isValidBeer)
    .filter(isFlyingSaucerBeerRecordWithinSizeCap);

  // 3. Fetch enrichment data from D1 (bounded query with chunking)
  const beerIds = rawBeers.map(b => b.id);
  const enrichmentMap = await getEnrichmentForBeerIds(env.DB, beerIds, requestId);

  // 4. Merge (use cleaned description if available, otherwise keep original)
  let cleanedCount = 0;
  const enrichedBeers = rawBeers.map(beer => {
    const enrichment = enrichmentMap.get(beer.id);
    if (enrichment?.brew_description_cleaned) cleanedCount++;
    return {
      ...beer,
      brew_description: enrichment?.brew_description_cleaned ?? beer.brew_description,
      enriched_abv: enrichment?.abv ?? null,
      enrichment_confidence: enrichment?.confidence ?? null,
      enrichment_source: enrichment?.source ?? null,
      is_description_cleaned: !!enrichment?.brew_description_cleaned,
    };
  });

  const enrichmentHash = enrichmentMap.size === 0 && beerIds.length > 0
    ? null
    : await computeEnrichmentHash(enrichmentMap);

  // 5. Write cache — compare hash to decide full write vs timestamp-only
  let cachedRow: CachedTaplistRow | null = null;
  try {
    cachedRow = await getCachedTaplist(env.DB, storeId);
  } catch {
    // If we can't read cached row, treat as content changed
  }

  const contentChanged = shouldUpdateContent(rawHash, cachedRow?.content_hash ?? null, enrichmentHash, cachedRow?.enrichment_hash ?? null);

  if (contentChanged) {
    ctx.waitUntil(
      setCachedTaplist(env.DB, storeId, enrichedBeers, rawHash, enrichmentHash ?? undefined).catch((err) => {
        logError('cache.write.failed', err, { requestId, storeId });
      })
    );
  } else {
    ctx.waitUntil(
      updateCacheTimestamp(env.DB, storeId).catch((err) => {
        logError('cache.write.failed', err, { requestId, storeId });
      })
    );
  }

  // 6. Sync beers to enriched_beers table (background task)
  const beersForPlaceholders = rawBeers.map(beer => ({
    id: beer.id,
    brew_name: beer.brew_name,
    brewer: beer.brewer,
    brew_description: beer.brew_description,
  }));
  ctx.waitUntil(
    processBackgroundEnrichment(env, beersForPlaceholders, requestId)
  );

  // 7. Combined ETag for conditional requests (used by GET /beers)
  const etag = await buildCombinedEtag(rawHash, enrichmentHash);

  return {
    ok: true,
    enrichedBeers,
    cleanedCount,
    enrichmentRecords: enrichmentMap.size,
    upstreamLatencyMs,
    etag,
  };
}

// ============================================================================
// Taplist Refresh (cron entry point; wraps the shared core)
// ============================================================================

export type TaplistRefreshResult = {
  readonly beersRefreshed: number;
  readonly upstreamLatencyMs: number;
  readonly success: boolean;
};

/**
 * Fetch a live taplist from Flying Saucer, merge enrichment data, write cache,
 * and queue new beers for enrichment in the background.
 *
 * Used by both handleBeerList (live-fetch path) and handleScheduledEnrichment
 * (hourly cron taplist refresh phase).
 */
export async function refreshTaplistForStore(
  env: Env,
  ctx: ExecutionContext,
  storeId: string,
  requestId: string,
): Promise<TaplistRefreshResult> {
  const start = Date.now();
  try {
    const result = await fetchMergeAndCacheTaplist(env, ctx, storeId, requestId, start);
    if (!result.ok) {
      return { beersRefreshed: 0, upstreamLatencyMs: result.upstreamLatencyMs, success: false };
    }
    return { beersRefreshed: result.enrichedBeers.length, upstreamLatencyMs: result.upstreamLatencyMs, success: true };
  } catch (error) {
    logError('taplist.refresh.failed', error, { requestId, storeId });
    return { beersRefreshed: 0, upstreamLatencyMs: Date.now() - start, success: false };
  }
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
  request: Request,
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
      // Check conditional request if we have a content hash
      let cachedEtag: string | null = null;
      if (cachedRow.content_hash) {
        cachedEtag = await buildCombinedEtag(cachedRow.content_hash, cachedRow.enrichment_hash);
        const conditionalResponse = checkConditionalRequest(request, cachedEtag);
        if (conditionalResponse) {
          for (const [key, value] of Object.entries(headers)) {
            conditionalResponse.headers.set(key, value);
          }
          return {
            response: conditionalResponse,
            beersReturned: 0,
            upstreamLatencyMs: 0,
            cacheOutcome: 'conditional',
          };
        }
      }

      const cachedBeers = parseCachedBeers(cachedRow.response_json);
      if (cachedBeers) {
        const responseHeaders = { ...headers };
        if (cachedEtag) {
          responseHeaders['ETag'] = cachedEtag;
          responseHeaders['Cache-Control'] = 'private, max-age=300';
        }
        return {
          response: Response.json({
            beers: cachedBeers,
            storeId,
            requestId: reqCtx.requestId,
            source: 'cache',
            cached_at: new Date(cachedRow.cached_at).toISOString(),
          }, { headers: responseHeaders }),
          beersReturned: cachedBeers.length,
          upstreamLatencyMs: 0,
          cacheOutcome: 'hit',
        };
      }
    }
  }

  try {
    // Shared fetch → validate → merge → cache → background-enrichment core
    const result = await fetchMergeAndCacheTaplist(env, ctx, storeId, reqCtx.requestId, upstreamStartTime);

    if (!result.ok) {
      // Stale fallback: serve cached data when upstream fails
      const fallbackRow = await resolveStaleRow(env.DB, cachedRow, cacheReadSucceeded, storeId);
      if (fallbackRow) {
        const staleBeers = parseCachedBeers(fallbackRow.response_json);
        if (staleBeers) return await serveStaleFallback(request, fallbackRow, staleBeers, storeId, reqCtx, headers, result.upstreamLatencyMs);
      }

      return {
        response: new Response(JSON.stringify({ error: 'Upstream Error' }), {
          status: 502,
          headers: { ...headers, 'Content-Type': 'application/json' }
        }),
        beersReturned: 0,
        upstreamLatencyMs: result.upstreamLatencyMs,
        cacheOutcome: 'miss',
      };
    }

    const { enrichedBeers, cleanedCount, enrichmentRecords, upstreamLatencyMs, etag } = result;

    // Per-caller merge logging (the cron path does not log this)
    logWithContext(reqCtx.requestId, 'beers.merge.complete', {
      totalBeers: enrichedBeers.length,
      cleanedDescriptions: cleanedCount,
      enrichmentRecords,
      storeId,
    });

    // Check conditional request against the combined hash
    const conditionalResponse = checkConditionalRequest(request, etag);
    if (conditionalResponse) {
      for (const [key, value] of Object.entries(headers)) {
        conditionalResponse.headers.set(key, value);
      }
      return {
        response: conditionalResponse,
        beersReturned: 0,
        upstreamLatencyMs,
        cacheOutcome: 'conditional',
      };
    }

    return {
      response: Response.json({
        beers: enrichedBeers,
        storeId,
        requestId: reqCtx.requestId,
        source: 'live',
        cached_at: new Date().toISOString(),
      }, { headers: { ...headers, 'ETag': etag, 'Cache-Control': 'private, max-age=300' } }),
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
      if (staleBeers) return await serveStaleFallback(request, fallbackRow, staleBeers, storeId, reqCtx, headers, Date.now() - upstreamStartTime);
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
    const bodyResult = await readBoundedJson(request, SMALL_JSON_BODY_MAX_BYTES);
    if (!bodyResult.ok) {
      return boundedJsonErrorResponse(bodyResult, reqCtx.requestId, headers);
    }

    const parseResult = BatchLookupRequestSchema.safeParse(bodyResult.data);
    if (!parseResult.success) {
      return Response.json(
        { error: 'ids array required', requestId: reqCtx.requestId },
        { status: 400, headers }
      );
    }
    const { ids } = parseResult.data;
    // BatchLookupRequestSchema already caps `ids` at BATCH_MAX_IDS (100) and
    // rejects an oversized array with a 400 above, instead of silently
    // truncating it after the fact.
    const requestedCount = ids.length;

    // Build parameterized query - includes both description fields for merging
    const placeholders = ids.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, abv, confidence, enrichment_source, is_verified, brew_description_original, brew_description_cleaned
       FROM enriched_beers
       WHERE id IN (${placeholders})`
    ).bind(...ids).all<{
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
    const missing = ids.filter(id => !foundIds.has(id));

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
      requested_count: requestedCount,
      // Kept for response-shape stability: an oversized ids array is now
      // rejected with a 400 by BatchLookupRequestSchema above, so a request
      // that reaches this point never needed truncation.
      truncated: false,
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
        console.error(`Sync statement ${i} failed:`, result.error);
        errors.push(`Statement ${i} failed`);
      }
    }
  } catch (error) {
    // Total batch failure - all statements failed
    failed = statements.length;
    console.error('Sync batch failed:', error);
    errors.push('Database write failed for batch');
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
    const bodyResult = await readBoundedJson(request, SYNC_BODY_MAX_BYTES);
    if (!bodyResult.ok) {
      return boundedJsonErrorResponse(bodyResult, reqCtx.requestId, headers);
    }

    const outerParse = SyncBeersRequestOuterSchema.safeParse(bodyResult.data);
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

    // SyncBeersRequestOuterSchema already caps `beers` at
    // SYNC_CONSTANTS.MAX_BATCH_SIZE and rejects an oversized array with a
    // 400 above, instead of silently truncating it after the fact.
    const beers = outerParse.data.beers;
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
      /**
       * Hash of brew_description above, computed the same way as
       * db/helpers.ts's categorizeBeer. Carried alongside the beer so a
       * cleanup-message producer can bind the outgoing message to the exact
       * description version it was built from (stale-result binding).
       * NOTE: queueBeersForCleanup (src/queue/helpers.ts) does not yet read
       * or forward this field onto the CleanupMessage it sends -- see the
       * handler-level comment below.
       */
      descriptionHash: string;
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
      //
      // description_hash is refreshed on conflict (COALESCE'd like brewer,
      // so a sync call that omits a description doesn't null out an
      // existing hash) -- previously this SET clause left description_hash
      // untouched for existing IDs, so a later `WHERE ... AND
      // description_hash = ?` staleness check on a queued cleanup result
      // would compare against a stale column that never matched the
      // description the cleanup message was actually built from.
      statements.push(
        env.DB.prepare(`
          INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash, last_seen_at, updated_at, is_verified)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            brew_name = COALESCE(excluded.brew_name, enriched_beers.brew_name),
            brewer = COALESCE(excluded.brewer, enriched_beers.brewer),
            description_hash = COALESCE(excluded.description_hash, enriched_beers.description_hash)
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
          // descriptionHash is non-null here: beer.brew_description is
          // truthy (checked above), and descriptionHash is computed from it
          // a few lines up via hashDescription().
          descriptionHash: descriptionHash as string,
        });
      }
    }

    // Execute batch insert/update
    const syncResult = await syncBeersWithBatchHandling(env.DB, statements);

    // Send to the cleanup queue FIRST, then mark only what was actually sent.
    // The old mark-then-send order stranded beers for REQUEUE_COOLDOWN_MS
    // (24h) whenever the queue send failed after the timestamps landed.
    let queuedForCleanup = 0;
    if (needsCleanup.length > 0) {
      // needsCleanup entries carry descriptionHash (see the type above);
      // queueBeersForCleanup does not yet forward it onto the CleanupMessage
      // it sends, so it is currently dropped here rather than reaching the
      // queue. See the module-level TODO near queueBeersForCleanup's import.
      const { queued, queuedIds } = await queueBeersForCleanup(env, needsCleanup, reqCtx.requestId);
      queuedForCleanup = queued;
      const sentSet = new Set(queuedIds ?? []);
      const toMark = needsCleanup.filter(beer => sentSet.has(beer.id));

      if (toMark.length > 0) {
        const updateStatements = toMark.map(beer =>
          env.DB.prepare(
            `UPDATE enriched_beers SET queued_for_cleanup_at = ? WHERE id = ?`
          ).bind(now, beer.id)
        );
        await env.DB.batch(updateStatements);
      }
    }

    // Combine errors
    const allErrors = [...validationErrors, ...syncResult.errors];

    logWithContext(reqCtx.requestId, 'beers.sync.complete', {
      synced: syncResult.succeeded,
      queuedForCleanup: queuedForCleanup,
      validationErrors: validationErrors.length,
    });

    return Response.json({
      synced: syncResult.succeeded,
      queued_for_cleanup: queuedForCleanup,
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
