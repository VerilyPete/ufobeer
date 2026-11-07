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

const BYTE_ORDER_MARK = '\ufeff';
const C1_CONTROL = /[\u0080-\u009f]/u;
const LETTER = /^\p{L}$/u;
const ENDS_WITH_LETTER = /\p{L}$/u;
const NBSP = '\u00a0';
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
  readonly before: string;
  readonly after: string;
  readonly wordHasMojibake: boolean;
  readonly earlierLetterMojibake: boolean;
}): boolean {
  const { run, repaired, before, after, wordHasMojibake, earlierLetterMojibake } = options;
  const codePoint = repaired.codePointAt(0) ?? 0;
  if (codePoint >= 0x10000) return inRange(codePoint, EMOJI);
  if (codePoint >= 0x800) return PLAUSIBLE_THREE_BYTE.some(range => inRange(codePoint, range));
  const [lead = '', continuation = ''] = [...run];
  if (lead === 'Â') return inRange(codePoint, [0xa0, 0xbf]);
  if (LATIN_LETTER_LEADS.has(lead) && continuation === NBSP) {
    // A genuine word can end in Ã or Å before a non-breaking space ("MAÇÃ"),
    // whatever follows, so the run is repaired only where no genuine word
    // ends: on its own ("à la", "Šumava"), or after mojibake ("dÃ©jÃ").
    return !ENDS_WITH_LETTER.test(before) || earlierLetterMojibake;
  }
  if (LATIN_LETTER_LEADS.has(lead)) {
    return LETTER.test(repaired) && inRange(codePoint, [0xc0, 0x17f])
      && (wordHasMojibake || !endsWord(continuation, after));
  }
  return C1_CONTROL.test(run);
}

const byteOf = (char: string): number => WINDOWS_1252_HIGH_BYTES.get(char) ?? char.charCodeAt(0);

const continuationsFor = (leadByte: number): number => {
  if (leadByte >= 0xf0) return 3;
  if (leadByte >= 0xe0) return 2;
  return 1;
};

type DecodedRun = { readonly repaired: string; readonly rest: string };

function decodeRun(options: {
  readonly run: string;
  readonly offset: number;
  readonly word: string;
  readonly wordHasMojibake: boolean;
  readonly earlierLetterMojibake: boolean;
}): DecodedRun | null {
  const { run, offset, word, wordHasMojibake, earlierLetterMojibake } = options;
  const [lead = '', ...continuations] = [...run];
  const needed = continuationsFor(byteOf(lead));
  if (continuations.length < needed) return null;
  const candidate = [lead, ...continuations.slice(0, needed)];
  const rest = continuations.slice(needed).join('');
  try {
    const repaired = strictUtf8.decode(new Uint8Array(candidate.map(byteOf)));
    const before = word.slice(0, offset);
    const after = rest + word.slice(offset + run.length);
    return isPlausibleRepair({ run: candidate.join(''), repaired, before, after, wordHasMojibake, earlierLetterMojibake })
      ? { repaired, rest } : null;
  } catch {
    return null;
  }
}

type LetterEvidence = {
  readonly earlierByOffset: ReadonlyMap<number, boolean>;
  readonly wordHasMojibake: boolean;
};

const isLetterRepair = (decoded: DecodedRun | null): boolean => decoded !== null && LETTER.test(decoded.repaired);

// A word with one unambiguous repaired letter is mojibake, so a word-final
// run in it is repaired even when its byte reads as trailing punctuation
// ("RychtÃ¡Å™" -> "Rychtář"), while a genuine word stays intact ("MAÇÃ”").
//
// A run before an Ã/Å + U+00A0 run needs letter mojibake in the text before
// it. One left-to-right pass records that for each run, because rescanning
// every prefix grew exponentially on long words of ambiguous runs. Judged on
// the text before the current run, only the previous run can differ from its
// judgement on the whole word: endsWord reads at most two characters after a
// run, and any earlier run has a whole run of two or more characters between
// it and the current one. So the previous run alone is judged again.
function letterEvidence(word: string): LetterEvidence {
  const runs = [...word.matchAll(MOJIBAKE_RUN)].map(({ 0: run, index: offset }) => ({ run, offset }));
  const earlier: boolean[] = [];
  const letter: boolean[] = [];
  let seenBeforePrevious = false;
  runs.forEach(({ run, offset }, index) => {
    seenBeforePrevious = seenBeforePrevious || (letter[index - 2] ?? false);
    const previous = runs[index - 1];
    const previousLetterBeforeRun = previous !== undefined && isLetterRepair(decodeRun({
      ...previous, word: word.slice(0, offset), wordHasMojibake: false, earlierLetterMojibake: earlier[index - 1] ?? false,
    }));
    earlier.push(seenBeforePrevious || previousLetterBeforeRun);
    letter.push(isLetterRepair(decodeRun({ run, offset, word, wordHasMojibake: false, earlierLetterMojibake: earlier[index] ?? false })));
  });
  return {
    earlierByOffset: new Map(runs.map(({ offset }, index) => [offset, earlier[index] ?? false])),
    wordHasMojibake: letter.some(Boolean),
  };
}

function repairWord(word: string): string {
  const { earlierByOffset, wordHasMojibake } = letterEvidence(word);
  return word.replace(MOJIBAKE_RUN, (run: string, offset: number) => {
    const earlierLetterMojibake = earlierByOffset.get(offset) ?? false;
    const decoded = decodeRun({ run, offset, word, wordHasMojibake, earlierLetterMojibake });
    return decoded === null ? run : decoded.repaired.replace(BYTE_ORDER_MARK, '') + decoded.rest;
  });
}

// Whitespace separates words, including a non-breaking space and its
// mangled form "Â" + U+00A0, which is kept whole so it is still repaired.
// After any other lead, U+00A0 is a continuation byte ("Ã" + U+00A0 is à),
// so it stays in the word for isPlausibleRepair to judge.
const WORD_SEPARATOR = /((?:Â\u00a0|(?<![\u00c3-\u00f4])\u00a0|[^\S\u00a0])+)/u;

export function repairMojibake(text: string): string {
  return text.split(WORD_SEPARATOR).map(repairWord).join('');
}
