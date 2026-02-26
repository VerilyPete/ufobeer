/**
 * Unit tests for request context and middleware functions.
 *
 * @module test/context.test
 */

import { describe, it, expect, vi } from 'vitest';
import { getCorsHeaders, errorResponse } from '../src/context';
import type { Env, ErrorResponseOptions } from '../src/types';

// ============================================================================
// Factory Functions
// ============================================================================

const getMockEnv = (overrides?: Partial<Env>): Env => ({
  ALLOWED_ORIGIN: 'https://ufobeer.app',
  DB: {} as D1Database,
  ...overrides,
} as Env);

const getErrorResponseOptions = (
  overrides?: Partial<ErrorResponseOptions>
): ErrorResponseOptions => ({
  requestId: 'req-test-456',
  headers: { 'Content-Type': 'application/json' },
  ...overrides,
});

// ============================================================================
// getCorsHeaders Tests
// ============================================================================

describe('getCorsHeaders', () => {
  it('returns Access-Control-Allow-Origin set to env.ALLOWED_ORIGIN', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env);
    expect(result).not.toBeNull();
    expect(result!['Access-Control-Allow-Origin']).toBe('https://ufobeer.app');
  });

  it('returns Access-Control-Allow-Methods containing GET', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env);
    expect(result).not.toBeNull();
    expect(result!['Access-Control-Allow-Methods']).toContain('GET');
  });

  it('returns Access-Control-Allow-Methods containing POST', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env);
    expect(result).not.toBeNull();
    expect(result!['Access-Control-Allow-Methods']).toContain('POST');
  });

  it('returns Access-Control-Allow-Headers containing X-API-Key', () => {
    const env = getMockEnv();
    const result = getCorsHeaders(env);
    expect(result).not.toBeNull();
    expect(result!['Access-Control-Allow-Headers']).toContain('X-API-Key');
  });

  it('returns null when ALLOWED_ORIGIN is an empty string', () => {
    const env = getMockEnv({ ALLOWED_ORIGIN: '' });
    const result = getCorsHeaders(env);
    expect(result).toBeNull();
  });

  it('returns null when ALLOWED_ORIGIN is undefined', () => {
    const env = getMockEnv({ ALLOWED_ORIGIN: undefined as unknown as string });
    const result = getCorsHeaders(env);
    expect(result).toBeNull();
  });

  it('logs an error when ALLOWED_ORIGIN is not configured', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = getMockEnv({ ALLOWED_ORIGIN: '' });

    getCorsHeaders(env);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('ALLOWED_ORIGIN not configured')
    );
    consoleSpy.mockRestore();
  });
});

// ============================================================================
// errorResponse Tests
// ============================================================================

describe('errorResponse', () => {
  it('returns a Response object', () => {
    const options = getErrorResponseOptions();
    const result = errorResponse('Something went wrong', 'GENERIC_ERROR', options);
    expect(result).toBeInstanceOf(Response);
  });

  it('returns response body with success: false', async () => {
    const options = getErrorResponseOptions();
    const result = errorResponse('Bad request', 'BAD_REQUEST', options);
    const body = await result.json();
    expect(body.success).toBe(false);
  });

  it('returns response body with error.message equal to the provided message', async () => {
    const options = getErrorResponseOptions();
    const result = errorResponse('Invalid store ID', 'INVALID_STORE', options);
    const body = await result.json();
    expect(body.error.message).toBe('Invalid store ID');
  });

  it('returns response body with error.code equal to the provided code', async () => {
    const options = getErrorResponseOptions();
    const result = errorResponse('Not found', 'NOT_FOUND', options);
    const body = await result.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns response body with requestId from options', async () => {
    const options = getErrorResponseOptions({ requestId: 'req-unique-789' });
    const result = errorResponse('Error', 'ERR', options);
    const body = await result.json();
    expect(body.requestId).toBe('req-unique-789');
  });

  it('returns status 400 when options.status is not provided', () => {
    const options = getErrorResponseOptions();
    const result = errorResponse('Bad input', 'BAD_INPUT', options);
    expect(result.status).toBe(400);
  });

  it('returns the provided status when options.status is specified', () => {
    const options = getErrorResponseOptions({ status: 404 });
    const result = errorResponse('Not found', 'NOT_FOUND', options);
    expect(result.status).toBe(404);
  });

  it('includes extra fields from options.extra in the response body', async () => {
    const options = getErrorResponseOptions({
      extra: { retryAfter: 60, limit: 100 },
    });
    const result = errorResponse('Rate limited', 'RATE_LIMITED', options);
    const body = await result.json();
    expect(body.retryAfter).toBe(60);
    expect(body.limit).toBe(100);
  });
});
