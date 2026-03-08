import { describe, it, expect } from 'vitest';
import { checkConditionalRequest } from '../../src/utils/conditional';

function createRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/beers', { headers });
}

describe('checkConditionalRequest', () => {
  const currentETag = '"abc123def456abc123def456abc123de"';

  it('returns null when no conditional headers present', () => {
    const request = createRequest();

    const result = checkConditionalRequest(request, currentETag);

    expect(result).toBeNull();
  });

  it('returns 304 when If-None-Match matches current ETag', () => {
    const request = createRequest({ 'If-None-Match': currentETag });

    const result = checkConditionalRequest(request, currentETag);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(304);
  });

  it('returns null when If-None-Match does NOT match', () => {
    const request = createRequest({ 'If-None-Match': '"different_etag_value_here_00000"' });

    const result = checkConditionalRequest(request, currentETag);

    expect(result).toBeNull();
  });

  it('returns 304 for wildcard If-None-Match: *', () => {
    const request = createRequest({ 'If-None-Match': '*' });

    const result = checkConditionalRequest(request, currentETag);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(304);
  });

  it('returns 304 when current ETag is in comma-separated list', () => {
    const request = createRequest({
      'If-None-Match': `"other_etag_0000000000000000000", ${currentETag}, "another_000000000000000000000"`,
    });

    const result = checkConditionalRequest(request, currentETag);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(304);
  });

  it('returns null when current ETag is NOT in comma-separated list', () => {
    const request = createRequest({
      'If-None-Match': '"etag_a_000000000000000000000000", "etag_b_000000000000000000000000"',
    });

    const result = checkConditionalRequest(request, currentETag);

    expect(result).toBeNull();
  });

  it('does NOT match unquoted ETag values', () => {
    const unquoted = currentETag.slice(1, -1); // strip quotes
    const request = createRequest({ 'If-None-Match': unquoted });

    const result = checkConditionalRequest(request, currentETag);

    expect(result).toBeNull();
  });

  it('304 response includes ETag and Cache-Control headers', () => {
    const request = createRequest({ 'If-None-Match': currentETag });

    const result = checkConditionalRequest(request, currentETag)!;

    expect(result.headers.get('ETag')).toBe(currentETag);
    expect(result.headers.get('Cache-Control')).toBe('private, max-age=300');
  });

  it('304 response has null body', async () => {
    const request = createRequest({ 'If-None-Match': currentETag });

    const result = checkConditionalRequest(request, currentETag)!;

    expect(result.body).toBeNull();
  });

  it('returns 304 when client sends weak ETag matching strong server ETag', () => {
    const request = createRequest({ 'If-None-Match': `W/${currentETag}` });

    const result = checkConditionalRequest(request, currentETag);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(304);
  });

  it('returns 304 when weak ETag is in comma-separated list', () => {
    const request = createRequest({
      'If-None-Match': `"other_etag_0000000000000000000", W/${currentETag}`,
    });

    const result = checkConditionalRequest(request, currentETag);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(304);
  });

  it('returns null when weak ETag does NOT match', () => {
    const request = createRequest({ 'If-None-Match': 'W/"different_etag_value_here_00000"' });

    const result = checkConditionalRequest(request, currentETag);

    expect(result).toBeNull();
  });
});
