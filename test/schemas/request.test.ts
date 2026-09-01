import { describe, it, expect } from 'vitest';
import {
  BatchLookupRequestSchema,
  BATCH_MAX_IDS,
  BATCH_ID_MAX_LENGTH,
  SyncBeerItemSchema,
  SyncBeersRequestSchema,
  SyncBeersRequestOuterSchema,
  DlqReplayRequestSchema,
  DlqAcknowledgeRequestSchema,
  DLQ_REPLAY_MAX_IDS,
  DLQ_ACKNOWLEDGE_MAX_IDS,
  MAX_DELAY_SECONDS,
  TriggerEnrichmentRequestSchema,
  TriggerCleanupRequestSchema,
  CleanupMessageSchema,
} from '../../src/schemas/request';
import { SYNC_CONSTANTS } from '../../src/types';

describe('BatchLookupRequestSchema', () => {
  it('rejects missing ids', () => {
    const result = BatchLookupRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects ids as non-array', () => {
    const result = BatchLookupRequestSchema.safeParse({ ids: 'not-array' });
    expect(result.success).toBe(false);
  });

  it('rejects empty ids array', () => {
    const result = BatchLookupRequestSchema.safeParse({ ids: [] });
    expect(result.success).toBe(false);
  });

  it('rejects ids containing non-strings', () => {
    const result = BatchLookupRequestSchema.safeParse({ ids: [123, 456] });
    expect(result.success).toBe(false);
  });

  it('rejects ids containing empty strings', () => {
    const result = BatchLookupRequestSchema.safeParse({ ids: ['abc', ''] });
    expect(result.success).toBe(false);
  });

  it('accepts valid ids array', () => {
    const result = BatchLookupRequestSchema.safeParse({ ids: ['abc', 'def'] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ ids: ['abc', 'def'] });
    }
  });

  it('rejects unknown properties (request schemas are .strict() for client-authored bodies)', () => {
    const result = BatchLookupRequestSchema.safeParse({ ids: ['abc'], extra: 'field' });
    expect(result.success).toBe(false);
  });

  it('accepts exactly BATCH_MAX_IDS (100) ids', () => {
    const ids = Array.from({ length: BATCH_MAX_IDS }, (_, i) => `id-${i}`);
    const result = BatchLookupRequestSchema.safeParse({ ids });
    expect(result.success).toBe(true);
  });

  it('rejects one more than BATCH_MAX_IDS (101) ids', () => {
    const ids = Array.from({ length: BATCH_MAX_IDS + 1 }, (_, i) => `id-${i}`);
    const result = BatchLookupRequestSchema.safeParse({ ids });
    expect(result.success).toBe(false);
  });

  it('accepts an id at exactly BATCH_ID_MAX_LENGTH (50) chars', () => {
    const result = BatchLookupRequestSchema.safeParse({ ids: ['x'.repeat(BATCH_ID_MAX_LENGTH)] });
    expect(result.success).toBe(true);
  });

  it('rejects an id exceeding BATCH_ID_MAX_LENGTH (51 chars)', () => {
    const result = BatchLookupRequestSchema.safeParse({ ids: ['x'.repeat(BATCH_ID_MAX_LENGTH + 1)] });
    expect(result.success).toBe(false);
  });
});

describe('SyncBeersRequestSchema', () => {
  it('rejects missing beers field', () => {
    const result = SyncBeersRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects beers as non-array', () => {
    const result = SyncBeersRequestSchema.safeParse({ beers: 'not-array' });
    expect(result.success).toBe(false);
  });

  it('accepts empty beers array', () => {
    const result = SyncBeersRequestSchema.safeParse({ beers: [] });
    expect(result.success).toBe(true);
  });

  it('rejects beer missing id', () => {
    const result = SyncBeerItemSchema.safeParse({ brew_name: 'Test IPA' });
    expect(result.success).toBe(false);
  });

  it('rejects beer missing brew_name', () => {
    const result = SyncBeerItemSchema.safeParse({ id: 'beer-1' });
    expect(result.success).toBe(false);
  });

  it('rejects beer with empty id', () => {
    const result = SyncBeerItemSchema.safeParse({ id: '', brew_name: 'Test IPA' });
    expect(result.success).toBe(false);
  });

  it('rejects beer with empty brew_name', () => {
    const result = SyncBeerItemSchema.safeParse({ id: 'beer-1', brew_name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects beer with id exceeding 50 chars', () => {
    const result = SyncBeerItemSchema.safeParse({
      id: 'a'.repeat(51),
      brew_name: 'Test IPA',
    });
    expect(result.success).toBe(false);
  });

  it('rejects beer with brew_name exceeding 200 chars', () => {
    const result = SyncBeerItemSchema.safeParse({
      id: 'beer-1',
      brew_name: 'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('rejects beer with brew_description exceeding 2000 chars', () => {
    const result = SyncBeerItemSchema.safeParse({
      id: 'beer-1',
      brew_name: 'Test IPA',
      brew_description: 'a'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid beer with only required fields', () => {
    const result = SyncBeerItemSchema.safeParse({
      id: 'beer-1',
      brew_name: 'Test IPA',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid beer with optional brewer and brew_description', () => {
    const result = SyncBeerItemSchema.safeParse({
      id: 'beer-1',
      brew_name: 'Test IPA',
      brewer: 'Test Brewery',
      brew_description: 'A hoppy IPA',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.brewer).toBe('Test Brewery');
      expect(result.data.brew_description).toBe('A hoppy IPA');
    }
  });

  it('accepts brewer at exactly MAX_BREW_NAME_LENGTH (200) chars', () => {
    const result = SyncBeerItemSchema.safeParse({
      id: 'beer-1',
      brew_name: 'Test IPA',
      brewer: 'b'.repeat(SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH),
    });
    expect(result.success).toBe(true);
  });

  it('rejects brewer exceeding MAX_BREW_NAME_LENGTH (201 chars) -- previously unbounded', () => {
    const result = SyncBeerItemSchema.safeParse({
      id: 'beer-1',
      brew_name: 'Test IPA',
      brewer: 'b'.repeat(SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown properties on a beer item', () => {
    const result = SyncBeerItemSchema.safeParse({
      id: 'beer-1',
      brew_name: 'Test IPA',
      unexpected_field: 'value',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown properties on the sync request envelope', () => {
    const result = SyncBeersRequestSchema.safeParse({ beers: [], extra: 'field' });
    expect(result.success).toBe(false);
  });
});

describe('SyncBeersRequestOuterSchema', () => {
  it('accepts exactly SYNC_CONSTANTS.MAX_BATCH_SIZE (50) beers', () => {
    const beers = Array.from({ length: SYNC_CONSTANTS.MAX_BATCH_SIZE }, (_, i) => ({ id: `beer-${i}` }));
    const result = SyncBeersRequestOuterSchema.safeParse({ beers });
    expect(result.success).toBe(true);
  });

  it('rejects one more than SYNC_CONSTANTS.MAX_BATCH_SIZE (51) beers', () => {
    const beers = Array.from({ length: SYNC_CONSTANTS.MAX_BATCH_SIZE + 1 }, (_, i) => ({ id: `beer-${i}` }));
    const result = SyncBeersRequestOuterSchema.safeParse({ beers });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level properties', () => {
    const result = SyncBeersRequestOuterSchema.safeParse({ beers: [], extra: 'field' });
    expect(result.success).toBe(false);
  });
});

describe('DlqReplayRequestSchema', () => {
  it('rejects missing ids field', () => {
    const result = DlqReplayRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty ids array', () => {
    const result = DlqReplayRequestSchema.safeParse({ ids: [] });
    expect(result.success).toBe(false);
  });

  it('rejects ids with non-numbers', () => {
    const result = DlqReplayRequestSchema.safeParse({ ids: ['a', 'b'] });
    expect(result.success).toBe(false);
  });

  it('rejects negative delay_seconds', () => {
    const result = DlqReplayRequestSchema.safeParse({ ids: [1], delay_seconds: -5 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer delay_seconds', () => {
    const result = DlqReplayRequestSchema.safeParse({ ids: [1], delay_seconds: 1.5 });
    expect(result.success).toBe(false);
  });

  it('accepts valid replay request with delay', () => {
    const result = DlqReplayRequestSchema.safeParse({ ids: [1, 2], delay_seconds: 30 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ ids: [1, 2], delay_seconds: 30 });
    }
  });

  it('accepts valid replay request without delay (defaults to 0)', () => {
    const result = DlqReplayRequestSchema.safeParse({ ids: [1] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.delay_seconds).toBe(0);
    }
  });

  it('accepts exactly DLQ_REPLAY_MAX_IDS (50) ids', () => {
    const ids = Array.from({ length: DLQ_REPLAY_MAX_IDS }, (_, i) => i + 1);
    const result = DlqReplayRequestSchema.safeParse({ ids });
    expect(result.success).toBe(true);
  });

  it('rejects one more than DLQ_REPLAY_MAX_IDS (51) ids', () => {
    const ids = Array.from({ length: DLQ_REPLAY_MAX_IDS + 1 }, (_, i) => i + 1);
    const result = DlqReplayRequestSchema.safeParse({ ids });
    expect(result.success).toBe(false);
  });

  it('accepts delay_seconds at exactly MAX_DELAY_SECONDS (Cloudflare Queues max delay)', () => {
    const result = DlqReplayRequestSchema.safeParse({ ids: [1], delay_seconds: MAX_DELAY_SECONDS });
    expect(result.success).toBe(true);
  });

  it('rejects delay_seconds one second over MAX_DELAY_SECONDS', () => {
    const result = DlqReplayRequestSchema.safeParse({ ids: [1], delay_seconds: MAX_DELAY_SECONDS + 1 });
    expect(result.success).toBe(false);
  });

  it('rejects unknown properties', () => {
    const result = DlqReplayRequestSchema.safeParse({ ids: [1], extra: 'field' });
    expect(result.success).toBe(false);
  });
});

describe('DlqAcknowledgeRequestSchema', () => {
  it('rejects missing ids', () => {
    const result = DlqAcknowledgeRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty ids array', () => {
    const result = DlqAcknowledgeRequestSchema.safeParse({ ids: [] });
    expect(result.success).toBe(false);
  });

  it('rejects ids with non-numbers', () => {
    const result = DlqAcknowledgeRequestSchema.safeParse({ ids: ['a'] });
    expect(result.success).toBe(false);
  });

  it('accepts valid acknowledge request', () => {
    const result = DlqAcknowledgeRequestSchema.safeParse({ ids: [1, 2, 3] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ ids: [1, 2, 3] });
    }
  });

  it('accepts exactly DLQ_ACKNOWLEDGE_MAX_IDS (100) ids', () => {
    const ids = Array.from({ length: DLQ_ACKNOWLEDGE_MAX_IDS }, (_, i) => i + 1);
    const result = DlqAcknowledgeRequestSchema.safeParse({ ids });
    expect(result.success).toBe(true);
  });

  it('rejects one more than DLQ_ACKNOWLEDGE_MAX_IDS (101) ids', () => {
    const ids = Array.from({ length: DLQ_ACKNOWLEDGE_MAX_IDS + 1 }, (_, i) => i + 1);
    const result = DlqAcknowledgeRequestSchema.safeParse({ ids });
    expect(result.success).toBe(false);
  });

  it('rejects unknown properties', () => {
    const result = DlqAcknowledgeRequestSchema.safeParse({ ids: [1], extra: 'field' });
    expect(result.success).toBe(false);
  });
});

describe('TriggerEnrichmentRequestSchema', () => {
  it('accepts empty body with defaults', () => {
    const result = TriggerEnrichmentRequestSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.exclude_failures).toBe(false);
      expect(result.data.dry_run).toBe(false);
    }
  });

  it('rejects limit outside 1-100', () => {
    const result = TriggerEnrichmentRequestSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);

    const result2 = TriggerEnrichmentRequestSchema.safeParse({ limit: 101 });
    expect(result2.success).toBe(false);
  });

  it('rejects non-integer limit', () => {
    const result = TriggerEnrichmentRequestSchema.safeParse({ limit: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean exclude_failures', () => {
    const result = TriggerEnrichmentRequestSchema.safeParse({ exclude_failures: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean dry_run', () => {
    const result = TriggerEnrichmentRequestSchema.safeParse({ dry_run: 1 });
    expect(result.success).toBe(false);
  });

  it('accepts valid request with all fields', () => {
    const result = TriggerEnrichmentRequestSchema.safeParse({
      limit: 50,
      exclude_failures: true,
      dry_run: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ limit: 50, exclude_failures: true, dry_run: false });
    }
  });

  it('rejects unknown properties', () => {
    const result = TriggerEnrichmentRequestSchema.safeParse({ limit: 10, extra: 'field' });
    expect(result.success).toBe(false);
  });
});

describe('TriggerCleanupRequestSchema', () => {
  it('rejects missing mode', () => {
    const result = TriggerCleanupRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects invalid mode value', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive-integer limit', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'all', limit: 0 });
    expect(result.success).toBe(false);

    const result2 = TriggerCleanupRequestSchema.safeParse({ mode: 'all', limit: 1.5 });
    expect(result2.success).toBe(false);
  });

  it('rejects non-boolean dry_run', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'all', dry_run: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean confirm', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'all', confirm: 1 });
    expect(result.success).toBe(false);
  });

  it('accepts valid mode: missing', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'missing' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('missing');
      expect(result.data.dry_run).toBe(false);
    }
  });

  it('accepts valid mode: all with confirm', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'all', confirm: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('all');
      expect(result.data.confirm).toBe(true);
    }
  });
});

describe('TriggerCleanupRequestSchema error codes', () => {
  it('rejects missing mode with INVALID_MODE code', () => {
    const result = TriggerCleanupRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_MODE:/);
    }
  });

  it('rejects invalid mode value with INVALID_MODE code', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'invalid' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_MODE:/);
    }
  });

  it('rejects non-integer limit with INVALID_LIMIT code', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'all', limit: 1.5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_LIMIT:/);
    }
  });

  it('rejects non-boolean dry_run with INVALID_DRY_RUN code', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'all', dry_run: 'yes' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_DRY_RUN:/);
    }
  });

  it('rejects non-boolean confirm with INVALID_CONFIRM code', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'all', confirm: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_CONFIRM:/);
    }
  });
});

describe('TriggerCleanupRequestSchema unknown properties', () => {
  it('rejects unknown properties', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'missing', extra: 'field' });
    expect(result.success).toBe(false);
  });
});

describe('CleanupMessageSchema (internal queue message shape)', () => {
  it('accepts a message without descriptionHash (pre-existing / in-flight messages)', () => {
    const result = CleanupMessageSchema.safeParse({
      beerId: 'beer-1',
      beerName: 'Test IPA',
      brewer: 'Brewery',
      brewDescription: 'A hoppy IPA',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.descriptionHash).toBeUndefined();
    }
  });

  it('accepts and preserves a message with descriptionHash', () => {
    const result = CleanupMessageSchema.safeParse({
      beerId: 'beer-1',
      beerName: 'Test IPA',
      brewer: 'Brewery',
      brewDescription: 'A hoppy IPA',
      descriptionHash: 'abc123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.descriptionHash).toBe('abc123');
    }
  });

  it('tolerates unknown properties (not .strict(): validates our own producers, not client input)', () => {
    const result = CleanupMessageSchema.safeParse({
      beerId: 'beer-1',
      beerName: 'Test IPA',
      brewer: 'Brewery',
      brewDescription: 'A hoppy IPA',
      someFutureField: 'value',
    });
    expect(result.success).toBe(true);
  });
});
