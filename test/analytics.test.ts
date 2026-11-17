/**
 * Unit tests for analytics tracking functions.
 *
 * @module test/analytics.test
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  trackRequest,
  trackEnrichment,
  trackCron,
  trackRateLimit,
  trackAdminDlq,
  trackDlqConsumer,
  trackAdminTrigger,
  trackCleanupTrigger,
  trackUsageIngest,
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

const getMockAnalytics = (): { writeDataPoint: Mock } => ({
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
  beersReset: 0,
  durationMs: 150,
  dryRun: false,
  ...overrides,
});

// ============================================================================
// Whole data points
//
// Each input uses distinct values for every field it controls, so swapping
// any two slots that can differ fails a test. Trackers that derive a slot
// from success get a successful and a failed input.
// ============================================================================

const NOW = new Date('2026-03-01T18:30:00Z');

function writtenBy(track: (analytics: AnalyticsEngineDataset) => void): unknown {
  const analytics = getMockAnalytics();
  track(analytics);
  expect(analytics.writeDataPoint).toHaveBeenCalledTimes(1);
  return analytics.writeDataPoint.mock.calls[0]![0];
}

describe('the full data point each tracker writes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { statusCode: 200, category: '2xx', errorType: 'success', errorCount: 0, rateLimited: 0, endpoint: '/beers', method: 'GET', storeId: '13879', clientId: 'client-abc', cacheOutcome: 'stale', responseTimeMs: 123, beersReturned: 37, upstreamLatencyMs: 88 },
    { statusCode: 500, category: '5xx', errorType: 'server_error', errorCount: 1, rateLimited: 0, endpoint: '/beers/batch', method: 'POST', storeId: '13885', clientId: 'client-def', cacheOutcome: 'miss', responseTimeMs: 456, beersReturned: 12, upstreamLatencyMs: 99 },
    { statusCode: 429, category: '4xx', errorType: 'rate_limit', errorCount: 1, rateLimited: 1, endpoint: '/health', method: 'HEAD', storeId: '13886', clientId: 'client-ghi', cacheOutcome: 'bypass', responseTimeMs: 789, beersReturned: 5, upstreamLatencyMs: 77 },
  ] as const)('trackRequest with status $statusCode', (c) => {
    const written = writtenBy(a => trackRequest(a, {
      endpoint: c.endpoint,
      method: c.method,
      storeId: c.storeId,
      statusCode: c.statusCode,
      clientId: c.clientId,
      responseTimeMs: c.responseTimeMs,
      beersReturned: c.beersReturned,
      cacheOutcome: c.cacheOutcome,
      upstreamLatencyMs: c.upstreamLatencyMs,
    }));

    expect(written).toEqual({
      indexes: [`${c.clientId}:${c.endpoint}`],
      blobs: [c.endpoint, c.method, c.storeId, c.category, c.errorType, c.clientId, 'request', '', c.cacheOutcome],
      doubles: [c.responseTimeMs, 1, c.beersReturned, 0, 0, c.errorCount, c.rateLimited, c.upstreamLatencyMs],
    });
  });

  it.each([
    ['perplexity', true, 450, '2xx', 'success', 0, 0],
    ['cache', true, 560, '2xx', 'success', 1, 0],
    ['exa', false, 670, '5xx', 'enrichment_fail', 0, 1],
  ] as const)('trackEnrichment from %s, success %s', (source, success, durationMs, category, errorType, cacheHit, errorCount) => {
    const written = writtenBy(a => trackEnrichment(a, { beerId: 'beer-123', source, success, durationMs }));

    expect(written).toEqual({
      indexes: [`enrichment:${source}`],
      blobs: ['', '', '', category, errorType, '', 'enrichment', source],
      doubles: [durationMs, 1, 0, 1, cacheHit, errorCount, 0, 0],
    });
  });

  it.each([
    { success: true, now: '2026-03-01T18:30:00Z', day: '2026-03-01', category: '2xx', outcome: 'success', errorCount: 0, beersQueued: 7, dailyRemaining: 490, monthlyRemaining: 1990, durationMs: 2000 },
    { success: false, now: '2026-04-02T06:15:00Z', day: '2026-04-02', category: '5xx', outcome: 'cron_error', errorCount: 1, beersQueued: 8, dailyRemaining: 380, monthlyRemaining: 1880, durationMs: 3000 },
  ])('trackCron with success $success', (c) => {
    vi.setSystemTime(new Date(c.now));
    const written = writtenBy(a => trackCron(a, {
      beersQueued: c.beersQueued, dailyRemaining: c.dailyRemaining, monthlyRemaining: c.monthlyRemaining, durationMs: c.durationMs, success: c.success,
    }));

    expect(written).toEqual({
      indexes: [`cron:${c.day}`],
      blobs: ['cron', '', '', c.category, c.outcome, '', 'cron', ''],
      doubles: [c.durationMs, 1, 0, c.beersQueued, 0, c.errorCount, 0, 0, c.dailyRemaining, c.monthlyRemaining],
    });
  });

  it.each([
    ['client-abc', '/beers'],
    ['client-def', '/beers/batch'],
  ])('trackRateLimit for %s on %s', (clientId, endpoint) => {
    expect(writtenBy(a => trackRateLimit(a, clientId, endpoint))).toEqual({
      indexes: [`ratelimit:${clientId}`],
      blobs: [endpoint, '', '', '4xx', 'rate_limit', clientId, 'rate_limit', ''],
      doubles: [0, 1, 0, 0, 0, 1, 1, 0],
    });
  });

  it.each([
    ['dlq_replay', true, 'POST', '2xx', 'success', 0, 12, 34],
    ['dlq_list', false, 'GET', '5xx', 'admin_error', 1, 23, 45],
  ] as const)('trackAdminDlq %s with success %s', (operation, success, method, category, outcome, errorCount, messageCount, durationMs) => {
    const written = writtenBy(a => trackAdminDlq(a, { operation, success, messageCount, durationMs }));

    expect(written).toEqual({
      indexes: [`admin:${operation}`],
      blobs: ['/admin/dlq', method, '', category, outcome, '', 'admin', ''],
      doubles: [durationMs, 1, 0, messageCount, 0, errorCount, 0, 0],
    });
  });

  it.each([
    [true, 'beer-enrichment', '2xx', 'success', 0, 4, 50],
    [false, 'description-cleanup', '5xx', 'dlq_store_error', 1, 5, 60],
  ])('trackDlqConsumer with success %s from %s', (success, sourceQueue, category, outcome, errorCount, attempts, durationMs) => {
    const written = writtenBy(a => trackDlqConsumer(a, { beerId: 'beer-abc', attempts, sourceQueue, success, durationMs }));

    expect(written).toEqual({
      indexes: [`dlq_consumer:${sourceQueue}`],
      blobs: ['dlq_consumer', '', '', category, outcome, '', 'dlq_consumer', ''],
      doubles: [durationMs, 1, 0, attempts, 0, errorCount, 0, 0],
    });
  });

  it.each([
    { success: true, category: '2xx', outcome: 'success', errorCount: 0, beersQueued: 25, dailyRemaining: 475, monthlyRemaining: 1975, durationMs: 300 },
    { success: false, category: '5xx', outcome: 'trigger_error', errorCount: 1, beersQueued: 26, dailyRemaining: 365, monthlyRemaining: 1865, durationMs: 400 },
  ])('trackAdminTrigger with success $success', (c) => {
    const written = writtenBy(a => trackAdminTrigger(a, {
      beersQueued: c.beersQueued, dailyRemaining: c.dailyRemaining, monthlyRemaining: c.monthlyRemaining, durationMs: c.durationMs, success: c.success,
    }));

    expect(written).toEqual({
      indexes: ['admin:enrich_trigger'],
      blobs: ['/admin/enrich/trigger', 'POST', '', c.category, c.outcome, '', 'admin_trigger', ''],
      doubles: [c.durationMs, 1, 0, c.beersQueued, 0, c.errorCount, 0, 0, c.dailyRemaining, c.monthlyRemaining],
    });
  });

  it.each([
    { action: 'cleanup_trigger', mode: 'all', beersQueued: 99, beersReset: 3, durationMs: 999, dryRun: false, index: 'execute' },
    { action: 'cleanup_preview', mode: 'missing', beersQueued: 88, beersReset: 4, durationMs: 777, dryRun: true, index: 'dry_run' },
  ])('trackCleanupTrigger $action in $mode mode', (c) => {
    const written = writtenBy(a => trackCleanupTrigger(a, {
      action: c.action, mode: c.mode, beersQueued: c.beersQueued, beersReset: c.beersReset, durationMs: c.durationMs, dryRun: c.dryRun,
    }));

    expect(written).toEqual({
      indexes: [c.index],
      blobs: [c.action, c.mode],
      doubles: [c.beersQueued, 0, c.beersReset, c.durationMs],
    });
  });

  it.each([
    ['daily_post_cap', 5, 3],
    ['new_install_cap', 6, 2],
  ])('trackUsageIngest with outcome %s', (outcome, eventsAccepted, eventsDropped) => {
    const written = writtenBy(a => trackUsageIngest(a, { outcome, eventsAccepted, eventsDropped }));

    expect(written).toEqual({
      indexes: [`usage:${outcome}`],
      blobs: ['/usage', 'POST', '', '2xx', outcome, '', 'usage_ingest', ''],
      doubles: [eventsAccepted, eventsDropped],
    });
  });
});

describe('trackUsageIngest', () => {
  it('does not throw when analytics is undefined', () => {
    expect(() => trackUsageIngest(undefined, { outcome: 'admitted', eventsAccepted: 2, eventsDropped: 0 })).not.toThrow();
  });
});

// ============================================================================
// trackRequest Tests
// ============================================================================

describe('trackRequest', () => {
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

  it('sets double3 (beers_returned) to 0 when beersReturned is undefined', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ beersReturned: undefined }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[2]).toBe(0);
  });

  it('sets blob9 to empty string when cacheOutcome is undefined', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ cacheOutcome: undefined }));
    const blobs = (analytics.writeDataPoint.mock.calls[0]![0] as { blobs: string[] }).blobs;
    expect(blobs[8]).toBe('');
  });

  it('sets double8 (upstream_latency_ms) to 0 when upstreamLatencyMs is undefined', () => {
    const analytics = getMockAnalytics();
    trackRequest(analytics, getRequestMetrics({ upstreamLatencyMs: undefined }));
    const doubles = (analytics.writeDataPoint.mock.calls[0]![0] as { doubles: number[] }).doubles;
    expect(doubles[7]).toBe(0);
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
  it('does not throw when analytics is undefined', () => {
    expect(() => trackEnrichment(undefined, getEnrichmentMetrics())).not.toThrow();
  });
});

// ============================================================================
// trackCron Tests
// ============================================================================

describe('trackCron', () => {
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

  it('does not throw when analytics is undefined', () => {
    expect(() => trackCron(undefined, getCronMetrics())).not.toThrow();
  });
});

// ============================================================================
// trackRateLimit Tests
// ============================================================================

describe('trackRateLimit', () => {
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

  it('does not throw when analytics is undefined', () => {
    expect(() => trackAdminDlq(undefined, getAdminDlqMetrics())).not.toThrow();
  });
});

// ============================================================================
// trackDlqConsumer Tests
// ============================================================================

describe('trackDlqConsumer', () => {
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

  it('does not throw when analytics is undefined', () => {
    expect(() => trackCleanupTrigger(undefined, getCleanupTriggerMetrics())).not.toThrow();
  });
});
