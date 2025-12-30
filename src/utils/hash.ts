/**
 * Hash Utilities
 *
 * Shared hashing functions for description change detection.
 * Uses Web Crypto API available in Cloudflare Workers.
 *
 * @module utils/hash
 */

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
