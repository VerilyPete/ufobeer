/**
 * Description Cleanup Queue Consumer
 *
 * Processes beer descriptions using Workers AI (Llama 3.2 1B) to clean up
 * spelling errors, punctuation issues, and HTML artifacts.
 *
 * Pipeline:
 * 1. Receive cleanup message with beer description
 * 2. Check quota before calling AI
 * 3. Call Workers AI for cleanup (with validation)
 * 4. Extract ABV from cleaned description
 * 5. If ABV found: Update DB with cleaned desc + ABV, done
 * 6. If ABV not found: Update DB with cleaned desc, queue for Perplexity
 *
 * @module queue/cleanup
 */

import type { Env, CleanupMessage } from '../types';
import pLimit from 'p-limit';
import { extractABV } from '../db/helpers';
import {
  withTimeout,
  isCircuitBreakerOpen,
  recordCallLatency,
  AI_TIMEOUT_MS,
  batchUpdateWithRetry,
  reserveCleanupQuotaBatch,
} from './cleanupHelpers';

// ============================================================================
// Constants
// ============================================================================

/** Default daily cleanup limit - can be overridden via env.DAILY_CLEANUP_LIMIT */
const DEFAULT_DAILY_CLEANUP_LIMIT = 1000;

const CLEANUP_PROMPT = `Clean the text between <TEXT> and </TEXT>. Return ONLY the cleaned text, nothing else.

REMOVE only these HTML tags:
- <p>, </p>, <br>, <br />, <span>, </span>

DECODE HTML entities to normal characters:
- &amp; becomes &
- &nbsp; becomes space
- &lt; becomes <
- &gt; becomes >
- &#39; becomes '
- \\' becomes '
- \\r\\n becomes newline

DO NOT:
- Encode characters (never turn & into &amp;)
- Change "and" to "&" or vice versa
- Remove numbers from beer names (keep "Fireman's 4" not "Fireman's")
- Remove hashtags like #forsuredude
- Change price indicators (keep $$$$ exactly as written)
- Rewrite sentences or change grammar (only fix obvious typos)

KEEP EXACTLY as written:
- All words, sentences, ABV values, prices ($, $$, $$$, $$$$)
- All capitalization (keep "This" not "this")
- All punctuation and special characters
- All hashtags and social media content

<TEXT>
`;

// ============================================================================
// Types
// ============================================================================

/**
 * Result from cleanDescriptionSafely containing the cleaned description,
 * whether the original was used, and the extracted ABV to avoid redundant
 * regex execution in the hot path.
 */
export interface CleanupResult {
  cleaned: string;
  usedOriginal: boolean;
  extractedABV: number | null;
}

/**
 * Metrics for a batch of cleanup operations.
 * Used for observability and alerting.
 */
interface BatchMetrics {
  totalMessages: number;
  aiSuccessCount: number;
  aiFailureCount: number;
  abvExtractedCount: number;
  fallbackUsedCount: number;
  avgLatencyMs: number;
  circuitBreakerTriggered: boolean;
}

/**
 * Operations collected from batch processing.
 * Includes D1 statements, queue messages, and message disposition.
 */
interface BatchOperations {
  dbStatements: D1PreparedStatement[];
  perplexityMessages: EnrichmentMessage[];
  ackMessages: Message<CleanupMessage>[];
  retryMessages: Message<CleanupMessage>[];
  metrics: BatchMetrics;
}

/**
 * Message format for Perplexity enrichment queue.
 * Exported for use by Phase 6 handleFallbackBatch.
 */
export interface EnrichmentMessage {
  beerId: string;
  beerName: string;
  brewer: string;
}

/**
 * Result from processAIConcurrently for each message.
 */
export interface AIResult {
  index: number;
  success: boolean;
  cleaned?: string;
  usedOriginal?: boolean;
  extractedABV?: number | null;  // ABV already extracted by cleanDescriptionSafely
  error?: string;
  useFallback?: boolean;  // Set when circuit breaker is open
  latencyMs?: number;
}

/**
 * Source of fallback processing.
 * Used for tracking/debugging why AI cleanup was skipped.
 */
export type FallbackSource = 'fallback-quota-exceeded' | 'fallback-circuit-breaker';

// Common prefixes the LLM might add that we need to strip
const RESPONSE_PREFIXES = [
  'Here is the cleaned text:',
  'Here is the cleaned description:',
  'Here\'s the cleaned text:',
  'Cleaned text:',
  'Cleaned:',
];

/**
 * Strip common LLM preamble prefixes and leading whitespace from the response.
 */
function stripResponsePrefixes(text: string): string {
  let result = text.trim();

  // Strip known prefixes
  for (const prefix of RESPONSE_PREFIXES) {
    if (result.toLowerCase().startsWith(prefix.toLowerCase())) {
      result = result.slice(prefix.length);
      break;
    }
  }

  // Remove any leading newlines/whitespace after stripping prefix
  return result.replace(/^[\s\n]+/, '').trim();
}

// ============================================================================
// Quota Management
// ============================================================================

/**
 * Check if we're within daily cleanup quota.
 * Returns true if we can process more cleanup requests.
 */
export async function checkCleanupQuota(db: D1Database, limit?: number): Promise<boolean> {
  const dailyLimit = limit ?? DEFAULT_DAILY_CLEANUP_LIMIT;
  const today = new Date().toISOString().split('T')[0];
  const result = await db.prepare(
    'SELECT request_count FROM cleanup_limits WHERE date = ?'
  ).bind(today).first<{ request_count: number }>();

  return (result?.request_count ?? 0) < dailyLimit;
}

/**
 * Increment the daily cleanup quota counter.
 */
export async function incrementCleanupQuota(db: D1Database): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const now = Date.now();
  await db.prepare(`
    INSERT INTO cleanup_limits (date, request_count, last_updated)
    VALUES (?, 1, ?)
    ON CONFLICT(date) DO UPDATE SET
      request_count = request_count + 1,
      last_updated = excluded.last_updated
  `).bind(today, now).run();
}

// ============================================================================
// Cleanup Function with Validation
// ============================================================================

/**
 * Clean description using Workers AI with validation.
 * Returns the cleaned description, whether the original was used,
 * and the extracted ABV to avoid redundant regex execution.
 *
 * Falls back to original if:
 * - AI call fails
 * - ABV extraction breaks after cleanup
 * - Length changes dramatically (>2x or <0.5x)
 */
async function cleanDescriptionSafely(
  original: string,
  ai: Ai
): Promise<CleanupResult> {
  if (!original) {
    return {
      cleaned: original,
      usedOriginal: true,
      extractedABV: extractABV(original),
    };
  }

  let cleaned: string;
  try {
    const result = await ai.run('@cf/meta/llama-3.2-3b-instruct', {
      prompt: CLEANUP_PROMPT + original + '\n</TEXT>',
      max_tokens: 700,
    });

    // Workers AI returns { response?: string, ... }
    if (result.response) {
      cleaned = stripResponsePrefixes(result.response);
    } else {
      console.error('[cleanup] AI response missing text');
      return {
        cleaned: original,
        usedOriginal: true,
        extractedABV: extractABV(original),
      };
    }
  } catch (e) {
    console.error('[cleanup] Inference failed:', e instanceof Error ? e.message : String(e));
    return {
      cleaned: original,
      usedOriginal: true,
      extractedABV: extractABV(original),
    };
  }

  // Validation 1: ABV extraction should work the same or better
  const originalAbv = extractABV(original);
  const cleanedAbv = extractABV(cleaned);

  if (originalAbv !== null && cleanedAbv === null) {
    console.warn('[cleanup] Cleanup broke ABV extraction, using original');
    return {
      cleaned: original,
      usedOriginal: true,
      extractedABV: originalAbv,
    };
  }

  // Validation 2: Length shouldn't change much (only removing HTML artifacts)
  // Tighter bounds since we're only removing artifacts, not rewriting
  const lengthRatio = cleaned.length / original.length;
  if (lengthRatio < 0.7 || lengthRatio > 1.1) {
    console.warn(`[cleanup] Length changed too much (ratio=${lengthRatio.toFixed(2)}), using original`);
    return {
      cleaned: original,
      usedOriginal: true,
      extractedABV: originalAbv,
    };
  }

  // AI cleanup successful - return ABV from cleaned version
  return {
    cleaned,
    usedOriginal: false,
    extractedABV: cleanedAbv,
  };
}

// ============================================================================
// Concurrent AI Processing
// ============================================================================

/**
 * Process AI cleanup calls concurrently using p-limit.
 *
 * p-limit maintains exactly N concurrent calls (no chunking delays).
 * Each completed call immediately starts the next pending call.
 *
 * @param messages - Queue messages to process
 * @param ai - Workers AI binding
 * @param maxConcurrent - Maximum concurrent AI calls (default 10)
 * @param options - Optional configuration for testability
 * @param options.cleanFn - Cleanup function (defaults to cleanDescriptionSafely)
 * @param options.timeoutMs - Timeout in milliseconds (defaults to AI_TIMEOUT_MS)
 * @returns Array of AIResult in the same order as input messages
 */
export async function processAIConcurrently(
  messages: Message<CleanupMessage>[],
  ai: Ai,
  maxConcurrent: number,
  options: {
    cleanFn?: (description: string, ai: Ai) => Promise<CleanupResult>;
    timeoutMs?: number;
  } = {}
): Promise<AIResult[]> {
  const cleanFn = options.cleanFn ?? cleanDescriptionSafely;
  const timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
  // Handle empty message array
  if (messages.length === 0) {
    return [];
  }

  const limit = pLimit(maxConcurrent);
  const totalMessages = messages.length;

  const promises = messages.map((msg, index) =>
    limit(async (): Promise<AIResult> => {
      // Check circuit breaker before making AI call (includes half-open logic)
      if (isCircuitBreakerOpen()) {
        return {
          index,
          success: false,
          error: 'Circuit breaker open',
          useFallback: true
        };
      }

      const startTime = Date.now();
      const beerId = msg.body.beerId;

      try {
        const { cleaned, usedOriginal, extractedABV } = await withTimeout(
          cleanFn(msg.body.brewDescription, ai),
          timeoutMs
        );

        const latencyMs = Date.now() - startTime;
        recordCallLatency(latencyMs, index, totalMessages, beerId);

        return {
          index,
          success: true,
          cleaned,
          usedOriginal,
          extractedABV,
          latencyMs
        };
      } catch (error) {
        const latencyMs = Date.now() - startTime;
        recordCallLatency(latencyMs, index, totalMessages, beerId);

        return {
          index,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          latencyMs,
        };
      }
    })
  );

  const settled = await Promise.allSettled(promises);

  // Note: The rejection branch below should never trigger because the inner
  // function has try/catch that always returns an AIResult. We keep it for
  // defensive programming in case of unexpected runtime errors.
  return settled.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    // Promise rejection (shouldn't happen with try/catch - defensive only)
    return {
      index,
      success: false,
      error: result.reason?.message ?? 'Unknown error',
    };
  });
}

// ============================================================================
// Batch Operations Builder
// ============================================================================

/**
 * Build batch operations from AI processing results.
 *
 * Categorizes results and builds:
 * - D1 prepared statements for batch update
 * - Messages for Perplexity enrichment queue
 * - Lists of messages to ack or retry
 * - Metrics for observability
 *
 * Uses pre-extracted ABV from cleanDescriptionSafely to avoid redundant regex.
 */
function buildBatchOperations(
  messages: Message<CleanupMessage>[],
  aiResults: AIResult[],
  env: Env
): BatchOperations {
  const dbStatements: D1PreparedStatement[] = [];
  const perplexityMessages: EnrichmentMessage[] = [];
  const ackMessages: Message<CleanupMessage>[] = [];
  const retryMessages: Message<CleanupMessage>[] = [];
  const now = Date.now();

  // Metrics tracking
  let aiSuccessCount = 0;
  let aiFailureCount = 0;
  let abvExtractedCount = 0;
  let fallbackUsedCount = 0;
  let totalLatencyMs = 0;
  let latencyCount = 0;
  let circuitBreakerTriggered = false;

  for (const result of aiResults) {
    const message = messages[result.index];
    const { beerId, beerName, brewer, brewDescription } = message.body;

    // Track latency
    if (result.latencyMs !== undefined) {
      totalLatencyMs += result.latencyMs;
      latencyCount++;
    }

    // Handle circuit breaker fallback
    if (result.useFallback) {
      circuitBreakerTriggered = true;
      fallbackUsedCount++;

      // Extract ABV from the original description since AI cleanup is unavailable.
      // This is a fallback path when the circuit breaker is open or quota is exceeded.
      // We still attempt ABV extraction via regex on the raw description text.
      const abv = extractABV(brewDescription);

      if (abv !== null) {
        abvExtractedCount++;
        dbStatements.push(
          env.DB.prepare(`
            UPDATE enriched_beers SET
              brew_description_cleaned = ?,
              description_cleaned_at = ?,
              cleanup_source = 'fallback-circuit-breaker',
              abv = ?,
              confidence = 0.8,
              enrichment_source = 'description-fallback'
            WHERE id = ?
          `).bind(brewDescription, now, abv, beerId)
        );
      } else {
        dbStatements.push(
          env.DB.prepare(`
            UPDATE enriched_beers SET
              brew_description_cleaned = ?,
              description_cleaned_at = ?,
              cleanup_source = 'fallback-circuit-breaker'
            WHERE id = ?
          `).bind(brewDescription, now, beerId)
        );
        perplexityMessages.push({ beerId, beerName, brewer });
      }

      ackMessages.push(message);
      continue;
    }

    // Handle AI failure - retry the message
    if (!result.success) {
      aiFailureCount++;
      retryMessages.push(message);
      continue;
    }

    // Handle AI success
    aiSuccessCount++;
    const cleaned = result.cleaned!;
    const usedOriginal = result.usedOriginal!;
    // Use pre-extracted ABV from cleanDescriptionSafely (avoids redundant regex)
    const abv = result.extractedABV;

    if (abv !== null) {
      abvExtractedCount++;
      dbStatements.push(
        env.DB.prepare(`
          UPDATE enriched_beers SET
            brew_description_cleaned = ?,
            description_cleaned_at = ?,
            cleanup_source = ?,
            abv = ?,
            confidence = 0.9,
            enrichment_source = 'description'
          WHERE id = ?
        `).bind(
          cleaned,
          now,
          usedOriginal ? null : 'workers-ai',
          abv,
          beerId
        )
      );
    } else {
      dbStatements.push(
        env.DB.prepare(`
          UPDATE enriched_beers SET
            brew_description_cleaned = ?,
            description_cleaned_at = ?,
            cleanup_source = ?
          WHERE id = ?
        `).bind(
          cleaned,
          now,
          usedOriginal ? null : 'workers-ai',
          beerId
        )
      );
      // No ABV found - queue for Perplexity enrichment
      perplexityMessages.push({ beerId, beerName, brewer });
    }

    ackMessages.push(message);
  }

  const metrics: BatchMetrics = {
    totalMessages: messages.length,
    aiSuccessCount,
    aiFailureCount,
    abvExtractedCount,
    fallbackUsedCount,
    avgLatencyMs: latencyCount > 0 ? Math.round(totalLatencyMs / latencyCount) : 0,
    circuitBreakerTriggered,
  };

  return {
    dbStatements,
    perplexityMessages,
    ackMessages,
    retryMessages,
    metrics,
  };
}

/**
 * Log batch metrics in structured JSON format for parsing.
 *
 * Key metrics:
 * - total: Total messages in batch
 * - ai_success/ai_failure: AI call results
 * - abv_extracted: How many descriptions had ABV
 * - fallback_used: Circuit breaker fallback count
 * - avg_latency_ms: Average AI call latency
 * - circuit_breaker: Whether circuit breaker was triggered
 * - abv_rate: Percentage of successful cleanups that had ABV
 */
function logBatchMetrics(metrics: BatchMetrics): void {
  console.log('[cleanup] Batch metrics:', JSON.stringify({
    total: metrics.totalMessages,
    ai_success: metrics.aiSuccessCount,
    ai_failure: metrics.aiFailureCount,
    abv_extracted: metrics.abvExtractedCount,
    fallback_used: metrics.fallbackUsedCount,
    avg_latency_ms: metrics.avgLatencyMs,
    circuit_breaker: metrics.circuitBreakerTriggered,
    abv_rate: metrics.aiSuccessCount > 0
      ? Math.round((metrics.abvExtractedCount / metrics.aiSuccessCount) * 100)
      : 0,
  }));
}

// ============================================================================
// Fallback Handler
// ============================================================================

/**
 * Handle fallback when quota exceeded or cleanup failed.
 * Tries ABV extraction on original, queues for Perplexity if not found.
 */
async function handleFallback(
  env: Env,
  beerId: string,
  beerName: string,
  brewer: string,
  originalDescription: string
): Promise<void> {
  // Try ABV extraction on original
  const abv = extractABV(originalDescription);

  if (abv !== null) {
    await env.DB.prepare(`
      UPDATE enriched_beers SET abv = ?, confidence = 0.9, enrichment_source = 'description'
      WHERE id = ?
    `).bind(abv, beerId).run();
    console.log(`[cleanup:fallback] ${beerId}: ABV extracted from original (${abv}%)`);
  } else {
    // Queue for Perplexity
    await env.ENRICHMENT_QUEUE.send({ beerId, beerName, brewer });
    console.log(`[cleanup:fallback] ${beerId}: No ABV found, queued for Perplexity`);
  }
}

/**
 * Handle messages that cannot use AI (quota exceeded or circuit breaker open).
 *
 * For each message:
 * 1. Attempts ABV extraction from the original description (regex only)
 * 2. Stores the original description with appropriate cleanup_source
 * 3. Queues to Perplexity if ABV is not found
 *
 * This ensures progress even when AI is unavailable:
 * - Beer data gets stored (not lost)
 * - ABV can still be obtained via Perplexity
 *
 * IMPORTANT: This function does NOT call message.ack() or message.retry().
 * Message acknowledgment is the caller's responsibility (separation of concerns).
 * The caller (Phase 7: handleCleanupBatch) handles ack/retry after this function
 * completes successfully. This keeps fallback processing focused on data operations
 * and allows the caller to handle ack/retry consistently for all code paths.
 *
 * @param env - Worker environment bindings
 * @param messages - Queue messages to process with fallback
 * @param source - Why fallback was used (for tracking/debugging)
 */
export async function handleFallbackBatch(
  env: Env,
  messages: Message<CleanupMessage>[],
  source: FallbackSource
): Promise<void> {
  const now = Date.now();
  const dbStatements: D1PreparedStatement[] = [];
  const perplexityMessages: EnrichmentMessage[] = [];

  let abvFoundCount = 0;

  for (const message of messages) {
    const { beerId, beerName, brewer, brewDescription } = message.body;

    // Try to extract ABV from the original description (no AI cleanup)
    const abv = extractABV(brewDescription);

    if (abv !== null) {
      // Found ABV in original description
      abvFoundCount++;
      dbStatements.push(
        env.DB.prepare(`
          UPDATE enriched_beers SET
            brew_description_cleaned = ?,
            description_cleaned_at = ?,
            cleanup_source = ?,
            abv = ?,
            confidence = 0.8,
            enrichment_source = 'description-fallback'
          WHERE id = ?
        `).bind(brewDescription, now, source, abv, beerId)
      );
    } else {
      // No ABV found - store original and queue for Perplexity enrichment
      dbStatements.push(
        env.DB.prepare(`
          UPDATE enriched_beers SET
            brew_description_cleaned = ?,
            description_cleaned_at = ?,
            cleanup_source = ?
          WHERE id = ?
        `).bind(brewDescription, now, source, beerId)
      );
      perplexityMessages.push({ beerId, beerName, brewer });
    }
  }

  // Execute D1 updates with retry
  if (dbStatements.length > 0) {
    await batchUpdateWithRetry(env.DB, dbStatements);
  }

  // Queue Perplexity messages atomically
  if (perplexityMessages.length > 0) {
    try {
      await env.ENRICHMENT_QUEUE.sendBatch(
        perplexityMessages.map(msg => ({ body: msg }))
      );
    } catch (queueError) {
      // Log but don't fail - cron job will pick up unenriched beers
      console.error('[cleanup] Fallback: Failed to queue Perplexity messages:', queueError);
    }
  }

  console.log(`[cleanup] Fallback processed ${messages.length} messages`, {
    source,
    abv_found: abvFoundCount,
    queued_for_perplexity: perplexityMessages.length,
  });
}

// ============================================================================
// Main Consumer Handler
// ============================================================================

/**
 * Handle a batch of cleanup queue messages with parallel AI processing.
 *
 * Flow:
 * 1. Reserve quota atomically (prevents race conditions)
 * 2. Process AI calls in parallel with p-limit (maintains N concurrent calls)
 * 3. Build batch operations from results
 * 4. Execute D1 batch update with retry
 * 5. Queue Perplexity messages atomically
 * 6. Ack/retry individual messages based on results
 *
 * @param batch - Queue message batch from Cloudflare
 * @param env - Worker environment bindings
 */
export async function handleCleanupBatch(
  batch: MessageBatch<CleanupMessage>,
  env: Env
): Promise<void> {
  // Read configuration from environment (with defaults)
  const dailyLimit = env.DAILY_CLEANUP_LIMIT
    ? parseInt(env.DAILY_CLEANUP_LIMIT, 10)
    : DEFAULT_DAILY_CLEANUP_LIMIT;
  const maxConcurrent = env.MAX_CLEANUP_CONCURRENCY
    ? parseInt(env.MAX_CLEANUP_CONCURRENCY, 10)
    : 10;

  console.log('[cleanup] Processing batch', {
    batch_size: batch.messages.length,
    daily_limit: dailyLimit,
    max_concurrent: maxConcurrent,
  });

  // ============================================================
  // Phase 1: Reserve quota atomically
  // ============================================================
  let reserved: number;
  let remaining: number;
  try {
    ({ reserved, remaining } = await reserveCleanupQuotaBatch(
      env.DB,
      batch.messages.length,
      dailyLimit
    ));
  } catch (error) {
    console.error('[cleanup] Quota reservation failed:', error);
    for (const msg of batch.messages) {
      msg.retry();
    }
    return;
  }

  console.log('[cleanup] Quota reservation', {
    requested: batch.messages.length,
    reserved,
    remaining,
  });

  // Split messages: those we can process vs those that exceed quota
  const toProcess = batch.messages.slice(0, reserved);
  const quotaExceeded = batch.messages.slice(reserved);

  // Handle quota-exceeded messages with fallback (no AI, just regex extraction)
  if (quotaExceeded.length > 0) {
    console.log(`[cleanup] ${quotaExceeded.length} messages exceeded quota, using fallback`);
    try {
      await handleFallbackBatch(env, quotaExceeded, 'fallback-quota-exceeded');
      for (const msg of quotaExceeded) {
        msg.ack();  // Ack after successful fallback processing
      }
    } catch (error) {
      console.error('[cleanup] Fallback batch failed:', error);
      for (const msg of quotaExceeded) {
        msg.retry();
      }
    }
  }

  // If no messages to process (all exceeded quota), we're done
  if (toProcess.length === 0) {
    console.log('[cleanup] No quota available for batch');
    return;
  }

  // ============================================================
  // Phase 2: Parallel AI calls with p-limit
  // ============================================================
  const aiResults = await processAIConcurrently(toProcess, env.AI, maxConcurrent);

  // ============================================================
  // Phase 3: Build batch operations from results
  // ============================================================
  const {
    dbStatements,
    perplexityMessages,
    ackMessages,
    retryMessages,
    metrics,
  } = buildBatchOperations(toProcess, aiResults, env);

  // ============================================================
  // Phase 4: Log metrics
  // ============================================================
  logBatchMetrics(metrics);

  // ============================================================
  // Phase 5: Execute batch D1 update with retry
  // ============================================================
  if (dbStatements.length > 0) {
    try {
      await batchUpdateWithRetry(env.DB, dbStatements);
    } catch (dbError) {
      console.error('[cleanup] Batch D1 update failed after retries:', dbError);
      // Retry ALL messages if DB fails after retries
      // This is acceptable because D1 failures are rare and quota double-consumption
      // is bounded to one batch worth (~25 calls)
      for (const msg of toProcess) {
        msg.retry();
      }
      return;
    }
  }

  // ============================================================
  // Phase 6: Queue Perplexity messages atomically
  // ============================================================
  if (perplexityMessages.length > 0) {
    try {
      await env.ENRICHMENT_QUEUE.sendBatch(
        perplexityMessages.map(msg => ({ body: msg }))
      );
      console.log(`[cleanup] Queued ${perplexityMessages.length} messages for Perplexity enrichment`);
    } catch (queueError) {
      // Log but don't fail - cron job will pick up unenriched beers later
      console.error('[cleanup] Failed to queue Perplexity messages:', queueError);
    }
  }

  // ============================================================
  // Phase 7: Ack/retry individual messages based on results
  // ============================================================
  for (const msg of ackMessages) {
    msg.ack();
  }
  for (const msg of retryMessages) {
    msg.retry();
  }

  console.log('[cleanup] Batch complete', {
    acked: ackMessages.length,
    retried: retryMessages.length,
    perplexity_queued: perplexityMessages.length,
  });
}
