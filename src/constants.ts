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
