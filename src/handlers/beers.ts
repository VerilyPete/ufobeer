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
import { isValidBeer, hasBeerStock } from '../types';
import { getEnrichmentForBeerIds } from '../db';
import { recordSeenBeers } from '../db/seenBeers';
import type { SeenBeer } from '../db/seenBeers';
import { queueBeersForEnrichment, sendCleanupAndMark } from '../queue';
import { getCachedTaplist, setCachedTaplist, updateCacheTimestamp, parseCachedBeers } from '../db/cache';
import type { CachedTaplistRow } from '../db/cache';
import type { CachedBeer } from '../schemas/cache';
import { hashDescription, buildCombinedEtag } from '../utils/hash';
import {
  ENRICHMENT_SOURCES_HEADER,
  parseAcceptedSources,
  relabelEnrichmentSources,
  wireEnrichmentSource,
  type AcceptedSources,
} from '../utils/enrichmentSource';
import { checkConditionalRequest } from '../utils/conditional';
import { shouldUpdateContent } from '../utils/cache-helpers';
import { computeEnrichmentHash } from '../utils/enrichment-hash';
import { isValidStoreId } from '../validation/storeId';
import { logError, logWithContext } from '../utils/log';
import { readBoundedJson, boundedJsonErrorResponse } from '../utils/body';
import { readBoundedText, ResponseTooLargeError } from '../utils/bounded-response';
import { CACHE_TTL_MS, UPSTREAM_TAPLIST_TIMEOUT_MS, SYNC_BODY_MAX_BYTES, SMALL_JSON_BODY_MAX_BYTES, FLYING_SAUCER_RESPONSE_MAX_BYTES } from '../constants';
import { FlyingSaucerResponseSchema, isFlyingSaucerBeerRecordWithinSizeCap } from '../schemas/external';
import { cleanBeerNames } from '../utils/beer-name';
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
  beers: readonly SeenBeer[],
  requestId: string
): Promise<void> {
  try {
    const now = Date.now();
    const result = await recordSeenBeers(env.DB, beers, { now });
    const { queued: cleanupQueued } = await sendCleanupAndMark(env, result.cleanup, requestId, now);

    if (result.enrichment.length > 0) {
      await queueBeersForEnrichment(env, result.enrichment, requestId);
    }

    logWithContext(requestId, 'background.enrichment.complete', {
      cleanup: cleanupQueued,
      enrichment: result.enrichment.length,
      failed: [...result.outcomes.values()].filter(outcome => outcome === 'failed').length,
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
  acceptedSources: AcceptedSources,
): Promise<GetBeersResult> {
  const responseHeaders = { ...headers };
  if (fallbackRow.content_hash) {
    const etag = await buildCombinedEtag(fallbackRow.content_hash, fallbackRow.enrichment_hash, acceptedSources);
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
      beers: relabelEnrichmentSources(staleBeers, acceptedSources),
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
      readonly contentHash: string;
      readonly enrichmentHash: string | null;
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
    .filter(isFlyingSaucerBeerRecordWithinSizeCap)
    .map(cleanBeerNames);

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

  // The caller builds the ETag: it varies with the sources the client accepts.
  return {
    ok: true,
    enrichedBeers,
    cleanedCount,
    enrichmentRecords: enrichmentMap.size,
    upstreamLatencyMs,
    contentHash: rawHash,
    enrichmentHash,
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
  baseHeaders: Record<string, string>,
  reqCtx: RequestContext,
  storeId: string,
  freshRequested = false
): Promise<GetBeersResult> {
  const upstreamStartTime = Date.now();
  // Labels and ETags depend on this request header, so every response
  // (including 304s and errors) says so.
  const headers: Record<string, string> = { ...baseHeaders, Vary: ENRICHMENT_SOURCES_HEADER };
  const acceptedSources = parseAcceptedSources(request.headers.get(ENRICHMENT_SOURCES_HEADER));

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
        cachedEtag = await buildCombinedEtag(cachedRow.content_hash, cachedRow.enrichment_hash, acceptedSources);
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
            beers: relabelEnrichmentSources(cachedBeers, acceptedSources),
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
        if (staleBeers) return await serveStaleFallback(request, fallbackRow, staleBeers, storeId, reqCtx, headers, result.upstreamLatencyMs, acceptedSources);
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

    const { enrichedBeers, cleanedCount, enrichmentRecords, upstreamLatencyMs } = result;
    const etag = await buildCombinedEtag(result.contentHash, result.enrichmentHash, acceptedSources);

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
        beers: relabelEnrichmentSources(enrichedBeers, acceptedSources),
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
      if (staleBeers) return await serveStaleFallback(request, fallbackRow, staleBeers, storeId, reqCtx, headers, Date.now() - upstreamStartTime, acceptedSources);
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
  baseHeaders: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  const headers: Record<string, string> = { ...baseHeaders, Vary: ENRICHMENT_SOURCES_HEADER };
  const acceptedSources = parseAcceptedSources(request.headers.get(ENRICHMENT_SOURCES_HEADER));
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
        enrichment_source: wireEnrichmentSource(row.enrichment_source, acceptedSources),
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
 * POST /beers/sync - Sync missing beers from mobile client
 *
 * Request body: { beers: Array<{ id, brew_name, brewer?, brew_description? }> }
 * Returns: { synced, queued_for_cleanup, requestId, errors? }
 *
 * This endpoint allows the mobile client to sync beers that were missing
 * from the enriched_beers table (identified via the batch lookup endpoint).
 * A changed description replaces the stored text and hash together, guarded
 * on what this request read, and is queued for cleanup only if written. An
 * unchanged or omitted description updates names and last_seen_at only.
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
    const validBeers: SeenBeer[] = [];

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
          brewer: beerParse.data.brewer,
          brew_description: beerParse.data.brew_description,
        });
      }
    }

    if (validBeers.length === 0) {
      return Response.json(
        { error: 'No valid beers in request', errors: validationErrors, requestId: reqCtx.requestId },
        { status: 400, headers }
      );
    }

    // Sync queues cleanup only; undescribed pending rows are left to the cron.
    const now = Date.now();
    const result = await recordSeenBeers(env.DB, validBeers, { now });
    const { queued: queuedForCleanup, markError } = await sendCleanupAndMark(env, result.cleanup, reqCtx.requestId, now);
    if (markError !== null) throw markError;

    // Duplicate ids collapse to their last valid item, but every valid item
    // counts toward `synced` unless its beer's write failed.
    const synced = validBeers.filter(beer => result.outcomes.get(beer.id) !== 'failed').length;
    const writeFailed = [...result.outcomes.values()].includes('failed');
    const allErrors = [...validationErrors, ...(writeFailed ? ['Database write failed for batch'] : [])];

    logWithContext(reqCtx.requestId, 'beers.sync.complete', {
      synced,
      queuedForCleanup: queuedForCleanup,
      validationErrors: validationErrors.length,
    });

    return Response.json({
      synced,
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
