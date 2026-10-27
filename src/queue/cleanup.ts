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
import { shouldSkipEnrichment } from '../config';
import {
  ABV_CONFIDENCE_FROM_DESCRIPTION,
  ABV_CONFIDENCE_FROM_DESCRIPTION_FALLBACK,
  MAX_PROMPT_DESCRIPTION_LENGTH,
  MAX_CLEANED_OUTPUT_LENGTH,
} from '../constants';
import {
  withTimeout,
  defaultCircuitBreaker,
  AI_TIMEOUT_MS,
  batchUpdateWithRetry,
  reserveCleanupQuotaBatch,
} from './cleanupHelpers';
import type { CircuitBreaker } from './circuitBreaker';
import { applyCleanupFixes, checkCleanup } from './cleanupGuard';
import { log } from '../utils/log';

// ============================================================================
// Constants
// ============================================================================

/** Default daily cleanup limit - can be overridden via env.DAILY_CLEANUP_LIMIT */
const DEFAULT_DAILY_CLEANUP_LIMIT = 1000;

// ============================================================================
// Prompt injection / output validation constants
// ============================================================================
// MAX_PROMPT_DESCRIPTION_LENGTH and MAX_CLEANED_OUTPUT_LENGTH now live in
// src/constants.ts (imported above) as part of the constants consolidation.

/** C0 control characters and DEL, excluding \t \n \r which are legitimate
 * in free-form beer descriptions. */
// Built from numeric char codes (rather than a regex literal with hex
// escapes) to keep this file's raw bytes unambiguous: C0 controls
// (0x00-0x1F) minus tab/newline/carriage-return (legitimate in
// free-form descriptions), plus DEL (0x7F).
const CONTROL_CHAR_CODES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 127];
const CONTROL_CHAR_PATTERN = new RegExp('[' + CONTROL_CHAR_CODES.map((c) => String.fromCharCode(c)).join('') + ']');

/**
 * Sanitize raw description text for the fallback ("use original") path:
 * strip HTML tags and control characters, and bound length. Every
 * `usedOriginal: true` return from `cleanDescriptionSafely` -- and the
 * circuit-breaker/quota-exceeded fallback paths that never call it at all
 * -- persist this value as `brew_description_cleaned` and it is served
 * directly to clients (`handlers/beers.ts`'s
 * `enrichment?.brew_description_cleaned ?? beer.brew_description`).
 * Without this, an AI failure serves the raw unsanitized source, HTML
 * included, as the "cleaned" value.
 */
function sanitizeFallbackDescription(text: string): string {
  // Decode source formatting before stripping tags so encoded markup cannot
  // bypass sanitization. Unknown entities/escapes remain literal.
  const entities: Record<string, string> = {
    amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>',
    rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—',
  };
  const decoded = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return entities[name.toLowerCase()] ?? entity;
    const hex = name[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : entity;
  });
  return decoded
    .replace(/\\r\\n|\\[rnt]/g, ' ')
    .replace(/\\(['"])/g, '$1')
    .replace(/<\/?(?:p|div|br)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .replace(new RegExp(CONTROL_CHAR_PATTERN, 'g'), '')
    .trim()
    .slice(0, MAX_CLEANED_OUTPUT_LENGTH);
}

// ============================================================================
// Types
// ============================================================================

/**
 * Result from cleanDescriptionSafely containing the cleaned description,
 * whether the original was used, and the extracted ABV to avoid redundant
 * regex execution in the hot path.
 */
/**
 * Identifies the beer being cleaned: its ID for audit logging, and its name
 * and brewer, which the guard never lets the model alter.
 */
export type CleanupContext = {
  readonly beerId: string;
  readonly protectedTerms: readonly string[];
};

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
 * A single UPDATE statement paired with the beer ID it targets, so a
 * stale-write result (0 rows changed -- see findStaleBeerIds) can be
 * traced back to the message it came from after db.batch() resolves.
 */
type DbOperation = {
  readonly statement: D1PreparedStatement;
  readonly beerId: string;
};

/**
 * Operations collected from batch processing.
 * Includes D1 statements, queue messages, and message disposition.
 */
type BatchOperations = {
  readonly dbOperations: readonly DbOperation[];
  readonly perplexityMessages: readonly EnrichmentMessage[];
  readonly ackMessages: readonly Message<CleanupMessage>[];
  readonly retryMessages: readonly Message<CleanupMessage>[];
  readonly metrics: BatchMetrics;
};

/**
 * Determine which beer IDs' UPDATE did not actually change a row, from the
 * D1Result[] db.batch() resolves with and the beerId each statement
 * targeted (same order). This is the stale-result signal: every write in
 * this module is bound with `WHERE id = ? AND description_hash = ?`, so a
 * mismatch (the row's authoritative description changed after this
 * message was produced) reports 0 changes instead of throwing.
 *
 * A result with no reported `meta.changes` (e.g. a simplified test double
 * that resolves `db.batch()` with `[]`) is treated as a successful write,
 * not stale -- real D1 always reports per-statement changes, so this only
 * affects test doubles that don't model per-statement results.
 */
function findStaleBeerIds(
  operations: readonly DbOperation[],
  results: readonly D1Result[]
): ReadonlySet<string> {
  const stale = new Set<string>();
  operations.forEach((op, i) => {
    if (results[i]?.meta?.changes === 0) {
      stale.add(op.beerId);
    }
  });
  return stale;
}

/** Log a stale-write warning in a consistent shape across call sites. */
function logStaleWrite(beerId: string, reason: string): void {
  console.warn(JSON.stringify({
    event: 'cleanup.stale_result',
    beerId,
    reason,
  }));
}

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

// ============================================================================
// Cleanup Function with Validation
// ============================================================================

/**
 * Clean a description deterministically: sanitize it, then apply every fix
 * the cleanup guard permits (applyCleanupFixes: reviewed spelling pairs, a
 * missing space after a comma or between a percentage and ABV, a missing
 * final full stop). No model is called. An evaluation of Llama 3.2 3B and
 * Haiku 5.5 found every edit either could safely persist was one of these,
 * while both also editorialized (plans/pr44-review-fixes.md, step 6).
 */
async function cleanDescriptionSafely(
  original: string,
  _ai: Ai,
  context: CleanupContext
): Promise<CleanupResult> {
  // Bounded regardless of source: request-schema bounds on brew_description
  // are a client-facing concern and do not constrain descriptions that
  // originate from Flying Saucer.
  const source = sanitizeFallbackDescription(original.slice(0, MAX_PROMPT_DESCRIPTION_LENGTH));
  const cleaned = applyCleanupFixes({ source, protectedTerms: context.protectedTerms });
  const verdict = checkCleanup({
    source,
    output: cleaned,
    protectedTerms: context.protectedTerms,
    maxEdits: Number.POSITIVE_INFINITY,
  });
  if (verdict.ok && verdict.edits.length > 0) {
    log('cleanup.fixes.applied', { beerId: context.beerId, edits: verdict.edits });
  }
  return { cleaned, usedOriginal: false, extractedABV: extractABV(source) };
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
    cleanFn?: (description: string, ai: Ai, context: CleanupContext) => Promise<CleanupResult>;
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
          cleanFn(msg.body.brewDescription, ai, {
            beerId,
            protectedTerms: [msg.body.beerName, msg.body.brewer],
          }),
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

  const dbOperations: DbOperation[] = [];
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
        if (c.usedOriginal) {
          aiFailureCount++;
          fallbackUsedCount++;
        } else {
          aiSuccessCount++;
        }
        abvExtractedCount++;
        dbOperations.push({
          beerId: c.beerId,
          statement: env.DB.prepare(`
            UPDATE enriched_beers SET
              brew_description_cleaned = ?,
              description_cleaned_at = ?,
              cleanup_source = ?,
              abv = ?,
              confidence = ${ABV_CONFIDENCE_FROM_DESCRIPTION},
              enrichment_source = 'description',
              enrichment_status = 'enriched'
            WHERE id = ? AND description_hash = ?
          `).bind(
            c.cleaned,
            now,
            c.usedOriginal ? 'fallback-ai' : 'deterministic',
            c.abv,
            c.beerId,
            c.message.body.descriptionHash ?? null
          ),
        });
        ackMessages.push(c.message);
        break;

      case 'success_no_abv':
        if (c.usedOriginal) {
          aiFailureCount++;
          fallbackUsedCount++;
        } else {
          aiSuccessCount++;
        }
        dbOperations.push({
          beerId: c.beerId,
          statement: env.DB.prepare(`
            UPDATE enriched_beers SET
              brew_description_cleaned = ?,
              description_cleaned_at = ?,
              cleanup_source = ?
            WHERE id = ? AND description_hash = ?
          `).bind(
            c.cleaned,
            now,
            c.usedOriginal ? 'fallback-ai' : 'deterministic',
            c.beerId,
            c.message.body.descriptionHash ?? null
          ),
        });
        if (!shouldSkipEnrichment(c.beerName)) {
          // The row's description_hash column is untouched by this UPDATE
          // (only cleanup fields are set above), so the CleanupMessage's
          // own descriptionHash -- which just matched the row for this
          // write to have succeeded -- is still the row's current hash.
          // Forwarding it gives the downstream Perplexity write the same
          // stale-result binding as cleanup.ts (Cloudflare security review
          // Phase 1, item 2a/5 parity).
          perplexityMessages.push({
            beerId: c.beerId,
            beerName: c.beerName,
            brewer: c.brewer,
            descriptionHash: c.message.body.descriptionHash ?? null,
          });
        }
        ackMessages.push(c.message);
        break;

      case 'fallback_with_abv':
        circuitBreakerTriggered = true;
        fallbackUsedCount++;
        abvExtractedCount++;
        dbOperations.push({
          beerId: c.beerId,
          statement: env.DB.prepare(`
            UPDATE enriched_beers SET
              brew_description_cleaned = ?,
              description_cleaned_at = ?,
              cleanup_source = 'fallback-circuit-breaker',
              abv = ?,
              confidence = ${ABV_CONFIDENCE_FROM_DESCRIPTION_FALLBACK},
              enrichment_source = 'description-fallback',
              enrichment_status = 'enriched'
            WHERE id = ? AND description_hash = ?
          `).bind(
            sanitizeFallbackDescription(c.brewDescription),
            now,
            c.abv,
            c.beerId,
            c.message.body.descriptionHash ?? null
          ),
        });
        ackMessages.push(c.message);
        break;

      case 'fallback_no_abv':
        circuitBreakerTriggered = true;
        fallbackUsedCount++;
        dbOperations.push({
          beerId: c.beerId,
          statement: env.DB.prepare(`
            UPDATE enriched_beers SET
              brew_description_cleaned = ?,
              description_cleaned_at = ?,
              cleanup_source = 'fallback-circuit-breaker'
            WHERE id = ? AND description_hash = ?
          `).bind(
            sanitizeFallbackDescription(c.brewDescription),
            now,
            c.beerId,
            c.message.body.descriptionHash ?? null
          ),
        });
        if (!shouldSkipEnrichment(c.beerName)) {
          perplexityMessages.push({
            beerId: c.beerId,
            beerName: c.beerName,
            brewer: c.brewer,
            descriptionHash: c.message.body.descriptionHash ?? null,
          });
        }
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
    dbOperations,
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
 * - fallback_used: Rejected/failed AI and circuit breaker fallback count
 * - avg_latency_ms: Average AI call latency
 * - circuit_breaker: Whether circuit breaker was triggered
 * - abv_rate: Percentage of batch messages with extracted ABV
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
    abv_rate: metrics.totalMessages > 0
      ? Math.round((metrics.abvExtractedCount / metrics.totalMessages) * 100)
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
  const dbOperations: DbOperation[] = [];
  const perplexityCandidates: EnrichmentMessage[] = [];

  let abvFoundCount = 0;

  for (const message of messages) {
    const { beerId, beerName, brewer, brewDescription, descriptionHash } = message.body;
    // Sanitize before persisting -- this path never calls Workers AI, so
    // without this the raw unsanitized description (HTML included)
    // becomes the served "cleaned" value. ABV is extracted from the raw
    // source, not the sanitized value: sanitization only strips
    // HTML/control chars and never touches ABV-relevant characters.
    const sanitizedDescription = sanitizeFallbackDescription(brewDescription);
    const abv = extractABV(brewDescription);

    if (abv !== null) {
      // Found ABV in original description
      abvFoundCount++;
      dbOperations.push({
        beerId,
        statement: env.DB.prepare(`
          UPDATE enriched_beers SET
            brew_description_cleaned = ?,
            description_cleaned_at = ?,
            cleanup_source = ?,
            abv = ?,
            confidence = ${ABV_CONFIDENCE_FROM_DESCRIPTION_FALLBACK},
            enrichment_source = 'description-fallback'
          WHERE id = ? AND description_hash = ?
        `).bind(sanitizedDescription, now, source, abv, beerId, descriptionHash ?? null),
      });
    } else {
      // No ABV found - store original and queue for Perplexity enrichment (if not blocklisted)
      dbOperations.push({
        beerId,
        statement: env.DB.prepare(`
          UPDATE enriched_beers SET
            brew_description_cleaned = ?,
            description_cleaned_at = ?,
            cleanup_source = ?
          WHERE id = ? AND description_hash = ?
        `).bind(sanitizedDescription, now, source, beerId, descriptionHash ?? null),
      });
      if (!shouldSkipEnrichment(beerName)) {
        perplexityCandidates.push({
          beerId,
          beerName,
          brewer,
          descriptionHash: descriptionHash ?? null,
        });
      }
    }
  }

  // Execute D1 updates with retry, then determine which writes actually
  // landed. A stale (hash-mismatched, or missing-hash) message must not
  // enqueue Perplexity work derived from data that was never persisted.
  let staleBeerIds: ReadonlySet<string> = new Set();
  if (dbOperations.length > 0) {
    const results = await batchUpdateWithRetry(env.DB, dbOperations.map(op => op.statement));
    staleBeerIds = findStaleBeerIds(dbOperations, results);
    for (const beerId of staleBeerIds) {
      logStaleWrite(beerId, 'fallback batch: description_hash mismatch or missing');
    }
  }

  const perplexityMessages = perplexityCandidates.filter(msg => !staleBeerIds.has(msg.beerId));

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

/** Result of the D1 batch execution phase. */
type DatabaseBatchResult =
  | { readonly success: true; readonly staleBeerIds: ReadonlySet<string> }
  | { readonly success: false };

/**
 * Phase 5: Execute D1 batch update with retry logic.
 *
 * Wraps batchUpdateWithRetry, handles failure by retrying all messages, and
 * -- on success -- reports which beer IDs had a stale write (0 rows
 * changed, from the `WHERE id = ? AND description_hash = ?` optimistic
 * concurrency check on every UPDATE this module issues) so the caller can
 * skip deriving further work (e.g. Perplexity enqueue) from data that was
 * never actually persisted.
 *
 * @param db - D1 database instance
 * @param operations - Prepared D1 statements paired with their beer IDs
 * @param messages - Original messages (for retry on total batch failure)
 */
async function executeDatabaseBatch(
  db: D1Database,
  operations: readonly DbOperation[],
  messages: readonly Message<CleanupMessage>[]
): Promise<DatabaseBatchResult> {
  if (operations.length === 0) return { success: true, staleBeerIds: new Set() };

  try {
    const results = await batchUpdateWithRetry(db, operations.map(op => op.statement));
    const staleBeerIds = findStaleBeerIds(operations, results);
    for (const beerId of staleBeerIds) {
      logStaleWrite(beerId, 'main batch: description_hash mismatch or missing');
    }
    return { success: true, staleBeerIds };
  } catch (dbError) {
    console.error('[cleanup] Batch D1 update failed after retries:', dbError);
    // Retry ALL messages if DB fails after retries
    // This is acceptable because D1 failures are rare and quota double-consumption
    // is bounded to one batch worth (~25 calls)
    for (const msg of messages) {
      msg.retry();
    }
    return { success: false };
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
  // Phase 0: Drop messages with no descriptionHash
  // ============================================================
  // Only possible for messages already in flight (enqueued before the
  // deploy that added CleanupMessage.descriptionHash) -- every UPDATE this
  // consumer issues binds `AND description_hash = ?`, and a message with
  // no hash to bind can never be distinguished from a genuinely stale one,
  // so it is treated the same way: acknowledged without writing. This is a
  // one-time drop of whatever was queued at deploy time, not an ongoing
  // condition.
  const messagesWithHash: Message<CleanupMessage>[] = [];
  for (const msg of batch.messages) {
    if (msg.body.descriptionHash) {
      messagesWithHash.push(msg);
    } else {
      logStaleWrite(msg.body.beerId, 'no descriptionHash on message (pre-deploy in-flight message)');
      msg.ack();
    }
  }
  if (messagesWithHash.length === 0) {
    console.log('[cleanup] All messages in batch had no descriptionHash; acked without processing');
    return;
  }

  // ============================================================
  // Phase 1: Reserve quota atomically
  // ============================================================
  let quotaResult: QuotaReservationResult;
  try {
    quotaResult = await reserveQuotaForBatch(env.DB, messagesWithHash, dailyLimit);
  } catch (error) {
    console.error('[cleanup] Quota reservation failed:', error);
    for (const msg of messagesWithHash) {
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
  const dbResult = await executeDatabaseBatch(
    env.DB,
    operations.dbOperations,
    quotaResult.toProcess
  );
  if (!dbResult.success) {
    return; // Messages already retried in executeDatabaseBatch
  }

  // ============================================================
  // Phase 6: Queue Perplexity messages
  // ============================================================
  // Exclude beers whose write was stale (0 rows changed) -- enqueuing
  // Perplexity work derived from data that was never persisted would
  // reintroduce the same stale-result problem one step downstream.
  const perplexityMessages = operations.perplexityMessages.filter(
    msg => !dbResult.staleBeerIds.has(msg.beerId)
  );
  await queueForPerplexityEnrichment(env.ENRICHMENT_QUEUE, perplexityMessages);

  // ============================================================
  // Phase 7: Ack/retry individual messages based on results
  // ============================================================
  acknowledgeMessages(operations.ackMessages, operations.retryMessages);
}
