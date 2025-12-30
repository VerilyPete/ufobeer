// ============================================================================
// Core Cloudflare Workers Environment
// ============================================================================

/**
 * Environment bindings and configuration for the Cloudflare Worker.
 * Includes D1 database, Queue, Analytics, secrets, and environment variables.
 */
export interface Env {
  // Database
  DB: D1Database;

  // Queue (from Phase 1) - used for enrichment and DLQ replay
  ENRICHMENT_QUEUE: Queue<EnrichmentMessage>;

  // Queue for description cleanup (LLM-based)
  CLEANUP_QUEUE: Queue<CleanupMessage>;

  // Workers AI binding for description cleanup
  AI: Ai;

  // Analytics Engine (optional - graceful degradation if not configured)
  ANALYTICS?: AnalyticsEngineDataset;

  // Secrets (set via wrangler secret put)
  API_KEY: string;
  FLYING_SAUCER_API_BASE: string;
  PERPLEXITY_API_KEY?: string;
  ADMIN_SECRET?: string; // Required for /admin/* routes

  // Environment variables (set in wrangler.jsonc vars)
  ALLOWED_ORIGIN: string;
  RATE_LIMIT_RPM: string;

  // Circuit breaker (from Phase 1)
  DAILY_ENRICHMENT_LIMIT?: string;
  MONTHLY_ENRICHMENT_LIMIT?: string;
  ENRICHMENT_ENABLED?: string;

  // Cleanup limits (optional)
  DAILY_CLEANUP_LIMIT?: string;
  MAX_CLEANUP_CONCURRENCY?: string;
}

// ============================================================================
// Queue Message Types
// ============================================================================

/**
 * Message format for enrichment queue.
 * Sent from API → Queue → Consumer → Perplexity → Database update.
 */
export interface EnrichmentMessage {
  beerId: string;
  beerName: string;
  brewer: string;
}

/**
 * Message format for description cleanup queue.
 * Sent from API → Queue → Consumer → Workers AI → Database update.
 * If ABV cannot be extracted after cleanup, forwards to enrichment queue.
 */
export interface CleanupMessage {
  beerId: string;
  beerName: string;
  brewer: string;
  brewDescription: string;
}

// ============================================================================
// Flying Saucer API Types
// ============================================================================

/**
 * Beer data structure from Flying Saucer API.
 * API returns nested format: [{...}, {brewInStock: [...]}]
 */
export interface FlyingSaucerBeer {
  id: string;
  brew_name: string;
  brewer: string;
  brew_description?: string;
  container_type?: string;
  [key: string]: unknown;
}

// ============================================================================
// Request Context & Audit
// ============================================================================

/**
 * Request metadata for audit logging and analytics.
 * Created at start of each request, passed through handler chain.
 */
export interface RequestContext {
  requestId: string;
  startTime: number;
  clientIdentifier: string;
  apiKeyHash: string | null;
  clientIp: string | null;
  userAgent: string | null;
}

// ============================================================================
// DLQ (Dead Letter Queue) Types
// ============================================================================

/**
 * DLQ message stored in D1 database for admin inspection.
 * Created when enrichment queue consumer fails after max retries.
 */
export interface DlqMessageRow {
  id: number;
  message_id: string;
  beer_id: string;
  beer_name: string | null;
  brewer: string | null;
  failed_at: number;
  failure_count: number;
  failure_reason: string | null;
  source_queue: string;
  status: string;
  replay_count: number;
  replayed_at: number | null;
  acknowledged_at: number | null;
  raw_message: string | null;
}

/**
 * Pagination cursor for DLQ list endpoint.
 * Uses failed_at + id for stable pagination.
 */
export interface PaginationCursor {
  failed_at: number;
  id: number;
}

/**
 * Request body for POST /admin/dlq/replay.
 * Replays failed messages back to enrichment queue.
 */
export interface DlqReplayRequest {
  ids: number[];           // D1 row IDs to replay
  delay_seconds?: number;  // Delay before processing (default 0)
}

/**
 * Request body for POST /admin/dlq/acknowledge.
 * Marks DLQ messages as acknowledged (resolved).
 */
export interface DlqAcknowledgeRequest {
  ids: number[];  // D1 row IDs to acknowledge
}

// ============================================================================
// Manual Enrichment Trigger Types
// ============================================================================

/**
 * Request body for POST /admin/enrich/trigger.
 * Manually triggers enrichment for unenriched beers.
 */
export interface TriggerEnrichmentRequest {
  /** Maximum number of beers to queue (default: 50, max: 100) */
  limit?: number;
  /** Only queue beers that have never been attempted (exclude DLQ failures) */
  exclude_failures?: boolean;
  /** Dry run mode - return what would be queued without actually queueing */
  dry_run?: boolean;
}

/**
 * Quota status for enrichment limits.
 */
export interface QuotaStatus {
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Response data for POST /admin/enrich/trigger.
 */
export interface TriggerEnrichmentData {
  beers_queued: number;
  skip_reason?: 'kill_switch' | 'daily_limit' | 'monthly_limit' | 'no_eligible_beers';
  quota: {
    daily: QuotaStatus;
    monthly: QuotaStatus;
  };
  enabled: boolean;
  filters: {
    exclude_failures: boolean;
  };
}

// ============================================================================
// Force Re-Enrichment Types
// ============================================================================

/**
 * Request body for POST /admin/enrich/force.
 * Forces re-enrichment of beers matching criteria (even if already enriched).
 */
export interface ForceEnrichmentRequest {
  admin_id?: string;
  beer_ids?: string[];
  criteria?: {
    confidence_below?: number;           // 0.0-1.0
    enrichment_older_than_days?: number; // positive integer
    enrichment_source?: 'perplexity' | 'manual';
  };
  limit?: number;      // 1-100, default 50
  dry_run?: boolean;   // default false
}

/**
 * Response for POST /admin/enrich/force.
 */
export interface ForceEnrichmentResponse {
  success: boolean;
  requestId: string;
  data?: {
    matched_count: number;
    queued_count: number;
    skipped_count: number;
    skipped_ids?: string[];    // IDs skipped due to race condition (included if <= 50)
    queued_ids?: string[];     // IDs that were queued (included if <= 50)
    dry_run: boolean;
    applied_criteria?: object;
    quota: {
      daily: { used: number; limit: number; remaining: number };
      monthly: { used: number; limit: number; remaining: number };
    };
  };
  error?: { message: string; code: string };
}

/**
 * Beer data returned from database when querying for re-enrichment.
 */
export interface BeerToReEnrich {
  id: string;
  brew_name: string;
  brewer: string | null;
  abv: number | null;
  confidence: number | null;
  enrichment_source: string | null;
  updated_at: number;
}

/**
 * Validation result for force enrichment request.
 */
export interface ForceEnrichmentValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: string;
}

/**
 * Result of clearing enrichment data (used in force re-enrichment).
 */
export interface ClearResult {
  clearedCount: number;
  skippedCount: number;
  skippedIds: string[];
  clearedIds: string[];
}

// ============================================================================
// Enrichment Quota Types
// ============================================================================

/**
 * Enrichment quota status with circuit breaker checks.
 * Reusable for both /admin/enrich/trigger and /admin/enrich/force endpoints.
 */
export interface EnrichmentQuotaStatus {
  canProcess: boolean;
  skipReason?: 'kill_switch' | 'daily_limit' | 'monthly_limit';
  daily: { used: number; limit: number; remaining: number };
  monthly: { used: number; limit: number; remaining: number };
}

// ============================================================================
// Response Helper Types
// ============================================================================

/**
 * Options for creating standardized error responses.
 */
export interface ErrorResponseOptions {
  requestId: string;
  headers: Record<string, string>;
  status?: number;
  /** Additional fields to include in the error response */
  extra?: Record<string, unknown>;
}

/**
 * Result from GET /beers endpoint handler.
 */
export interface GetBeersResult {
  response: Response;
  beersReturned: number;
  upstreamLatencyMs: number;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard: Validates that an object is a valid FlyingSaucerBeer.
 */
export function isValidBeer(beer: unknown): beer is FlyingSaucerBeer {
  return (
    typeof beer === 'object' &&
    beer !== null &&
    'id' in beer &&
    typeof (beer as FlyingSaucerBeer).id === 'string' &&
    (beer as FlyingSaucerBeer).id.length > 0 &&
    'brew_name' in beer &&
    typeof (beer as FlyingSaucerBeer).brew_name === 'string'
  );
}

/**
 * Type guard: Checks if an object contains a brewInStock array.
 * Flying Saucer API returns: [{...}, {brewInStock: [...]}]
 */
export function hasBeerStock(item: unknown): item is { brewInStock: unknown[] } {
  return (
    item !== null &&
    typeof item === 'object' &&
    'brewInStock' in item &&
    Array.isArray((item as { brewInStock?: unknown }).brewInStock)
  );
}

// ============================================================================
// Beer Sync Types (Batch Endpoint Enhancement)
// ============================================================================

/**
 * Request body for POST /beers/sync.
 * Accepts beer data from mobile client for syncing to enriched_beers table.
 */
export interface SyncBeersRequest {
  beers: Array<{
    id: string;
    brew_name: string;
    brewer?: string;
    brew_description?: string;
  }>;
}

/**
 * Response for POST /beers/sync.
 * Returns counts of synced and queued beers.
 */
export interface SyncBeersResponse {
  synced: number;
  queued_for_cleanup: number;
  requestId: string;
  errors?: string[];
}

/**
 * Updated response type for POST /beers/batch.
 * Now includes missing IDs and merged descriptions (consistent with GET /beers).
 * Field names aligned with mobile app expectations.
 */
export interface BatchLookupResponse {
  enrichments: Record<string, {
    enriched_abv: number | null;
    enrichment_confidence: number;
    enrichment_source: string | null;
    is_verified: boolean;
    /** Merged description: prefers cleaned version, falls back to original (like GET /beers) */
    brew_description: string | null;
    /** True if the brew_description came from the cleaned version */
    has_cleaned_description: boolean;
  }>;
  missing: string[];
  requestId: string;
}

/**
 * Constants for sync endpoint validation.
 */
export const SYNC_CONSTANTS = {
  MAX_BATCH_SIZE: 50,
  MAX_DESC_LENGTH: 2000,
  MAX_BREW_NAME_LENGTH: 200,
  MAX_ID_LENGTH: 50,
  RATE_LIMIT_RPM: 10,
  REQUEUE_COOLDOWN_MS: 24 * 60 * 60 * 1000, // 24 hours
} as const;

// ============================================================================
// Cleanup Trigger Types
// ============================================================================

/**
 * Request body for POST /admin/cleanup/trigger
 */
export interface TriggerCleanupRequest {
  /** Operation mode: 'all' resets and re-queues, 'missing' only queues unprocessed */
  mode: 'all' | 'missing';
  /** Max beers to process (1-500, default 500) */
  limit?: number;
  /** Preview without making changes */
  dry_run?: boolean;
  /** Required for mode: 'all' to prevent accidents */
  confirm?: boolean;
}

/**
 * Preview data returned when confirm is missing for mode: 'all'
 */
export interface CleanupPreview {
  /** Number of beers that would have cleanup fields reset */
  beers_would_reset: number;
  /** Number of beers that would be skipped (blocklisted) */
  beers_would_skip: number;
  /** Total beers matching criteria */
  beers_total: number;
}

/**
 * Response data for POST /admin/cleanup/trigger
 */
export interface TriggerCleanupData {
  /** Unique operation ID for tracking */
  operation_id: string;
  /** Beers sent to queue */
  beers_queued: number;
  /** Beers skipped (blocklisted) */
  beers_skipped: number;
  /** Beers reset (only present for mode: 'all') */
  beers_reset?: number;
  /** Beers matching but not processed (due to limit) */
  beers_remaining: number;
  /** Operation mode used */
  mode: 'all' | 'missing';
  /** Was this a dry run */
  dry_run: boolean;
  /** Present if no beers queued */
  skip_reason?: 'no_eligible_beers';
  /** Quota information */
  quota: {
    daily: {
      used: number;
      limit: number;
      remaining: number;
      projected_after: number;
    };
  };
}

/**
 * Constants for cleanup trigger endpoint.
 */
export const CLEANUP_TRIGGER_CONSTANTS = {
  /** Maximum beers per trigger request */
  MAX_LIMIT: 500,
  /** Default beers per trigger request */
  DEFAULT_LIMIT: 500,
  /** Cooldown between trigger operations (5 minutes) */
  COOLDOWN_MS: 5 * 60 * 1000,
  /** system_state key for cooldown tracking */
  COOLDOWN_KEY: 'cleanup_trigger_last_run',
  /** D1 batch size limit for database operations */
  D1_BATCH_SIZE: 100,
} as const;

/**
 * Validation result for cleanup trigger request.
 */
export interface CleanupTriggerValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: string;
}
