import { getToday } from './utils/date';

/**
 * Analytics Engine helper functions for tracking worker metrics.
 *
 * Uses Cloudflare Workers Analytics Engine for time-series analytics.
 * Data is retained for 3 months and can be queried via SQL API.
 *
 * Schema: beer_enrichment_metrics
 * - Blobs (dimensions):
 *     blob1: endpoint
 *     blob2: method
 *     blob3: store_id
 *     blob4: status_category
 *     blob5: error_type (actual errors only) OR skip_reason (non-error early exits for cron)
 *     blob6: client_id
 *     blob7: event_type
 *     blob8: enrichment_source
 * - Doubles (metrics):
 *     double1: response_time_ms
 *     double2: request_count
 *     double3: beers_returned
 *     double4: enrichment_count (or beers_queued for cron)
 *     double5: cache_hit (TODO: not yet populated for /beers - caching not implemented)
 *     double6: error_count
 *     double7: rate_limit_triggered
 *     double8: upstream_latency_ms
 *     double9: daily_remaining (cron only)
 *     double10: monthly_remaining (cron only)
 */

/**
 * Analytics Engine dataset interface.
 * writeDataPoint is non-blocking - the runtime handles writing in the background.
 */
export interface AnalyticsEngineDataset {
  writeDataPoint(data: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

/**
 * Metrics for tracking HTTP requests to the worker.
 */
export type RequestMetrics = {
  readonly endpoint: string;
  readonly method: string;
  readonly storeId?: string | undefined;
  readonly statusCode: number;
  readonly errorType?: string | undefined;
  readonly clientId: string;
  readonly responseTimeMs: number;
  readonly beersReturned?: number | undefined;
  readonly cacheHit?: boolean | undefined;
  readonly upstreamLatencyMs?: number | undefined;
};

/**
 * Metrics for tracking enrichment operations.
 */
export type EnrichmentMetrics = {
  readonly beerId: string;
  readonly source: 'perplexity' | 'cache';
  readonly success: boolean;
  readonly durationMs: number;
};

/**
 * Metrics for tracking cron job executions.
 *
 * Note: Use `skipReason` for non-error early exits (kill_switch, daily_limit, etc.)
 * and `errorType` only for actual errors (exception, etc.)
 */
export type CronMetrics = {
  readonly beersQueued: number;
  readonly dailyRemaining: number;
  readonly monthlyRemaining: number;
  readonly durationMs: number;
  readonly success: boolean;
  /** Reason for skipping enrichment (non-error early exit) */
  readonly skipReason?: 'kill_switch' | 'daily_limit' | 'monthly_limit' | 'no_beers' | undefined;
  /** Error type for actual failures */
  readonly errorType?: string | undefined;
};

/**
 * Get HTTP status category (2xx, 3xx, 4xx, 5xx)
 */
function getStatusCategory(statusCode: number): string {
  if (statusCode >= 200 && statusCode < 300) return '2xx';
  if (statusCode >= 300 && statusCode < 400) return '3xx';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  return '5xx';
}

/**
 * Classify error type from status code and context.
 * Used for grouping errors in analytics queries.
 */
function getErrorType(statusCode: number, errorType?: string): string {
  if (errorType) return errorType;
  if (statusCode === 429) return 'rate_limit';
  if (statusCode === 401) return 'auth_fail';
  if (statusCode === 502) return 'upstream_error';
  if (statusCode >= 400 && statusCode < 500) return 'client_error';
  if (statusCode >= 500) return 'server_error';
  return 'success';
}

/**
 * Safely write a data point to Analytics Engine.
 * Gracefully handles cases where the analytics binding is not available.
 *
 * @param analytics - The Analytics Engine dataset binding (may be undefined)
 * @param dataPoint - The data point to write
 */
function safeWriteDataPoint(
  analytics: AnalyticsEngineDataset | undefined,
  dataPoint: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }
): void {
  if (!analytics) {
    return;
  }
  try {
    analytics.writeDataPoint(dataPoint);
  } catch (error) {
    // Log but don't throw - analytics should never break the main request flow
    console.error('Analytics write failed:', error);
  }
}

/**
 * Track an HTTP request to the worker.
 * Call this at the end of each request handler.
 *
 * Note: writeDataPoint is non-blocking - it returns immediately
 * and the runtime handles writing in the background.
 *
 * Index: "{client_id}:{endpoint}" for balanced sampling per client and endpoint
 */
export function trackRequest(
  analytics: AnalyticsEngineDataset | undefined,
  metrics: RequestMetrics
): void {
  const statusCategory = getStatusCategory(metrics.statusCode);
  const errorType = getErrorType(metrics.statusCode, metrics.errorType);
  const isError = metrics.statusCode >= 400;
  const isRateLimited = metrics.statusCode === 429;

  safeWriteDataPoint(analytics, {
    indexes: [`${metrics.clientId}:${metrics.endpoint}`],
    blobs: [
      metrics.endpoint,           // blob1: endpoint
      metrics.method,             // blob2: method
      metrics.storeId || '',      // blob3: store_id
      statusCategory,             // blob4: status_category
      errorType,                  // blob5: error_type
      metrics.clientId,           // blob6: client_id
      'request',                  // blob7: event_type
      '',                         // blob8: enrichment_source (N/A for requests)
    ],
    doubles: [
      metrics.responseTimeMs,           // double1: response_time_ms
      1,                                // double2: request_count
      metrics.beersReturned || 0,       // double3: beers_returned
      0,                                // double4: enrichment_count
      metrics.cacheHit ? 1 : 0,         // double5: cache_hit (TODO: not populated - caching not implemented)
      isError ? 1 : 0,                  // double6: error_count
      isRateLimited ? 1 : 0,            // double7: rate_limit_triggered
      metrics.upstreamLatencyMs || 0,   // double8: upstream_latency_ms
    ],
  });
}

/**
 * Track an enrichment operation (Perplexity API call or cache hit).
 *
 * Index: "enrichment:{source}" for grouping by enrichment source
 */
export function trackEnrichment(
  analytics: AnalyticsEngineDataset | undefined,
  metrics: EnrichmentMetrics
): void {
  safeWriteDataPoint(analytics, {
    indexes: [`enrichment:${metrics.source}`],
    blobs: [
      '',                         // blob1: endpoint (N/A)
      '',                         // blob2: method (N/A)
      '',                         // blob3: store_id (N/A)
      metrics.success ? '2xx' : '5xx', // blob4: status_category
      metrics.success ? 'success' : 'enrichment_fail', // blob5: error_type
      '',                         // blob6: client_id (N/A)
      'enrichment',               // blob7: event_type
      metrics.source,             // blob8: enrichment_source
    ],
    doubles: [
      metrics.durationMs,         // double1: response_time_ms (enrichment duration)
      1,                          // double2: request_count (event count)
      0,                          // double3: beers_returned (N/A)
      1,                          // double4: enrichment_count
      metrics.source === 'cache' ? 1 : 0, // double5: cache_hit
      metrics.success ? 0 : 1,    // double6: error_count
      0,                          // double7: rate_limit_triggered
      0,                          // double8: upstream_latency_ms
    ],
  });
}

/**
 * Track a cron job execution.
 *
 * Index: "cron:{YYYY-MM-DD}" for date-based sampling distribution
 */
export function trackCron(
  analytics: AnalyticsEngineDataset | undefined,
  metrics: CronMetrics
): void {
  // Use date in index for better sampling distribution
  const today = getToday();

  // Determine blob5 value: skipReason for non-error exits, errorType for actual errors
  let blob5Value: string;
  if (metrics.errorType) {
    // Actual error
    blob5Value = metrics.errorType;
  } else if (metrics.skipReason) {
    // Non-error early exit
    blob5Value = `skip:${metrics.skipReason}`;
  } else {
    blob5Value = metrics.success ? 'success' : 'cron_error';
  }

  safeWriteDataPoint(analytics, {
    indexes: [`cron:${today}`],
    blobs: [
      'cron',                     // blob1: endpoint
      '',                         // blob2: method (N/A)
      '',                         // blob3: store_id (N/A)
      metrics.success ? '2xx' : '5xx', // blob4: status_category
      blob5Value,                 // blob5: error_type or skip_reason
      '',                         // blob6: client_id (N/A)
      'cron',                     // blob7: event_type
      '',                         // blob8: enrichment_source (N/A)
    ],
    doubles: [
      metrics.durationMs,         // double1: response_time_ms (cron duration)
      1,                          // double2: request_count (execution count)
      0,                          // double3: beers_returned (N/A)
      metrics.beersQueued,        // double4: enrichment_count (beers queued)
      0,                          // double5: cache_hit (N/A)
      metrics.success ? 0 : 1,    // double6: error_count
      0,                          // double7: rate_limit_triggered
      0,                          // double8: upstream_latency_ms
      metrics.dailyRemaining,     // double9: daily_remaining
      metrics.monthlyRemaining,   // double10: monthly_remaining
    ],
  });
}

/**
 * Track a rate limit event separately for detailed rate limit monitoring.
 * This is called in addition to trackRequest when a rate limit is triggered.
 *
 * Index: "ratelimit:{client_id}" for per-client rate limit analysis
 */
export function trackRateLimit(
  analytics: AnalyticsEngineDataset | undefined,
  clientId: string,
  endpoint: string
): void {
  safeWriteDataPoint(analytics, {
    indexes: [`ratelimit:${clientId}`],
    blobs: [
      endpoint,                   // blob1: endpoint
      '',                         // blob2: method (N/A)
      '',                         // blob3: store_id (N/A)
      '4xx',                      // blob4: status_category (429 is a 4xx)
      'rate_limit',               // blob5: error_type
      clientId,                   // blob6: client_id
      'rate_limit',               // blob7: event_type
      '',                         // blob8: enrichment_source (N/A)
    ],
    doubles: [
      0,                          // double1: response_time_ms
      1,                          // double2: request_count
      0,                          // double3: beers_returned
      0,                          // double4: enrichment_count
      0,                          // double5: cache_hit
      1,                          // double6: error_count
      1,                          // double7: rate_limit_triggered
      0,                          // double8: upstream_latency_ms
    ],
  });
}

/**
 * Metrics for tracking admin DLQ operations.
 */
export type AdminDlqMetrics = {
  readonly operation: 'dlq_list' | 'dlq_replay' | 'dlq_acknowledge' | 'dlq_stats';
  readonly success: boolean;
  readonly messageCount: number;
  readonly durationMs: number;
  readonly errorType?: string | undefined;
};

/**
 * Metrics for tracking DLQ consumer operations (storing messages to D1).
 */
export type DlqConsumerMetrics = {
  readonly beerId: string;
  readonly attempts: number;
  readonly sourceQueue: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly errorType?: string | undefined;
};

/**
 * Track admin DLQ operations for audit and monitoring.
 *
 * Index: "admin:{operation}" for grouping by admin operation type
 */
export function trackAdminDlq(
  analytics: AnalyticsEngineDataset | undefined,
  metrics: AdminDlqMetrics
): void {
  safeWriteDataPoint(analytics, {
    indexes: [`admin:${metrics.operation}`],
    blobs: [
      `/admin/dlq`,               // blob1: endpoint
      metrics.operation === 'dlq_list' || metrics.operation === 'dlq_stats' ? 'GET' : 'POST', // blob2: method
      '',                         // blob3: store_id (N/A)
      metrics.success ? '2xx' : '5xx', // blob4: status_category
      metrics.errorType || (metrics.success ? 'success' : 'admin_error'), // blob5: error_type
      '',                         // blob6: client_id (admin ops are privileged)
      'admin',                    // blob7: event_type
      '',                         // blob8: enrichment_source (N/A)
    ],
    doubles: [
      metrics.durationMs,         // double1: response_time_ms
      1,                          // double2: request_count
      0,                          // double3: beers_returned
      metrics.messageCount,       // double4: enrichment_count (repurposed for message count)
      0,                          // double5: cache_hit
      metrics.success ? 0 : 1,    // double6: error_count
      0,                          // double7: rate_limit_triggered
      0,                          // double8: upstream_latency_ms
    ],
  });
}

/**
 * Track DLQ consumer operations (storing failed messages to D1).
 *
 * Index: "dlq_consumer:{source_queue}" for grouping by source queue
 */
export function trackDlqConsumer(
  analytics: AnalyticsEngineDataset | undefined,
  metrics: DlqConsumerMetrics
): void {
  safeWriteDataPoint(analytics, {
    indexes: [`dlq_consumer:${metrics.sourceQueue}`],
    blobs: [
      'dlq_consumer',             // blob1: endpoint (pseudo-endpoint for queue consumer)
      '',                         // blob2: method (N/A)
      '',                         // blob3: store_id (N/A)
      metrics.success ? '2xx' : '5xx', // blob4: status_category
      metrics.errorType || (metrics.success ? 'success' : 'dlq_store_error'), // blob5: error_type
      '',                         // blob6: client_id (N/A)
      'dlq_consumer',             // blob7: event_type
      '',                         // blob8: enrichment_source (N/A)
    ],
    doubles: [
      metrics.durationMs,         // double1: response_time_ms (store duration)
      1,                          // double2: request_count (message count)
      0,                          // double3: beers_returned (N/A)
      metrics.attempts,           // double4: enrichment_count (repurposed for attempt count)
      0,                          // double5: cache_hit (N/A)
      metrics.success ? 0 : 1,    // double6: error_count
      0,                          // double7: rate_limit_triggered
      0,                          // double8: upstream_latency_ms
    ],
  });
}

/**
 * Metrics for tracking admin enrichment trigger operations.
 */
export type AdminTriggerMetrics = {
  readonly beersQueued: number;
  readonly dailyRemaining: number;
  readonly monthlyRemaining: number;
  readonly durationMs: number;
  readonly success: boolean;
  /** Reason for skipping enrichment (non-error early exit) */
  readonly skipReason?: 'kill_switch' | 'daily_limit' | 'monthly_limit' | 'no_eligible_beers' | undefined;
  /** Error type for actual failures */
  readonly errorType?: string | undefined;
};

/**
 * Metrics for tracking admin cleanup trigger operations.
 */
export type CleanupTriggerMetrics = {
  readonly action: string;
  readonly mode: string;
  readonly beersQueued: number;
  readonly beersSkipped: number;
  readonly beersReset: number;
  readonly durationMs: number;
  readonly dryRun: boolean;
};

/**
 * Track admin cleanup trigger operations.
 *
 * Index: "admin:cleanup_trigger" for grouping cleanup trigger operations
 */
export function trackCleanupTrigger(
  analytics: AnalyticsEngineDataset | undefined,
  metrics: CleanupTriggerMetrics
): void {
  safeWriteDataPoint(analytics, {
    indexes: [metrics.dryRun ? 'dry_run' : 'execute'],
    blobs: [
      metrics.action,               // blob1: action (cleanup_trigger)
      metrics.mode,                 // blob2: mode (all, missing)
    ],
    doubles: [
      metrics.beersQueued,          // double1: beers_queued
      metrics.beersSkipped,         // double2: beers_skipped
      metrics.beersReset,           // double3: beers_reset
      metrics.durationMs,           // double4: duration_ms
    ],
  });
}

/**
 * Track admin enrichment trigger operations.
 *
 * Index: "admin:enrich_trigger" for grouping trigger operations
 */
export function trackAdminTrigger(
  analytics: AnalyticsEngineDataset | undefined,
  metrics: AdminTriggerMetrics
): void {
  // Determine blob5 value: skipReason for non-error exits, errorType for actual errors
  let blob5Value: string;
  if (metrics.errorType) {
    blob5Value = metrics.errorType;
  } else if (metrics.skipReason) {
    blob5Value = `skip:${metrics.skipReason}`;
  } else {
    blob5Value = metrics.success ? 'success' : 'trigger_error';
  }

  safeWriteDataPoint(analytics, {
    indexes: ['admin:enrich_trigger'],
    blobs: [
      '/admin/enrich/trigger',    // blob1: endpoint
      'POST',                     // blob2: method
      '',                         // blob3: store_id (N/A for now)
      metrics.success ? '2xx' : '5xx', // blob4: status_category
      blob5Value,                 // blob5: error_type or skip_reason
      '',                         // blob6: client_id (admin ops are privileged)
      'admin_trigger',            // blob7: event_type
      '',                         // blob8: enrichment_source (N/A)
    ],
    doubles: [
      metrics.durationMs,         // double1: response_time_ms
      1,                          // double2: request_count
      0,                          // double3: beers_returned
      metrics.beersQueued,        // double4: enrichment_count (beers queued)
      0,                          // double5: cache_hit
      metrics.success ? 0 : 1,    // double6: error_count
      0,                          // double7: rate_limit_triggered
      0,                          // double8: upstream_latency_ms
      metrics.dailyRemaining,     // double9: daily_remaining
      metrics.monthlyRemaining,   // double10: monthly_remaining
    ],
  });
}
