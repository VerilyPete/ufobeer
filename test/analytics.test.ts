/**
 * Unit tests for analytics tracking functions.
 *
 * @module test/analytics.test
 */

import { describe, it, expect, vi } from 'vitest';
import {
  trackRequest,
  trackEnrichment,
  trackCron,
  trackRateLimit,
  trackAdminDlq,
  trackDlqConsumer,
  trackAdminTrigger,
  trackCleanupTrigger,
} from '../src/analytics';
import type {
  AnalyticsEngineDataset,
  RequestMetrics,
  EnrichmentMetrics,
  CronMetrics,
  AdminDlqMetrics,
  DlqConsumerMetrics,
  AdminTriggerMetrics,
  CleanupTriggerMetrics,
} from '../src/analytics';

// ============================================================================
// Factory Functions
// ============================================================================

const getMockAnalytics = (): { writeDataPoint: ReturnType<typeof vi.fn> } => ({
  writeDataPoint: vi.fn(),
});

const getRequestMetrics = (overrides?: Partial<RequestMetrics>): RequestMetrics => ({
  endpoint: '/beers',
  method: 'GET',
  storeId: '13879',
  statusCode: 200,
  clientId: 'client-abc',
  responseTimeMs: 123,
  ...overrides,
});

const getEnrichmentMetrics = (overrides?: Partial<EnrichmentMetrics>): EnrichmentMetrics => ({
  beerId: 'beer-123',
  source: 'perplexity',
  success: true,
  durationMs: 450,
  ...overrides,
});

const getCronMetrics = (overrides?: Partial<CronMetrics>): CronMetrics => ({
  beersQueued: 10,
  dailyRemaining: 490,
  monthlyRemaining: 1990,
  durationMs: 2000,
  success: true,
  ...overrides,
});

const getAdminDlqMetrics = (overrides?: Partial<AdminDlqMetrics>): AdminDlqMetrics => ({
  operation: 'dlq_list',
  success: true,
  messageCount: 5,
  durationMs: 100,
  ...overrides,
});

const getDlqConsumerMetrics = (overrides?: Partial<DlqConsumerMetrics>): DlqConsumerMetrics => ({
  beerId: 'beer-abc',
  attempts: 3,
  sourceQueue: 'beer-enrichment',
  success: true,
  durationMs: 50,
  ...overrides,
});

const getAdminTriggerMetrics = (overrides?: Partial<AdminTriggerMetrics>): AdminTriggerMetrics => ({
  beersQueued: 25,
  dailyRemaining: 475,
  monthlyRemaining: 1975,
  durationMs: 300,
  success: true,
  ...overrides,
});

const getCleanupTriggerMetrics = (overrides?: Partial<CleanupTriggerMetrics>): CleanupTriggerMetrics => ({
  action: 'cleanup_trigger',
  mode: 'missing',
  beersQueued: 10,
  beersSkipped: 2,
  beersReset: 0,
  durationMs: 150,
  dryRun: false,
  ...overrides,
});

// ============================================================================
// trackRequest Tests
// ============================================================================

describe('trackRequest', () => {
  it('calls writeDataPoint once with the correct shape', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics());
    expect(analytics.writeDataPoint).toHaveBeenCalledTimes(1);
    const call = analytics.writeDataPoint.mock.calls[0]![0] as {
      indexes: string[];
      blobs: string[];
      doubles: number[];
    };
    expect(call.indexes).toBeDefined();
    expect(call.blobs).toBeDefined();
    expect(call.doubles).toBeDefined();
  });

  // --- blob4 (status_category) via getStatusCategory ---

  it('sets blob4 to "2xx" for status 200', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 200 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('2xx');
  });

  it('sets blob4 to "2xx" for status 201', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 201 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('2xx');
  });

  it('sets blob4 to "3xx" for status 301', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 301 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('3xx');
  });

  it('sets blob4 to "4xx" for status 400', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 400 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('4xx');
  });

  it('sets blob4 to "4xx" for status 429', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 429 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('4xx');
  });

  it('sets blob4 to "5xx" for status 500', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 500 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('5xx');
  });

  it('sets blob4 to "5xx" for status 502', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 502 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('5xx');
  });

  // --- blob5 (error_type) via getErrorType ---

  it('sets blob5 to "success" for status 200', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 200 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('success');
  });

  it('sets blob5 to "rate_limit" for status 429 with no explicit errorType', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 429 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('rate_limit');
  });

  it('sets blob5 to "auth_fail" for status 401', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 401 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('auth_fail');
  });

  it('sets blob5 to "upstream_error" for status 502', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 502 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('upstream_error');
  });

  it('sets blob5 to "client_error" for generic 4xx status 403', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 403 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('client_error');
  });

  it('sets blob5 to "server_error" for generic 5xx status 503', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 503 }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('server_error');
  });

  it('sets blob5 to the explicit errorType when provided, overriding derived type', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 500, errorType: 'custom_error' }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('custom_error');
  });

  // --- doubles ---

  it('sets double6 (error_count) to 1 for status 400', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 400 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[5]).toBe(1);
  });

  it('sets double6 (error_count) to 0 for status 200', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 200 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[5]).toBe(0);
  });

  it('sets double7 (rate_limit_triggered) to 1 for status 429', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 429 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[6]).toBe(1);
  });

  it('sets double7 (rate_limit_triggered) to 0 for status 200', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ statusCode: 200 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[6]).toBe(0);
  });

  it('sets double3 (beers_returned) to 0 when beersReturned is undefined', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ beersReturned: undefined }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[2]).toBe(0);
  });

  it('sets double3 (beers_returned) to the beersReturned value when provided', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ beersReturned: 42 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[2]).toBe(42);
  });

  it('sets blob9 to cacheOutcome value when provided', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ cacheOutcome: 'hit' }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[8]).toBe('hit');
  });

  it('sets blob9 to empty string when cacheOutcome is undefined', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ cacheOutcome: undefined }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[8]).toBe('');
  });

  it('tracks all four cache outcomes in blob9', () => {
    const outcomes = ['hit', 'miss', 'stale', 'bypass'] as const;
    for (const outcome of outcomes) {
      const analytics = getMockAnalytics();
      trackRequest(analytics, getRequestMetrics({ cacheOutcome: outcome }));
      const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
      expect(blobs[8]).toBe(outcome);
    }
  });

  it('sets double8 (upstream_latency_ms) to 0 when upstreamLatencyMs is undefined', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ upstreamLatencyMs: undefined }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[7]).toBe(0);
  });

  it('sets indexes[0] to "${clientId}:${endpoint}"', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ clientId: 'my-client', endpoint: '/health' }));
    const indexes = (analytics.writeDataPoint.mock.calls[0]![0] as { indexes: string[] }).indexes;
    expect(indexes[0]).toBe('my-client:/health');
  });

  it('sets blob3 (store_id) to empty string when storeId is undefined', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ storeId: undefined }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[2]).toBe('');
  });

  // --- null-guard and error-catch (safeWriteDataPoint) ---

  it('does not throw when analytics is undefined', () => {
    expect(() => trackRequest(undefined, getRequestMetrics())).not.toThrow();
  });

  it('does not call writeDataPoint when analytics is undefined', () => {
    const analytics = getMockAnalytics();
    trackRequest(undefined, getRequestMetrics());
    expect(analytics.writeDataPoint).not.toHaveBeenCalled();
  });

  it('does not throw when writeDataPoint throws', () => {
    const analytics = getMockAnalytics();
    analytics.writeDataPoint.mockImplementation(() => {
      throw new Error('write failed');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => trackRequest(analytics, getRequestMetrics())).not.toThrow();
    consoleSpy.mockRestore();
  });
});

// ============================================================================
// trackEnrichment Tests
// ============================================================================

describe('trackEnrichment', () => {
  it('calls writeDataPoint once with correct shape', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics());
    expect(analytics.writeDataPoint).toHaveBeenCalledTimes(1);
    const call = analytics.writeDataPoint.mock.calls[0]![0] as {
      indexes: string[];
      blobs: string[];
      doubles: number[];
    };
    expect(call.indexes).toBeDefined();
    expect(call.blobs).toBeDefined();
    expect(call.doubles).toBeDefined();
  });

  it('sets blob4 to "2xx" when success is true', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics({ success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('2xx');
  });

  it('sets blob4 to "5xx" when success is false', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics({ success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('5xx');
  });

  it('sets blob5 to "success" when success is true', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics({ success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('success');
  });

  it('sets blob5 to "enrichment_fail" when success is false', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics({ success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('enrichment_fail');
  });

  it('sets blob8 (enrichment_source) to "perplexity" when source is "perplexity"', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics({ source: 'perplexity' }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[7]).toBe('perplexity');
  });

  it('sets blob8 (enrichment_source) to "cache" when source is "cache"', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics({ source: 'cache' }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[7]).toBe('cache');
  });

  it('sets double5 (cache_hit) to 1 when source is "cache"', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics({ source: 'cache' }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[4]).toBe(1);
  });

  it('sets double5 (cache_hit) to 0 when source is "perplexity"', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics({ source: 'perplexity' }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[4]).toBe(0);
  });

  it('sets double6 (error_count) to 0 when success is true', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics({ success: true }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[5]).toBe(0);
  });

  it('sets double6 (error_count) to 1 when success is false', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics({ success: false }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[5]).toBe(1);
  });

  it('sets indexes[0] to "enrichment:perplexity" for perplexity source', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics({ source: 'perplexity' }));
    const indexes = (analytics.writeDataPoint.mock.calls[0]![0] as { indexes: string[] }).indexes;
    expect(indexes[0]).toBe('enrichment:perplexity');
  });

  it('sets indexes[0] to "enrichment:cache" for cache source', () => {
    const analytics = getMockAnalytics();
    trackEnrichment(analytics, getEnrichmentMetrics({ source: 'cache' }));
    const indexes = (analytics.writeDataPoint.mock.calls[0]![0] as { indexes: string[] }).indexes;
    expect(indexes[0]).toBe('enrichment:cache');
  });

  it('does not throw when analytics is undefined', () => {
    expect(() => trackEnrichment(undefined, getEnrichmentMetrics())).not.toThrow();
  });
});

// ============================================================================
// trackCron Tests
// ============================================================================

describe('trackCron', () => {
  it('calls writeDataPoint once with correct shape', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics());
    expect(analytics.writeDataPoint).toHaveBeenCalledTimes(1);
    const call = analytics.writeDataPoint.mock.calls[0]![0] as {
      indexes: string[];
      blobs: string[];
      doubles: number[];
    };
    expect(call.indexes).toBeDefined();
    expect(call.blobs).toBeDefined();
    expect(call.doubles).toBeDefined();
  });

  it('sets blob5 to the errorType value when errorType is provided', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics({ errorType: 'timeout_error', success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('timeout_error');
  });

  it('sets blob5 to "skip:kill_switch" when skipReason is "kill_switch"', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics({ skipReason: 'kill_switch', success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('skip:kill_switch');
  });

  it('sets blob5 to "skip:daily_limit" when skipReason is "daily_limit"', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics({ skipReason: 'daily_limit', success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('skip:daily_limit');
  });

  it('sets blob5 to "skip:monthly_limit" when skipReason is "monthly_limit"', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics({ skipReason: 'monthly_limit', success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('skip:monthly_limit');
  });

  it('sets blob5 to "skip:no_beers" when skipReason is "no_beers"', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics({ skipReason: 'no_beers', success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('skip:no_beers');
  });

  it('sets blob5 to "success" when success is true and no errorType or skipReason', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics({ success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('success');
  });

  it('sets blob5 to "cron_error" when success is false and no errorType or skipReason', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics({ success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('cron_error');
  });

  it('gives errorType precedence over skipReason when both are present', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics({ errorType: 'exception', skipReason: 'kill_switch', success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('exception');
  });

  it('sets double9 (daily_remaining) to the dailyRemaining value', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics({ dailyRemaining: 123 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[8]).toBe(123);
  });

  it('sets double10 (monthly_remaining) to the monthlyRemaining value', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics({ monthlyRemaining: 456 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[9]).toBe(456);
  });

  it('sets double4 (beers_queued) to the beersQueued value', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics({ beersQueued: 77 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[3]).toBe(77);
  });

  it('sets indexes[0] starting with "cron:"', () => {
    const analytics = getMockAnalytics();
    trackCron(analytics, getCronMetrics());
    const indexes = (analytics.writeDataPoint.mock.calls[0]![0] as { indexes: string[] }).indexes;
    expect(indexes[0]).toMatch(/^cron:/);
  });

  it('does not throw when analytics is undefined', () => {
    expect(() => trackCron(undefined, getCronMetrics())).not.toThrow();
  });
});

// ============================================================================
// trackRateLimit Tests
// ============================================================================

describe('trackRateLimit', () => {
  it('calls writeDataPoint once', () => {
    const analytics = getMockAnalytics();
    trackRateLimit(analytics, 'client-xyz', '/beers');
    expect(analytics.writeDataPoint).toHaveBeenCalledTimes(1);
  });

  it('sets blob5 to "rate_limit"', () => {
    const analytics = getMockAnalytics();
    trackRateLimit(analytics, 'client-xyz', '/beers');
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('rate_limit');
  });

  it('sets blob4 to "4xx"', () => {
    const analytics = getMockAnalytics();
    trackRateLimit(analytics, 'client-xyz', '/beers');
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('4xx');
  });

  it('sets double7 (rate_limit_triggered) to 1', () => {
    const analytics = getMockAnalytics();
    trackRateLimit(analytics, 'client-xyz', '/beers');
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[6]).toBe(1);
  });

  it('sets double6 (error_count) to 1', () => {
    const analytics = getMockAnalytics();
    trackRateLimit(analytics, 'client-xyz', '/beers');
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[5]).toBe(1);
  });

  it('sets indexes[0] to "ratelimit:${clientId}"', () => {
    const analytics = getMockAnalytics();
    trackRateLimit(analytics, 'client-xyz', '/beers');
    const indexes = (analytics.writeDataPoint.mock.calls[0]![0] as { indexes: string[] }).indexes;
    expect(indexes[0]).toBe('ratelimit:client-xyz');
  });

  it('sets blob1 (endpoint) to the provided endpoint string', () => {
    const analytics = getMockAnalytics();
    trackRateLimit(analytics, 'client-xyz', '/health');
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[0]).toBe('/health');
  });

  it('does not throw when analytics is undefined', () => {
    expect(() => trackRateLimit(undefined, 'client-xyz', '/beers')).not.toThrow();
  });
});

// ============================================================================
// trackAdminDlq Tests
// ============================================================================

describe('trackAdminDlq', () => {
  it('sets blob2 (method) to "GET" for dlq_list operation', () => {
    const analytics = getMockAnalytics();
    trackAdminDlq(analytics, getAdminDlqMetrics({ operation: 'dlq_list' }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[1]).toBe('GET');
  });

  it('sets blob2 (method) to "GET" for dlq_stats operation', () => {
    const analytics = getMockAnalytics();
    trackAdminDlq(analytics, getAdminDlqMetrics({ operation: 'dlq_stats' }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[1]).toBe('GET');
  });

  it('sets blob2 (method) to "POST" for dlq_replay operation', () => {
    const analytics = getMockAnalytics();
    trackAdminDlq(analytics, getAdminDlqMetrics({ operation: 'dlq_replay' }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[1]).toBe('POST');
  });

  it('sets blob2 (method) to "POST" for dlq_acknowledge operation', () => {
    const analytics = getMockAnalytics();
    trackAdminDlq(analytics, getAdminDlqMetrics({ operation: 'dlq_acknowledge' }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[1]).toBe('POST');
  });

  it('sets blob4 to "2xx" when success is true', () => {
    const analytics = getMockAnalytics();
    trackAdminDlq(analytics, getAdminDlqMetrics({ success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('2xx');
  });

  it('sets blob4 to "5xx" when success is false', () => {
    const analytics = getMockAnalytics();
    trackAdminDlq(analytics, getAdminDlqMetrics({ success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('5xx');
  });

  it('sets blob5 to "success" when success is true and no errorType', () => {
    const analytics = getMockAnalytics();
    trackAdminDlq(analytics, getAdminDlqMetrics({ success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('success');
  });

  it('sets blob5 to "admin_error" when success is false and no errorType', () => {
    const analytics = getMockAnalytics();
    trackAdminDlq(analytics, getAdminDlqMetrics({ success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('admin_error');
  });

  it('sets blob5 to the explicit errorType when provided', () => {
    const analytics = getMockAnalytics();
    trackAdminDlq(analytics, getAdminDlqMetrics({ errorType: 'db_timeout', success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('db_timeout');
  });

  it('sets double4 (message_count) to the messageCount value', () => {
    const analytics = getMockAnalytics();
    trackAdminDlq(analytics, getAdminDlqMetrics({ messageCount: 42 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[3]).toBe(42);
  });

  it('sets indexes[0] to "admin:${operation}"', () => {
    const analytics = getMockAnalytics();
    trackAdminDlq(analytics, getAdminDlqMetrics({ operation: 'dlq_replay' }));
    const indexes = (analytics.writeDataPoint.mock.calls[0]![0] as { indexes: string[] }).indexes;
    expect(indexes[0]).toBe('admin:dlq_replay');
  });

  it('does not throw when analytics is undefined', () => {
    expect(() => trackAdminDlq(undefined, getAdminDlqMetrics())).not.toThrow();
  });
});

// ============================================================================
// trackDlqConsumer Tests
// ============================================================================

describe('trackDlqConsumer', () => {
  it('sets blob4 to "2xx" when success is true', () => {
    const analytics = getMockAnalytics();
    trackDlqConsumer(analytics, getDlqConsumerMetrics({ success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('2xx');
  });

  it('sets blob4 to "5xx" when success is false', () => {
    const analytics = getMockAnalytics();
    trackDlqConsumer(analytics, getDlqConsumerMetrics({ success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[3]).toBe('5xx');
  });

  it('sets blob5 to "success" when success is true and no errorType', () => {
    const analytics = getMockAnalytics();
    trackDlqConsumer(analytics, getDlqConsumerMetrics({ success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('success');
  });

  it('sets blob5 to "dlq_store_error" when success is false and no errorType', () => {
    const analytics = getMockAnalytics();
    trackDlqConsumer(analytics, getDlqConsumerMetrics({ success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('dlq_store_error');
  });

  it('sets blob5 to the explicit errorType when provided', () => {
    const analytics = getMockAnalytics();
    trackDlqConsumer(analytics, getDlqConsumerMetrics({ errorType: 'd1_write_fail', success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('d1_write_fail');
  });

  it('sets double4 (attempt count) to the attempts value', () => {
    const analytics = getMockAnalytics();
    trackDlqConsumer(analytics, getDlqConsumerMetrics({ attempts: 7 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[3]).toBe(7);
  });

  it('sets indexes[0] to "dlq_consumer:${sourceQueue}"', () => {
    const analytics = getMockAnalytics();
    trackDlqConsumer(analytics, getDlqConsumerMetrics({ sourceQueue: 'description-cleanup' }));
    const indexes = (analytics.writeDataPoint.mock.calls[0]![0] as { indexes: string[] }).indexes;
    expect(indexes[0]).toBe('dlq_consumer:description-cleanup');
  });

  it('does not throw when analytics is undefined', () => {
    expect(() => trackDlqConsumer(undefined, getDlqConsumerMetrics())).not.toThrow();
  });
});

// ============================================================================
// trackAdminTrigger Tests
// ============================================================================

describe('trackAdminTrigger', () => {
  it('sets blob5 to the errorType when provided', () => {
    const analytics = getMockAnalytics();
    trackAdminTrigger(analytics, getAdminTriggerMetrics({ errorType: 'quota_exceeded', success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('quota_exceeded');
  });

  it('sets blob5 to "skip:kill_switch" when skipReason is "kill_switch"', () => {
    const analytics = getMockAnalytics();
    trackAdminTrigger(analytics, getAdminTriggerMetrics({ skipReason: 'kill_switch', success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('skip:kill_switch');
  });

  it('sets blob5 to "skip:daily_limit" when skipReason is "daily_limit"', () => {
    const analytics = getMockAnalytics();
    trackAdminTrigger(analytics, getAdminTriggerMetrics({ skipReason: 'daily_limit', success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('skip:daily_limit');
  });

  it('sets blob5 to "skip:monthly_limit" when skipReason is "monthly_limit"', () => {
    const analytics = getMockAnalytics();
    trackAdminTrigger(analytics, getAdminTriggerMetrics({ skipReason: 'monthly_limit', success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('skip:monthly_limit');
  });

  it('sets blob5 to "skip:no_eligible_beers" when skipReason is "no_eligible_beers"', () => {
    const analytics = getMockAnalytics();
    trackAdminTrigger(analytics, getAdminTriggerMetrics({ skipReason: 'no_eligible_beers', success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('skip:no_eligible_beers');
  });

  it('sets blob5 to "success" when success is true and no errorType or skipReason', () => {
    const analytics = getMockAnalytics();
    trackAdminTrigger(analytics, getAdminTriggerMetrics({ success: true }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('success');
  });

  it('sets blob5 to "trigger_error" when success is false and no errorType or skipReason', () => {
    const analytics = getMockAnalytics();
    trackAdminTrigger(analytics, getAdminTriggerMetrics({ success: false }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[4]).toBe('trigger_error');
  });

  it('sets double9 to the dailyRemaining value', () => {
    const analytics = getMockAnalytics();
    trackAdminTrigger(analytics, getAdminTriggerMetrics({ dailyRemaining: 333 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[8]).toBe(333);
  });

  it('sets double10 to the monthlyRemaining value', () => {
    const analytics = getMockAnalytics();
    trackAdminTrigger(analytics, getAdminTriggerMetrics({ monthlyRemaining: 888 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[9]).toBe(888);
  });

  it('sets double4 to the beersQueued value', () => {
    const analytics = getMockAnalytics();
    trackAdminTrigger(analytics, getAdminTriggerMetrics({ beersQueued: 50 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[3]).toBe(50);
  });

  it('sets indexes[0] to "admin:enrich_trigger"', () => {
    const analytics = getMockAnalytics();
    trackAdminTrigger(analytics, getAdminTriggerMetrics());
    const indexes = (analytics.writeDataPoint.mock.calls[0]![0] as { indexes: string[] }).indexes;
    expect(indexes[0]).toBe('admin:enrich_trigger');
  });

  it('does not throw when analytics is undefined', () => {
    expect(() => trackAdminTrigger(undefined, getAdminTriggerMetrics())).not.toThrow();
  });
});

// ============================================================================
// trackCleanupTrigger Tests
// ============================================================================

describe('trackCleanupTrigger', () => {
  it('sets indexes[0] to "execute" when dryRun is false', () => {
    const analytics = getMockAnalytics();
    trackCleanupTrigger(analytics, getCleanupTriggerMetrics({ dryRun: false }));
    const indexes = (analytics.writeDataPoint.mock.calls[0]![0] as { indexes: string[] }).indexes;
    expect(indexes[0]).toBe('execute');
  });

  it('sets indexes[0] to "dry_run" when dryRun is true', () => {
    const analytics = getMockAnalytics();
    trackCleanupTrigger(analytics, getCleanupTriggerMetrics({ dryRun: true }));
    const indexes = (analytics.writeDataPoint.mock.calls[0]![0] as { indexes: string[] }).indexes;
    expect(indexes[0]).toBe('dry_run');
  });

  it('sets blob1 to the action value', () => {
    const analytics = getMockAnalytics();
    trackCleanupTrigger(analytics, getCleanupTriggerMetrics({ action: 'cleanup_trigger' }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[0]).toBe('cleanup_trigger');
  });

  it('sets blob2 to the mode value', () => {
    const analytics = getMockAnalytics();
    trackCleanupTrigger(analytics, getCleanupTriggerMetrics({ mode: 'all' }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[1]).toBe('all');
  });

  it('sets double1 to the beersQueued value', () => {
    const analytics = getMockAnalytics();
    trackCleanupTrigger(analytics, getCleanupTriggerMetrics({ beersQueued: 99 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[0]).toBe(99);
  });

  it('sets double2 to the beersSkipped value', () => {
    const analytics = getMockAnalytics();
    trackCleanupTrigger(analytics, getCleanupTriggerMetrics({ beersSkipped: 5 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[1]).toBe(5);
  });

  it('sets double3 to the beersReset value', () => {
    const analytics = getMockAnalytics();
    trackCleanupTrigger(analytics, getCleanupTriggerMetrics({ beersReset: 3 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[2]).toBe(3);
  });

  it('sets double4 to the durationMs value', () => {
    const analytics = getMockAnalytics();
    trackCleanupTrigger(analytics, getCleanupTriggerMetrics({ durationMs: 999 }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[3]).toBe(999);
  });

  it('does not throw when analytics is undefined', () => {
    expect(() => trackCleanupTrigger(undefined, getCleanupTriggerMetrics())).not.toThrow();
  });
});
