/**
 * Conditional Request Handling
 *
 * Pure function for ETag-based conditional request support (RFC 7232).
 * No D1, no fetch, no side effects.
 *
 * @module utils/conditional
 */

/**
 * Check if a request can be satisfied with a 304 Not Modified response.
 *
 * @param request - The incoming HTTP request
 * @param currentETag - The current ETag value (quoted, e.g. "abc123...")
 * @returns A 304 Response if the client's cached version is current, or null if the full response should be sent
 */
export function checkConditionalRequest(request: Request, currentETag: string): Response | null {
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (!ifNoneMatch) return null;

  const clientETags = ifNoneMatch === '*'
    ? ['*']
    : ifNoneMatch.split(',').map(e => e.trim().replace(/^W\//, ''));

  const strongETag = currentETag.replace(/^W\//, '');

  if (clientETags.includes('*') || clientETags.includes(strongETag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: currentETag,
        'Cache-Control': 'private, max-age=300',
      },
    });
  }

  return null;
}
