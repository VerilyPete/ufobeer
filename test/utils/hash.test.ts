/**
 * Unit tests for hash utility functions.
 *
 * @module test/utils/hash.test
 */

import { describe, it, expect } from 'vitest';
import { hashDescription } from '../../src/utils/hash';

describe('hashDescription', () => {
  it('returns a string of exactly 32 characters', async () => {
    const result = await hashDescription('Some beer description');
    expect(result).toHaveLength(32);
  });

  it('returns only lowercase hex characters [0-9a-f]', async () => {
    const result = await hashDescription('Test input for hex validation');
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('returns a deterministic result for the same input', async () => {
    const input = 'Repeatable hash test';
    const first = await hashDescription(input);
    const second = await hashDescription(input);
    expect(first).toBe(second);
  });

  it('returns different hashes for different inputs', async () => {
    const hashA = await hashDescription('Sierra Nevada Pale Ale');
    const hashB = await hashDescription('Guinness Draught');
    expect(hashA).not.toBe(hashB);
  });

  it('handles an empty string input without throwing', async () => {
    const result = await hashDescription('');
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('handles a very long string (10,000+ characters) without throwing', async () => {
    const longInput = 'a'.repeat(10_001);
    const result = await hashDescription(longInput);
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('returns 32 characters regardless of input length', async () => {
    const inputs = ['', 'x', 'short', 'a'.repeat(1000), 'a'.repeat(50_000)];
    for (const input of inputs) {
      const result = await hashDescription(input);
      expect(result).toHaveLength(32);
    }
  });

  it('produces different hashes for strings that differ by one character', async () => {
    const hashA = await hashDescription('hello world');
    const hashB = await hashDescription('hello worle');
    expect(hashA).not.toBe(hashB);
  });
});
