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
    ['an emoji', 'Cheers ðŸ\u008dº from the taproom', 'Cheers 🍺 from the taproom'],
    ['a Latin Extended-A capital', 'Brewed with Å½atec hops', 'Brewed with Žatec hops'],
    ['a Latin Extended-A capital after a guillemet byte', 'A crisp Å»ywiec lager', 'A crisp Żywiec lager'],
    ['several Central European letters', 'A PlzeÅˆskÃ½ Prazdroj clone', 'A Plzeňský Prazdroj clone'],
    ['a letter whose byte reads as punctuation inside a word', 'A classic KÃ–LSCH', 'A classic KÖLSCH'],
  ])('repairs %s', (_case, source, expected) => {
    expect(repairMojibake(source)).toBe(expected);
  });

  it.each([
    ['correctly encoded accents', 'Märzen with purée, açai and Føldånroll from Wünder'],
    ['correctly encoded punctuation', 'the region’s love — rich – “Original” at 4°C…'],
    // Each of these is also valid UTF-8 when read as Windows-1252 bytes.
    ['a capital accent before a registered sign', 'Brewed for CAFÉ® members'],
    ['a capital accent before an apostrophe', 'JOSÉ’s cask ale'],
    ['a capital accent before a trademark sign', 'The BRÜ™ series'],
    ['an accent before a closing quote and ellipsis', 'They called it “café”… and it stuck'],
    ['a word ending in Ã before a closing quote', 'A cider called “MAÇÃ”'],
    ['a word ending in Ã before a closing guillemet', 'A cider called «MAÇÃ» here'],
    ['a word ending in Å before an apostrophe', 'Brewed in ÅLESUND’s harbour by SKÅ’s crew'],
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
