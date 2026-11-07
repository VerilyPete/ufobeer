/**
 * Hash Utilities
 *
 * Shared hashing functions for description change detection.
 * Uses Web Crypto API available in Cloudflare Workers.
 *
 * @module utils/hash
 */

import { TAPLIST_FORMAT_VERSION } from '../constants';

/**
 * Generate SHA-256 hash of text for change detection.
 * Takes first 16 bytes (32 hex chars) for storage efficiency.
 *
 * Uses Web Crypto API (crypto.subtle) which is available in:
 * - Cloudflare Workers
 * - Node.js 15+
 * - Modern browsers
 *
 * @param text - The text to hash
 * @returns 32 character hex string (first 16 bytes of SHA-256)
 *
 * @example
 * ```typescript
 * const hash = await hashDescription('Some beer description');
 * // Returns: '5eb63bbbe01eeed093cb22bb8f5acdc3'
 * ```
 */
export async function hashDescription(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  // Take first 16 bytes (32 hex chars) for storage efficiency
  return hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate an RFC 7232 compliant ETag from a response body.
 * Wraps the 32-char SHA-256 prefix in double quotes.
 *
 * @param body - The raw response body string to hash
 * @returns Quoted ETag string, e.g. "5eb63bbbe01eeed093cb22bb8f5acdc3"
 */
export async function generateETag(body: string): Promise<string> {
  const hash = await hashDescription(body);
  return `"${hash}"`;
}

/**
 * Build an RFC 7232 compliant ETag combining content and enrichment hashes.
 *
 * Hashes the taplist format version with the content hash and, when available,
 * the enrichment hash (null when the enrichment fetch failed), so the ETag
 * changes when content, enrichment or the served format changes.
 *
 * @param contentHash - 32-char hex hash of taplist content
 * @param enrichmentHash - 32-char hex hash of enrichment data, or null if unavailable
 * @returns Quoted ETag string
 */
export async function buildCombinedEtag(
  contentHash: string,
  enrichmentHash: string | null,
): Promise<string> {
  const combined = await hashDescription(`taplist-v${TAPLIST_FORMAT_VERSION}:${contentHash}:${enrichmentHash ?? ''}`);
  return `"${combined}"`;
}
