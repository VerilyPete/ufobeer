import { describe, it, expect } from 'vitest';
import { shouldUpdateContent } from '../../src/utils/cache-helpers';

describe('shouldUpdateContent', () => {
  it('returns true when hashes differ', () => {
    expect(shouldUpdateContent('newhash123', 'oldhash456', null, null)).toBe(true);
  });

  it('returns false when hashes match', () => {
    expect(shouldUpdateContent('samehash', 'samehash', null, null)).toBe(false);
  });

  it('returns true when stored hash is null (first time / pre-migration)', () => {
    expect(shouldUpdateContent('anyhash', null, null, null)).toBe(true);
  });

  it('returns true when content hashes match but enrichment hashes differ', () => {
    expect(shouldUpdateContent('contenthash', 'contenthash', 'newenrichment', 'oldenrichment')).toBe(true);
  });

  it('returns false when both content and enrichment hashes match', () => {
    expect(shouldUpdateContent('contenthash', 'contenthash', 'enrichmenthash', 'enrichmenthash')).toBe(false);
  });

  it('returns true when stored enrichment hash is null (post-migration first request)', () => {
    expect(shouldUpdateContent('contenthash', 'contenthash', 'enrichmenthash', null)).toBe(true);
  });

  it('returns true when both content and enrichment hashes differ', () => {
    expect(shouldUpdateContent('newcontent', 'oldcontent', 'newenrichment', 'oldenrichment')).toBe(true);
  });

  it('returns false when new enrichment hash is null (enrichment fetch failed) regardless of stored enrichment hash', () => {
    expect(shouldUpdateContent('contenthash', 'contenthash', null, 'someoldenrichment')).toBe(false);
  });
});
