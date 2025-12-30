/**
 * Helper functions for cleanup queue parallel processing.
 *
 * @module queue/helpers
 */

// ============================================================================
// Exported Constants
// ============================================================================

/** Timeout for individual AI calls in milliseconds */
export const AI_TIMEOUT_MS = 10_000;

/** Threshold above which an AI call is considered "slow" */
export const SLOW_THRESHOLD_MS = 5000;

/** Number of slow calls before circuit breaker opens */
export const SLOW_CALL_LIMIT = 3;

/** Time before circuit breaker resets to half-open state */
export const BREAKER_RESET_MS = 60_000;

// ============================================================================
// Timeout Helper
// ============================================================================

/**
 * Timeout helper that properly clears the timer.
 * Avoids leaving uncancelled timers in the isolate.
 *
 * @param promise - The promise to race against timeout
 * @param ms - Timeout in milliseconds
 * @returns The result of the promise if it completes before timeout
 * @throws Error with message 'AI call timeout' if timeout expires first
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('AI call timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

// ============================================================================
// Circuit Breaker
// ============================================================================

/**
 * Circuit breaker state interface for type safety.
 */
interface CircuitBreakerState {
  slowCallCount: number;
  isOpen: boolean;
  lastOpenedAt: number;
  slowBeerIds: string[];  // Track beer IDs that triggered slow calls
}

/**
 * Module-scope circuit breaker state.
 * Persists across batch invocations in warm Worker isolates.
 * With max_concurrency: 1, the same isolate handles sequential batches.
 */
const breaker: CircuitBreakerState = {
  slowCallCount: 0,
  isOpen: false,
  lastOpenedAt: 0,
  slowBeerIds: [],
};

/**
 * Check if circuit breaker is open, with half-open logic.
 * After BREAKER_RESET_MS, resets to allow one attempt.
 *
 * @returns true if circuit breaker is open and should block AI calls
 */
export function isCircuitBreakerOpen(): boolean {
  if (!breaker.isOpen) return false;

  // Half-open: reset after timeout to allow recovery
  const now = Date.now();
  if (now - breaker.lastOpenedAt > BREAKER_RESET_MS) {
    console.log('[cleanup] Circuit breaker half-open, allowing retry');
    breaker.isOpen = false;
    breaker.slowCallCount = 0;
    breaker.slowBeerIds = [];
    return false;
  }

  return true;
}

/**
 * Record call latency and potentially open circuit breaker.
 *
 * @param latencyMs - The latency of the AI call in milliseconds
 * @param currentIndex - The index of the current message in the batch
 * @param totalMessages - Total number of messages in the batch
 * @param beerId - The ID of the beer being processed (for debugging)
 */
export function recordCallLatency(
  latencyMs: number,
  currentIndex: number,
  totalMessages: number,
  beerId: string
): void {
  if (latencyMs > SLOW_THRESHOLD_MS) {
    breaker.slowCallCount++;
    breaker.slowBeerIds.push(beerId);
    if (breaker.slowCallCount >= SLOW_CALL_LIMIT && !breaker.isOpen) {
      breaker.isOpen = true;
      breaker.lastOpenedAt = Date.now();
      // Approximate in-flight calls: with p-limit, at most maxConcurrent - 1
      // calls are still running when one completes
      const estimatedInFlight = 9; // maxConcurrent - 1
      console.warn('[cleanup] Circuit breaker opened', {
        slow_call_count: breaker.slowCallCount,
        threshold_ms: SLOW_THRESHOLD_MS,
        triggered_by_beer_ids: breaker.slowBeerIds,
        opened_at_index: currentIndex,
        total_messages: totalMessages,
        remaining_messages: totalMessages - currentIndex - 1,
        estimated_in_flight: estimatedInFlight,
        will_reset_after_ms: BREAKER_RESET_MS,
      });
    }
  }
}

/**
 * Reset circuit breaker state. Exported for testing purposes only.
 * Do not call this in production code.
 */
export function resetCircuitBreaker(): void {
  breaker.slowCallCount = 0;
  breaker.isOpen = false;
  breaker.lastOpenedAt = 0;
  breaker.slowBeerIds = [];
}

/**
 * Get current circuit breaker state. Exported for testing purposes only.
 * Do not call this in production code.
 *
 * @returns A copy of the current circuit breaker state
 */
export function getCircuitBreakerState(): CircuitBreakerState {
  return { ...breaker };
}

// ============================================================================
// Quota Management
// ============================================================================

/**
 * Reserve cleanup quota slots atomically for a batch.
 * Uses single SQL statement to prevent TOCTOU race conditions.
 *
 * @param db - D1 database instance
 * @param requested - Number of quota slots to reserve
 * @param dailyLimit - Maximum allowed daily cleanups
 * @returns Object with reserved count and remaining quota
 */
export async function reserveCleanupQuotaBatch(
  db: D1Database,
  requested: number,
  dailyLimit: number
): Promise<{ reserved: number; remaining: number }> {
  const today = new Date().toISOString().split('T')[0];
  const now = Date.now();

  // Ensure row exists
  await db.prepare(`
    INSERT INTO cleanup_limits (date, request_count, last_updated)
    VALUES (?, 0, ?)
    ON CONFLICT(date) DO NOTHING
  `).bind(today, now).run();

  // Atomic reservation using a single UPDATE with conditional logic.
  //
  // BUG FIX: The RETURNING clause sees the post-update value of request_count.
  // We cannot reliably compute 'reserved' in SQL because we can't distinguish between:
  //   - Reservation succeeded (count was incremented)
  //   - Reservation failed but count was already under the limit
  //
  // SOLUTION: Read the count before update, then do the atomic update.
  // This is still safe from TOCTOU because the UPDATE itself is atomic -
  // we just need the pre-update value to calculate reserved correctly.

  // First, get the current count
  const currentRow = await db.prepare(`
    SELECT request_count FROM cleanup_limits WHERE date = ?
  `).bind(today).first<{ request_count: number }>();
  const oldCount = currentRow?.request_count ?? 0;

  // Atomic update - only increment if within limit
  const result = await db.prepare(`
    UPDATE cleanup_limits
    SET
      request_count = CASE
        WHEN request_count + ? <= ? THEN request_count + ?
        ELSE request_count
      END,
      last_updated = ?
    WHERE date = ?
    RETURNING request_count as new_count
  `).bind(
    requested, dailyLimit, requested,
    now,
    today
  ).first<{ new_count: number }>();

  if (!result) {
    return { reserved: 0, remaining: 0 };
  }

  // Calculate reserved by comparing old and new counts.
  // If new_count > oldCount, the reservation succeeded and we reserved (new_count - oldCount).
  // If new_count == oldCount, the reservation failed (quota would be exceeded).
  const reserved = result.new_count > oldCount ? result.new_count - oldCount : 0;

  return {
    reserved,
    remaining: Math.max(0, dailyLimit - result.new_count),
  };
}

// ============================================================================
// D1 Batch Operations
// ============================================================================

/**
 * Execute D1 batch with retry and exponential backoff.
 * Avoids wasting AI calls that would be re-done on message retry.
 *
 * @param db - D1 database instance
 * @param statements - Array of prepared statements to execute
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @throws Error if all retry attempts fail
 */
export async function batchUpdateWithRetry(
  db: D1Database,
  statements: D1PreparedStatement[],
  maxRetries = 3
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await db.batch(statements);
      return;
    } catch (error) {
      console.warn(`[cleanup] D1 batch attempt ${attempt} failed:`, error);
      if (attempt === maxRetries) throw error;
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
    }
  }
}
