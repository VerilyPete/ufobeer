import { describe, it, expect } from 'vitest';
import { redact, truncate, stripQueryString, pathOnly, TRUNCATION_MARKER } from '../src/redact';

describe('redact', () => {
  it('redacts an Authorization header value', () => {
    expect(redact('Authorization: Bearer abc.def.ghi')).toContain('Authorization: [redacted]');
    expect(redact('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
  });

  it('redacts an X-Api-Key header value', () => {
    expect(redact('X-Api-Key: sk_live_1234567890abcdef')).toContain('X-Api-Key: [redacted]');
    expect(redact('X-Api-Key: sk_live_1234567890abcdef')).not.toContain('sk_live_1234567890abcdef');
  });

  it('redacts an X-Admin-Secret header value', () => {
    expect(redact('X-Admin-Secret: topsecretvalue123')).toContain('X-Admin-Secret: [redacted]');
    expect(redact('X-Admin-Secret: topsecretvalue123')).not.toContain('topsecretvalue123');
  });

  it('redacts a Cookie header line', () => {
    const input = 'Cookie: session=abc123; other=xyz789';
    expect(redact(input)).toBe('Cookie: [redacted]');
  });

  it('redacts email addresses', () => {
    expect(redact('contact user@example.com for help')).toBe('contact [redacted-email] for help');
  });

  it('redacts long alphanumeric tokens that mix letters and digits', () => {
    const token = 'a1b2c3d4e5f6g7h8i9j0k1l2';
    expect(token.length).toBeGreaterThanOrEqual(24);
    expect(redact(`token=${token}`)).toBe('token=[redacted-token]');
  });

  it('does not redact ordinary long words with no digits', () => {
    expect(redact('responseStreamDisconnected')).toBe('responseStreamDisconnected');
  });

  it('does not redact short identifiers', () => {
    expect(redact('id123')).toBe('id123');
  });

  it('leaves unrelated text untouched', () => {
    expect(redact('Cannot read properties of undefined')).toBe('Cannot read properties of undefined');
  });
});

describe('truncate', () => {
  it('returns text unchanged when under the limit', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('cuts text at the limit and appends the truncation marker', () => {
    const result = truncate('a'.repeat(50), 10);
    expect(result).toBe(`${'a'.repeat(10)}${TRUNCATION_MARKER}`);
  });

  it('returns text unchanged when exactly at the limit', () => {
    const text = 'a'.repeat(10);
    expect(truncate(text, 10)).toBe(text);
  });
});

describe('stripQueryString', () => {
  it('removes the query string but keeps scheme, host, and path', () => {
    expect(stripQueryString('https://api.ufobeer.app/beers?sid=13&fresh=true')).toBe(
      'https://api.ufobeer.app/beers',
    );
  });

  it('leaves a URL with no query string unchanged', () => {
    expect(stripQueryString('https://api.ufobeer.app/health')).toBe('https://api.ufobeer.app/health');
  });

  it('falls back to slicing at "?" for a non-parseable URL', () => {
    expect(stripQueryString('/relative/path?token=abc')).toBe('/relative/path');
  });
});

describe('pathOnly', () => {
  it('returns just the pathname, dropping scheme, host, and query', () => {
    expect(pathOnly('https://api.ufobeer.app/beers?sid=13')).toBe('/beers');
  });

  it('falls back to slicing at "?" for a non-parseable URL', () => {
    expect(pathOnly('/relative/path?token=abc')).toBe('/relative/path');
  });
});
