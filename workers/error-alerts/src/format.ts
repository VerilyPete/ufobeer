import { redact, truncate, stripQueryString, pathOnly } from './redact';

export const MAX_TRACES_PER_EMAIL = 10;
export const FROM_ADDRESS = 'alerts@ufobeer.app';

// Cap on a single exception message, applied before the rest of the email
// is assembled, so one huge (or adversarially long) message can't dominate
// the body on its own.
export const MAX_EXCEPTION_MESSAGE_LENGTH = 500;

// Same idea, for a single error-level log message.
export const MAX_LOG_MESSAGE_LENGTH = 500;

// Overall email body cap, enforced last and independently of the per-field
// limits above — many small fields together still can't grow the email
// without bound.
export const MAX_EMAIL_BODY_LENGTH = 20_000;

// Prepended when the cooldown or email-volume cap fell back to its
// in-isolate tier (see cooldown.ts / emailCap.ts), so a reader knows
// dedup is weaker than usual and volume may be higher than the normal cap.
export const DEGRADED_COOLDOWN_MARKER = '[cooldown: degraded — KV unavailable; dedup and volume limits are weaker than usual]';

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
    lines.push(`Request: ${trace.event.request.method} ${stripQueryString(trace.event.request.url)}`);
  }

  lines.push('');

  const errorLogs = trace.logs.filter((log) => log.level === 'error');

  if (trace.exceptions.length > 0) {
    lines.push('--- Exceptions ---');
    for (const exc of trace.exceptions) {
      lines.push(`${exc.name}: ${truncate(redact(exc.message), MAX_EXCEPTION_MESSAGE_LENGTH)}`);
    }
    lines.push('');
  }

  if (errorLogs.length > 0) {
    lines.push('--- Error Logs ---');
    for (const log of errorLogs) {
      const message = truncate(redact(safeStringify(log.message)), MAX_LOG_MESSAGE_LENGTH);
      lines.push(`[${formatTimestamp(log.timestamp)}] ${message}`);
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
    const path = pathOnly(event.request.url);
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

export function buildBody(traces: readonly TraceItem[], suppressedCount?: number, degraded?: boolean): string {
  const cappedTraces = traces.slice(0, MAX_TRACES_PER_EMAIL);
  const omittedCount = traces.length - cappedTraces.length;

  const parts: string[] = [];

  if (degraded === true) {
    parts.push(`${DEGRADED_COOLDOWN_MARKER}\n`);
  }

  if (suppressedCount !== undefined && suppressedCount > 0) {
    parts.push(`${suppressedCount} alerts were suppressed since last notification\n`);
  }

  parts.push(cappedTraces.map(formatTrace).join('\n========================================\n\n'));

  if (omittedCount > 0) {
    parts.push(`\n... and ${omittedCount} more errors in this batch (omitted).`);
  }

  return truncate(parts.join('\n'), MAX_EMAIL_BODY_LENGTH);
}

export function buildRawEmail(subject: string, body: string, toAddress: string): string {
  const date = new Date().toUTCString();
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@ufobeer.app>`;
  const headers = [
    `From: ${FROM_ADDRESS}`,
    `To: ${toAddress}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ].join('\r\n');

  const crlfBody = body.replace(/\r?\n/g, '\r\n');

  return `${headers}\r\n\r\n${crlfBody}`;
}
