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

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const BYTE_ORDER_MARK = '﻿';
const C1_CONTROL = /[\u0080-\u009f]/u;
const LETTER = /^\p{L}$/u;
// Leads whose two-byte runs decode to Latin letters (Ã -> é, Ä -> č, Å -> Ž).
const LATIN_LETTER_LEADS = new Set(['Ã', 'Ä', 'Å']);
// Characters that commonly follow a word. A word ending in Ã, Ä or Å before
// one of these ("MAÇÃ”", "SKÅ’s") is genuine text, whereas mojibake sits
// inside a word ("KÃ–LSCH", "maÃ®tre").
const WORD_TRAILING = new Set(['’', '”', '“', '‘', '«', '»', '–', '—', '…', '•', '™', '®']);

function endsWord(continuation: string, after: string): boolean {
  if (!WORD_TRAILING.has(continuation)) return false;
  return (continuation === '’' ? /^s?(?!\p{L})/u : /^(?!\p{L})/u).test(after);
}

const inRange = (codePoint: number, [from, to]: readonly [number, number]): boolean =>
  codePoint >= from && codePoint <= to;

// Characters UTF-8 encodes in three bytes that mojibake plausibly came from:
// punctuation (– — ’ ” …), currency (€), letterlike symbols (™), ligatures
// (ﬁ ﬂ) and the byte-order mark. A CJK character, also three bytes, is far
// likelier to be an accent before punctuation ("café”…").
const PLAUSIBLE_THREE_BYTE: readonly (readonly [number, number])[] = [
  [0x2000, 0x206f], [0x20a0, 0x20cf], [0x2100, 0x214f], [0xfb00, 0xfb06], [0xfeff, 0xfeff],
];
const EMOJI: readonly [number, number] = [0x1f000, 0x1faff];

// Valid UTF-8 alone does not prove corruption: correctly encoded "CAFÉ®" is
// also the bytes of "ɮ". A repair is accepted only when its result is a
// character mojibake plausibly came from, in a plausible position.
function isPlausibleRepair(options: {
  readonly run: string;
  readonly repaired: string;
  readonly after: string;
}): boolean {
  const { run, repaired, after } = options;
  const codePoint = repaired.codePointAt(0) ?? 0;
  if (codePoint >= 0x10000) return inRange(codePoint, EMOJI);
  if (codePoint >= 0x800) return PLAUSIBLE_THREE_BYTE.some(range => inRange(codePoint, range));
  const [lead = '', continuation = ''] = [...run];
  if (lead === 'Â') return inRange(codePoint, [0xa0, 0xbf]);
  if (LATIN_LETTER_LEADS.has(lead)) {
    return LETTER.test(repaired) && inRange(codePoint, [0xc0, 0x17f]) && !endsWord(continuation, after);
  }
  return C1_CONTROL.test(run);
}

const byteOf = (char: string): number => WINDOWS_1252_HIGH_BYTES.get(char) ?? char.charCodeAt(0);

const continuationsFor = (leadByte: number): number => {
  if (leadByte >= 0xf0) return 3;
  if (leadByte >= 0xe0) return 2;
  return 1;
};

function repairRun(run: string, offset: number, text: string): string {
  const [lead = '', ...continuations] = [...run];
  const needed = continuationsFor(byteOf(lead));
  if (continuations.length < needed) return run;
  const candidate = [lead, ...continuations.slice(0, needed)];
  const rest = continuations.slice(needed).join('');
  try {
    const repaired = strictUtf8.decode(new Uint8Array(candidate.map(byteOf)));
    const after = rest + text.slice(offset + run.length);
    if (!isPlausibleRepair({ run: candidate.join(''), repaired, after })) return run;
    return repaired.replace(BYTE_ORDER_MARK, '') + rest;
  } catch {
    return run;
  }
}

export function repairMojibake(text: string): string {
  return text.replace(MOJIBAKE_RUN, repairRun);
}
