import { describe, expect, it } from 'vitest';
import { findMismatches, hashText } from '../../scripts/audit-description-hashes.mjs';
import { hashDescription } from '../../src/utils/hash';

describe('description hash audit script', () => {
  it.each(['A crisp lager', 'Brewer’s café — 5.5% ABV', ''])('hashes %j exactly as hashDescription does', async (text) => {
    expect(hashText(text)).toBe(await hashDescription(text));
  });

  it('lists only rows whose stored hash is not the hash of their stored text', async () => {
    const rows = [
      { id: 'ok', original: 'A crisp lager', hash: await hashDescription('A crisp lager') },
      { id: 'stale', original: 'A crisp lager', hash: await hashDescription('A hazy pale ale') },
      { id: 'missing', original: 'A dark porter', hash: null },
    ];

    expect(findMismatches(rows)).toEqual([
      { id: 'stale', stored: await hashDescription('A hazy pale ale'), expected: await hashDescription('A crisp lager') },
      { id: 'missing', stored: null, expected: await hashDescription('A dark porter') },
    ]);
  });
});
