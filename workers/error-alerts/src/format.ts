export const MAX_TRACES_PER_EMAIL = 10;
export const FROM_ADDRESS = 'alerts@ufobeer.app';
export const TO_ADDRESS = 'pete@verily.org';

// ---------------------------------------------------------------------------
// Type narrowing helpers
// ---------------------------------------------------------------------------

function isFetchEvent(event: TraceItem['event']): event is TraceItemFetchEventInfo {
  return event !== null && 'request' in event;
}

function isQueueEvent(event: TraceItem['event']): event is TraceItemQueueEventInfo {
  return event !== null && 'queue' in event;
}

function isScheduledEvent(event: TraceItem['event']): event is TraceItemScheduledEventInfo {
  return event !== null && 'cron' in event;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function formatTrace(trace: TraceItem): string {
  const lines: string[] = [];

  lines.push(`Worker: ${trace.scriptName ?? 'unknown'}`);
  lines.push(`Outcome: ${trace.outcome}`);

  if (trace.eventTimestamp !== null) {
    lines.push(`Time: ${new Date(trace.eventTimestamp).toISOString()}`);
  }

  if (isFetchEvent(trace.event)) {
    lines.push(`Request: ${trace.event.request.method} ${trace.event.request.url}`);
  }

  lines.push('');

  const errorLogs = trace.logs.filter((log) => log.level === 'error');

  if (trace.exceptions.length > 0) {
    lines.push('--- Exceptions ---');
    for (const exc of trace.exceptions) {
      lines.push(`${exc.name}: ${exc.message}`);
    }
    lines.push('');
  }

  if (errorLogs.length > 0) {
    lines.push('--- Error Logs ---');
    for (const log of errorLogs) {
      lines.push(`[${formatTimestamp(log.timestamp)}] ${safeStringify(log.message)}`);
    }
    lines.push('');
  }

  if (trace.truncated) {
    lines.push('[logs truncated]');
    lines.push('');
  }

  lines.push(`CPU: ${trace.cpuTime}ms | Wall: ${trace.wallTime}ms`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function buildSubject(trace: TraceItem): string {
  const prefix = `[UFO Beer] ${trace.outcome}`;
  const { event } = trace;

  if (isFetchEvent(event)) {
    const parsed = new URL(event.request.url);
    const path = parsed.pathname + parsed.search;
    return `${prefix} — ${event.request.method} ${path}`;
  }

  if (isQueueEvent(event)) {
    return `${prefix} — queue: ${event.queue}`;
  }

  if (isScheduledEvent(event)) {
    return `${prefix} — scheduled`;
  }

  return prefix;
}

export function buildBody(traces: readonly TraceItem[], suppressedCount?: number): string {
  const cappedTraces = traces.slice(0, MAX_TRACES_PER_EMAIL);
  const omittedCount = traces.length - cappedTraces.length;

  const parts: string[] = [];

  if (suppressedCount !== undefined && suppressedCount > 0) {
    parts.push(`${suppressedCount} alerts were suppressed since last notification\n`);
  }

  parts.push(cappedTraces.map(formatTrace).join('\n========================================\n\n'));

  if (omittedCount > 0) {
    parts.push(`\n... and ${omittedCount} more errors in this batch (omitted).`);
  }

  return parts.join('\n');
}

export function buildRawEmail(subject: string, body: string): string {
  const date = new Date().toUTCString();
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@ufobeer.app>`;
  const headers = [
    `From: ${FROM_ADDRESS}`,
    `To: ${TO_ADDRESS}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ].join('\r\n');

  const crlfBody = body.replace(/\r?\n/g, '\r\n');

  return `${headers}\r\n\r\n${crlfBody}`;
}
