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

/**
 * Bounded Sonar completion budget. Live Yuzu seltzer comparisons on
 * 2026-09-12 returned HTTP 400 at 100 tokens and 5.0% successfully at
 * both 256 and 512, with all other request fields unchanged. Leave
 * headroom for harder lookups; the answer still must be one ABV value.
 */
export const PERPLEXITY_MAX_COMPLETION_TOKENS = 512;

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
 * How long to keep audit log entries (in days).
 */
export const AUDIT_RETENTION_DAYS = 30;

/**
 * Maximum audit_log rows deleted per reaper invocation. Bounded so a single
 * cron tick cannot blow the D1 time budget (mirrors RATE_LIMIT_REAP_LIMIT
 * below). Consolidated here from src/audit.ts as part of the Cloudflare
 * security review's constants cleanup (2026-09-01).
 */
export const AUDIT_REAP_LIMIT = 10_000;

/**
 * Maximum target identifiers recorded verbatim in an admin audit row's
 * details. Bounds row size for large batch operations (dlq replay/ack,
 * cleanup trigger); excess identifiers are dropped and `target_ids_truncated`
 * is set instead.
 */
export const ADMIN_AUDIT_MAX_TARGET_IDS = 100;

/**
 * Maximum rate_limits rows deleted per reaper invocation. Bounded so a
 * single cron tick cannot blow the D1 time budget (mirrors AUDIT_REAP_LIMIT
 * above). Consolidated here from src/rate-limit.ts as part of the
 * Cloudflare security review's constants cleanup (2026-09-01).
 */
export const RATE_LIMIT_REAP_LIMIT = 10_000;

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
// Inbound JSON Body Limits
// =============================================================================

/**
 * Maximum accepted request body size for POST /beers/sync, in bytes.
 *
 * Derived from a worst-case contract fixture (kept live as a test in
 * test/constants.test.ts, "SYNC_BODY_MAX_BYTES fixture"): 50 beers (the
 * SyncBeersRequestOuterSchema cap), each with a max-length id (50 chars),
 * brew_name (200 chars), brewer (200 chars), and brew_description (2000
 * chars) -- every field filled with a triple-byte UTF-8 character (a BMP
 * CJK code point, outside the surrogate-pair range) to hit the worst-case
 * per-UTF-16-code-unit byte expansion that Zod's `.max()` (which counts
 * UTF-16 code units, not bytes) cannot see. That fixture serializes to
 * 370,461 bytes. 512 KiB (524,288 bytes) leaves roughly 41% operational
 * headroom above the measured worst case.
 */
export const SYNC_BODY_MAX_BYTES = 512 * 1024;

/**
 * Maximum accepted request body size for the smaller body-bearing JSON
 * routes: POST /beers/batch (<= 100 ids, each <= 50 chars), POST
 * /admin/dlq/replay and /admin/dlq/acknowledge (<= 50 / <= 100 numeric D1
 * row IDs plus a handful of scalar fields), and the admin enrichment and
 * cleanup trigger bodies (a handful of scalar flags, no arrays of
 * caller-supplied strings).
 *
 * Derived the same way as SYNC_BODY_MAX_BYTES (fixture kept live in
 * test/constants.test.ts, "SMALL_JSON_BODY_MAX_BYTES fixture"): the worst
 * case among these routes is /beers/batch's 100 ids at the 50-character id
 * bound, using the same triple-byte CJK worst case, which serializes to
 * 15,309 bytes. 64 KiB (65,536 bytes) leaves more than 4x headroom.
 */
export const SMALL_JSON_BODY_MAX_BYTES = 64 * 1024;

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

// =============================================================================
// AI Cleanup Prompt / Output Bounds (Workers AI, src/queue/cleanup.ts)
// =============================================================================

/**
 * Hard cap on description length before it is assembled into the Workers AI
 * prompt. Applied regardless of source -- request-schema bounds on
 * brew_description are a client-facing concern (src/schemas/request.ts) and
 * do not constrain descriptions that originate from Flying Saucer. Generous
 * relative to real beer descriptions (a few hundred characters).
 */
export const MAX_PROMPT_DESCRIPTION_LENGTH = 3000;

/**
 * Absolute cap on cleaned output length, independent of
 * MIN_/MAX_CLEANUP_LENGTH_RATIO. The ratio check alone is not a barrier:
 * an attacker who controls `original` also controls the denominator, so
 * the ratio can be sized to pass any desired output length.
 */
export const MAX_CLEANED_OUTPUT_LENGTH = 3200;

// =============================================================================
// Perplexity API Constants (src/services/perplexity.ts)
// =============================================================================

/**
 * Maximum length accepted for beerName/brewer before they are interpolated
 * into the Perplexity prompt. These fields can originate from
 * `/beers/sync`, which lets a caller with the extractable app key overwrite
 * them on an existing beer ID (see the Cloudflare security review's
 * "trusted-record poisoning" finding). Generous relative to any real beer
 * or brewery name.
 */
export const MAX_PROMPT_FIELD_LENGTH = 300;

/**
 * Perplexity chat-completion responses are short (max_tokens: 100 was
 * requested) — this is a defense-in-depth cap against a compromised or
 * misbehaving upstream returning something far larger than a legitimate
 * response could ever be, applied before JSON.parse.
 */
export const MAX_PERPLEXITY_RESPONSE_BYTES = 32 * 1024;

/**
 * Truncation length for logged upstream error bodies, independent of the
 * parser's own size cap above -- this bounds *log volume*, not memory.
 */
export const MAX_LOGGED_ERROR_BODY_LENGTH = 500;

// =============================================================================
// DLQ Consumer Constants (src/queue/dlq.ts)
// =============================================================================

/**
 * Matches `max_retries` for both the `beer-enrichment-dlq` and
 * `description-cleanup-dlq` consumers in wrangler.jsonc (verified in sync as
 * of 2026-09-01: both are set to 3 -- re-check this constant if either
 * changes).
 *
 * The DLQ consumers have finite retries but no further dead-letter
 * destination, so a message that exhausts retries here was previously
 * discarded silently. `message.attempts` reflects how many delivery
 * attempts this message has had, including the current one; once it
 * reaches this ceiling, retrying again is what the platform would drop
 * anyway, so the terminal-attempt failure path logs loudly (for Tail
 * Worker alerting, which already keys off console.error -- see
 * src/index.ts) and acks rather than retrying into a loop the platform
 * will silently end regardless.
 */
export const MAX_DLQ_CONSUMER_ATTEMPTS = 3;

// =============================================================================
// Flying Saucer Upstream Bounds (src/schemas/external.ts, src/handlers/beers.ts)
// =============================================================================
//
// Upstream (Flying Saucer, Perplexity) responses are materialized fully
// before schemas/external.ts's schemas run, so the bounds below cap
// *content* shape, not wire bytes. See src/utils/bounded-response.ts for
// the byte-level cap applied before JSON.parse, and
// FLYING_SAUCER_RESPONSE_MAX_BYTES below for the streaming cap applied in
// src/handlers/beers.ts before the upstream body is even fully read.

/**
 * Maximum length for any single known Flying Saucer text field (id,
 * brew_name, brewer, brew_description, container_type). Generous relative
 * to real taplist data (names/descriptions are a few hundred characters at
 * most) but bounds a compromised or misconfigured upstream from smuggling
 * an arbitrarily large string into a field this schema knows about.
 */
export const MAX_FLYING_SAUCER_FIELD_LENGTH = 5000;

/**
 * Ceiling on the number of items accepted from a single Flying Saucer
 * taplist response. Real taplists are at most a few hundred beers; this is
 * a generous safety ceiling, not a realistic count, so it never affects
 * legitimate traffic while still bounding unbounded memory growth from a
 * compromised or misbehaving upstream.
 */
export const MAX_FLYING_SAUCER_RESPONSE_ITEMS = 5000;

/**
 * Ceiling on a single beer record's *serialized* size, including
 * passthrough fields src/schemas/external.ts's FlyingSaucerBeerSchema does
 * not enumerate. See `isFlyingSaucerBeerRecordWithinSizeCap()` in that file
 * for why this cannot live inside the schema itself (`.passthrough()` plus
 * `.extend()` compatibility).
 */
export const MAX_FLYING_SAUCER_RECORD_SERIALIZED_BYTES = 20_000;

/**
 * Byte cap applied to the raw Flying Saucer taplist response body via
 * `readBoundedText()` (src/utils/bounded-response.ts), enforced while
 * streaming and before `JSON.parse` ever runs -- independent of, and much
 * earlier than, the content-shape bounds above.
 *
 * Justified against a measured realistic fixture (see
 * "FLYING_SAUCER_RESPONSE_MAX_BYTES fixture" in test/constants.test.ts):
 * 500 beers (a store's real taplist is "at most a few hundred", per the
 * MAX_FLYING_SAUCER_RESPONSE_ITEMS doc above -- 500 already doubles that),
 * each with every known field (id, brew_name, brewer, brewer_loc,
 * brew_style, brew_container, review_count, review_rating, brew_description,
 * added_date) filled with a realistic-worst-case length using a triple-byte
 * UTF-8 character (matching the SYNC_BODY_MAX_BYTES fixture's methodology),
 * wrapped in the real `[{...meta}, {brewInStock: [...]}]` envelope. That
 * fixture serializes to 1,291,045 bytes. 4 MiB (4,194,304 bytes) leaves
 * roughly 3.2x headroom above the measured realistic-worst-case, while
 * still rejecting a 200 MB (or larger) hostile/compromised-upstream
 * response almost immediately.
 */
export const FLYING_SAUCER_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

// =============================================================================
// CORS Preflight Contract (src/index.ts)
// =============================================================================

/**
 * Routes and methods a real browser preflight can legitimately ask for.
 * Deliberately excludes /admin/* and /health: X-Admin-Secret is not in the
 * CORS-allowed header set (browser-based admin tooling is not supported),
 * and /health/livez are simple unauthenticated GETs that never trigger a
 * preflight in the first place.
 */
export const CORS_PREFLIGHT_ROUTES: Readonly<Record<string, string>> = {
  '/beers': 'GET',
  '/beers/batch': 'POST',
  '/beers/sync': 'POST',
};

/** Mirrors the Access-Control-Allow-Headers contract in src/context.ts. */
export const CORS_ALLOWED_REQUEST_HEADERS = new Set(['content-type', 'x-api-key']);

/** Explicit provider unknowns may recover; retry through quota-checked sweeps. */
export const ABV_LOOKUP_MISS_RETRY_MS = 24 * 60 * 60 * 1000;
/** Avoid spending lookup quota on beers no longer present in recent taplists. */
export const ABV_LOOKUP_RECENTLY_SEEN_MS = 7 * 24 * 60 * 60 * 1000;
