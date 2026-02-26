/**
 * Queue helper functions for beer enrichment and cleanup.
 *
 * This module provides utilities for queueing beers for:
 * - Perplexity enrichment (ABV lookup)
 * - Description cleanup (LLM-based text cleanup)
 *
 * Includes blocklist filtering and batch handling.
 *
 * @module queue/helpers
 */

import type { Env, EnrichmentMessage, CleanupMessage } from '../types';
import { shouldSkipEnrichment } from '../config';

const BATCH_SIZE = 100; // Cloudflare Queues sendBatch limit

/**
 * Queue beers for Perplexity enrichment.
 *
 * Filters out blocklisted items and batches messages in chunks of 100
 * (Cloudflare Queues sendBatch limit). Continues processing on per-batch
 * errors - partial success is acceptable.
 *
 * @param env - Cloudflare Worker environment bindings
 * @param beers - Array of beers needing enrichment
 * @param requestId - Request ID for logging correlation
 * @returns Object with queued and skipped counts
 */
export async function queueBeersForEnrichment(
  env: Env,
  beers: ReadonlyArray<{ readonly id: string; readonly brew_name: string; readonly brewer: string }>,
  requestId: string
): Promise<{ queued: number; skipped: number }> {
  const eligible = beers.filter(b => !shouldSkipEnrichment(b.brew_name));
  const skipped = beers.length - eligible.length;

  if (eligible.length === 0) {
    console.log(JSON.stringify({
      event: 'queue_enrichment_skip',
      requestId,
      reason: 'no_eligible_beers',
      skipped,
    }));
    return { queued: 0, skipped };
  }

  let queued = 0;
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const chunk = eligible.slice(i, i + BATCH_SIZE);
    const messages = chunk.map(beer => ({
      body: {
        beerId: beer.id,
        beerName: beer.brew_name,
        brewer: beer.brewer,
      } satisfies EnrichmentMessage,
    }));

    try {
      await env.ENRICHMENT_QUEUE.sendBatch(messages);
      queued += chunk.length;
    } catch (error) {
      console.error(JSON.stringify({
        event: 'queue_enrichment_error',
        requestId,
        batchIndex: Math.floor(i / BATCH_SIZE) + 1,
        batchSize: chunk.length,
        error: error instanceof Error ? error.message : String(error),
      }));
      // Continue with next batch - partial success acceptable
    }
  }

  console.log(JSON.stringify({
    event: 'queue_enrichment_complete',
    requestId,
    queued,
    skipped,
    totalBeers: beers.length,
  }));

  return { queued, skipped };
}

/**
 * Queue beers for description cleanup.
 *
 * Similar to queueBeersForEnrichment but for the cleanup queue.
 * Filters out blocklisted items and batches messages in chunks of 100.
 *
 * @param env - Cloudflare Worker environment bindings
 * @param beers - Array of beers needing cleanup (includes brew_description)
 * @param requestId - Request ID for logging correlation
 * @returns Object with queued and skipped counts
 */
export async function queueBeersForCleanup(
  env: Env,
  beers: ReadonlyArray<{ readonly id: string; readonly brew_name: string; readonly brewer: string; readonly brew_description: string }>,
  requestId: string
): Promise<{ queued: number; skipped: number }> {
  const eligible = beers.filter(b => !shouldSkipEnrichment(b.brew_name));
  const skipped = beers.length - eligible.length;

  if (eligible.length === 0) {
    console.log(JSON.stringify({
      event: 'queue_cleanup_skip',
      requestId,
      reason: 'no_eligible_beers',
      skipped,
    }));
    return { queued: 0, skipped };
  }

  let queued = 0;
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const chunk = eligible.slice(i, i + BATCH_SIZE);
    const messages = chunk.map(beer => ({
      body: {
        beerId: beer.id,
        beerName: beer.brew_name,
        brewer: beer.brewer,
        brewDescription: beer.brew_description,
      } satisfies CleanupMessage,
    }));

    try {
      await env.CLEANUP_QUEUE.sendBatch(messages);
      queued += chunk.length;
    } catch (error) {
      console.error(JSON.stringify({
        event: 'queue_cleanup_error',
        requestId,
        batchIndex: Math.floor(i / BATCH_SIZE) + 1,
        batchSize: chunk.length,
        error: error instanceof Error ? error.message : String(error),
      }));
      // Continue with next batch - partial success acceptable
    }
  }

  console.log(JSON.stringify({
    event: 'queue_cleanup_complete',
    requestId,
    queued,
    skipped,
    totalBeers: beers.length,
  }));

  return { queued, skipped };
}
