/**
 * Application-wide constants.
 *
 * This file contains named constants for magic numbers used throughout
 * the codebase. Each constant includes documentation explaining its purpose.
 */

// =============================================================================
// AI Cleanup Constants
// =============================================================================

/**
 * Minimum ratio of cleaned description length to original.
 * Prevents AI from over-summarizing descriptions.
 * Example: If original is 100 chars, cleaned must be at least 70 chars.
 */
export const MIN_CLEANUP_LENGTH_RATIO = 0.7;

/**
 * Maximum ratio of cleaned description length to original.
 * Prevents AI from adding excessive content.
 * Example: If original is 100 chars, cleaned can be at most 110 chars.
 */
export const MAX_CLEANUP_LENGTH_RATIO = 1.1;

/**
 * Confidence values indicate ABV source, not quality.
 * - 0.9 = ABV extracted from beer description parsing
 * - 0.7 = ABV from Perplexity API fallback
 *
 * These values are used to track provenance, not as acceptance thresholds.
 */
export const ABV_CONFIDENCE_FROM_DESCRIPTION = 0.9;
export const ABV_CONFIDENCE_FROM_PERPLEXITY = 0.7;
/**
 * 0.8 = ABV extracted from the original description when the AI cleanup path
 * was unavailable (quota exceeded / circuit breaker open). Same extraction
 * method as 0.9 but recorded via the fallback path.
 */
export const ABV_CONFIDENCE_FROM_DESCRIPTION_FALLBACK = 0.8;

// =============================================================================
// Outbound Fetch Timeouts
// =============================================================================

/**
 * Timeout for Flying Saucer taplist fetches.
 * A hung upstream would otherwise pin the client request (or, in the cron,
 * stall the sequential per-store refresh). On timeout the existing error
 * paths take over: stale-cache fallback for GET /beers, skip for cron.
 * Tradeoff: a slow-but-alive upstream on a cold cache now yields a 502
 * instead of an unbounded wait.
 */
export const UPSTREAM_TAPLIST_TIMEOUT_MS = 10_000;

/**
 * Timeout for Perplexity chat-completion calls (sonar with web search can
 * legitimately take tens of seconds). Unlike env.AI.run, plain fetch supports
 * AbortSignal. A TimeoutError does not contain '429', so the consumer's rate-
 * limit branch is unaffected and the message takes the default retry path.
 */
export const PERPLEXITY_TIMEOUT_MS = 30_000;

// =============================================================================
// ABV Validation Constants
// =============================================================================

/**
 * Maximum plausible beer ABV for validation.
 * The strongest beers (like Snake Venom) are around 67.5%.
 * Values above this are likely parsing errors.
 */
export const MAX_BEER_ABV = 70;

/**
 * Minimum valid ABV for beer.
 * Non-alcoholic beers can have trace amounts, so we allow 0.
 */
export const MIN_BEER_ABV = 0;

// =============================================================================
// Audit & Cleanup Constants
// =============================================================================

/**
 * Probability of triggering audit log cleanup per request.
 * Set to 0.1% (1 in 1000 requests) to spread cleanup load.
 */
export const AUDIT_CLEANUP_PROBABILITY = 0.001;

/**
 * How long to keep audit log entries (in days).
 */
export const AUDIT_RETENTION_DAYS = 30;

// =============================================================================
// D1 Batching Constants
// =============================================================================

/**
 * Maximum parameters per D1 prepared statement.
 * D1 has a limit of 100, we use 90 for safety margin.
 */
export const D1_MAX_PARAMS_PER_STATEMENT = 90;

/**
 * Maximum statements per D1 batch() call.
 */
export const D1_MAX_STATEMENTS_PER_BATCH = 100;

// =============================================================================
// Cache Constants
// =============================================================================

/**
 * Time-to-live for store taplist cache entries.
 * Cached responses are served for this duration before triggering a fresh
 * upstream fetch. Pull-to-refresh bypasses this via fresh=true.
 */
export const CACHE_TTL_MS = 300_000; // 5 minutes

// =============================================================================
// Cron Schedule Constants
// =============================================================================

/**
 * Base interval between enrichment cron runs (2 hours).
 */
export const CRON_INTERVAL_MS = 2 * 60 * 60 * 1000;

/**
 * Maximum jitter applied to cron interval (±20 minutes).
 * Actual next-run = now + CRON_INTERVAL_MS + random(-CRON_JITTER_MS, +CRON_JITTER_MS)
 */
export const CRON_JITTER_MS = 20 * 60 * 1000;

/**
 * system_state key for storing the next scheduled cron run time.
 */
export const CRON_SCHEDULE_KEY = 'next_enrichment_cron_at';

/**
 * Operating hours for cron enrichment (Central Time).
 * Cron skips execution outside these hours since the bar is closed
 * and taplist data won't change.
 */
export const CRON_OPERATING_HOUR_START = 12; // noon CT
export const CRON_OPERATING_HOUR_END = 23;   // 11pm CT (last poll ~10:40pm)
