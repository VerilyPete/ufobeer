import { describe, it, expect, vi } from 'vitest';
import { readBoundedText, ResponseTooLargeError } from '../../src/utils/bounded-response';

function streamOf(text: string, chunkSize = 8): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
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

describe('readBoundedText', () => {
  describe('streaming path (response.body present)', () => {
    it('returns the full text when under the byte cap', async () => {
      const text = 'hello world';
      const result = await readBoundedText({ body: streamOf(text) }, 1000);
      expect(result).toBe(text);
    });

    it('throws ResponseTooLargeError when the stream exceeds the cap', async () => {
      const text = 'x'.repeat(1000);
      await expect(readBoundedText({ body: streamOf(text) }, 100)).rejects.toThrow(ResponseTooLargeError);
    });

    it('aborts before buffering the entire oversized stream', async () => {
      // A stream that would yield ~200MB if fully drained. If readBoundedText
      // buffered the whole thing before checking, this test would time out
      // or OOM; it must reject after a bounded number of pulls instead.
      const maxBytes = 1024;
      let pullCount = 0;
      const hugeStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount++;
          // Each pull yields 1MB; after a couple of pulls we're already
          // well past the 1KB cap.
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      });

      await expect(readBoundedText({ body: hugeStream }, maxBytes)).rejects.toThrow(ResponseTooLargeError);
      // Should have aborted almost immediately, not after streaming 200MB
      // worth of chunks.
      expect(pullCount).toBeLessThan(5);
    });

    it('accepts a body at exactly the byte cap', async () => {
      const text = 'x'.repeat(64);
      const result = await readBoundedText({ body: streamOf(text) }, 64);
      expect(result).toBe(text);
    });

    it('handles an empty stream', async () => {
      const result = await readBoundedText({ body: streamOf('') }, 100);
      expect(result).toBe('');
    });
  });

  describe('text() fallback (no body stream)', () => {
    it('returns text when under the cap', async () => {
      const response = { text: vi.fn().mockResolvedValue('short body') };
      const result = await readBoundedText(response, 1000);
      expect(result).toBe('short body');
    });

    it('throws ResponseTooLargeError when text() result exceeds the cap', async () => {
      const response = { text: vi.fn().mockResolvedValue('x'.repeat(1000)) };
      await expect(readBoundedText(response, 100)).rejects.toThrow(ResponseTooLargeError);
    });
  });

  describe('json() fallback (no body stream, no text())', () => {
    it('stringifies and returns json() result when under the cap', async () => {
      const response = { json: vi.fn().mockResolvedValue({ a: 1 }) };
      const result = await readBoundedText(response, 1000);
      expect(result).toBe(JSON.stringify({ a: 1 }));
    });

    it('throws ResponseTooLargeError when json() result exceeds the cap', async () => {
      const response = { json: vi.fn().mockResolvedValue({ a: 'x'.repeat(1000) }) };
      await expect(readBoundedText(response, 100)).rejects.toThrow(ResponseTooLargeError);
    });
  });

  it('throws a plain error when no body, text(), or json() is available', async () => {
    await expect(readBoundedText({}, 100)).rejects.toThrow(/no readable body/i);
  });
});
