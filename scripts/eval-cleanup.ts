// Offline evaluation of AI description cleanup against real descriptions
// (plan step 6). Runs the production path, processAIConcurrently ->
// cleanDescriptionSafely -> checkCleanup, with the production prompt and
// model, through the Workers AI REST API instead of the AI binding.
// Writes a Markdown report of every accepted edit and every fallback, for
// human review before the guard is deployed.
//
// Read-only against D1. Spends one Workers AI call per sampled description.
// Usage: npm run eval:cleanup -- [sample size, default 200] [report path]

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { processAIConcurrently } from '../src/queue/cleanup';
import { APPROVED_SPELLING_CORRECTIONS } from '../src/queue/dictionary/spellingCorrections';
import { createCircuitBreaker, DEFAULT_CONFIG } from '../src/queue/circuitBreaker';

type QueueMessage = Parameters<typeof processAIConcurrently>[0][number];
type AiBinding = Parameters<typeof processAIConcurrently>[1];
type Row = { readonly id: string; readonly brew_name: string; readonly brewer: string; readonly description: string };
type Outcome = {
  readonly row: Row;
  readonly response: string | null;
  readonly cleaned: string | null;
  readonly usedOriginal: boolean | null;
  readonly logs: readonly string[];
};

const sampleSize = Number(process.argv[2] ?? 200);
const reportPath = process.argv[3] ?? 'cleanup-eval-report.md';
const MODEL = '@cf/meta/llama-3.2-3b-instruct';
const QUERY =
  "SELECT id, brew_name, brewer, brew_description_original AS description FROM enriched_beers " +
  "WHERE brew_description_original IS NOT NULL AND brew_description_original != '' ORDER BY id";

function wrangler(args: readonly string[]): string {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

const accountId: string = JSON.parse(wrangler(['whoami', '--json'])).accounts[0].id;
const token = wrangler(['auth', 'token']).trim().split('\n').at(-1)?.trim() ?? '';
const rows: Row[] = JSON.parse(wrangler(['d1', 'execute', 'beer-db', '--remote', '--json', '--command', QUERY]))[0].results;

// Every description that exercises a permitted fix, then the rest in ID
// order, so the sample shows both what the guard accepts and what it rejects.
const exercisesFix = (row: Row) =>
  /[A-Za-z],[A-Za-z]/.test(row.description) ||
  [...APPROVED_SPELLING_CORRECTIONS.keys()].some(word => new RegExp(`\\b${word}\\b`, 'i').test(row.description));
const sample = [...rows.filter(exercisesFix), ...rows.filter(row => !exercisesFix(row))].slice(0, sampleSize);

// Local REST calls are slower than the production slow-call threshold; a
// tripping breaker would turn every later call into a fallback.
const neverOpen = createCircuitBreaker({ ...DEFAULT_CONFIG, slowThresholdMs: Number.POSITIVE_INFINITY });

async function runModel(inputs: unknown): Promise<string | null> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(inputs),
  });
  if (!response.ok) throw new Error(`Workers AI HTTP ${response.status}: ${await response.text()}`);
  const json: { result?: { response?: string } } = await response.json();
  return json.result?.response ?? null;
}

async function evaluate(row: Row): Promise<Outcome> {
  let response: string | null = null;
  const logs: string[] = [];
  const capture = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  const { log, warn, error } = console;
  const ai = {
    run: async (_model: string, inputs: unknown) => {
      response = await runModel(inputs);
      return { response };
    },
  };
  const message = {
    body: { beerId: row.id, beerName: row.brew_name, brewer: row.brewer, brewDescription: row.description },
    ack: () => {},
    retry: () => {},
  };
  console.log = console.warn = console.error = capture;
  try {
    // The shims implement only what processAIConcurrently uses; the full Ai
    // and Message types describe the Workers runtime bindings.
    const [result] = await processAIConcurrently(
      [message as unknown as QueueMessage],
      ai as unknown as AiBinding,
      1,
      { breaker: neverOpen, timeoutMs: 60_000 },
    );
    return {
      row,
      response,
      cleaned: result?.success ? result.cleaned : null,
      usedOriginal: result?.success ? result.usedOriginal : null,
      logs,
    };
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

const outcomes: Outcome[] = [];
for (const [index, row] of sample.entries()) {
  outcomes.push(await evaluate(row));
  process.stderr.write(`\r${index + 1}/${sample.length}`);
}
process.stderr.write('\n');

const event = (outcome: Outcome, name: string) =>
  outcome.logs.map(line => { try { return JSON.parse(line); } catch { return null; } }).find(entry => entry?.event === name);
const accepted = outcomes.filter(outcome => event(outcome, 'cleanup.guard.accepted'));
const unchanged = outcomes.filter(outcome => outcome.usedOriginal === false && !event(outcome, 'cleanup.guard.accepted'));
const rejected = outcomes.filter(outcome => outcome.usedOriginal !== false);
const reasonOf = (outcome: Outcome) =>
  event(outcome, 'cleanup.guard.rejected')?.rule ??
  outcome.logs.find(line => line.startsWith('[cleanup]'))?.replace(/\(.*$/, '').slice(0, 120) ??
  'no result';
const reasons = rejected.reduce<Record<string, number>>(
  (counts, outcome) => ({ ...counts, [reasonOf(outcome)]: (counts[reasonOf(outcome)] ?? 0) + 1 }),
  {},
);

const report = [
  '# Cleanup guard evaluation',
  '',
  `Model \`${MODEL}\`, ${outcomes.length} production descriptions, ${new Date().toISOString()}.`,
  '',
  '| Outcome | Count |',
  '|---|---|',
  `| Accepted with edits | ${accepted.length} |`,
  `| Accepted, model returned the source unchanged | ${unchanged.length} |`,
  `| Fell back to deterministic cleanup | ${rejected.length} |`,
  '',
  '## Fallback reasons',
  '',
  '| Reason | Count |',
  '|---|---|',
  ...Object.entries(reasons).sort(([, a], [, b]) => b - a).map(([reason, count]) => `| ${reason} | ${count} |`),
  '',
  '## Every accepted edit (review each one)',
  '',
  ...accepted.flatMap(outcome => [
    `### ${outcome.row.brew_name} (\`${outcome.row.id}\`)`,
    '',
    ...event(outcome, 'cleanup.guard.accepted').edits.map((edit: { from: string; to: string }) => `- \`${edit.from}\` → \`${edit.to}\``),
    '',
  ]),
  '## Fallback examples (first 40)',
  '',
  ...rejected.slice(0, 40).flatMap(outcome => [
    `### ${outcome.row.brew_name} — ${reasonOf(outcome)}`,
    '',
    '**Source:**',
    '',
    '> ' + outcome.row.description.replace(/\s+/g, ' ').slice(0, 600),
    '',
    '**Model:**',
    '',
    '> ' + (outcome.response ?? '(no response)').replace(/\s+/g, ' ').slice(0, 600),
    '',
  ]),
].join('\n');

writeFileSync(reportPath, report);
console.log(`Wrote ${reportPath}: ${accepted.length} accepted with edits, ${unchanged.length} unchanged, ${rejected.length} fell back.`);
