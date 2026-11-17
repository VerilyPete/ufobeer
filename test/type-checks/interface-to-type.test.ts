import { describe, it } from 'vitest';

import type { EnrichmentMessage, RequestContext } from '../../src/types';
import type { RateLimitResult } from '../../src/rate-limit';
import type { BeerEnrichmentData } from '../../src/db/helpers';

describe('interface-to-type conversion compile checks', () => {
  // ============================================================================
  // Readonly mutation tests — verify readonly is enforced.
  // Each test uses ts-expect-error to assert that assignment is rejected.
  // If readonly was accidentally omitted, the directive itself causes a
  // compile error (since the assignment would be valid).
  // ============================================================================

  it('readonly prevents mutation of EnrichmentMessage', () => {
    const msg: EnrichmentMessage = { beerId: '1', beerName: 'IPA', brewer: 'Test', descriptionHash: null };
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

});
