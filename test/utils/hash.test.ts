/**
 * Unit tests for hash utility functions.
 *
 * @module test/utils/hash.test
 */

import { describe, it, expect } from 'vitest';
import { hashDescription, generateETag, buildCombinedEtag } from '../../src/utils/hash';

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

describe('generateETag', () => {
  it('produces a quoted 32-char hex output', async () => {
    const etag = await generateETag('test body');
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('produces different outputs for different inputs', async () => {
    const etagA = await generateETag('body A');
    const etagB = await generateETag('body B');
    expect(etagA).not.toBe(etagB);
  });

  it('output is always wrapped in double quotes', async () => {
    const etag = await generateETag('anything');
    expect(etag.startsWith('"')).toBe(true);
    expect(etag.endsWith('"')).toBe(true);
  });

  it('handles empty string and returns valid format', async () => {
    const etag = await generateETag('');
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('wraps the same hash that hashDescription produces', async () => {
    const hash = await hashDescription('consistent');
    const etag = await generateETag('consistent');
    expect(etag).toBe(`"${hash}"`);
  });
});

describe('buildCombinedEtag', () => {
  it('returns content hash alone (quoted) when enrichment hash is null', async () => {
    const result = await buildCombinedEtag('abc123', null);
    expect(result).toBe('"abc123"');
  });

  it('returns combined hash (quoted) when both hashes are present', async () => {
    const result = await buildCombinedEtag('abc123', 'def456');
    expect(result).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('combined hash differs from content hash alone', async () => {
    const contentOnly = await buildCombinedEtag('abc123', null);
    const combined = await buildCombinedEtag('abc123', 'def456');
    expect(combined).not.toBe(contentOnly);
  });

  it('output is valid ETag format (matches "..." pattern)', async () => {
    const result = await buildCombinedEtag('somehash', 'enrichhash');
    expect(result.startsWith('"')).toBe(true);
    expect(result.endsWith('"')).toBe(true);
    expect(result.length).toBeGreaterThan(2);
  });

  it('is deterministic for same inputs', async () => {
    const first = await buildCombinedEtag('abc123', 'def456');
    const second = await buildCombinedEtag('abc123', 'def456');
    expect(first).toBe(second);
  });
});
