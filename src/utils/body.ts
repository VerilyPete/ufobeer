/**
 * Bounded JSON body reader.
 *
 * Every JSON-accepting route must reject a body that is too large before it
 * is fully materialized and parsed, reject a body with the wrong
 * Content-Type, and turn a malformed-JSON body into a 400 instead of an
 * uncaught throw that becomes a 500.
 *
 * `readBoundedJson` streams the request body and counts real bytes as they
 * arrive, so a chunked request or a dishonest (absent, short, or oversized)
 * `Content-Length` header cannot bypass the byte limit -- only the actual
 * streamed byte count decides whether the request is rejected. A declared
 * `Content-Length` that already exceeds the limit is still rejected before
 * any read, to avoid even starting to buffer a request that cannot succeed.
 *
 * @module utils/body
 */

import { errorResponse } from '../context';

// ============================================================================
// Types
// ============================================================================

export type BoundedJsonFailureCode =
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_JSON';

export type BoundedJsonSuccess = {
  readonly ok: true;
  readonly data: unknown;
};

export type BoundedJsonFailure = {
  readonly ok: false;
  readonly status: 400 | 413 | 415;
  readonly code: BoundedJsonFailureCode;
  readonly message: string;
  /**
   * Actual bytes streamed before the failure was determined. 0 for a
   * genuinely empty body (as opposed to a body that merely fails to parse).
   * Callers with a documented "empty body is valid" contract (e.g. the
   * admin enrichment trigger) can special-case bytesRead === 0 with
   * code === 'INVALID_JSON' rather than treating it as a client error.
   */
  readonly bytesRead: number;
};

export type BoundedJsonResult = BoundedJsonSuccess | BoundedJsonFailure;

// ============================================================================
// Content-Type check
// ============================================================================

const JSON_CONTENT_TYPE_RE = /^application\/json(?:\s*;.*)?$/i;

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('Content-Type');
  return contentType !== null && JSON_CONTENT_TYPE_RE.test(contentType.trim());
}

// ============================================================================
// Bounded Reader
// ============================================================================

/**
 * Read and parse a JSON request body, enforcing a byte limit and a
 * `Content-Type: application/json` requirement.
 *
 * @param request - The incoming request. Its body is consumed on success or
 *   on a byte-limit failure; not consumed (and not required to exist) on a
 *   Content-Type or declared-Content-Length failure.
 * @param maxBytes - Maximum accepted body size, in bytes.
 */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<BoundedJsonResult> {
  if (!hasJsonContentType(request)) {
    return {
      ok: false,
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Content-Type must be application/json',
      bytesRead: 0,
    };
  }

  // Reject an excessive DECLARED Content-Length before reading anything.
  // This is an early-reject optimization only -- the streaming loop below
  // is what actually enforces the limit against real bytes, since this
  // header can be absent, dishonestly low, or simply wrong for a chunked
  // request.
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      return {
        ok: false,
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: `Request body exceeds the ${maxBytes}-byte limit`,
        bytesRead: 0,
      };
    }
  }

  if (!request.body) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_JSON',
      message: 'Request body is empty',
      bytesRead: 0,
    };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          status: 413,
          code: 'PAYLOAD_TOO_LARGE',
          message: `Request body exceeds the ${maxBytes}-byte limit`,
          bytesRead: total,
        };
      }
      chunks.push(value);
    }
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_JSON',
      message: 'Failed to read request body',
      bytesRead: total,
    };
  }

  if (total === 0) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_JSON',
      message: 'Request body is empty',
      bytesRead: 0,
    };
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder('utf-8').decode(combined);

  try {
    const data: unknown = JSON.parse(text);
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_JSON',
      message: 'Request body is not valid JSON',
      bytesRead: total,
    };
  }
}

// ============================================================================
// Error Response Helper
// ============================================================================

/**
 * Build the standardized error Response for a BoundedJsonFailure, using the
 * repo's shared `errorResponse()` shape so the 400/413/415 contract stays
 * identical across every body-bearing route regardless of that route's own
 * (pre-existing) schema-validation error shape.
 */
export function boundedJsonErrorResponse(
  failure: BoundedJsonFailure,
  requestId: string,
  headers: Record<string, string>
): Response {
  return errorResponse(failure.message, failure.code, {
    requestId,
    headers,
    status: failure.status,
  });
}
