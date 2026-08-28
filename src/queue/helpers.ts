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
 * Batches messages in chunks of 100 (Cloudflare Queues sendBatch limit).
 * No blocklist filtering — all beers are queued for cleanup. Blocklist
 * filtering for Perplexity forwarding happens downstream in the cleanup
 * queue consumer (buildBatchOperations / handleFallbackBatch).
 *
 * Callers MUST only mark beers as queued (queued_for_cleanup_at, cleanup
 * resets) AFTER this resolves and only for the returned queuedIds — a
 * mark-then-send order strands un-sent beers behind the requeue cooldown.
 * Granularity is per chunk: sendBatch is all-or-nothing per chunk.
 *
 * @param env - Cloudflare Worker environment bindings
 * @param beers - Array of beers needing cleanup (includes brew_description)
 * @param requestId - Request ID for logging correlation
 * @returns Object with queued count and the IDs that were actually sent
 */
export async function queueBeersForCleanup(
  env: Env,
  beers: ReadonlyArray<{ readonly id: string; readonly brew_name: string; readonly brewer: string; readonly brew_description: string }>,
  requestId: string
): Promise<{ queued: number; queuedIds: string[] }> {
  if (beers.length === 0) {
    console.log(JSON.stringify({
      event: 'queue_cleanup_skip',
      requestId,
      reason: 'no_beers',
    }));
    return { queued: 0, queuedIds: [] };
  }

  let queued = 0;
  const queuedIds: string[] = [];
  for (let i = 0; i < beers.length; i += BATCH_SIZE) {
    const chunk = beers.slice(i, i + BATCH_SIZE);
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
      queuedIds.push(...chunk.map(beer => beer.id));
    } catch (error) {
      console.error(JSON.stringify({
        event: 'queue_cleanup_error',
        requestId,
        batchIndex: Math.floor(i / BATCH_SIZE) + 1,
        batchSize: chunk.length,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  console.log(JSON.stringify({
    event: 'queue_cleanup_complete',
    requestId,
    queued,
    totalBeers: beers.length,
  }));

  return { queued, queuedIds };
}
