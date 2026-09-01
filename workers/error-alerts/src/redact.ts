// Small, best-effort scrubbing of secret-shaped text before it is placed
// into an alert email. Not exhaustive by design — a short list of
// high-value patterns kept readable, not an attempt to catch everything.

// Marker appended whenever a field or the whole email body is cut short, so
// a reader can tell content was removed rather than the text simply ending.
export const TRUNCATION_MARKER = '… [truncated]';

const REDACTION_RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly replacement: string }> = [
  // `Authorization: <value>` / `X-Api-Key: <value>` / `X-Admin-Secret: <value>` header lines
  // — consume the rest of the line, since a header value like `Bearer <token>` is more
  // than one whitespace-delimited word.
  {
    pattern: /\b(authorization|x-api-key|x-admin-secret)\s*:\s*[^\n\r]+/gi,
    replacement: '$1: [redacted]',
  },
  // `Cookie: ...` header lines — redact the whole value, since a cookie
  // line typically packs more than one credential.
  {
    pattern: /\bcookie\s*:\s*[^\n\r]+/gi,
    replacement: 'Cookie: [redacted]',
  },
  // Email addresses.
  {
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    replacement: '[redacted-email]',
  },
  // Long alphanumeric runs that mix letters and digits — tokens, API keys,
  // hashes, JWT segments — without flagging ordinary long English words
  // (which rarely contain digits).
  {
    pattern: /\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g,
    replacement: '[redacted-token]',
  },
];

export function redact(text: string): string {
  return REDACTION_RULES.reduce((acc, rule) => acc.replace(rule.pattern, rule.replacement), text);
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}${TRUNCATION_MARKER}`;
}

// Keeps scheme + host + path, drops the query string entirely.
export function stripQueryString(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // Not a parseable absolute URL — conservatively cut everything from the
    // first `?` rather than risk leaking a query string we can't parse.
    const queryIndex = url.indexOf('?');
    return queryIndex === -1 ? url : url.slice(0, queryIndex);
  }
}

// Same idea as stripQueryString, but returns only the path (no scheme/host)
// for contexts — like the email subject — that already omit the host.
export function pathOnly(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const queryIndex = url.indexOf('?');
    return queryIndex === -1 ? url : url.slice(0, queryIndex);
  }
}
