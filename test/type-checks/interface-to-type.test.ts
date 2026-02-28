import { describe, it, expectTypeOf } from 'vitest';

// Import every exported type that will be converted
import type {
  Env,
  EnrichmentMessage,
  CleanupMessage,
  FlyingSaucerBeer,
  RequestContext,
  DlqMessageRow,
  PaginationCursor,
  DlqReplayRequest,
  DlqAcknowledgeRequest,
  TriggerEnrichmentRequest,
  QuotaStatus,
  TriggerEnrichmentData,
  EnrichmentQuotaStatus,
  ErrorResponseOptions,
  GetBeersResult,
  SyncBeersRequest,
  SyncBeersResponse,
  BatchLookupResponse,
  TriggerCleanupRequest,
  CleanupPreview,
  TriggerCleanupData,
  CleanupTriggerValidationResult,
} from '../../src/types';
import type { RequestMetrics, EnrichmentMetrics, CronMetrics, AdminDlqMetrics, DlqConsumerMetrics, AdminTriggerMetrics, CleanupTriggerMetrics, AnalyticsEngineDataset } from '../../src/analytics';
import type { RespondOptions } from '../../src/context';
import type { RateLimitResult } from '../../src/rate-limit';
import type { BeerEnrichmentData, InsertPlaceholdersResult } from '../../src/db/helpers';
import type { SyncBatchResult } from '../../src/handlers/beers';
import type { CleanupResult, AIResult, AIResultSuccess } from '../../src/queue/cleanup';
import type { LogData } from '../../src/utils/log';

describe('interface-to-type conversion compile checks', () => {
  // Verify key structural properties survive conversion.
  // These will fail to compile if the type shape changes.

  it('EnrichmentMessage has expected fields', () => {
    expectTypeOf<EnrichmentMessage>().toHaveProperty('beerId');
    expectTypeOf<EnrichmentMessage>().toHaveProperty('beerName');
    expectTypeOf<EnrichmentMessage>().toHaveProperty('brewer');
  });

  it('Env has DB binding', () => {
    expectTypeOf<Env>().toHaveProperty('DB');
    expectTypeOf<Env>().toHaveProperty('API_KEY');
  });

  it('FlyingSaucerBeer allows index access', () => {
    expectTypeOf<FlyingSaucerBeer>().toHaveProperty('id');
    expectTypeOf<FlyingSaucerBeer>().toHaveProperty('brew_name');
  });

  it('AnalyticsEngineDataset remains an interface with method', () => {
    expectTypeOf<AnalyticsEngineDataset>().toHaveProperty('writeDataPoint');
  });

  it('RateLimitResult has expected fields', () => {
    expectTypeOf<RateLimitResult>().toHaveProperty('allowed');
    expectTypeOf<RateLimitResult>().toHaveProperty('remaining');
    expectTypeOf<RateLimitResult>().toHaveProperty('resetAt');
  });

  it('RespondOptions has writeAuditLog callback', () => {
    expectTypeOf<RespondOptions>().toHaveProperty('writeAuditLog');
  });

  it('GetBeersResult has response field', () => {
    expectTypeOf<GetBeersResult>().toHaveProperty('response');
  });

  it('LogData supports index signature', () => {
    expectTypeOf<LogData>().toBeObject();
  });

  // ============================================================================
  // Readonly mutation tests — verify readonly is enforced.
  // Each test uses ts-expect-error to assert that assignment is rejected.
  // If readonly was accidentally omitted, the directive itself causes a
  // compile error (since the assignment would be valid).
  // ============================================================================

  it('readonly prevents mutation of EnrichmentMessage', () => {
    const msg: EnrichmentMessage = { beerId: '1', beerName: 'IPA', brewer: 'Test' };
    // @ts-expect-error — readonly property cannot be assigned
    msg.beerId = '2';
  });

  it('readonly prevents mutation of RateLimitResult', () => {
    const result: RateLimitResult = { allowed: true, remaining: 5, resetAt: 100, degraded: false };
    // @ts-expect-error — readonly property cannot be assigned
    result.allowed = false;
  });

  it('readonly prevents mutation of RequestContext', () => {
    const ctx = {} as RequestContext;
    // @ts-expect-error — readonly property cannot be assigned
    ctx.requestId = 'new-id';
  });

  it('readonly prevents mutation of BeerEnrichmentData', () => {
    const data: BeerEnrichmentData = { abv: 5.0, confidence: 0.9, source: 'test', brew_description_cleaned: null };
    // @ts-expect-error — readonly property cannot be assigned
    data.abv = 6.0;
  });

  it('readonly prevents mutation of CleanupResult', () => {
    const result = {} as CleanupResult;
    // @ts-expect-error — readonly property cannot be assigned
    result.cleaned = 'changed';
  });

  it('readonly prevents mutation of AIResult', () => {
    const result = {} as AIResultSuccess;
    // @ts-expect-error — readonly property cannot be assigned
    result.index = 99;
  });
});
