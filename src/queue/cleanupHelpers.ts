/**
 * Helper functions for the cleanup queue consumer.
 *
 * @module queue/cleanupHelpers
 */

// ============================================================================
// D1 Batch Operations
// ============================================================================

/**
 * Execute D1 batch with retry and exponential backoff.
 *
 * Returns the per-statement D1Result[] so callers can inspect
 * `result.meta.changes` -- callers bind their UPDATE statements with
 * `WHERE id = ? AND description_hash = ?` for optimistic concurrency, and
 * a mismatch reports 0 changes rather than throwing, so this return value
 * is how a stale write is detected (see findStaleBeerIds in cleanup.ts).
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
): Promise<D1Result[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await db.batch(statements);
    } catch (error) {
      lastError = error;
      console.warn(`[cleanup] D1 batch attempt ${attempt} failed:`, error);
      if (attempt === maxRetries) throw error;
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
    }
  }
  // Unreachable: the loop above always returns or throws on the final
  // attempt. Satisfies the compiler without an unsafe cast.
  throw lastError instanceof Error ? lastError : new Error('batchUpdateWithRetry: exhausted retries');
}
