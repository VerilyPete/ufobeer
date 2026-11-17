import { describe, it, expect } from 'vitest';
import {
  PerplexityResponseSchema,
  FlyingSaucerBeerSchema,
  FlyingSaucerResponseSchema,
  isFlyingSaucerBeerRecordWithinSizeCap,
} from '../../src/schemas/external';

describe('PerplexityResponseSchema', () => {
  it('accepts missing choices with default empty array', () => {
    const result = PerplexityResponseSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.choices).toEqual([]);
    }
  });

  it('extracts nested message content', () => {
    const result = PerplexityResponseSchema.safeParse({
      choices: [{ message: { content: 'ABV: 5.5%' } }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.choices[0]?.message?.content).toBe('ABV: 5.5%');
    }
  });

  it('handles malformed response gracefully', () => {
    const result = PerplexityResponseSchema.safeParse({
      choices: [{ message: {} }],
    });
    expect(result.success).toBe(true);
  });
});

describe('FlyingSaucerBeerSchema', () => {
  it('rejects beer missing id', () => {
    const result = FlyingSaucerBeerSchema.safeParse({ brew_name: 'Test' });
    expect(result.success).toBe(false);
  });

  it('rejects beer with empty id', () => {
    const result = FlyingSaucerBeerSchema.safeParse({ id: '', brew_name: 'Test' });
    expect(result.success).toBe(false);
  });

  it('rejects beer missing brew_name', () => {
    const result = FlyingSaucerBeerSchema.safeParse({ id: 'beer-1' });
    expect(result.success).toBe(false);
  });

  it('accepts valid beer and passes through extra fields', () => {
    const input = {
      id: 'beer-1',
      brew_name: 'Test IPA',
      brewer: 'Test Brewery',
      brewInStock: [{ storeId: '123' }],
      custom_field: 'preserved',
    };
    const result = FlyingSaucerBeerSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('beer-1');
      expect(result.data.brew_name).toBe('Test IPA');
      expect((result.data as Record<string, unknown>)['brewInStock']).toEqual([{ storeId: '123' }]);
      expect((result.data as Record<string, unknown>)['custom_field']).toBe('preserved');
    }
  });

  it('accepts beer without optional brewer', () => {
    const result = FlyingSaucerBeerSchema.safeParse({
      id: 'beer-1',
      brew_name: 'Test IPA',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.brewer).toBeUndefined();
    }
  });

  // ==========================================================================
  // Bounds (Cloudflare security review Phase 1, item 5: unbounded upstream)
  // ==========================================================================

  it('rejects id longer than 5,000 characters', () => {
    const result = FlyingSaucerBeerSchema.safeParse({
      id: 'x'.repeat(5001),
      brew_name: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an id of exactly 5,000 characters', () => {
    const result = FlyingSaucerBeerSchema.safeParse({
      id: 'x'.repeat(5000),
      brew_name: 'Test',
    });
    expect(result.success).toBe(true);
  });

  it('rejects brew_name longer than 5,000 characters', () => {
    const result = FlyingSaucerBeerSchema.safeParse({
      id: 'beer-1',
      brew_name: 'x'.repeat(5001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects brew_description longer than 5,000 characters', () => {
    const result = FlyingSaucerBeerSchema.safeParse({
      id: 'beer-1',
      brew_name: 'Test',
      brew_description: 'x'.repeat(5001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects brewer longer than 5,000 characters', () => {
    const result = FlyingSaucerBeerSchema.safeParse({
      id: 'beer-1',
      brew_name: 'Test',
      brewer: 'x'.repeat(5001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects container_type longer than 5,000 characters', () => {
    const result = FlyingSaucerBeerSchema.safeParse({
      id: 'beer-1',
      brew_name: 'Test',
      container_type: 'x'.repeat(5001),
    });
    expect(result.success).toBe(false);
  });
});

describe('FlyingSaucerResponseSchema', () => {
  it('accepts an array of exactly 5,000 items', () => {
    const items = Array.from({ length: 5000 }, () => ({}));
    const result = FlyingSaucerResponseSchema.safeParse(items);
    expect(result.success).toBe(true);
  });

  it('rejects an array of 5,001 items', () => {
    const items = Array.from({ length: 5001 }, () => ({}));
    const result = FlyingSaucerResponseSchema.safeParse(items);
    expect(result.success).toBe(false);
  });

  it('rejects a non-array payload', () => {
    const result = FlyingSaucerResponseSchema.safeParse({ not: 'an array' });
    expect(result.success).toBe(false);
  });
});

describe('isFlyingSaucerBeerRecordWithinSizeCap', () => {
  it('accepts a small record', () => {
    expect(isFlyingSaucerBeerRecordWithinSizeCap({ id: '1', brew_name: 'Test' })).toBe(true);
  });

  it('rejects a record whose passthrough fields push it over the aggregate cap', () => {
    const record = {
      id: '1',
      brew_name: 'Test',
      // A single well-formed known field cannot exceed the cap (it's
      // bounded independently), but an attacker-controlled passthrough
      // field is not enumerated by the schema and must be caught here.
      suspicious_passthrough_blob: 'x'.repeat(20_000),
    };
    expect(isFlyingSaucerBeerRecordWithinSizeCap(record)).toBe(false);
  });

  it.each([
    [20_000, true],
    [20_001, false],
  ])('a record serializing to %i characters is within the cap: %s', (length, expected) => {
    const overhead = JSON.stringify({ id: '1', blob: '' }).length;
    const record = { id: '1', blob: 'x'.repeat(length - overhead) };
    expect(JSON.stringify(record).length).toBe(length);
    expect(isFlyingSaucerBeerRecordWithinSizeCap(record)).toBe(expected);
  });

  it('handles a value that cannot be serialized without throwing', () => {
    const circular: Record<string, unknown> = { id: '1' };
    circular['self'] = circular;
    expect(isFlyingSaucerBeerRecordWithinSizeCap(circular)).toBe(false);
  });
});
