/**
 * Repair mojibake: UTF-8 text that was decoded as Windows-1252 somewhere
 * upstream, so "purée" arrives as "purÃ©e" and "–" as "â€“".
 *
 * Each run of a UTF-8 lead character followed by exactly the continuation
 * characters it requires is turned back into bytes and strictly decoded as
 * UTF-8. A run that does not decode is left untouched, so correctly encoded
 * text ("Märzen", "açai", "region’s") is never altered.
 *
 * @module queue/mojibake
 */

// The Windows-1252 characters for bytes 0x80-0x9F. The five bytes it leaves
// undefined (0x81, 0x8D, 0x8F, 0x90, 0x9D) pass through as the matching C1
// control code point, which maps back to the same byte.
const WINDOWS_1252_HIGH_BYTES: ReadonlyMap<string, number> = new Map([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85], ['†', 0x86], ['‡', 0x87],
  ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c], ['Ž', 0x8e],
  ['‘', 0x91], ['’', 0x92], ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97],
  ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b], ['œ', 0x9c], ['ž', 0x9e], ['Ÿ', 0x9f],
]);

const CONTINUATION = `[\\u0080-\\u00bf${[...WINDOWS_1252_HIGH_BYTES.keys()].join('')}]`;
const MOJIBAKE_RUN = new RegExp(`[\\u00c2-\\u00f4]${CONTINUATION}{1,3}`, 'gu');

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

const byteOf = (char: string): number => WINDOWS_1252_HIGH_BYTES.get(char) ?? char.charCodeAt(0);

const continuationsFor = (leadByte: number): number => {
  if (leadByte >= 0xf0) return 3;
  if (leadByte >= 0xe0) return 2;
  return 1;
};

function repairRun(run: string): string {
  const [lead = '', ...continuations] = [...run];
  const needed = continuationsFor(byteOf(lead));
  if (continuations.length < needed) return run;
  const bytes = [lead, ...continuations.slice(0, needed)].map(byteOf);
  try {
    return strictUtf8.decode(new Uint8Array(bytes)) + continuations.slice(needed).join('');
  } catch {
    return run;
  }
}

export function repairMojibake(text: string): string {
  return text.replace(MOJIBAKE_RUN, repairRun);
}
