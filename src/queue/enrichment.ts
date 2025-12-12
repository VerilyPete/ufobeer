/**
 * Enrichment queue consumer for processing beer ABV lookups.
 *
 * This module processes messages from the beer-enrichment queue, calling
 * the Perplexity API to fetch ABV data and updating the database.
 *
 * Features:
 * - Kill switch support (ENRICHMENT_ENABLED=false)
 * - Daily and monthly quota enforcement
 * - Atomic quota reservation before API calls
 * - Rate limiting with 2-second delay between calls
 * - 429 error handling with extended retry delay
 *
 * @module queue/enrichment
 */

import type { Env, EnrichmentMessage } from '../types';
import { fetchAbvFromPerplexity } from '../services/perplexity';
import { trackEnrichment } from '../analytics';

/**
 * Handle a batch of messages from the beer-enrichment queue.
 *
 * Processes messages sequentially with rate limiting to avoid hitting
 * Perplexity API rate limits. Uses a three-layer circuit breaker:
 *
 * Layer 1: Atomic reservation per-request (daily limit)
 * Layer 2: Monthly limit check (fail-safe on D1 error)
 * Layer 3: Kill switch (ENRICHMENT_ENABLED=false)
 *
 * @param batch - The batch of messages to process
 * @param env - Cloudflare Worker environment bindings
 */
export async function handleEnrichmentBatch(
  batch: MessageBatch<EnrichmentMessage>,
  env: Env
): Promise<void> {
  console.log(`Processing batch of ${batch.messages.length} beers for enrichment`);

  // Layer 3: Kill switch
  if (env.ENRICHMENT_ENABLED === 'false') {
    console.log('Enrichment disabled via kill switch');
    for (const message of batch.messages) {
      message.ack();
    }
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.slice(0, 7) + '-01';
  const monthEnd = today.slice(0, 7) + '-31';
  const dailyLimit = parseInt(env.DAILY_ENRICHMENT_LIMIT || '500');
  const monthlyLimit = parseInt(env.MONTHLY_ENRICHMENT_LIMIT || '2000');

  // Layer 2: Monthly limit check (fail-safe on D1 error)
  let monthlyCount: { total: number } | null = null;
  try {
    monthlyCount = await env.DB.prepare(
      `SELECT SUM(request_count) as total FROM enrichment_limits
       WHERE date >= ? AND date <= ?`
    ).bind(monthStart, monthEnd).first<{ total: number }>();
  } catch (dbError) {
    console.error('D1 unavailable for monthly limit check:', dbError);
    // Fail-safe: retry later when D1 is available
    for (const message of batch.messages) {
      message.retry();
    }
    return;
  }

  if (monthlyCount && monthlyCount.total >= monthlyLimit) {
    console.log(`Monthly limit reached (${monthlyLimit})`);
    for (const message of batch.messages) {
      message.ack();
    }
    return;
  }

  // Delay between API calls to avoid rate limits (Perplexity allows ~50-100 RPM)
  const API_DELAY_MS = 2000; // 2 seconds between calls = 30 requests/minute max

  // Process messages one at a time with atomic reservation
  for (let i = 0; i < batch.messages.length; i++) {
    const message = batch.messages[i];
    const { beerId, beerName, brewer } = message.body;
    const enrichmentStartTime = Date.now();

    // Add delay between API calls (skip delay for first message)
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
    }

    try {
      // Layer 1: Atomic reservation - reserve slot BEFORE API call
      const reservation = await env.DB.prepare(`
        INSERT INTO enrichment_limits (date, request_count, last_updated)
        VALUES (?, 1, ?)
        ON CONFLICT(date) DO UPDATE SET
          request_count = CASE
            WHEN request_count < ? THEN request_count + 1
            ELSE request_count
          END,
          last_updated = ?
        RETURNING request_count, (request_count <= ?) as reserved
      `).bind(today, Date.now(), dailyLimit, Date.now(), dailyLimit)
        .first<{ request_count: number; reserved: number }>();

      if (!reservation || !reservation.reserved) {
        console.log(`Daily limit reached, skipping ${beerId}`);
        message.ack();
        continue;
      }

      // Slot reserved - now make the API call
      // Counter is already incremented, so cost is tracked even if API call fails
      const abv = await fetchAbvFromPerplexity(env, beerName, brewer);

      // Track enrichment success/failure
      trackEnrichment(env.ANALYTICS, {
        beerId,
        source: 'perplexity',
        success: abv !== null,
        durationMs: Date.now() - enrichmentStartTime,
      });

      if (abv !== null) {
        await env.DB.prepare(`
          UPDATE enriched_beers
          SET abv = ?, confidence = 0.7, enrichment_source = 'perplexity', updated_at = ?
          WHERE id = ?
        `).bind(abv, Date.now(), beerId).run();

        console.log(`Enriched ${beerId}: ${beerName} -> ABV ${abv}%`);
      } else {
        console.log(`No ABV found for ${beerId}: ${beerName}`);
      }

      message.ack();
    } catch (error) {
      console.error(`Failed to enrich ${beerId}:`, error);

      // Track failed enrichment attempt
      trackEnrichment(env.ANALYTICS, {
        beerId,
        source: 'perplexity',
        success: false,
        durationMs: Date.now() - enrichmentStartTime,
      });

      // Note: Counter was already incremented via reservation
      // This is intentional - we want to track failed API calls too

      // Check if this is a rate limit error (429) - use longer delay
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('429')) {
        // Rate limited - retry after 2 minutes to let the rate limit window reset
        console.log(`Rate limited for ${beerId}, retrying in 120 seconds`);
        message.retry({ delaySeconds: 120 });
      } else {
        // Other errors - use default retry delay (60 seconds from wrangler.jsonc)
        message.retry();
      }
    }
  }
}
