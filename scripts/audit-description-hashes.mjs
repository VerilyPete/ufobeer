#!/usr/bin/env node
// Lists enriched_beers rows whose description_hash is not the hash of their
// stored brew_description_original (src/utils/hash.ts: first 16 bytes of
// SHA-256, as 32 hex characters). Expect none; see the Rollout section of
// plans/enriched-beers-write-paths.md for how to repair any it finds.
//
// Equal hash and text is a necessary check, not proof that the cleaned text
// matches the original.
//
// Read-only: queries the remote D1 database with wrangler.
// Usage: node scripts/audit-description-hashes.mjs [--local]

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const QUERY =
  "SELECT id, brew_description_original AS original, description_hash AS hash FROM enriched_beers " +
  "WHERE brew_description_original IS NOT NULL AND brew_description_original != ''";

export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest().subarray(0, 16).toString('hex');
}

export function findMismatches(rows) {
  return rows
    .filter(row => row.hash !== hashText(row.original))
    .map(row => ({ id: row.id, stored: row.hash, expected: hashText(row.original) }));
}

async function readRows(target) {
  const { execFileSync } = await import('node:child_process');
  const stdout = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'beer-db', target, '--json', '--command', QUERY],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const [result] = JSON.parse(stdout);
  if (!result?.results) throw new Error('Unexpected wrangler output');
  return result.results;
}

async function main() {
  const target = process.argv.includes('--local') ? '--local' : '--remote';
  const rows = await readRows(target);
  const mismatches = findMismatches(rows);
  console.log(JSON.stringify({ checked: rows.length, mismatches: mismatches.length }));
  for (const mismatch of mismatches) console.log(JSON.stringify(mismatch));
  process.exitCode = mismatches.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
