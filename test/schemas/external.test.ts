import { describe, it, expect } from 'vitest';
import {
  PerplexityResponseSchema,
  FlyingSaucerBeerSchema,
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
});
