/**
 * Worst-case size fixtures for the inbound and upstream byte limits in
 * src/constants.ts. Each measures the largest legitimate payload and checks
 * the limit leaves headroom above it. Constants that change behaviour are
 * tested through that behaviour, not by restating their values here.
 */

import { describe, it, expect } from 'vitest';
import {
  SYNC_BODY_MAX_BYTES,
  SMALL_JSON_BODY_MAX_BYTES,
  FLYING_SAUCER_RESPONSE_MAX_BYTES,
} from '../src/constants';
import { SYNC_CONSTANTS } from '../src/types';
import { BATCH_MAX_IDS, BATCH_ID_MAX_LENGTH } from '../src/schemas/request';

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
