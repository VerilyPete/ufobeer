import { describe, it, expect } from 'vitest';
import { repairMojibake } from '../../src/queue/mojibake';

// Every repaired case is taken from a production Flying Saucer description:
// UTF-8 text that was decoded as Windows-1252 before it reached the API.
describe('repairMojibake', () => {
  it.each([
    ['an accented letter', 'pineapple purÃ©e and vanilla', 'pineapple purée and vanilla'],
    ['an umlaut', 'A bÃ¤nging imperial stout', 'A bänging imperial stout'],
    ['a cedilla', 'fruits; aÃ§ai, guava', 'fruits; açai, guava'],
    ['a circumflex', 'Debelder and maÃ®tre-sommelier', 'Debelder and maître-sommelier'],
    ['a byte Windows-1252 leaves undefined', 'your babiÄ\u008dka\'s kolaches', 'your babička\'s kolaches'],
    ['an en dash', 'spot they love â€“ bold and zesty', 'spot they love – bold and zesty'],
    ['a closing quote ending in an undefined byte', '"Originalâ€\u009d, a flavourful beer', '"Original”, a flavourful beer'],
    ['an ellipsis', 'Dry, crisp, refreshingâ€¦.it\'s a lager', 'Dry, crisp, refreshing….it\'s a lager'],
    ['a ligature', 'a smooth proï¬\u0081le', 'a smooth proﬁle'],
    ['a non-breaking space', 'with Cider.Â  Varies by location.', 'with Cider.  Varies by location.'],
    ['several runs at once', 'MÃ¤rzen â€“ purÃ©e', 'Märzen – purée'],
    ['a byte-order mark, which is dropped', 'ï»¿A crisp lager', 'A crisp lager'],
  ])('repairs %s', (_case, source, expected) => {
    expect(repairMojibake(source)).toBe(expected);
  });

  it.each([
    ['correctly encoded accents', 'Märzen with purée, açai and Føldånroll from Wünder'],
    ['correctly encoded punctuation', 'the region’s love — rich – “Original” at 4°C…'],
    ['a lead character before plain text', 'Â la carte'],
    ['a lead character with too few continuation characters', 'love â€ bold'],
    ['a lead character before an invalid continuation', 'Ã X'],
    ['plain ASCII', 'A crisp, clean lager. 4.9% ABV'],
    ['empty text', ''],
  ])('leaves %s unchanged', (_case, source) => {
    expect(repairMojibake(source)).toBe(source);
  });

  it('is idempotent', () => {
    const source = 'MÃ¤rzen â€“ purÃ©e, babiÄ\u008dka and proï¬\u0081le';
    expect(repairMojibake(repairMojibake(source))).toBe(repairMojibake(source));
  });
});
