/// <reference path="../worker-configuration.d.ts" />
import { describe, it, expect } from 'vitest';
import { isErrorTrace, filterErrorTraces } from '../src/filter';

type MakeTraceOptions = {
  readonly outcome?: string;
  readonly exceptions?: readonly TraceException[];
  readonly logs?: readonly TraceLog[];
};

function makeTrace(options: MakeTraceOptions = {}): TraceItem {
  return {
    event: null,
    eventTimestamp: null,
    logs: options.logs ?? [],
    exceptions: options.exceptions ?? [],
    diagnosticsChannelEvents: [],
    scriptName: 'test-worker',
    outcome: options.outcome ?? 'ok',
    executionModel: 'stateless',
    truncated: false,
    cpuTime: 0,
    wallTime: 0,
  };
}

function makeException(message = 'Something went wrong'): TraceException {
  return {
    timestamp: Date.now(),
    message,
    name: 'Error',
  };
}

function makeLog(level: string, message = 'log message'): TraceLog {
  return {
    timestamp: Date.now(),
    level,
    message,
  };
}

describe('isErrorTrace', () => {
  it('returns true for exception outcome', () => {
    expect(isErrorTrace(makeTrace({ outcome: 'exception' }))).toBe(true);
  });

  it('returns true for exceededCpu outcome', () => {
    expect(isErrorTrace(makeTrace({ outcome: 'exceededCpu' }))).toBe(true);
  });

  it('returns false for canceled outcome', () => {
    expect(isErrorTrace(makeTrace({ outcome: 'canceled' }))).toBe(false);
  });

  it('returns false for responseStreamDisconnected outcome', () => {
    expect(isErrorTrace(makeTrace({ outcome: 'responseStreamDisconnected' }))).toBe(false);
  });

  it('returns true for ok outcome with exceptions present', () => {
    expect(isErrorTrace(makeTrace({ outcome: 'ok', exceptions: [makeException()] }))).toBe(true);
  });

  it('returns true for ok outcome with error-level logs', () => {
    expect(isErrorTrace(makeTrace({ outcome: 'ok', logs: [makeLog('error')] }))).toBe(true);
  });

  it('returns false when outcome is ok, no exceptions, and no error logs', () => {
    expect(
      isErrorTrace(
        makeTrace({
          outcome: 'ok',
          exceptions: [],
          logs: [makeLog('info'), makeLog('debug')],
        }),
      ),
    ).toBe(false);
  });

  it('returns true for an unknown outcome (safe default)', () => {
    expect(isErrorTrace(makeTrace({ outcome: 'unknownFutureOutcome' }))).toBe(true);
  });
});

describe('filterErrorTraces', () => {
  it('filters a mixed array down to error traces only', () => {
    const traces: readonly TraceItem[] = [
      makeTrace({ outcome: 'ok' }),
      makeTrace({ outcome: 'exception' }),
      makeTrace({ outcome: 'canceled' }),
      makeTrace({ outcome: 'ok', exceptions: [makeException()] }),
      makeTrace({ outcome: 'responseStreamDisconnected' }),
      makeTrace({ outcome: 'ok', logs: [makeLog('error')] }),
    ];

    const result = filterErrorTraces(traces);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(traces[1]);
    expect(result[1]).toBe(traces[3]);
    expect(result[2]).toBe(traces[5]);
  });
});
