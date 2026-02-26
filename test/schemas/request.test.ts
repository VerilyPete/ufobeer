import { describe, it, expect } from 'vitest';
import {
  BatchLookupRequestSchema,
  SyncBeerItemSchema,
  SyncBeersRequestSchema,
  DlqReplayRequestSchema,
  DlqAcknowledgeRequestSchema,
  TriggerEnrichmentRequestSchema,
  ForceEnrichmentRequestSchema,
  CriteriaSchema,
  TriggerCleanupRequestSchema,
} from '../../src/schemas/request';

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

  it('strips extra fields', () => {
    const result = BatchLookupRequestSchema.safeParse({ ids: ['abc'], extra: 'field' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ ids: ['abc'] });
    }
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
});

describe('ForceEnrichmentRequestSchema', () => {
  it('rejects empty body (neither beer_ids nor criteria)', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects both beer_ids and criteria present', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      beer_ids: ['abc'],
      criteria: { confidence_below: 0.5 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty beer_ids array', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({ beer_ids: [] });
    expect(result.success).toBe(false);
  });

  it('rejects beer_ids with >100 items', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `beer-${i}`);
    const result = ForceEnrichmentRequestSchema.safeParse({ beer_ids: ids });
    expect(result.success).toBe(false);
  });

  it('rejects beer_ids with non-string items', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({ beer_ids: [123] });
    expect(result.success).toBe(false);
  });

  it('rejects empty criteria object', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({ criteria: {} });
    expect(result.success).toBe(false);
  });

  it('rejects criteria.confidence_below outside 0-1', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      criteria: { confidence_below: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects criteria.enrichment_older_than_days non-positive-integer', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      criteria: { enrichment_older_than_days: 0 },
    });
    expect(result.success).toBe(false);

    const result2 = ForceEnrichmentRequestSchema.safeParse({
      criteria: { enrichment_older_than_days: 1.5 },
    });
    expect(result2.success).toBe(false);
  });

  it('rejects criteria.enrichment_source invalid value', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      criteria: { enrichment_source: 'openai' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects limit outside 1-100', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      beer_ids: ['abc'],
      limit: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer limit', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      beer_ids: ['abc'],
      limit: 3.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects beer_ids containing empty strings', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      beer_ids: ['abc', ''],
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean dry_run', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      beer_ids: ['abc'],
      dry_run: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty admin_id string', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      beer_ids: ['abc'],
      admin_id: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid beer_ids-based request', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      beer_ids: ['beer-1', 'beer-2'],
      limit: 50,
      dry_run: true,
      admin_id: 'admin-abc',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid criteria-based request', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      criteria: {
        confidence_below: 0.5,
        enrichment_older_than_days: 30,
        enrichment_source: 'perplexity',
      },
      limit: 25,
    });
    expect(result.success).toBe(true);
  });
});

describe('ForceEnrichmentRequestSchema error codes', () => {
  it('rejects empty beer_ids with INVALID_BEER_IDS_EMPTY code', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({ beer_ids: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_BEER_IDS_EMPTY:/);
    }
  });

  it('rejects >100 beer_ids with INVALID_BEER_IDS_TOO_MANY code', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `beer-${i}`);
    const result = ForceEnrichmentRequestSchema.safeParse({ beer_ids: ids });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_BEER_IDS_TOO_MANY:/);
    }
  });

  it('rejects non-string beer_ids items with INVALID_BEER_IDS_FORMAT code', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({ beer_ids: [123] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_BEER_IDS_FORMAT:/);
    }
  });

  it('rejects both beer_ids and criteria with INVALID_REQUEST_BOTH_SPECIFIED code', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      beer_ids: ['abc'],
      criteria: { confidence_below: 0.5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_REQUEST_BOTH_SPECIFIED:/);
    }
  });

  it('rejects neither beer_ids nor criteria with INVALID_REQUEST_NEITHER_SPECIFIED code', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_REQUEST_NEITHER_SPECIFIED:/);
    }
  });

  it('rejects invalid confidence_below with INVALID_CONFIDENCE code', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      criteria: { confidence_below: 1.5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const confidenceIssue = result.error.issues.find(i => i.message.startsWith('INVALID_CONFIDENCE:'));
      expect(confidenceIssue).toBeDefined();
    }
  });

  it('rejects invalid enrichment_source with INVALID_SOURCE code', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      criteria: { enrichment_source: 'openai' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const sourceIssue = result.error.issues.find(i => i.message.startsWith('INVALID_SOURCE:'));
      expect(sourceIssue).toBeDefined();
    }
  });
});

describe('CriteriaSchema', () => {
  it('rejects non-object criteria', () => {
    const result = CriteriaSchema.safeParse('bad');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_CRITERIA:/);
    }
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
