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
import { ExaError, fetchAbvFromUntappd } from '../services/exa';
import { trackEnrichment } from '../analytics';
import { reserveAbvFallbackSlot, reserveEnrichmentSlot } from '../db/quota';
import { SAME_IDENTITY_SQL } from '../db/identity';
import { ABV_CONFIDENCE_FROM_EXA, ABV_CONFIDENCE_FROM_PERPLEXITY, DEFAULT_EXA_DAILY_LIMIT } from '../constants';
import { getToday, getMonthStart, getMonthEnd } from '../utils/date';

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

  const today = getToday();
  const monthStart = getMonthStart();
  const monthEnd = getMonthEnd();
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
    if (!message) continue;
    const { beerId, beerName, brewer, descriptionHash } = message.body;

    // Check if beer still needs enrichment (pending status)
    const existing = await env.DB.prepare(
      'SELECT enrichment_status FROM enriched_beers WHERE id = ?'
    ).bind(beerId).first<{ enrichment_status: string | null }>();

    if (existing !== null && existing.enrichment_status !== 'pending') {
      console.log(`[enrichment] Skipping ${beerId}: status=${existing.enrichment_status}`);
      message.ack();
      continue;
    }

    const enrichmentStartTime = Date.now();

    // Add delay between API calls (skip delay for first message)
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
    }

    try {
      // Layer 1: Atomic reservation - reserve slot BEFORE API call
      const reservation = await reserveEnrichmentSlot(env.DB, today, dailyLimit);

      if (!reservation.reserved) {
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
        // Optimistic concurrency: bind the write to the same 'pending'
        // status this iteration already observed above, so a row that
        // changed status between that check and this write (e.g. another
        // consumer enriched it, or a redelivered message raced this one)
        // is not silently overwritten. AND'd with a descriptionHash check
        // for parity with cleanup.ts's stale-result binding -- the status
        // guard stays (belt and braces): a description-hash mismatch alone
        // would not catch a race where the row's description never
        // changed but its status did between the check above and this
        // write. `IS` (not `=`) so a null message hash -- a beer with no
        // description at all -- correctly matches a null stored column
        // instead of a SQL `NULL = NULL` non-match silently discarding
        // every such write as "stale."
        const updateResult = await env.DB.prepare(`
          UPDATE enriched_beers
          SET abv = ?, confidence = ${ABV_CONFIDENCE_FROM_PERPLEXITY}, enrichment_source = 'perplexity', enrichment_status = 'enriched', updated_at = ?
          WHERE id = ? AND enrichment_status = 'pending' AND description_hash IS ?
        `).bind(abv, Date.now(), beerId, descriptionHash ?? null).run();

        if (updateResult.meta?.changes === 0) {
          console.warn(JSON.stringify({
            event: 'enrichment.stale_result',
            beerId,
            reason: 'enrichment_status or description_hash changed between pending-check and write; result discarded',
          }));
        } else {
          console.log(`Enriched ${beerId}: ${beerName} -> ABV ${abv}%`);
        }
      } else {
        await recordPerplexityUnknown(env, message.body);
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

// ============================================================================
// Exa Untappd fallback (runs only after Perplexity's explicit "unknown")
// ============================================================================

type FallbackOutcome =
  | { readonly kind: 'abv'; readonly abv: number }
  | { readonly kind: 'miss' };

function exaDailyLimit(env: Env): number {
  const parsed = Number.parseInt(env.EXA_DAILY_LIMIT ?? '', 10);
  return Number.isNaN(parsed) ? DEFAULT_EXA_DAILY_LIMIT : parsed;
}

/**
 * The row the message was built from is still the one to enrich: pending,
 * same description hash, same name and brewer. Cleanup can enrich a row,
 * and a description or /beers/sync change can replace it, while Perplexity
 * runs; a stale message must not spend a paid Exa call.
 */
async function isStillCurrent(db: D1Database, body: EnrichmentMessage): Promise<boolean> {
  const current = await db.prepare(
    `SELECT 1 AS current FROM enriched_beers
     WHERE id = ? AND enrichment_status = 'pending' AND description_hash IS ? AND ${SAME_IDENTITY_SQL}`
  ).bind(body.beerId, body.descriptionHash ?? null, body.beerName, body.brewer).first<number>('current');
  return current !== null;
}

// Charged to the UTC day of the reservation itself: a message whose
// Perplexity call crosses midnight must not spend yesterday's allowance.
async function reserveFallbackSlot(env: Env): Promise<boolean> {
  try {
    return await reserveAbvFallbackSlot(env.DB, { date: getToday(), limit: exaDailyLimit(env) });
  } catch (error) {
    console.error('[enrichment] Exa slot reservation failed; skipping the fallback:', error);
    return false;
  }
}

/**
 * Missing key, kill switch and an exhausted cap all mean "fallback
 * unavailable": the beer takes the ordinary miss path. An Exa failure is a
 * miss too, never a retry, because a retry would repeat the Perplexity call
 * that already answered cleanly.
 */
async function runExaFallback(env: Env, body: EnrichmentMessage): Promise<FallbackOutcome> {
  if (!env.EXA_API_KEY || env.ABV_FALLBACK_ENABLED !== 'true') return { kind: 'miss' };
  // A stale message skips Exa; the guarded write below then changes nothing,
  // leaving the row to whatever cleanup, a sync or a newer message made it.
  if (!(await isStillCurrent(env.DB, body))) return { kind: 'miss' };
  if (!(await reserveFallbackSlot(env))) return { kind: 'miss' };

  const startTime = Date.now();
  try {
    const abv = await fetchAbvFromUntappd(env, body.beerName, body.brewer);
    trackEnrichment(env.ANALYTICS, { beerId: body.beerId, source: 'exa', success: abv !== null, durationMs: Date.now() - startTime });
    return abv === null ? { kind: 'miss' } : { kind: 'abv', abv };
  } catch (error) {
    trackEnrichment(env.ANALYTICS, { beerId: body.beerId, source: 'exa', success: false, durationMs: Date.now() - startTime });
    console.error(JSON.stringify({
      event: 'exa.fallback_failed',
      beerId: body.beerId,
      kind: error instanceof ExaError ? error.kind : 'transport',
      status: error instanceof ExaError ? error.status : undefined,
    }));
    return { kind: 'miss' };
  }
}

/**
 * Every terminal write here is guarded on the message's status, description
 * hash, name and brewer: Exa's strict match was made against that identity,
 * and /beers/sync can change it without touching status or hash. A D1 error
 * propagates so the caller retries the message.
 */
async function recordPerplexityUnknown(env: Env, body: EnrichmentMessage): Promise<void> {
  const outcome = await runExaFallback(env, body);

  const guard = `WHERE id = ? AND enrichment_status = 'pending' AND description_hash IS ? AND ${SAME_IDENTITY_SQL}`;
  const guardArgs = [body.beerId, body.descriptionHash ?? null, body.beerName, body.brewer];
  const result = outcome.kind === 'abv'
    ? await env.DB.prepare(
        `UPDATE enriched_beers
         SET abv = ?, confidence = ${ABV_CONFIDENCE_FROM_EXA}, enrichment_source = 'exa', enrichment_status = 'enriched', updated_at = ?
         ${guard}`
      ).bind(outcome.abv, Date.now(), ...guardArgs).run()
    : await env.DB.prepare(
        `UPDATE enriched_beers SET enrichment_status = 'not_found', updated_at = ? ${guard}`
      ).bind(Date.now(), ...guardArgs).run();

  if (result.meta?.changes === 0) {
    console.warn(JSON.stringify({
      event: 'enrichment.stale_result',
      beerId: body.beerId,
      reason: 'status, description_hash, name or brewer changed since the message; result discarded',
    }));
    return;
  }
  console.log(outcome.kind === 'abv'
    ? `Enriched ${body.beerId} via Exa: ${body.beerName} -> ABV ${outcome.abv}%`
    : `No ABV found for ${body.beerId}: ${body.beerName}`);
}
