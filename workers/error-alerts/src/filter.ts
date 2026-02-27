const NON_ERROR_OUTCOMES = new Set(['ok', 'canceled', 'responseStreamDisconnected']);

export function isErrorTrace(trace: TraceItem): boolean {
  if (!NON_ERROR_OUTCOMES.has(trace.outcome)) return true;
  if (trace.exceptions.length > 0) return true;
  if (trace.logs.some((log) => log.level === 'error')) return true;
  return false;
}

export function filterErrorTraces(traces: readonly TraceItem[]): readonly TraceItem[] {
  return traces.filter(isErrorTrace);
}
