/**
 * Tests for application-wide constants.
 *
 * Documents the exact values of all exported constants from src/constants.ts.
 * These tests catch inadvertent changes to values that affect business logic
 * across the codebase (cleanup thresholds, ABV validation, rate limiting, etc.).
 */

import { describe, it, expect } from 'vitest';
import {
  MIN_CLEANUP_LENGTH_RATIO,
  MAX_CLEANUP_LENGTH_RATIO,
  ABV_CONFIDENCE_FROM_DESCRIPTION,
  ABV_CONFIDENCE_FROM_PERPLEXITY,
  MAX_BEER_ABV,
  MIN_BEER_ABV,
  AUDIT_RETENTION_DAYS,
  AUDIT_REAP_LIMIT,
  ADMIN_AUDIT_MAX_TARGET_IDS,
  RATE_LIMIT_REAP_LIMIT,
  D1_MAX_PARAMS_PER_STATEMENT,
  D1_MAX_STATEMENTS_PER_BATCH,
  SYNC_BODY_MAX_BYTES,
  SMALL_JSON_BODY_MAX_BYTES,
  MAX_PROMPT_DESCRIPTION_LENGTH,
  MAX_CLEANED_OUTPUT_LENGTH,
  MAX_PROMPT_FIELD_LENGTH,
  MAX_PERPLEXITY_RESPONSE_BYTES,
  MAX_LOGGED_ERROR_BODY_LENGTH,
  MAX_DLQ_CONSUMER_ATTEMPTS,
  MAX_FLYING_SAUCER_FIELD_LENGTH,
  MAX_FLYING_SAUCER_RESPONSE_ITEMS,
  MAX_FLYING_SAUCER_RECORD_SERIALIZED_BYTES,
  FLYING_SAUCER_RESPONSE_MAX_BYTES,
  CORS_PREFLIGHT_ROUTES,
  CORS_ALLOWED_REQUEST_HEADERS,
} from '../src/constants';
import { SYNC_CONSTANTS } from '../src/types';
import { BATCH_MAX_IDS, BATCH_ID_MAX_LENGTH } from '../src/schemas/request';

describe('AI cleanup constants', () => {
  it('should set MIN_CLEANUP_LENGTH_RATIO to 0.7', () => {
    expect(MIN_CLEANUP_LENGTH_RATIO).toBe(0.7);
  });

  it('should set MAX_CLEANUP_LENGTH_RATIO to 1.1', () => {
    expect(MAX_CLEANUP_LENGTH_RATIO).toBe(1.1);
  });

  it('should set ABV_CONFIDENCE_FROM_DESCRIPTION to 0.9', () => {
    expect(ABV_CONFIDENCE_FROM_DESCRIPTION).toBe(0.9);
  });

  it('should set ABV_CONFIDENCE_FROM_PERPLEXITY to 0.7', () => {
    expect(ABV_CONFIDENCE_FROM_PERPLEXITY).toBe(0.7);
  });
});

describe('ABV validation constants', () => {
  it('should set MAX_BEER_ABV to 70', () => {
    expect(MAX_BEER_ABV).toBe(70);
  });

  it('should set MIN_BEER_ABV to 0', () => {
    expect(MIN_BEER_ABV).toBe(0);
  });
});

describe('audit and cleanup constants', () => {
  it('should set AUDIT_RETENTION_DAYS to 30', () => {
    expect(AUDIT_RETENTION_DAYS).toBe(30);
  });

  it('should set AUDIT_REAP_LIMIT to 10,000', () => {
    expect(AUDIT_REAP_LIMIT).toBe(10_000);
  });

  it('should set ADMIN_AUDIT_MAX_TARGET_IDS to 100', () => {
    expect(ADMIN_AUDIT_MAX_TARGET_IDS).toBe(100);
  });

  it('should set RATE_LIMIT_REAP_LIMIT to 10,000', () => {
    expect(RATE_LIMIT_REAP_LIMIT).toBe(10_000);
  });
});

describe('AI cleanup prompt/output bounds', () => {
  it('should set MAX_PROMPT_DESCRIPTION_LENGTH to 3000', () => {
    expect(MAX_PROMPT_DESCRIPTION_LENGTH).toBe(3000);
  });

  it('should set MAX_CLEANED_OUTPUT_LENGTH to 3200', () => {
    expect(MAX_CLEANED_OUTPUT_LENGTH).toBe(3200);
  });
});

describe('Perplexity constants', () => {
  it('should set MAX_PROMPT_FIELD_LENGTH to 300', () => {
    expect(MAX_PROMPT_FIELD_LENGTH).toBe(300);
  });

  it('should set MAX_PERPLEXITY_RESPONSE_BYTES to 32 KiB', () => {
    expect(MAX_PERPLEXITY_RESPONSE_BYTES).toBe(32 * 1024);
  });

  it('should set MAX_LOGGED_ERROR_BODY_LENGTH to 500', () => {
    expect(MAX_LOGGED_ERROR_BODY_LENGTH).toBe(500);
  });
});

describe('DLQ consumer constants', () => {
  it('should set MAX_DLQ_CONSUMER_ATTEMPTS to 3, matching wrangler.jsonc max_retries', () => {
    // wrangler.jsonc sets max_retries: 3 for both beer-enrichment-dlq and
    // description-cleanup-dlq consumers -- this constant must stay in sync.
    expect(MAX_DLQ_CONSUMER_ATTEMPTS).toBe(3);
  });
});

describe('Flying Saucer upstream bounds', () => {
  it('should set MAX_FLYING_SAUCER_FIELD_LENGTH to 5000', () => {
    expect(MAX_FLYING_SAUCER_FIELD_LENGTH).toBe(5000);
  });

  it('should set MAX_FLYING_SAUCER_RESPONSE_ITEMS to 5000', () => {
    expect(MAX_FLYING_SAUCER_RESPONSE_ITEMS).toBe(5000);
  });

  it('should set MAX_FLYING_SAUCER_RECORD_SERIALIZED_BYTES to 20,000', () => {
    expect(MAX_FLYING_SAUCER_RECORD_SERIALIZED_BYTES).toBe(20_000);
  });
});

describe('CORS preflight contract constants', () => {
  it('lists /beers, /beers/batch, /beers/sync with their allowed methods', () => {
    expect(CORS_PREFLIGHT_ROUTES).toEqual({
      '/beers': 'GET',
      '/beers/batch': 'POST',
      '/beers/sync': 'POST',
    });
  });

  it('allows content-type and x-api-key request headers', () => {
    expect(CORS_ALLOWED_REQUEST_HEADERS.has('content-type')).toBe(true);
    expect(CORS_ALLOWED_REQUEST_HEADERS.has('x-api-key')).toBe(true);
    expect(CORS_ALLOWED_REQUEST_HEADERS.size).toBe(2);
  });
});

describe('D1 batching constants', () => {
  it('should set D1_MAX_PARAMS_PER_STATEMENT to 90', () => {
    expect(D1_MAX_PARAMS_PER_STATEMENT).toBe(90);
  });

  it('should set D1_MAX_STATEMENTS_PER_BATCH to 100', () => {
    expect(D1_MAX_STATEMENTS_PER_BATCH).toBe(100);
  });
});

// =============================================================================
// Inbound JSON Body Limit Fixtures
// =============================================================================
//
// These fixtures are the live justification cited in the SYNC_BODY_MAX_BYTES
// and SMALL_JSON_BODY_MAX_BYTES doc comments in src/constants.ts. They
// reconstruct the worst-case legitimate request for each route and measure
// its real UTF-8 wire size, so the chosen byte limits stay honest as the
// underlying schema bounds (SYNC_CONSTANTS, BATCH_MAX_IDS, ...) evolve.
//
// Every string field is filled with a triple-byte-per-UTF-16-code-unit BMP
// character ("中", U+4E2D -- 3 bytes in UTF-8, 1 UTF-16 code unit, no
// surrogate pair) rather than ASCII. Zod's `.max()` counts UTF-16 code
// units, not bytes, so an all-ASCII fixture would understate the true
// worst-case wire size for any legitimate multibyte content (accented
// names, non-Latin brewery names, emoji, etc.).

/** Worst-case-byte-expansion character: 3 UTF-8 bytes per 1 UTF-16 code unit. */
const WORST_CASE_CHAR = '中';

describe('SYNC_BODY_MAX_BYTES fixture', () => {
  it('is derived with explicit headroom above the worst-case legitimate /beers/sync request', () => {
    const beer = {
      id: WORST_CASE_CHAR.repeat(SYNC_CONSTANTS.MAX_ID_LENGTH),
      brew_name: WORST_CASE_CHAR.repeat(SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH),
      // brewer is bounded to the same length as brew_name (see
      // SyncBeerItemSchema in src/schemas/request.ts).
      brewer: WORST_CASE_CHAR.repeat(SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH),
      brew_description: WORST_CASE_CHAR.repeat(SYNC_CONSTANTS.MAX_DESC_LENGTH),
    };
    const beers = Array.from({ length: SYNC_CONSTANTS.MAX_BATCH_SIZE }, () => beer);
    const payload = JSON.stringify({ beers });
    const measuredBytes = new TextEncoder().encode(payload).length;

    // The number this test protects: the constant's doc comment cites this
    // exact measured value. If the fixture's inputs change, update both.
    expect(measuredBytes).toBe(370_461);

    // The chosen limit must exceed the measured worst case with real
    // headroom -- not just barely clear it.
    expect(SYNC_BODY_MAX_BYTES).toBeGreaterThan(measuredBytes);
    const headroomRatio = SYNC_BODY_MAX_BYTES / measuredBytes;
    expect(headroomRatio).toBeGreaterThan(1.2); // at least 20% headroom
  });
});

describe('FLYING_SAUCER_RESPONSE_MAX_BYTES fixture', () => {
  it('is derived with explicit headroom above a measured realistic Flying Saucer taplist response', () => {
    // Real taplists are "at most a few hundred beers" (see
    // MAX_FLYING_SAUCER_RESPONSE_ITEMS's doc comment in src/constants.ts).
    // 500 beers already doubles that. Field set and lengths mirror the real
    // Flying Saucer response shape recorded in contract-test/fixtures.ts
    // (id, brew_name, brewer, brewer_loc, brew_style, brew_container,
    // review_count, review_rating, brew_description, added_date), sized
    // generously for real content (a beer description a few hundred
    // characters, not the schema's 5000-char defensive ceiling).
    const REALISTIC_ITEM_COUNT = 500;
    const beer = {
      id: WORST_CASE_CHAR.repeat(10),
      brew_name: WORST_CASE_CHAR.repeat(60),
      brewer: WORST_CASE_CHAR.repeat(40),
      brewer_loc: WORST_CASE_CHAR.repeat(30),
      brew_style: WORST_CASE_CHAR.repeat(30),
      brew_container: WORST_CASE_CHAR.repeat(15),
      review_count: WORST_CASE_CHAR.repeat(5),
      review_rating: WORST_CASE_CHAR.repeat(6),
      brew_description: WORST_CASE_CHAR.repeat(600),
      added_date: WORST_CASE_CHAR.repeat(10),
    };
    const beers = Array.from({ length: REALISTIC_ITEM_COUNT }, () => beer);
    // Matches the real upstream envelope: [{...metadata}, {brewInStock: [...]}]
    const payload = JSON.stringify([{ store_info: 'metadata' }, { brewInStock: beers }]);
    const measuredBytes = new TextEncoder().encode(payload).length;

    // The number this test protects: the constant's doc comment cites this
    // exact measured value. If the fixture's inputs change, update both.
    expect(measuredBytes).toBe(1_291_045);

    expect(FLYING_SAUCER_RESPONSE_MAX_BYTES).toBeGreaterThan(measuredBytes);
    const headroomRatio = FLYING_SAUCER_RESPONSE_MAX_BYTES / measuredBytes;
    expect(headroomRatio).toBeGreaterThan(2); // more than 2x headroom

    // The cap must still reject a hostile/compromised-upstream response far
    // below a real 200 MB attack payload.
    const hostileBytes = 200 * 1024 * 1024;
    expect(FLYING_SAUCER_RESPONSE_MAX_BYTES).toBeLessThan(hostileBytes);
  });
});

describe('SMALL_JSON_BODY_MAX_BYTES fixture', () => {
  it('is derived with explicit headroom above the worst-case legitimate /beers/batch request', () => {
    // /beers/batch is the largest of the "small" routes: BATCH_MAX_IDS ids,
    // each at BATCH_ID_MAX_LENGTH -- larger than DLQ replay/acknowledge's
    // numeric ID arrays or the admin trigger routes' scalar flags.
    const ids = Array.from({ length: BATCH_MAX_IDS }, () => WORST_CASE_CHAR.repeat(BATCH_ID_MAX_LENGTH));
    const payload = JSON.stringify({ ids });
    const measuredBytes = new TextEncoder().encode(payload).length;

    expect(measuredBytes).toBe(15_309);

    expect(SMALL_JSON_BODY_MAX_BYTES).toBeGreaterThan(measuredBytes);
    const headroomRatio = SMALL_JSON_BODY_MAX_BYTES / measuredBytes;
    expect(headroomRatio).toBeGreaterThan(4); // more than 4x headroom
  });
});
