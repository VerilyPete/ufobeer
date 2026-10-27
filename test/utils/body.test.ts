/**
 * Tests for the shared bounded JSON body reader (src/utils/body.ts).
 *
 * Covers the acceptance-criteria boundary matrix: exact byte-limit boundary,
 * declared vs. absent vs. dishonest Content-Length, chunked transfer,
 * UTF-8 multibyte expansion, wrong Content-Type, and malformed JSON -- all
 * independent of any specific route.
 */

import { describe, it, expect } from 'vitest';
import { readBoundedJson, boundedJsonErrorResponse } from '../../src/utils/body';

const MAX_BYTES = 100;

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

/** A body stream that throws if it is ever pulled from -- used to prove a
 * failure was returned WITHOUT reading the body. */
function unreadableStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      throw new Error('body must not be read for this case');
    },
  });
}

function streamOf(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

describe('readBoundedJson', () => {
  describe('Content-Type enforcement', () => {
    it('returns 415 when Content-Type is missing', async () => {
      const request = new Request('https://example.test/x', {
        method: 'POST',
        body: JSON.stringify({ a: 1 }),
      });
      const result = await readBoundedJson(request, MAX_BYTES);
      expect(result).toMatchObject({ ok: false, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    });

    it('returns 415 when Content-Type is not application/json', async () => {
      const request = jsonRequest(JSON.stringify({ a: 1 }), { 'Content-Type': 'text/plain' });
      const result = await readBoundedJson(request, MAX_BYTES);
      expect(result).toMatchObject({ ok: false, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    });

    it('accepts application/json with a charset parameter', async () => {
      const request = jsonRequest(JSON.stringify({ a: 1 }), {
        'Content-Type': 'application/json; charset=utf-8',
      });
      const result = await readBoundedJson(request, MAX_BYTES);
      expect(result).toEqual({ ok: true, data: { a: 1 } });
    });
  });

  describe('declared Content-Length', () => {
    it('rejects an excessive declared Content-Length before reading the body', async () => {
      const request = new Request('https://example.test/x', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(MAX_BYTES + 1000),
        },
        body: unreadableStream(),
        duplex: 'half',
      } as RequestInit);

      const result = await readBoundedJson(request, MAX_BYTES);
      expect(result).toMatchObject({ ok: false, status: 413, code: 'PAYLOAD_TOO_LARGE', bytesRead: 0 });
    });

    it('does not reject on an absent Content-Length header', async () => {
      const body = 'x'.repeat(10);
      const request = new Request('https://example.test/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamOf(new TextEncoder().encode(`"${body}"`), 4),
        duplex: 'half',
      } as RequestInit);

      const result = await readBoundedJson(request, MAX_BYTES);
      expect(result).toEqual({ ok: true, data: body });
    });

    it('rejects when a dishonestly SHORT declared Content-Length hides a body that exceeds the limit', async () => {
      const bytes = new TextEncoder().encode(JSON.stringify('x'.repeat(MAX_BYTES + 50)));
      const request = new Request('https://example.test/x', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '3', // dishonestly small
        },
        body: streamOf(bytes, 16),
        duplex: 'half',
      } as RequestInit);

      const result = await readBoundedJson(request, MAX_BYTES);
      expect(result).toMatchObject({ ok: false, status: 413, code: 'PAYLOAD_TOO_LARGE' });
    });
  });

  describe('chunked transfer / streamed byte counting', () => {
    it('aborts once streamed bytes exceed the limit regardless of chunk boundaries', async () => {
      const bytes = new TextEncoder().encode(JSON.stringify('y'.repeat(MAX_BYTES + 20)));
      const request = new Request('https://example.test/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamOf(bytes, 7), // chunk size that doesn't evenly divide
        duplex: 'half',
      } as RequestInit);

      const result = await readBoundedJson(request, MAX_BYTES);
      expect(result).toMatchObject({ ok: false, status: 413, code: 'PAYLOAD_TOO_LARGE' });
      if (!result.ok) {
        expect(result.bytesRead).toBeGreaterThan(MAX_BYTES);
      }
    });

    it('counts BYTES, not characters, for multibyte UTF-8 content', async () => {
      // "中" is 1 UTF-16 code unit / 3 UTF-8 bytes. 40 of them wrapped in a
      // JSON string is well under 100 characters but well over 100 bytes.
      const value = '中'.repeat(40);
      expect(value.length).toBeLessThan(MAX_BYTES);
      const payload = JSON.stringify(value);
      expect(new TextEncoder().encode(payload).length).toBeGreaterThan(MAX_BYTES);

      const request = jsonRequest(payload);
      const result = await readBoundedJson(request, MAX_BYTES);
      expect(result).toMatchObject({ ok: false, status: 413, code: 'PAYLOAD_TOO_LARGE' });
    });
  });

  describe('exact byte-limit boundary', () => {
    it('accepts a body of exactly maxBytes', async () => {
      // '"' + N x's + '"' must equal exactly MAX_BYTES bytes.
      const padLength = MAX_BYTES - 2;
      const payload = JSON.stringify('x'.repeat(padLength));
      expect(new TextEncoder().encode(payload).length).toBe(MAX_BYTES);

      const result = await readBoundedJson(jsonRequest(payload), MAX_BYTES);
      expect(result).toEqual({ ok: true, data: 'x'.repeat(padLength) });
    });

    it('rejects a body one byte over maxBytes', async () => {
      const padLength = MAX_BYTES - 1;
      const payload = JSON.stringify('x'.repeat(padLength));
      expect(new TextEncoder().encode(payload).length).toBe(MAX_BYTES + 1);

      const result = await readBoundedJson(jsonRequest(payload), MAX_BYTES);
      expect(result).toMatchObject({ ok: false, status: 413, code: 'PAYLOAD_TOO_LARGE' });
    });
  });

  describe('malformed and empty bodies', () => {
    it('returns 400 INVALID_JSON for malformed JSON rather than throwing', async () => {
      const result = await readBoundedJson(jsonRequest('{not valid json'), MAX_BYTES);
      expect(result).toMatchObject({ ok: false, status: 400, code: 'INVALID_JSON' });
    });

    it('returns 400 INVALID_JSON with bytesRead 0 for an empty body', async () => {
      const result = await readBoundedJson(jsonRequest(''), MAX_BYTES);
      expect(result).toMatchObject({ ok: false, status: 400, code: 'INVALID_JSON', bytesRead: 0 });
    });
  });

  describe('success', () => {
    it('returns the parsed JSON value on success', async () => {
      const result = await readBoundedJson(jsonRequest(JSON.stringify({ ids: ['a', 'b'] })), MAX_BYTES);
      expect(result).toEqual({ ok: true, data: { ids: ['a', 'b'] } });
    });
  });
});

describe('boundedJsonErrorResponse', () => {
  it('builds a Response whose status, code, and requestId match the failure', async () => {
    const failure = await readBoundedJson(
      new Request('https://example.test/x', { method: 'POST', body: '{}' }),
      MAX_BYTES
    );
    expect(failure.ok).toBe(false);
    if (failure.ok) return;

    const response = boundedJsonErrorResponse(failure, 'req-123', { 'X-Test': '1' });
    expect(response.status).toBe(415);
    expect(response.headers.get('X-Test')).toBe('1');

    const body = await response.json() as { success: boolean; error: { code: string; message: string }; requestId: string };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(body.requestId).toBe('req-123');
  });
});
