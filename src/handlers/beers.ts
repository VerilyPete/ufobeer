/**
 * Beer Handlers
 *
 * Endpoints for fetching and querying beer data.
 * Includes:
 * - handleBeerList() - GET /beers?sid= - Fetch beers from Flying Saucer and merge enrichment
 * - handleBatchLookup() - POST /beers/batch - Batch lookup enrichment data by beer IDs
 *
 * Extracted from index.ts as part of Phase 7 refactoring.
 */

import type {
  Env,
  RequestContext,
  FlyingSaucerBeer,
  GetBeersResult,
} from '../types';
import { isValidBeer, hasBeerStock } from '../types';
import { insertPlaceholders } from '../db';
import { queueBeersForEnrichment } from '../queue';

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

    // 3. Fetch enrichment data from D1
    const { results } = await env.DB.prepare(
      'SELECT id, abv, confidence, enrichment_source FROM enriched_beers'
    ).all<{ id: string; abv: number | null; confidence: number; enrichment_source: string | null }>();

    const enrichmentMap = new Map(
      results.map(r => [r.id, { abv: r.abv, confidence: r.confidence, source: r.enrichment_source }])
    );

    // 4. Merge data
    const enrichedBeers = rawBeers.map(beer => {
      const enrichment = enrichmentMap.get(beer.id);
      return {
        ...beer,
        enriched_abv: enrichment?.abv ?? null,
        enrichment_confidence: enrichment?.confidence ?? null,
        enrichment_source: enrichment?.source ?? null,
      };
    });

    // 5. Sync beers to enriched_beers table (background task)
    // This populates the table so cron/trigger can find beers to enrich.
    // ABV is extracted from brew_description when available - only beers
    // without parseable ABV will be queued for Perplexity enrichment.
    const beersForPlaceholders = rawBeers.map(beer => ({
      id: beer.id,
      brew_name: beer.brew_name,
      brewer: beer.brewer,
      brew_description: beer.brew_description,
    }));
    ctx.waitUntil(
      insertPlaceholders(env.DB, beersForPlaceholders, reqCtx.requestId)
        .then(result => {
          if (result.needsEnrichment.length > 0) {
            return queueBeersForEnrichment(env, result.needsEnrichment, reqCtx.requestId);
          }
          return { queued: 0, skipped: 0 };
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
 * Returns enrichment data for up to 100 beer IDs.
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

    // Build parameterized query
    const placeholders = limitedIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, abv, confidence, enrichment_source, is_verified FROM enriched_beers WHERE id IN (${placeholders})`
    ).bind(...limitedIds).all<{
      id: string;
      abv: number | null;
      confidence: number;
      enrichment_source: string | null;
      is_verified: number;
    }>();

    // Format response
    const enrichmentData: Record<string, { abv: number | null; confidence: number; source: string | null; is_verified: boolean }> = {};
    for (const row of results) {
      enrichmentData[row.id] = {
        abv: row.abv,
        confidence: row.confidence,
        source: row.enrichment_source,
        is_verified: Boolean(row.is_verified),
      };
    }

    return Response.json({
      enrichments: enrichmentData,
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
