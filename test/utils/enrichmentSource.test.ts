import { describe, expect, it } from 'vitest';
import {
  parseAcceptedSources,
  relabelEnrichmentSources,
  wireEnrichmentSource,
} from '../../src/utils/enrichmentSource';
import { buildCombinedEtag, hashDescription } from '../../src/utils/hash';
import { TAPLIST_FORMAT_VERSION } from '../../src/constants';

const none = parseAcceptedSources(null);

describe('wireEnrichmentSource', () => {
  it.each(['description', 'description-fallback', 'perplexity', 'manual'])(
    'passes %j through whatever the client accepts', (stored) => {
      expect(wireEnrichmentSource(stored, none)).toBe(stored);
    });

  it('passes null through', () => {
    expect(wireEnrichmentSource(null, none)).toBeNull();
  });

  it('hides exa from a client that did not ask for it', () => {
    expect(wireEnrichmentSource('exa', none)).toBeNull();
  });

  it('shows exa to a client that asked for it', () => {
    expect(wireEnrichmentSource('exa', parseAcceptedSources('exa'))).toBe('exa');
  });

  it('hides any future source until a client asks for it', () => {
    expect(wireEnrichmentSource('untappd-api', parseAcceptedSources('exa'))).toBeNull();
    expect(wireEnrichmentSource('untappd-api', parseAcceptedSources('exa, untappd-api'))).toBe('untappd-api');
  });
});

describe('parseAcceptedSources', () => {
  it.each([
    ['exa', ['exa']],
    ['  EXA ', ['exa']],
    ['exa,exa, Exa', ['exa']],
    ['perplexity , exa', ['exa']],
    ['manual', []],
    ['exa,, ,', ['exa']],
    ['exa, <script>, a b, ünïcode, 9lives', ['exa']],
    ['', []],
  ])('normalizes %j to %j', (header, expected) => {
    expect([...parseAcceptedSources(header)].sort()).toEqual(expected);
  });

  it('ignores an oversized header entirely', () => {
    expect([...parseAcceptedSources(`exa,${'x'.repeat(300)}`)]).toEqual([]);
  });

  it('keeps at most eight sources', () => {
    const header = Array.from({ length: 12 }, (_, i) => `source${i}`).join(',');
    expect(parseAcceptedSources(header).size).toBe(8);
  });
});

describe('relabelEnrichmentSources', () => {
  it('relabels each beer and leaves every other field alone', () => {
    const beers = [
      { id: '1', enrichment_source: 'exa', enriched_abv: 8 },
      { id: '2', enrichment_source: 'perplexity', enriched_abv: 5 },
      { id: '3', enrichment_source: null, enriched_abv: null },
    ];
    expect(relabelEnrichmentSources(beers, none)).toEqual([
      { id: '1', enrichment_source: null, enriched_abv: 8 },
      { id: '2', enrichment_source: 'perplexity', enriched_abv: 5 },
      { id: '3', enrichment_source: null, enriched_abv: null },
    ]);
    expect(beers[0]?.enrichment_source).toBe('exa');
  });
});

describe('buildCombinedEtag with accepted sources', () => {
  it.each([['def', 'abc:def'], [null, 'abc:']])(
    'keeps the pre-negotiation ETag for enrichment hash %j when no source is accepted', async (enrichmentHash, suffix) => {
      const preNegotiation = `"${await hashDescription(`taplist-v${TAPLIST_FORMAT_VERSION}:${suffix}`)}"`;
      expect(await buildCombinedEtag('abc', enrichmentHash)).toBe(preNegotiation);
      expect(await buildCombinedEtag('abc', enrichmentHash, none)).toBe(preNegotiation);
      expect(await buildCombinedEtag('abc', enrichmentHash, parseAcceptedSources('<junk>, manual'))).toBe(preNegotiation);
    });

  it('gives a header-sending client a different, stable ETag', async () => {
    const withExa = await buildCombinedEtag('abc', 'def', parseAcceptedSources('exa'));
    expect(withExa).not.toBe(await buildCombinedEtag('abc', 'def'));
    expect(withExa).toBe(await buildCombinedEtag('abc', 'def', parseAcceptedSources(' EXA,exa ')));
    expect(withExa).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('does not depend on header order', async () => {
    expect(await buildCombinedEtag('abc', null, parseAcceptedSources('exa,foo')))
      .toBe(await buildCombinedEtag('abc', null, parseAcceptedSources('foo, exa')));
  });
});
