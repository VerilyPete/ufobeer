// ============================================================================
// Core Cloudflare Workers Environment
// ============================================================================

/**
 * Environment bindings and configuration for the Cloudflare Worker.
 * Includes D1 database, Queue, Analytics, secrets, and environment variables.
 */
export type Env = {
  // Database
  readonly DB: D1Database;

  // Queue (from Phase 1) - used for enrichment and DLQ replay
  readonly ENRICHMENT_QUEUE: Queue<EnrichmentMessage>;

  // Queue for description cleanup (LLM-based)
  readonly CLEANUP_QUEUE: Queue<CleanupMessage>;

  // Workers AI binding for description cleanup
  readonly AI: Ai;

  // Analytics Engine (optional - graceful degradation if not configured)
  readonly ANALYTICS?: AnalyticsEngineDataset | undefined;

  // Secrets (set via wrangler secret put)
  readonly API_KEY: string;
  readonly FLYING_SAUCER_API_BASE: string;
  readonly PERPLEXITY_API_KEY?: string | undefined;
  readonly ADMIN_SECRET?: string | undefined; // Required for /admin/* routes

  // Environment variables (set in wrangler.jsonc vars)
  readonly ALLOWED_ORIGIN: string;
  readonly RATE_LIMIT_RPM: string;

  // Circuit breaker (from Phase 1)
  readonly DAILY_ENRICHMENT_LIMIT?: string | undefined;
  readonly MONTHLY_ENRICHMENT_LIMIT?: string | undefined;
  readonly ENRICHMENT_ENABLED?: string | undefined;

  // Cleanup limits (optional)
  readonly DAILY_CLEANUP_LIMIT?: string | undefined;
  readonly MAX_CLEANUP_CONCURRENCY?: string | undefined;
};

// ============================================================================
// Queue Message Types
// ============================================================================

/**
 * Message format for enrichment queue.
 * Sent from API → Queue → Consumer → Perplexity → Database update.
 */
export type EnrichmentMessage = {
  readonly beerId: string;
  readonly beerName: string;
  readonly brewer: string;
};

/**
 * Message format for description cleanup queue.
 * Sent from API → Queue → Consumer → Workers AI → Database update.
 * If ABV cannot be extracted after cleanup, forwards to enrichment queue.
 */
export type CleanupMessage = {
  readonly beerId: string;
  readonly beerName: string;
  readonly brewer: string;
  readonly brewDescription: string;
};

// ============================================================================
// Flying Saucer API Types
// ============================================================================

/**
 * Beer data structure from Flying Saucer API.
 * API returns nested format: [{...}, {brewInStock: [...]}]
 */
export type FlyingSaucerBeer = {
  readonly id: string;
  readonly brew_name: string;
  readonly brewer: string;
  readonly brew_description?: string | undefined;
  readonly container_type?: string | undefined;
  readonly [key: string]: unknown;
};

// ============================================================================
// Request Context & Audit
// ============================================================================

/**
 * Request metadata for audit logging and analytics.
 * Created at start of each request, passed through handler chain.
 */
export type RequestContext = {
  readonly requestId: string;
  readonly startTime: number;
  readonly clientIdentifier: string;
  readonly apiKeyHash: string | null;
  readonly clientIp: string | null;
  readonly userAgent: string | null;
};

// ============================================================================
// DLQ (Dead Letter Queue) Types
// ============================================================================

/**
 * DLQ message stored in D1 database for admin inspection.
 * Created when enrichment queue consumer fails after max retries.
 */
export type DlqMessageRow = {
  readonly id: number;
  readonly message_id: string;
  readonly beer_id: string;
  readonly beer_name: string | null;
  readonly brewer: string | null;
  readonly failed_at: number;
  readonly failure_count: number;
  readonly failure_reason: string | null;
  readonly source_queue: string;
  readonly status: string;
  readonly replay_count: number;
  readonly replayed_at: number | null;
  readonly acknowledged_at: number | null;
  readonly raw_message: string | null;
};

/**
 * Pagination cursor for DLQ list endpoint.
 * Uses failed_at + id for stable pagination.
 */
export type PaginationCursor = {
  readonly failed_at: number;
  readonly id: number;
};

/**
 * Request body for POST /admin/dlq/replay.
 * Replays failed messages back to enrichment queue.
 */
export type DlqReplayRequest = {
  readonly ids: readonly number[];           // D1 row IDs to replay
  readonly delay_seconds?: number | undefined;  // Delay before processing (default 0)
};

/**
 * Request body for POST /admin/dlq/acknowledge.
 * Marks DLQ messages as acknowledged (resolved).
 */
export type DlqAcknowledgeRequest = {
  readonly ids: readonly number[];  // D1 row IDs to acknowledge
};

// ============================================================================
// Manual Enrichment Trigger Types
// ============================================================================

/**
 * Request body for POST /admin/enrich/trigger.
 * Manually triggers enrichment for unenriched beers.
 */
export type TriggerEnrichmentRequest = {
  /** Maximum number of beers to queue (default: 50, max: 100) */
  readonly limit?: number | undefined;
  /** Only queue beers that have never been attempted (exclude DLQ failures) */
  readonly exclude_failures?: boolean | undefined;
  /** Dry run mode - return what would be queued without actually queueing */
  readonly dry_run?: boolean | undefined;
};

/**
 * Quota status for enrichment limits.
 */
export type QuotaStatus = {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
};

/**
 * Response data for POST /admin/enrich/trigger.
 */
export type TriggerEnrichmentData = {
  readonly beers_queued: number;
  readonly skip_reason?: 'kill_switch' | 'daily_limit' | 'monthly_limit' | 'no_eligible_beers' | undefined;
  readonly quota: {
    readonly daily: QuotaStatus;
    readonly monthly: QuotaStatus;
  };
  readonly enabled: boolean;
  readonly filters: {
    readonly exclude_failures: boolean;
  };
};

// ============================================================================
// Force Re-Enrichment Types
// ============================================================================

/**
 * Request body for POST /admin/enrich/force.
 * Forces re-enrichment of beers matching criteria (even if already enriched).
 */
export type ForceEnrichmentRequest = {
  readonly admin_id?: string | undefined;
  readonly beer_ids?: readonly string[] | undefined;
  readonly criteria?: {
    readonly confidence_below?: number | undefined;           // 0.0-1.0
    readonly enrichment_older_than_days?: number | undefined; // positive integer
    readonly enrichment_source?: 'perplexity' | 'manual' | undefined;
  } | undefined;
  readonly limit?: number | undefined;      // 1-100, default 50
  readonly dry_run?: boolean | undefined;   // default false
};

/**
 * Response for POST /admin/enrich/force.
 */
export type ForceEnrichmentResponse = {
  readonly success: boolean;
  readonly requestId: string;
  readonly data?: {
    readonly matched_count: number;
    readonly queued_count: number;
    readonly skipped_count: number;
    readonly skipped_ids?: readonly string[] | undefined;    // IDs skipped due to race condition (included if <= 50)
    readonly queued_ids?: readonly string[] | undefined;     // IDs that were queued (included if <= 50)
    readonly dry_run: boolean;
    readonly applied_criteria?: object | undefined;
    readonly quota: {
      readonly daily: { readonly used: number; readonly limit: number; readonly remaining: number };
      readonly monthly: { readonly used: number; readonly limit: number; readonly remaining: number };
    };
  } | undefined;
  readonly error?: { readonly message: string; readonly code: string } | undefined;
};

/**
 * Beer data returned from database when querying for re-enrichment.
 */
export type BeerToReEnrich = {
  readonly id: string;
  readonly brew_name: string;
  readonly brewer: string | null;
  readonly abv: number | null;
  readonly confidence: number | null;
  readonly enrichment_source: string | null;
  readonly updated_at: number;
};

/**
 * Validation result for force enrichment request.
 */
export type ForceEnrichmentValidationResult = {
  readonly valid: boolean;
  readonly error?: string | undefined;
  readonly errorCode?: string | undefined;
};

/**
 * Result of clearing enrichment data (used in force re-enrichment).
 */
export type ClearResult = {
  readonly clearedCount: number;
  readonly skippedCount: number;
  readonly skippedIds: readonly string[];
  readonly clearedIds: readonly string[];
};

// ============================================================================
// Enrichment Quota Types
// ============================================================================

/**
 * Enrichment quota status with circuit breaker checks.
 * Reusable for both /admin/enrich/trigger and /admin/enrich/force endpoints.
 */
export type EnrichmentQuotaStatus = {
  readonly canProcess: boolean;
  readonly skipReason?: 'kill_switch' | 'daily_limit' | 'monthly_limit' | undefined;
  readonly daily: { readonly used: number; readonly limit: number; readonly remaining: number };
  readonly monthly: { readonly used: number; readonly limit: number; readonly remaining: number };
};

// ============================================================================
// Response Helper Types
// ============================================================================

/**
 * Options for creating standardized error responses.
 */
export type ErrorResponseOptions = {
  readonly requestId: string;
  readonly headers: Record<string, string>;
  readonly status?: number | undefined;
  /** Additional fields to include in the error response */
  readonly extra?: Record<string, unknown> | undefined;
};

/**
 * Result from GET /beers endpoint handler.
 */
export type GetBeersResult = {
  readonly response: Response;
  readonly beersReturned: number;
  readonly upstreamLatencyMs: number;
};

// ============================================================================
// Type Guards
// ============================================================================

import { z } from 'zod';
import { FlyingSaucerBeerSchema } from './schemas/external';

/**
 * Type guard: Validates that an object is a valid FlyingSaucerBeer.
 */
export function isValidBeer(beer: unknown): beer is FlyingSaucerBeer {
  return FlyingSaucerBeerSchema.safeParse(beer).success;
}

const BeerStockSchema = z.object({
  brewInStock: z.array(z.unknown()),
}).passthrough();

/**
 * Type guard: Checks if an object contains a brewInStock array.
 * Flying Saucer API returns: [{...}, {brewInStock: [...]}]
 */
export function hasBeerStock(item: unknown): item is { brewInStock: unknown[] } {
  return BeerStockSchema.safeParse(item).success;
}

// ============================================================================
// Beer Sync Types (Batch Endpoint Enhancement)
// ============================================================================

/**
 * Request body for POST /beers/sync.
 * Accepts beer data from mobile client for syncing to enriched_beers table.
 */
export type SyncBeersRequest = {
  readonly beers: ReadonlyArray<{
    readonly id: string;
    readonly brew_name: string;
    readonly brewer?: string | undefined;
    readonly brew_description?: string | undefined;
  }>;
};

/**
 * Response for POST /beers/sync.
 * Returns counts of synced and queued beers.
 */
export type SyncBeersResponse = {
  readonly synced: number;
  readonly queued_for_cleanup: number;
  readonly requestId: string;
  readonly errors?: readonly string[] | undefined;
};

/**
 * Updated response type for POST /beers/batch.
 * Now includes missing IDs and merged descriptions (consistent with GET /beers).
 * Field names aligned with mobile app expectations.
 */
export type BatchLookupResponse = {
  readonly enrichments: Readonly<Record<string, {
    readonly enriched_abv: number | null;
    readonly enrichment_confidence: number;
    readonly enrichment_source: string | null;
    readonly is_verified: boolean;
    /** Merged description: prefers cleaned version, falls back to original (like GET /beers) */
    readonly brew_description: string | null;
    /** True if the brew_description came from the cleaned version */
    readonly has_cleaned_description: boolean;
  }>>;
  readonly missing: readonly string[];
  readonly requestId: string;
};

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
export type TriggerCleanupRequest = {
  /** Operation mode: 'all' resets and re-queues, 'missing' only queues unprocessed */
  readonly mode: 'all' | 'missing';
  /** Max beers to process (1-500, default 500) */
  readonly limit?: number | undefined;
  /** Preview without making changes */
  readonly dry_run?: boolean | undefined;
  /** Required for mode: 'all' to prevent accidents */
  readonly confirm?: boolean | undefined;
};

/**
 * Preview data returned when confirm is missing for mode: 'all'
 */
export type CleanupPreview = {
  /** Number of beers that would have cleanup fields reset */
  readonly beers_would_reset: number;
  /** Number of beers that would be skipped (blocklisted) */
  readonly beers_would_skip: number;
  /** Total beers matching criteria */
  readonly beers_total: number;
};

/**
 * Response data for POST /admin/cleanup/trigger
 */
export type TriggerCleanupData = {
  /** Unique operation ID for tracking */
  readonly operation_id: string;
  /** Beers sent to queue */
  readonly beers_queued: number;
  /** Beers skipped (blocklisted) */
  readonly beers_skipped: number;
  /** Beers reset (only present for mode: 'all') */
  readonly beers_reset?: number | undefined;
  /** Beers matching but not processed (due to limit) */
  readonly beers_remaining: number;
  /** Operation mode used */
  readonly mode: 'all' | 'missing';
  /** Was this a dry run */
  readonly dry_run: boolean;
  /** Present if no beers queued */
  readonly skip_reason?: 'no_eligible_beers' | undefined;
  /** Quota information */
  readonly quota: {
    readonly daily: {
      readonly used: number;
      readonly limit: number;
      readonly remaining: number;
      readonly projected_after: number;
    };
  };
};

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
export type CleanupTriggerValidationResult = {
  readonly valid: boolean;
  readonly error?: string | undefined;
  readonly errorCode?: string | undefined;
};
