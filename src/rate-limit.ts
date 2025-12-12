/**
 * Rate limiting logic for API requests.
 *
 * Uses D1 database to track request counts per client per minute.
 * Implements a fixed window rate limit (requests bucketed into minute intervals)
 * with automatic cleanup.
 *
 * Note: Fixed window means a user could theoretically make `limit` requests
 * at 11:59:59 and another `limit` at 12:00:00. For stricter enforcement,
 * consider using Durable Objects for token bucket rate limiting.
 */

/**
 * Result of a rate limit check.
 */
export interface RateLimitResult {
  /** Whether the request is allowed (within rate limit) */
  allowed: boolean;
  /** Number of remaining requests in the current window */
  remaining: number;
  /** Timestamp (ms) when the rate limit window resets */
  resetAt: number;
}

/**
 * Check and update rate limit for a client.
 *
 * Uses an atomic upsert pattern to increment the request counter
 * and check if the limit has been exceeded. The rate limit is
 * enforced per minute bucket.
 *
 * Features:
 * - Atomic counter increment (no race conditions)
 * - Automatic cleanup of old rate limit records (1% sample)
 * - Graceful degradation on database errors (allows request)
 *
 * @param db - D1 database instance
 * @param clientIdentifier - Unique identifier for the client (IP or API key hash)
 * @param limitPerMinute - Maximum number of requests allowed per minute
 * @returns Rate limit check result with allowed status and metadata
 *
 * @example
 * ```typescript
 * const result = await checkRateLimit(env.DB, 'client-hash-123', 60);
 * if (!result.allowed) {
 *   return new Response('Rate limited', {
 *     status: 429,
 *     headers: {
 *       'X-RateLimit-Reset': String(Math.floor(result.resetAt / 1000)),
 *       'Retry-After': String(Math.ceil((result.resetAt - Date.now()) / 1000)),
 *     }
 *   });
 * }
 * ```
 */
export async function checkRateLimit(
  db: D1Database,
  clientIdentifier: string,
  limitPerMinute: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60000);
  const resetAt = (minuteBucket + 1) * 60000;

  try {
    // Atomic upsert - increment counter
    await db.prepare(`
      INSERT INTO rate_limits (client_identifier, minute_bucket, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(client_identifier, minute_bucket)
      DO UPDATE SET request_count = request_count + 1
    `).bind(clientIdentifier, minuteBucket).run();

    // Check new count
    const result = await db.prepare(
      'SELECT request_count FROM rate_limits WHERE client_identifier = ? AND minute_bucket = ?'
    ).bind(clientIdentifier, minuteBucket).first<{ request_count: number }>();

    const count = result?.request_count || 1;

    if (count > limitPerMinute) {
      return { allowed: false, remaining: 0, resetAt };
    }

    // Occasional cleanup (1% of requests)
    if (Math.random() < 0.01) {
      await db.prepare('DELETE FROM rate_limits WHERE minute_bucket < ?')
        .bind(minuteBucket - 60).run();
    }

    return { allowed: true, remaining: Math.max(0, limitPerMinute - count), resetAt };
  } catch (error) {
    // On error, allow request but log
    console.error('Rate limit check failed:', error);
    return { allowed: true, remaining: limitPerMinute, resetAt };
  }
}
