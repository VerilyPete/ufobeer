import { describe, it, expect } from 'vitest';
import { shouldUpdateContent } from '../../src/utils/cache-helpers';

describe('shouldUpdateContent', () => {
  it('returns true when hashes differ', () => {
    expect(shouldUpdateContent('newhash123', 'oldhash456')).toBe(true);
  });

  it('returns false when hashes match', () => {
    expect(shouldUpdateContent('samehash', 'samehash')).toBe(false);
  });

  it('returns true when stored hash is null (first time / pre-migration)', () => {
    expect(shouldUpdateContent('anyhash', null)).toBe(true);
  });
});
