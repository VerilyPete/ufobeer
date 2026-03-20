import { describe, it, expect } from 'vitest';
import { computeEnrichmentHash } from '../../src/utils/enrichment-hash';
import type { BeerEnrichmentData } from '../../src/db/helpers';

const makeEnrichment = (overrides: Partial<BeerEnrichmentData> = {}): BeerEnrichmentData => ({
  abv: 5.0,
  confidence: 0.9,
  source: 'untappd',
  brew_description_cleaned: 'A crisp pale ale',
  ...overrides,
});

describe('computeEnrichmentHash', () => {
  it('returns consistent hash for same enrichment data', async () => {
    const map = new Map<string, BeerEnrichmentData>([
      ['beer1', makeEnrichment()],
      ['beer2', makeEnrichment({ abv: 6.5, source: 'ratebeer' })],
    ]);
    const first = await computeEnrichmentHash(map);
    const second = await computeEnrichmentHash(map);
    expect(first).toBe(second);
  });

  it('returns different hash when ABV changes for one beer', async () => {
    const base = new Map<string, BeerEnrichmentData>([['beer1', makeEnrichment({ abv: 5.0 })]]);
    const changed = new Map<string, BeerEnrichmentData>([['beer1', makeEnrichment({ abv: 7.5 })]]);
    const hashA = await computeEnrichmentHash(base);
    const hashB = await computeEnrichmentHash(changed);
    expect(hashA).not.toBe(hashB);
  });

  it('returns different hash when confidence changes but ABV stays the same', async () => {
    const base = new Map<string, BeerEnrichmentData>([['beer1', makeEnrichment({ confidence: 0.9 })]]);
    const changed = new Map<string, BeerEnrichmentData>([['beer1', makeEnrichment({ confidence: 0.5 })]]);
    const hashA = await computeEnrichmentHash(base);
    const hashB = await computeEnrichmentHash(changed);
    expect(hashA).not.toBe(hashB);
  });

  it('returns different hash when source changes but ABV and confidence stay the same', async () => {
    const base = new Map<string, BeerEnrichmentData>([['beer1', makeEnrichment({ source: 'untappd' })]]);
    const changed = new Map<string, BeerEnrichmentData>([['beer1', makeEnrichment({ source: 'ratebeer' })]]);
    const hashA = await computeEnrichmentHash(base);
    const hashB = await computeEnrichmentHash(changed);
    expect(hashA).not.toBe(hashB);
  });

  it('returns different hash when brew_description_cleaned changes but other fields stay the same', async () => {
    const base = new Map<string, BeerEnrichmentData>([
      ['beer1', makeEnrichment({ brew_description_cleaned: 'A crisp pale ale' })],
    ]);
    const changed = new Map<string, BeerEnrichmentData>([
      ['beer1', makeEnrichment({ brew_description_cleaned: 'A hoppy IPA' })],
    ]);
    const hashA = await computeEnrichmentHash(base);
    const hashB = await computeEnrichmentHash(changed);
    expect(hashA).not.toBe(hashB);
  });

  it('returns different hash when a new beer gets enrichment data', async () => {
    const base = new Map<string, BeerEnrichmentData>([['beer1', makeEnrichment()]]);
    const withExtra = new Map<string, BeerEnrichmentData>([
      ['beer1', makeEnrichment()],
      ['beer2', makeEnrichment({ abv: 8.0 })],
    ]);
    const hashA = await computeEnrichmentHash(base);
    const hashB = await computeEnrichmentHash(withExtra);
    expect(hashA).not.toBe(hashB);
  });

  it('returns consistent hash regardless of Map insertion order (deterministic)', async () => {
    const mapAB = new Map<string, BeerEnrichmentData>([
      ['beer1', makeEnrichment({ abv: 5.0 })],
      ['beer2', makeEnrichment({ abv: 6.5 })],
    ]);
    const mapBA = new Map<string, BeerEnrichmentData>([
      ['beer2', makeEnrichment({ abv: 6.5 })],
      ['beer1', makeEnrichment({ abv: 5.0 })],
    ]);
    const hashAB = await computeEnrichmentHash(mapAB);
    const hashBA = await computeEnrichmentHash(mapBA);
    expect(hashAB).toBe(hashBA);
  });

  it('returns deterministic hash for empty map', async () => {
    const emptyMap = new Map<string, BeerEnrichmentData>();
    const first = await computeEnrichmentHash(emptyMap);
    const second = await computeEnrichmentHash(emptyMap);
    expect(first).toBe(second);
    expect(first).toHaveLength(32);
    expect(first).toMatch(/^[0-9a-f]+$/);
  });
});
