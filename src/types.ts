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
 * Validate force re-enrichment request.
 * IMPORTANT: Either beer_ids OR criteria is required. Empty body is rejected.
 */
export function validateForceEnrichmentRequest(body: unknown): ForceEnrichmentValidationResult {
  // Reject null/undefined/non-object
  if (body === null || body === undefined || typeof body !== 'object') {
    return {
      valid: false,
      error: 'Request body must be a JSON object with beer_ids or criteria',
      errorCode: 'INVALID_BODY',
    };
  }

  const req = body as ForceEnrichmentRequest;

  // Must specify either beer_ids OR criteria (not both, not neither)
  const hasBeerIds = req.beer_ids !== undefined;
  const hasCriteria = req.criteria !== undefined;

  if (hasBeerIds && hasCriteria) {
    return {
      valid: false,
      error: 'Cannot specify both beer_ids and criteria',
      errorCode: 'INVALID_REQUEST_BOTH_SPECIFIED',
    };
  }

  if (!hasBeerIds && !hasCriteria) {
    return {
      valid: false,
      error: 'Must specify either beer_ids or criteria',
      errorCode: 'INVALID_REQUEST_NEITHER_SPECIFIED',
    };
  }

  // Validate beer_ids
  if (hasBeerIds) {
    if (!Array.isArray(req.beer_ids)) {
      return { valid: false, error: 'beer_ids must be an array', errorCode: 'INVALID_BEER_IDS' };
    }
    if (req.beer_ids.length === 0) {
      return { valid: false, error: 'beer_ids cannot be empty', errorCode: 'INVALID_BEER_IDS_EMPTY' };
    }
    if (req.beer_ids.length > 100) {
      return { valid: false, error: 'beer_ids max 100 items', errorCode: 'INVALID_BEER_IDS_TOO_MANY' };
    }
    if (!req.beer_ids.every(id => typeof id === 'string' && id.length > 0)) {
      return { valid: false, error: 'All beer_ids must be non-empty strings', errorCode: 'INVALID_BEER_IDS_FORMAT' };
    }
  }

  // Validate criteria
  if (hasCriteria) {
    if (typeof req.criteria !== 'object' || req.criteria === null) {
      return { valid: false, error: 'criteria must be an object', errorCode: 'INVALID_CRITERIA' };
    }
    if (Object.keys(req.criteria).length === 0) {
      return { valid: false, error: 'criteria cannot be empty', errorCode: 'INVALID_CRITERIA_EMPTY' };
    }

    // confidence_below: 0.0-1.0
    if (req.criteria.confidence_below !== undefined) {
      const c = req.criteria.confidence_below;
      if (typeof c !== 'number' || c < 0 || c > 1) {
        return { valid: false, error: 'confidence_below must be 0.0-1.0', errorCode: 'INVALID_CONFIDENCE' };
      }
    }

    // enrichment_older_than_days: positive integer
    if (req.criteria.enrichment_older_than_days !== undefined) {
      const d = req.criteria.enrichment_older_than_days;
      if (typeof d !== 'number' || d < 1 || !Number.isInteger(d)) {
        return { valid: false, error: 'enrichment_older_than_days must be positive integer', errorCode: 'INVALID_DAYS' };
      }
    }

    // enrichment_source: 'perplexity' | 'manual'
    if (req.criteria.enrichment_source !== undefined) {
      if (!['perplexity', 'manual'].includes(req.criteria.enrichment_source)) {
        return { valid: false, error: "enrichment_source must be 'perplexity' or 'manual'", errorCode: 'INVALID_SOURCE' };
      }
    }
  }

  // Validate limit: 1-100
  if (req.limit !== undefined) {
    if (typeof req.limit !== 'number' || req.limit < 1 || req.limit > 100) {
      return { valid: false, error: 'limit must be 1-100', errorCode: 'INVALID_LIMIT' };
    }
  }

  // Validate dry_run: boolean
  if (req.dry_run !== undefined && typeof req.dry_run !== 'boolean') {
    return { valid: false, error: 'dry_run must be boolean', errorCode: 'INVALID_DRY_RUN' };
  }

  // Validate admin_id: non-empty string if provided
  if (req.admin_id !== undefined) {
    if (typeof req.admin_id !== 'string' || req.admin_id.trim().length === 0) {
      return { valid: false, error: 'admin_id must be non-empty string', errorCode: 'INVALID_ADMIN_ID' };
    }
  }

  return { valid: true };
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
