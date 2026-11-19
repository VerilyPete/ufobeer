/**
 * Unit tests for hash utility functions.
 *
 * Expected values were computed outside this code, with Node's
 * `crypto.createHash('sha256')`. These hashes are stored in D1 and sent as
 * ETags, so a change to any of them is a breaking change.
 *
 * @module test/utils/hash.test
 */

import { describe, it, expect } from 'vitest';
import { hashDescription, generateETag, buildCombinedEtag } from '../../src/utils/hash';

describe('hashDescription', () => {
  it.each([
    ['plain ASCII', 'Some beer description', 'bcd78c93c10c8c8351f896796d1ec9dd'],
    ['non-ASCII text, hashed as UTF-8', 'Café crème — 5,2 % vol 🍺', '194d5f3d63f8160acf10c24161a42610'],
    ['an empty string', '', 'e3b0c44298fc1c149afbf4c8996fb924'],
  ])('returns the first 16 bytes of SHA-256 as lowercase hex for %s', async (_case, text, expected) => {
    expect(await hashDescription(text)).toBe(expected);
  });
});

describe('generateETag', () => {
  it('quotes the description hash of the body', async () => {
    expect(await generateETag('Some beer description')).toBe('"bcd78c93c10c8c8351f896796d1ec9dd"');
  });
});

describe('buildCombinedEtag', () => {
  it.each([
    ['content and enrichment hashes', 'def456', new Set<string>(), '"93c716548884edbe2d401a649fc94fbe"'],
    ['no enrichment hash', null, new Set<string>(), '"869726fac5200468bd9157965bf77503"'],
    ['a negotiated source', 'def456', new Set(['exa']), '"f54e0890b9c0f6efd4633ad611a19a65"'],
  ])('hashes the format version with %s', async (_case, enrichmentHash, sources, expected) => {
    expect(await buildCombinedEtag('abc123', enrichmentHash, sources)).toBe(expected);
  });

  it('stops matching ETags issued before the current taplist format', async () => {
    const preFormatEtags = ['"abc123"', `"${await hashDescription('abc123def456')}"`];

    const etags = [await buildCombinedEtag('abc123', null), await buildCombinedEtag('abc123', 'def456')];

    expect(etags.filter(etag => preFormatEtags.includes(etag))).toEqual([]);
  });
});
