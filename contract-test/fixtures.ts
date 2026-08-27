export const GOLDEN_STORE_ID = '13879';
export const GOLDEN_NOW = Date.UTC(2026, 7, 27, 5, 35, 0);
export const GOLDEN_CACHED_AT = Date.UTC(2026, 7, 27, 5, 31, 0);
export const GOLDEN_CONTENT_HASH = 'golden-content-hash';

export const goldenTaproomBeers = [
  {
    id: 'golden-complete',
    brew_name: 'Contract IPA',
    brewer: 'Schema Brewing',
    brewer_loc: 'Austin, TX',
    brew_style: 'IPA',
    brew_container: 'Draft',
    review_count: '12',
    review_rating: '4.25',
    brew_description: 'Citrus & pine — “fresh”.',
    added_date: '2026-08-27',
    enriched_abv: 6.5,
    enrichment_confidence: 0.95,
    enrichment_source: 'manual',
    is_description_cleaned: false,
  },
  {
    id: 'golden-nullable',
    brew_name: 'Null Island Lager',
    brewer: 'Schema Brewing',
    enriched_abv: null,
    enrichment_confidence: null,
    enrichment_source: null,
    is_description_cleaned: false,
  },
] as const;
