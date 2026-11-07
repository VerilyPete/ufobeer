/**
 * Request contract for POST /usage (plans/usage-telemetry.md, slice 7).
 *
 * BeerSelector commits usage-report.request.json, written by the app's
 * production Swift encoder for a canonical batch, and
 * usage-report.expected.json, the same batch written by hand. A 204 makes
 * the app delete its batch and the parser silently drops unknown names and
 * bad counts, so this test asserts the parsed events and counts, not only
 * that the envelope is accepted.
 *
 * The fixtures resolve through the @usage-contract-fixtures alias
 * (vitest.config.mts): the sibling BeerSelector checkout by default.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import requestFixture from '@usage-contract-fixtures/usage-report.request.json?raw';
import expectedFixture from '@usage-contract-fixtures/usage-report.expected.json?raw';
import { parseUsageReport, USAGE_AI_STATUSES, USAGE_EVENTS } from '../src/schemas/request';

const ExpectedReportSchema = z.object({
  install_id: z.string(),
  batch_id: z.string(),
  app_version: z.string(),
  // A known status, never the parser's 'other' fallback: an app-side
  // spelling change must not vanish into normalization.
  ai_status: z.enum(USAGE_AI_STATUSES),
  os_major: z.number(),
  events: z.array(z.object({ name: z.string(), count: z.number().int() }).strict()),
}).strict();

const RequestEventItemsSchema = z.object({ events: z.array(z.unknown()) });

const expected = ExpectedReportSchema.parse(JSON.parse(expectedFixture));
const request: unknown = JSON.parse(requestFixture);

const byName = (events: ReadonlyArray<{ readonly name: string; readonly count: number }>) =>
  [...events].map(({ name, count }) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));

const parseOk = () => {
  const result = parseUsageReport(request);
  if (!result.success) {
    throw new Error(`the app's request was rejected: ${result.error.message}`);
  }
  return result;
};

describe('POST /usage request contract (app encoder -> worker parser)', () => {
  it('accepts the envelope the app encodes', () => {
    expect(parseUsageReport(request).success).toBe(true);
  });

  it('keeps every event item the app sends, without dropping or merging any', () => {
    const result = parseOk();

    expect(result.droppedCount).toBe(0);
    expect(result.report.events).toHaveLength(RequestEventItemsSchema.parse(request).events.length);
  });

  it('reads the envelope the app means', () => {
    const { report } = parseOk();

    expect({
      installId: report.installId,
      batchId: report.batchId,
      appVersion: report.appVersion,
      aiStatus: report.aiStatus,
      osMajor: report.osMajor,
    }).toEqual({
      installId: expected.install_id.toLowerCase(),
      batchId: expected.batch_id.toLowerCase(),
      appVersion: expected.app_version,
      aiStatus: expected.ai_status,
      osMajor: expected.os_major,
    });
  });

  it('reads every event name and count the app means', () => {
    expect(byName(parseOk().report.events)).toEqual(byName(expected.events));
  });

  // A subset, not equality: the worker learns a new event first, deploys,
  // and only then does the app add it, so each side's contract run (against
  // the other repository's main) stays green at every step. The app proves
  // in its own Swift test that the canonical batch covers every event it
  // can send.
  it('only sends events the worker knows', () => {
    const known: ReadonlySet<string> = new Set(USAGE_EVENTS);
    expect(expected.events.map((event) => event.name).filter((name) => !known.has(name))).toEqual([]);
  });

  it('uses a canonical batch with one item per event and counts 1 to N, so no count can hide another', () => {
    const names = expected.events.map((event) => event.name);
    const counts = expected.events.map((event) => event.count);

    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts.map((_, i) => i + 1));
  });
});
