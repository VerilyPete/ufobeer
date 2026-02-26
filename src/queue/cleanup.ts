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

import type { Env, CleanupMessage, EnrichmentMessage } from '../types';
import pLimit from 'p-limit';
import { extractABV } from '../db/helpers';
import {
  MIN_CLEANUP_LENGTH_RATIO,
  MAX_CLEANUP_LENGTH_RATIO,
  ABV_CONFIDENCE_FROM_DESCRIPTION,
} from '../constants';
import {
  withTimeout,
  defaultCircuitBreaker,
  AI_TIMEOUT_MS,
  batchUpdateWithRetry,
  reserveCleanupQuotaBatch,
} from './cleanupHelpers';
import type { CircuitBreaker } from './circuitBreaker';

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
export type CleanupResult = {
  readonly cleaned: string;
  readonly usedOriginal: boolean;
  readonly extractedABV: number | null;
};

/**
 * Metrics for a batch of cleanup operations.
 * Used for observability and alerting.
 */
type BatchMetrics = {
  readonly totalMessages: number;
  readonly aiSuccessCount: number;
  readonly aiFailureCount: number;
  readonly abvExtractedCount: number;
  readonly fallbackUsedCount: number;
  readonly avgLatencyMs: number;
  readonly circuitBreakerTriggered: boolean;
};

/**
 * Operations collected from batch processing.
 * Includes D1 statements, queue messages, and message disposition.
 */
type BatchOperations = {
  readonly dbStatements: readonly D1PreparedStatement[];
  readonly perplexityMessages: readonly EnrichmentMessage[];
  readonly ackMessages: readonly Message<CleanupMessage>[];
  readonly retryMessages: readonly Message<CleanupMessage>[];
  readonly metrics: BatchMetrics;
};

/**
 * Result from processAIConcurrently for each message.
 * Three-way discriminated union: narrow on `success`, then `useFallback`.
 */
export type AIResultSuccess = {
  readonly index: number;
  readonly success: true;
  readonly cleaned: string;
  readonly usedOriginal: boolean;
  readonly extractedABV: number | null;
  readonly latencyMs: number;
};

export type AIResultFallback = {
  readonly index: number;
  readonly success: false;
  readonly useFallback: true;
  readonly error: string;
  readonly latencyMs?: number | undefined;
};

export type AIResultFailure = {
  readonly index: number;
  readonly success: false;
  readonly useFallback?: false | undefined;
  readonly error: string;
  readonly latencyMs?: number | undefined;
};

export type AIResult = AIResultSuccess | AIResultFallback | AIResultFailure;

/**
 * Categorized result from AI processing.
 * Pure function output used by buildBatchOperations.
 */
export type CategorizedResult =
  | {
      readonly type: 'success_with_abv';
      readonly cleaned: string;
      readonly usedOriginal: boolean;
      readonly abv: number;
      readonly beerId: string;
      readonly message: Message<CleanupMessage>;
      readonly latencyMs: number;
    }
  | {
      readonly type: 'success_no_abv';
      readonly cleaned: string;
      readonly usedOriginal: boolean;
      readonly beerId: string;
      readonly beerName: string;
      readonly brewer: string;
      readonly message: Message<CleanupMessage>;
      readonly latencyMs: number;
    }
  | {
      readonly type: 'fallback_with_abv';
      readonly abv: number;
      readonly brewDescription: string;
      readonly beerId: string;
      readonly message: Message<CleanupMessage>;
      readonly latencyMs?: number | undefined;
    }
  | {
      readonly type: 'fallback_no_abv';
      readonly brewDescription: string;
      readonly beerId: string;
      readonly beerName: string;
      readonly brewer: string;
      readonly message: Message<CleanupMessage>;
      readonly latencyMs?: number | undefined;
    }
  | {
      readonly type: 'failure';
      readonly message: Message<CleanupMessage>;
      readonly latencyMs?: number | undefined;
    };

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
  if (lengthRatio < MIN_CLEANUP_LENGTH_RATIO || lengthRatio > MAX_CLEANUP_LENGTH_RATIO) {
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
  messages: readonly Message<CleanupMessage>[],
  ai: Ai,
  maxConcurrent: number,
  options: {
    cleanFn?: (description: string, ai: Ai) => Promise<CleanupResult>;
    timeoutMs?: number;
    breaker?: CircuitBreaker;
  } = {}
): Promise<AIResult[]> {
  const cleanFn = options.cleanFn ?? cleanDescriptionSafely;
  const timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
  const breaker = options.breaker ?? defaultCircuitBreaker;
  // Handle empty message array
  if (messages.length === 0) {
    return [];
  }

  const limit = pLimit(maxConcurrent);
  const totalMessages = messages.length;

  const promises = messages.map((msg, index) =>
    limit(async (): Promise<AIResult> => {
      // Check circuit breaker before making AI call (includes half-open logic)
      if (breaker.isOpen()) {
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
        breaker.recordLatency(latencyMs, index, totalMessages, beerId, maxConcurrent);

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
        breaker.recordLatency(latencyMs, index, totalMessages, beerId, maxConcurrent);

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
// Categorization (Pure Function)
// ============================================================================

/**
 * Categorize a single AI result into a discriminated union.
 *
 * Pure function: no side effects, no database access.
 * Extracts the decision logic from buildBatchOperations into a testable unit.
 */
export function categorizeAIResult(
  result: AIResult,
  message: Message<CleanupMessage>,
): CategorizedResult {
  const { beerId, beerName, brewer, brewDescription } = message.body;

  if (!result.success) {
    if (result.useFallback) {
      const abv = extractABV(brewDescription);
      if (abv !== null) {
        return {
          type: 'fallback_with_abv',
          abv,
          brewDescription,
          beerId,
          message,
          latencyMs: result.latencyMs,
        };
      }
      return {
        type: 'fallback_no_abv',
        brewDescription,
        beerId,
        beerName,
        brewer,
        message,
        latencyMs: result.latencyMs,
      };
    }
    return {
      type: 'failure',
      message,
      latencyMs: result.latencyMs,
    };
  }

  const { cleaned, usedOriginal, extractedABV: abv, latencyMs } = result;
  if (abv !== null) {
    return {
      type: 'success_with_abv',
      cleaned,
      usedOriginal,
      abv,
      beerId,
      message,
      latencyMs,
    };
  }
  return {
    type: 'success_no_abv',
    cleaned,
    usedOriginal,
    beerId,
    beerName,
    brewer,
    message,
    latencyMs,
  };
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
 * Uses categorizeAIResult for testable categorization logic,
 * then maps categories to D1 statements and queue messages.
 */
function buildBatchOperations(
  messages: readonly Message<CleanupMessage>[],
  aiResults: AIResult[],
  env: Env
): BatchOperations {
  const now = Date.now();

  const categorized = aiResults
    .map((result) => {
      const message = messages[result.index];
      if (!message) return null;
      return categorizeAIResult(result, message);
    })
    .filter((c): c is CategorizedResult => c !== null);

  const dbStatements: D1PreparedStatement[] = [];
  const perplexityMessages: EnrichmentMessage[] = [];
  const ackMessages: Message<CleanupMessage>[] = [];
  const retryMessages: Message<CleanupMessage>[] = [];

  let aiSuccessCount = 0;
  let aiFailureCount = 0;
  let abvExtractedCount = 0;
  let fallbackUsedCount = 0;
  let totalLatencyMs = 0;
  let latencyCount = 0;
  let circuitBreakerTriggered = false;

  for (const c of categorized) {
    if (c.latencyMs !== undefined) {
      totalLatencyMs += c.latencyMs;
      latencyCount++;
    }

    switch (c.type) {
      case 'success_with_abv':
        aiSuccessCount++;
        abvExtractedCount++;
        dbStatements.push(
          env.DB.prepare(`
            UPDATE enriched_beers SET
              brew_description_cleaned = ?,
              description_cleaned_at = ?,
              cleanup_source = ?,
              abv = ?,
              confidence = ${ABV_CONFIDENCE_FROM_DESCRIPTION},
              enrichment_source = 'description'
            WHERE id = ?
          `).bind(
            c.cleaned,
            now,
            c.usedOriginal ? null : 'workers-ai',
            c.abv,
            c.beerId
          )
        );
        ackMessages.push(c.message);
        break;

      case 'success_no_abv':
        aiSuccessCount++;
        dbStatements.push(
          env.DB.prepare(`
            UPDATE enriched_beers SET
              brew_description_cleaned = ?,
              description_cleaned_at = ?,
              cleanup_source = ?
            WHERE id = ?
          `).bind(
            c.cleaned,
            now,
            c.usedOriginal ? null : 'workers-ai',
            c.beerId
          )
        );
        perplexityMessages.push({ beerId: c.beerId, beerName: c.beerName, brewer: c.brewer });
        ackMessages.push(c.message);
        break;

      case 'fallback_with_abv':
        circuitBreakerTriggered = true;
        fallbackUsedCount++;
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
          `).bind(c.brewDescription, now, c.abv, c.beerId)
        );
        ackMessages.push(c.message);
        break;

      case 'fallback_no_abv':
        circuitBreakerTriggered = true;
        fallbackUsedCount++;
        dbStatements.push(
          env.DB.prepare(`
            UPDATE enriched_beers SET
              brew_description_cleaned = ?,
              description_cleaned_at = ?,
              cleanup_source = 'fallback-circuit-breaker'
            WHERE id = ?
          `).bind(c.brewDescription, now, c.beerId)
        );
        perplexityMessages.push({ beerId: c.beerId, beerName: c.beerName, brewer: c.brewer });
        ackMessages.push(c.message);
        break;

      case 'failure':
        aiFailureCount++;
        retryMessages.push(c.message);
        break;
    }
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
  messages: readonly Message<CleanupMessage>[],
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
// Extracted Phase Functions
// ============================================================================

/**
 * Result from quota reservation phase.
 */
type QuotaReservationResult = {
  /** Number of messages reserved for AI processing */
  readonly reserved: number;
  /** Remaining quota after reservation */
  readonly remaining: number;
  /** Messages that can be processed with AI */
  readonly toProcess: readonly Message<CleanupMessage>[];
  /** Messages that exceeded quota (need fallback) */
  readonly quotaExceeded: readonly Message<CleanupMessage>[];
};

/**
 * Phase 1: Reserve quota for batch processing.
 *
 * Atomically reserves quota slots to prevent race conditions between
 * concurrent queue consumers. Messages that exceed quota are returned
 * separately for fallback processing.
 *
 * @param db - D1 database instance
 * @param messages - Queue messages to process
 * @param dailyLimit - Maximum daily cleanup limit
 * @returns Quota reservation result with split message arrays
 * @throws Error if quota reservation fails (caller should retry all messages)
 */
async function reserveQuotaForBatch(
  db: D1Database,
  messages: readonly Message<CleanupMessage>[],
  dailyLimit: number
): Promise<QuotaReservationResult> {
  const { reserved, remaining } = await reserveCleanupQuotaBatch(
    db,
    messages.length,
    dailyLimit
  );

  console.log('[cleanup] Quota reservation', {
    requested: messages.length,
    reserved,
    remaining,
  });

  return {
    reserved,
    remaining,
    toProcess: messages.slice(0, reserved),
    quotaExceeded: messages.slice(reserved),
  };
}

/**
 * Phase 1b: Handle messages that exceeded quota with fallback processing.
 *
 * Processes quota-exceeded messages using regex-only ABV extraction
 * (no AI cleanup). Acknowledges messages on success, retries on failure.
 *
 * @param env - Worker environment bindings
 * @param quotaExceeded - Messages that exceeded quota
 */
async function handleQuotaExceededMessages(
  env: Env,
  quotaExceeded: readonly Message<CleanupMessage>[]
): Promise<void> {
  if (quotaExceeded.length === 0) return;

  console.log(`[cleanup] ${quotaExceeded.length} messages exceeded quota, using fallback`);
  try {
    await handleFallbackBatch(env, quotaExceeded, 'fallback-quota-exceeded');
    for (const msg of quotaExceeded) {
      msg.ack();
    }
  } catch (error) {
    console.error('[cleanup] Fallback batch failed:', error);
    for (const msg of quotaExceeded) {
      msg.retry();
    }
  }
}

/**
 * Phase 5: Execute D1 batch update with retry logic.
 *
 * Wraps batchUpdateWithRetry and handles failure by retrying all messages.
 * Returns true if batch succeeded, false if all messages should be retried.
 *
 * @param db - D1 database instance
 * @param statements - Prepared D1 statements to execute
 * @param messages - Original messages (for retry on failure)
 * @returns true if successful, false if messages should be retried
 */
async function executeDatabaseBatch(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
  messages: readonly Message<CleanupMessage>[]
): Promise<boolean> {
  if (statements.length === 0) return true;

  try {
    await batchUpdateWithRetry(db, [...statements]);
    return true;
  } catch (dbError) {
    console.error('[cleanup] Batch D1 update failed after retries:', dbError);
    // Retry ALL messages if DB fails after retries
    // This is acceptable because D1 failures are rare and quota double-consumption
    // is bounded to one batch worth (~25 calls)
    for (const msg of messages) {
      msg.retry();
    }
    return false;
  }
}

/**
 * Phase 6: Queue messages to Perplexity enrichment queue.
 *
 * Sends messages for beers without ABV to the Perplexity enrichment queue.
 * Logs errors but does not fail - cron job will pick up unenriched beers later.
 *
 * @param queue - Enrichment queue binding
 * @param perplexityMessages - Messages to queue for Perplexity
 */
async function queueForPerplexityEnrichment(
  queue: Queue<EnrichmentMessage>,
  perplexityMessages: readonly EnrichmentMessage[]
): Promise<void> {
  if (perplexityMessages.length === 0) return;

  try {
    await queue.sendBatch(
      perplexityMessages.map(msg => ({ body: msg }))
    );
    console.log(`[cleanup] Queued ${perplexityMessages.length} messages for Perplexity enrichment`);
  } catch (queueError) {
    // Log but don't fail - cron job will pick up unenriched beers later
    console.error('[cleanup] Failed to queue Perplexity messages:', queueError);
  }
}

/**
 * Phase 7: Acknowledge or retry messages based on processing results.
 *
 * @param ackMessages - Messages to acknowledge (successfully processed)
 * @param retryMessages - Messages to retry (failed processing)
 */
function acknowledgeMessages(
  ackMessages: readonly Message<CleanupMessage>[],
  retryMessages: readonly Message<CleanupMessage>[]
): void {
  for (const msg of ackMessages) {
    msg.ack();
  }
  for (const msg of retryMessages) {
    msg.retry();
  }

  console.log('[cleanup] Batch complete', {
    acked: ackMessages.length,
    retried: retryMessages.length,
  });
}

// ============================================================================
// Main Consumer Handler
// ============================================================================

/**
 * Handle a batch of cleanup queue messages with parallel AI processing.
 *
 * Orchestrates the cleanup pipeline through these phases:
 * 1. Reserve quota atomically (prevents race conditions)
 * 2. Handle quota-exceeded messages with fallback
 * 3. Process AI calls in parallel with p-limit
 * 4. Build batch operations from AI results
 * 5. Log metrics for observability
 * 6. Execute D1 batch update with retry
 * 7. Queue messages for Perplexity enrichment
 * 8. Acknowledge/retry messages based on results
 *
 * Each phase is extracted into a focused function for testability and clarity.
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
  let quotaResult: QuotaReservationResult;
  try {
    quotaResult = await reserveQuotaForBatch(env.DB, batch.messages, dailyLimit);
  } catch (error) {
    console.error('[cleanup] Quota reservation failed:', error);
    for (const msg of batch.messages) {
      msg.retry();
    }
    return;
  }

  // ============================================================
  // Phase 1b: Handle quota-exceeded messages with fallback
  // ============================================================
  await handleQuotaExceededMessages(env, quotaResult.quotaExceeded);

  // If no messages to process (all exceeded quota), we're done
  if (quotaResult.toProcess.length === 0) {
    console.log('[cleanup] No quota available for batch');
    return;
  }

  // ============================================================
  // Phase 2: Parallel AI calls with p-limit
  // ============================================================
  const aiResults = await processAIConcurrently(
    quotaResult.toProcess,
    env.AI,
    maxConcurrent
  );

  // ============================================================
  // Phase 3: Build batch operations from results
  // ============================================================
  const operations = buildBatchOperations(quotaResult.toProcess, aiResults, env);

  // ============================================================
  // Phase 4: Log metrics
  // ============================================================
  logBatchMetrics(operations.metrics);

  // ============================================================
  // Phase 5: Execute batch D1 update with retry
  // ============================================================
  const dbSuccess = await executeDatabaseBatch(
    env.DB,
    operations.dbStatements,
    quotaResult.toProcess
  );
  if (!dbSuccess) {
    return; // Messages already retried in executeDatabaseBatch
  }

  // ============================================================
  // Phase 6: Queue Perplexity messages
  // ============================================================
  await queueForPerplexityEnrichment(env.ENRICHMENT_QUEUE, operations.perplexityMessages);

  // ============================================================
  // Phase 7: Ack/retry individual messages based on results
  // ============================================================
  acknowledgeMessages(operations.ackMessages, operations.retryMessages);
}
