import { describe, it, expect } from 'vitest';
import {
  buildSubject,
  buildBody,
  buildRawEmail,
  MAX_TRACES_PER_EMAIL,
  FROM_ADDRESS,
  TO_ADDRESS,
} from '../src/format';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

type PartialTraceItem = {
  event?: TraceItem['event'];
  logs?: TraceLog[];
  exceptions?: TraceException[];
  scriptName?: string | null;
  outcome?: string;
  truncated?: boolean;
  cpuTime?: number;
  wallTime?: number;
  eventTimestamp?: number | null;
};

function makeTrace(overrides: PartialTraceItem = {}): TraceItem {
  return {
    event: overrides.event !== undefined ? overrides.event : makeFetchEvent(),
    logs: overrides.logs ?? [],
    exceptions: overrides.exceptions ?? [],
    scriptName: overrides.scriptName !== undefined ? overrides.scriptName : 'ufobeer-worker',
    outcome: overrides.outcome ?? 'exception',
    truncated: overrides.truncated ?? false,
    cpuTime: overrides.cpuTime ?? 10,
    wallTime: overrides.wallTime ?? 20,
    eventTimestamp: overrides.eventTimestamp !== undefined ? overrides.eventTimestamp : 1700000000000,
    diagnosticsChannelEvents: [],
    executionModel: 'stateless',
  };
}

function makeFetchEvent(method = 'GET', url = 'https://api.ufobeer.app/beers?store_id=13'): TraceItemFetchEventInfo {
  return {
    request: {
      method,
      url,
      headers: {},
      cf: undefined,
      getUnredacted() {
        return this;
      },
    },
  };
}

function makeQueueEvent(queue = 'beer-enrichment', batchSize = 5): TraceItemQueueEventInfo {
  return { queue, batchSize };
}

function makeScheduledEvent(cron = '0 */12 * * *', scheduledTime = 1700000000000): TraceItemScheduledEventInfo {
  return { cron, scheduledTime };
}

function makeException(overrides: Partial<TraceException> = {}): TraceException {
  return {
    timestamp: 1700000000000,
    name: overrides.name ?? 'TypeError',
    message: overrides.message ?? 'Cannot read properties of undefined',
    stack: overrides.stack,
  };
}

function makeLog(level: string, message: unknown, timestamp = 1700000000000): TraceLog {
  return { timestamp, level, message };
}

// ---------------------------------------------------------------------------
// buildSubject
// ---------------------------------------------------------------------------

describe('buildSubject', () => {
  it('includes outcome and request path for fetch events', () => {
    const trace = makeTrace({
      outcome: 'exception',
      event: makeFetchEvent('GET', 'https://api.ufobeer.app/beers?store_id=13'),
    });

    expect(buildSubject(trace)).toBe('[UFO Beer] exception — GET /beers?store_id=13');
  });

  it('includes queue name for queue events', () => {
    const trace = makeTrace({
      outcome: 'exception',
      event: makeQueueEvent('beer-enrichment'),
    });

    expect(buildSubject(trace)).toBe('[UFO Beer] exception — queue: beer-enrichment');
  });

  it('says "scheduled" for cron events', () => {
    const trace = makeTrace({
      outcome: 'exception',
      event: makeScheduledEvent(),
    });

    expect(buildSubject(trace)).toBe('[UFO Beer] exception — scheduled');
  });

  it('includes only outcome when event is null', () => {
    const trace = makeTrace({ outcome: 'exception', event: null });

    expect(buildSubject(trace)).toBe('[UFO Beer] exception');
  });
});

// ---------------------------------------------------------------------------
// buildBody
// ---------------------------------------------------------------------------

describe('buildBody', () => {
  it('includes exception name and message', () => {
    const trace = makeTrace({
      exceptions: [makeException({ name: 'RangeError', message: 'Index out of range' })],
    });

    const body = buildBody([trace]);

    expect(body).toContain('RangeError: Index out of range');
  });

  it('includes error-level log messages', () => {
    const trace = makeTrace({
      logs: [makeLog('error', 'Something went wrong')],
    });

    const body = buildBody([trace]);

    expect(body).toContain('Something went wrong');
  });

  it('includes CPU and wall time', () => {
    const trace = makeTrace({ cpuTime: 42, wallTime: 99 });

    const body = buildBody([trace]);

    expect(body).toContain('CPU: 42ms | Wall: 99ms');
  });

  it('notes "[logs truncated]" when trace.truncated is true', () => {
    const trace = makeTrace({ truncated: true });

    const body = buildBody([trace]);

    expect(body).toContain('[logs truncated]');
  });

  it('does not note truncated when trace.truncated is false', () => {
    const trace = makeTrace({ truncated: false });

    const body = buildBody([trace]);

    expect(body).not.toContain('[logs truncated]');
  });

  it('caps traces at MAX_TRACES_PER_EMAIL', () => {
    const traces = Array.from({ length: MAX_TRACES_PER_EMAIL + 3 }, (_, i) =>
      makeTrace({ scriptName: `worker-${i}` })
    );

    const body = buildBody(traces);

    // Only the first MAX_TRACES_PER_EMAIL workers should appear
    expect(body).toContain('worker-0');
    expect(body).toContain(`worker-${MAX_TRACES_PER_EMAIL - 1}`);
    expect(body).not.toContain(`worker-${MAX_TRACES_PER_EMAIL}`);
  });

  it('appends omitted count message when batch exceeds cap', () => {
    const overflow = 3;
    const traces = Array.from({ length: MAX_TRACES_PER_EMAIL + overflow }, () => makeTrace());

    const body = buildBody(traces);

    expect(body).toContain(`... and ${overflow} more errors in this batch (omitted).`);
  });

  it('handles non-string log messages using JSON.stringify', () => {
    const trace = makeTrace({
      logs: [makeLog('error', { code: 42, detail: 'bad' })],
    });

    const body = buildBody([trace]);

    expect(body).toContain(JSON.stringify({ code: 42, detail: 'bad' }));
  });

  it('handles unserializable log messages gracefully', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const trace = makeTrace({
      logs: [makeLog('error', circular)],
    });

    const body = buildBody([trace]);

    expect(body).toContain('[unserializable]');
  });

  it('prepends suppressed count when suppressedCount > 0', () => {
    const trace = makeTrace();

    const body = buildBody([trace], 7);

    expect(body).toMatch(/^7 alerts were suppressed since last notification/);
  });

  it('does not prepend suppressed count when suppressedCount is 0', () => {
    const trace = makeTrace();

    const body = buildBody([trace], 0);

    expect(body).not.toContain('alerts were suppressed');
  });

  it('uses scriptName from trace and falls back to "unknown"', () => {
    const traceWithName = makeTrace({ scriptName: 'my-worker' });
    const traceWithNull = makeTrace({ scriptName: null });

    expect(buildBody([traceWithName])).toContain('Worker: my-worker');
    expect(buildBody([traceWithNull])).toContain('Worker: unknown');
  });

  it('omits Exceptions section when there are no exceptions', () => {
    const trace = makeTrace({ exceptions: [] });

    const body = buildBody([trace]);

    expect(body).not.toContain('--- Exceptions ---');
  });

  it('omits Error Logs section when there are no error-level logs', () => {
    const trace = makeTrace({
      logs: [makeLog('info', 'just info')],
    });

    const body = buildBody([trace]);

    expect(body).not.toContain('--- Error Logs ---');
  });

  it('separates multiple traces with a divider', () => {
    const traces = [
      makeTrace({ scriptName: 'worker-a' }),
      makeTrace({ scriptName: 'worker-b' }),
    ];

    const body = buildBody(traces);

    expect(body).toContain('========================================');
    expect(body).toContain('worker-a');
    expect(body).toContain('worker-b');
  });
});

// ---------------------------------------------------------------------------
// buildRawEmail
// ---------------------------------------------------------------------------

describe('buildRawEmail', () => {
  it('uses CRLF line endings throughout', () => {
    const raw = buildRawEmail('Test Subject', 'Hello body');

    // Should not contain bare LF (only \r\n pairs)
    const withoutCRLF = raw.replace(/\r\n/g, '');
    expect(withoutCRLF).not.toContain('\n');
  });

  it('separates headers from body with CRLF+CRLF', () => {
    const raw = buildRawEmail('Test Subject', 'Hello body');

    expect(raw).toContain('\r\n\r\n');
    const [headers, ...bodyParts] = raw.split('\r\n\r\n');
    expect(headers).toBeTruthy();
    expect(bodyParts.join('\r\n\r\n')).toContain('Hello body');
  });

  it('includes required headers: From, To, Date, Subject, MIME-Version, Content-Type', () => {
    const raw = buildRawEmail('Alert Subject', 'body text');

    expect(raw).toContain(`From: ${FROM_ADDRESS}`);
    expect(raw).toContain(`To: ${TO_ADDRESS}`);
    expect(raw).toContain('Subject: Alert Subject');
    expect(raw).toContain('MIME-Version: 1.0');
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    // Date header should be present (value changes, just check key)
    expect(raw).toMatch(/^Date: /m);
  });
});
