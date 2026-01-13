/**
 * Vitest configuration for pure unit tests.
 *
 * This config runs tests without the Cloudflare Workers pool,
 * allowing tests to run without Cloudflare authentication.
 * Use this for testing pure functions that don't require
 * actual Worker runtime features.
 *
 * Usage: npm run test:unit
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    // Use default Node.js pool instead of Cloudflare Workers pool
    pool: 'threads',
    include: ['test/**/*.test.ts'],
    // Exclude integration tests that require the Workers pool
    exclude: [
      'test/**/*.integration.test.ts',
      'test/**/*.spec.ts',
      'test/index.spec.ts',
    ],
    globals: true,
  },
});
