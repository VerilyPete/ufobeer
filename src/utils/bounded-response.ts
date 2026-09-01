/**
 * Bounded response body reading.
 *
 * `Response#json()` / `Response#text()` buffer the *complete* body before
 * returning, regardless of size. A compromised or misbehaving upstream (or
 * a dishonest/missing Content-Length) can therefore force the Worker to
 * materialize an arbitrarily large string in memory before any validation
 * runs. `readBoundedText` streams the body instead, aborting as soon as
 * the cumulative byte count exceeds `maxBytes` — well before a large body
 * is fully buffered.
 *
 * @module utils/bounded-response
 */

/** Thrown when a response body exceeds the caller-supplied byte cap. */
export class ResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Response body exceeded ${maxBytes} byte limit`);
    this.name = 'ResponseTooLargeError';
  }
}

type MinimalResponse = {
  readonly body?: ReadableStream<Uint8Array> | null;
  text?(): Promise<string>;
  json?(): Promise<unknown>;
};

/**
 * Read a fetch `Response` body as text while enforcing a hard byte cap.
 *
 * Prefers streaming via `response.body` so an oversized body is rejected
 * without fully buffering it. Falls back to `response.text()` (still
 * capped, but after full buffering) and finally to `response.json()`
 * re-stringified, for response objects — real or test doubles — that
 * don't expose a readable stream.
 *
 * @throws ResponseTooLargeError if the body exceeds maxBytes
 */
export async function readBoundedText(response: MinimalResponse, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    return readBoundedStream(body, maxBytes);
  }

  if (typeof response.text === 'function') {
    const text = await response.text();
    if (byteLength(text) > maxBytes) {
      throw new ResponseTooLargeError(maxBytes);
    }
    return text;
  }

  if (typeof response.json === 'function') {
    const parsed = await response.json();
    const text = JSON.stringify(parsed);
    if (byteLength(text) > maxBytes) {
      throw new ResponseTooLargeError(maxBytes);
    }
    return text;
  }

  throw new Error('Response has no readable body (no body stream, text(), or json())');
}

async function readBoundedStream(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new ResponseTooLargeError(maxBytes);
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the stream errored; nothing further to clean up.
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
