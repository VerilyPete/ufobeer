#!/usr/bin/env node
// Proposes spelling corrections for human review. Prints every codespell
// misspelling -> correction pair that occurs in production beer descriptions
// and is not yet in src/queue/dictionary/spellingCorrections.ts, with a count,
// an example beer and the surrounding text. Nothing is applied automatically:
// a reviewer copies only the pairs that are genuine typos in context.
//
// Pairs whose misspelling is a SCOWL/ESDB size-95 word are skipped, since a
// real word is never a typo. That filter is not sufficient on its own
// ("tripel", "Hass", "folx" pass it), which is why review is required.
//
// Read-only: queries the remote D1 database with wrangler.
// Usage: npm run spelling:candidates

import { execFileSync } from 'node:child_process';
import { APPROVED_SPELLING_CORRECTIONS } from '../src/queue/dictionary/spellingCorrections.ts';

const CODESPELL_URL =
  'https://raw.githubusercontent.com/codespell-project/codespell/main/codespell_lib/data/dictionary.txt';
const SCOWL_URL =
  'http://app.aspell.net/create?max_size=95&spelling=US&spelling=GBs&spelling=GBz&spelling=CA&spelling=AU' +
  '&max_variant=3&diacritic=both&special=hacker&special=roman-numerals&download=wordlist&encoding=utf-8&format=inline';
const QUERY =
  "SELECT brew_name, brew_description_original AS description FROM enriched_beers " +
  "WHERE brew_description_original IS NOT NULL AND brew_description_original != ''";
// Same word boundaries as src/queue/cleanupGuard.ts, so "café" is one word.
const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const PLAIN_WORD = /^[a-z]+$/;
// Pairs a reviewer has struck, with the reason, so they are not proposed again.
const REJECTED = new Map([
  ['tripel', 'Belgian beer style, not a typo of "triple"'],
  ['tripels', 'plural of the tripel beer style'],
]);

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
  return response.text();
}

function readDescriptions() {
  const stdout = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'beer-db', '--remote', '--json', '--command', QUERY],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const [result] = JSON.parse(stdout);
  if (!result?.results) throw new Error('Unexpected wrangler output');
  return result.results;
}

const [codespell, scowl] = await Promise.all([download(CODESPELL_URL), download(SCOWL_URL)]);

const separator = scowl.indexOf('\n---\n');
if (separator === -1) throw new Error('SCOWL list is missing its header separator');
const realWords = new Set(scowl.slice(separator + 5).split('\n').map(word => word.trim().toLowerCase()));

const pairs = new Map(
  codespell
    .split('\n')
    .map(line => line.trim().match(/^([^-]+)->([^,]+),?$/))
    .filter(match => match !== null)
    .map(([, misspelling, correction]) => [misspelling, correction])
    .filter(([misspelling, correction]) =>
      PLAIN_WORD.test(misspelling) && PLAIN_WORD.test(correction) &&
      !realWords.has(misspelling) && !APPROVED_SPELLING_CORRECTIONS.has(misspelling) &&
      !REJECTED.has(misspelling)),
);

const candidates = new Map();
for (const { brew_name: beer, description } of readDescriptions()) {
  for (const match of description.matchAll(WORD_PATTERN)) {
    const misspelling = match[0].toLowerCase();
    const correction = pairs.get(misspelling);
    if (!correction) continue;
    const existing = candidates.get(misspelling);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const context = description.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40);
    candidates.set(misspelling, { correction, count: 1, beer, context: context.replace(/\s+/g, ' ') });
  }
}

const rows = [...candidates.entries()].sort(([, a], [, b]) => b.count - a.count);
if (rows.length === 0) console.log('No new candidate pairs.');
for (const [misspelling, { correction, count, beer, context }] of rows) {
  console.log(`${misspelling} -> ${correction}  x${count}  [${beer}]\n    …${context}…`);
}
