/**
 * Unit tests for authentication and security helpers.
 *
 * @module test/auth.test
 */

import { describe, it, expect, vi } from 'vitest';
import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import type { Env, RequestContext } from '../src/types';
import {
  timingSafeCompare,
  hashApiKey,
  validateApiKey,
  authorizeAdmin,
  getClientIp,
  getClientIdentifier,
  createRequestContext,
} from '../src/auth';

// ============================================================================
// Polyfill: crypto.subtle.timingSafeEqual (Cloudflare Workers API, not in Node)
// ============================================================================

if (typeof crypto.subtle.timingSafeEqual !== 'function') {
  (crypto.subtle as unknown as Record<string, unknown>).timingSafeEqual = (
    a: ArrayBuffer | ArrayBufferView,
    b: ArrayBuffer | ArrayBufferView,
  ): boolean => {
    const bufA = ArrayBuffer.isView(a) ? Buffer.from(a.buffer, a.byteOffset, a.byteLength) : Buffer.from(a);
    const bufB = ArrayBuffer.isView(b) ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return nodeTimingSafeEqual(bufA, bufB);
  };
}

// ============================================================================
// Factory Functions
// ============================================================================

const createRequest = (headers: Record<string, string> = {}): Request =>
  new Request('https://example.com', { headers });

const createMockEnv = (overrides?: Partial<{ API_KEY: string }>): Pick<Env, 'API_KEY'> => ({
  API_KEY: 'test-api-key-secret',
  ...overrides,
});

const createMockEnvWithAdmin = (
  overrides?: Partial<{ ADMIN_SECRET: string | undefined }>,
): Pick<Env, 'ADMIN_SECRET'> => ({
  ADMIN_SECRET: 'admin-secret-value',
  ...overrides,
});

const createMockReqCtx = (): RequestContext => ({
  requestId: 'req-test-123',
  startTime: Date.now(),
  clientIdentifier: 'test-client',
  apiKeyHash: null,
  clientIp: '127.0.0.1',
  userAgent: 'test-agent',
});

// ============================================================================
// timingSafeCompare Tests
// ============================================================================

describe('timingSafeCompare', () => {
  it('returns true when both strings are identical', async () => {
    expect(await timingSafeCompare('hello', 'hello')).toBe(true);
  });

  it('returns false when strings differ by one character', async () => {
    expect(await timingSafeCompare('hello', 'hellp')).toBe(false);
  });

  it('returns false when strings differ in length', async () => {
    expect(await timingSafeCompare('short', 'a-much-longer-string')).toBe(false);
  });

  it('returns true when both are empty strings', async () => {
    expect(await timingSafeCompare('', '')).toBe(true);
  });

  it('returns false when one is empty and one is not', async () => {
    expect(await timingSafeCompare('', 'notempty')).toBe(false);
  });

  it('is consistent across multiple calls with the same inputs', async () => {
    const first = await timingSafeCompare('consistent', 'consistent');
    const second = await timingSafeCompare('consistent', 'consistent');
    expect(first).toBe(true);
    expect(second).toBe(true);
  });
});

// ============================================================================
// hashApiKey Tests
// ============================================================================

describe('hashApiKey', () => {
  it('returns a 16-character hex string', async () => {
    const hash = await hashApiKey('my-secret-key');
    expect(hash).toHaveLength(16);
  });

  it('returns only characters [0-9a-f]', async () => {
    const hash = await hashApiKey('my-secret-key');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns a deterministic hash for the same input', async () => {
    const hash1 = await hashApiKey('deterministic-key');
    const hash2 = await hashApiKey('deterministic-key');
    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different inputs', async () => {
    const hash1 = await hashApiKey('key-alpha');
    const hash2 = await hashApiKey('key-beta');
    expect(hash1).not.toBe(hash2);
  });

  it('handles empty string input without throwing', async () => {
    const hash = await hashApiKey('');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('handles a long key (256+ chars) without throwing', async () => {
    const longKey = 'a'.repeat(300);
    const hash = await hashApiKey(longKey);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ============================================================================
// validateApiKey Tests
// ============================================================================

describe('validateApiKey', () => {
  it('returns invalid with null hash when X-API-Key header is missing', async () => {
    const request = createRequest();
    const result = await validateApiKey(
      request,
      createMockEnv() as Env,
      createMockReqCtx(),
    );
    expect(result).toEqual({ valid: false, apiKeyHash: null });
  });

  it('returns invalid with null hash when X-API-Key does not match env.API_KEY', async () => {
    const request = createRequest({ 'X-API-Key': 'wrong-key' });
    const result = await validateApiKey(
      request,
      createMockEnv() as Env,
      createMockReqCtx(),
    );
    expect(result).toEqual({ valid: false, apiKeyHash: null });
  });

  it('returns valid with a 16-char hex apiKeyHash when X-API-Key matches', async () => {
    const request = createRequest({ 'X-API-Key': 'test-api-key-secret' });
    const result = await validateApiKey(
      request,
      createMockEnv() as Env,
      createMockReqCtx(),
    );
    expect(result.valid).toBe(true);
    expect(result.apiKeyHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns a 16-character hex string as apiKeyHash on success', async () => {
    const request = createRequest({ 'X-API-Key': 'test-api-key-secret' });
    const result = await validateApiKey(
      request,
      createMockEnv() as Env,
      createMockReqCtx(),
    );
    expect(result.apiKeyHash).toHaveLength(16);
  });

  it('logs a warning when X-API-Key header is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = createRequest();
    await validateApiKey(request, createMockEnv() as Env, createMockReqCtx());
    expect(warnSpy).toHaveBeenCalledOnce();
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged.event).toBe('auth_failed');
    expect(logged.reason).toBe('missing_api_key');
    warnSpy.mockRestore();
  });

  it('logs a warning with first 4 chars of submitted key when key is wrong', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = createRequest({ 'X-API-Key': 'bad-key-value' });
    await validateApiKey(request, createMockEnv() as Env, createMockReqCtx());
    expect(warnSpy).toHaveBeenCalledOnce();
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged.event).toBe('auth_failed');
    expect(logged.reason).toBe('invalid_api_key');
    expect(logged.apiKeyPrefix).toBe('bad-...');
    warnSpy.mockRestore();
  });

  it('does not log when key is valid', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = createRequest({ 'X-API-Key': 'test-api-key-secret' });
    await validateApiKey(request, createMockEnv() as Env, createMockReqCtx());
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ============================================================================
// authorizeAdmin Tests
// ============================================================================

describe('authorizeAdmin', () => {
  it('returns unauthorized when env.ADMIN_SECRET is undefined', async () => {
    const request = createRequest({ 'X-Admin-Secret': 'anything' });
    const result = await authorizeAdmin(
      request,
      createMockEnvWithAdmin({ ADMIN_SECRET: undefined }) as Env,
      createMockReqCtx(),
    );
    expect(result).toEqual({
      authorized: false,
      error: 'Admin endpoints not configured',
    });
  });

  it('returns unauthorized when X-Admin-Secret header is absent', async () => {
    const request = createRequest();
    const result = await authorizeAdmin(
      request,
      createMockEnvWithAdmin() as Env,
      createMockReqCtx(),
    );
    expect(result).toEqual({
      authorized: false,
      error: 'Missing admin credentials',
    });
  });

  it('returns unauthorized when X-Admin-Secret does not match', async () => {
    const request = createRequest({ 'X-Admin-Secret': 'wrong-secret' });
    const result = await authorizeAdmin(
      request,
      createMockEnvWithAdmin() as Env,
      createMockReqCtx(),
    );
    expect(result).toEqual({
      authorized: false,
      error: 'Invalid admin credentials',
    });
  });

  it('returns authorized when X-Admin-Secret matches', async () => {
    const request = createRequest({ 'X-Admin-Secret': 'admin-secret-value' });
    const result = await authorizeAdmin(
      request,
      createMockEnvWithAdmin() as Env,
      createMockReqCtx(),
    );
    expect(result).toEqual({ authorized: true });
  });

  it('logs an error when ADMIN_SECRET is not configured', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = createRequest();
    await authorizeAdmin(
      request,
      createMockEnvWithAdmin({ ADMIN_SECRET: undefined }) as Env,
      createMockReqCtx(),
    );
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain('ADMIN_SECRET not configured');
    errorSpy.mockRestore();
  });
});

// ============================================================================
// getClientIp Tests
// ============================================================================

describe('getClientIp', () => {
  it('returns the CF-Connecting-IP header value when present', () => {
    const request = createRequest({ 'CF-Connecting-IP': '1.2.3.4' });
    expect(getClientIp(request)).toBe('1.2.3.4');
  });

  it('returns the X-Forwarded-For header value when CF-Connecting-IP is absent', () => {
    const request = createRequest({ 'X-Forwarded-For': '5.6.7.8' });
    expect(getClientIp(request)).toBe('5.6.7.8');
  });

  it('returns null when neither header is present', () => {
    const request = createRequest();
    expect(getClientIp(request)).toBeNull();
  });

  it('prefers CF-Connecting-IP over X-Forwarded-For when both are present', () => {
    const request = createRequest({
      'CF-Connecting-IP': '1.2.3.4',
      'X-Forwarded-For': '5.6.7.8',
    });
    expect(getClientIp(request)).toBe('1.2.3.4');
  });
});

// ============================================================================
// getClientIdentifier Tests
// ============================================================================

describe('getClientIdentifier', () => {
  it('returns X-Client-ID header value when present', () => {
    const request = createRequest({ 'X-Client-ID': 'my-client-id' });
    expect(getClientIdentifier(request)).toBe('my-client-id');
  });

  it('returns client IP when X-Client-ID is absent but CF-Connecting-IP is present', () => {
    const request = createRequest({ 'CF-Connecting-IP': '10.0.0.1' });
    expect(getClientIdentifier(request)).toBe('10.0.0.1');
  });

  it('returns "unknown" when neither X-Client-ID nor IP headers are present', () => {
    const request = createRequest();
    expect(getClientIdentifier(request)).toBe('unknown');
  });

  it('truncates result to exactly 64 characters when input exceeds 64 characters', () => {
    const longId = 'x'.repeat(100);
    const request = createRequest({ 'X-Client-ID': longId });
    const result = getClientIdentifier(request);
    expect(result).toHaveLength(64);
    expect(result).toBe('x'.repeat(64));
  });

  it('does not truncate when input is exactly 64 characters', () => {
    const exactId = 'y'.repeat(64);
    const request = createRequest({ 'X-Client-ID': exactId });
    expect(getClientIdentifier(request)).toBe(exactId);
    expect(getClientIdentifier(request)).toHaveLength(64);
  });

  it('does not truncate when input is less than 64 characters', () => {
    const shortId = 'z'.repeat(30);
    const request = createRequest({ 'X-Client-ID': shortId });
    expect(getClientIdentifier(request)).toBe(shortId);
    expect(getClientIdentifier(request)).toHaveLength(30);
  });
});

// ============================================================================
// createRequestContext Tests
// ============================================================================

describe('createRequestContext', () => {
  it('returns an object with requestId that is a non-empty UUID string', () => {
    const request = createRequest();
    const ctx = createRequestContext(request);
    expect(ctx.requestId).toBeTruthy();
    expect(ctx.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('returns an object with startTime that is a positive number', () => {
    const request = createRequest();
    const ctx = createRequestContext(request);
    expect(ctx.startTime).toBeGreaterThan(0);
  });

  it('returns an object with clientIdentifier derived from request headers', () => {
    const request = createRequest({ 'CF-Connecting-IP': '192.168.1.1' });
    const ctx = createRequestContext(request);
    expect(ctx.clientIdentifier).toBe('192.168.1.1');
  });

  it('returns an object with apiKeyHash set to null', () => {
    const request = createRequest();
    const ctx = createRequestContext(request);
    expect(ctx.apiKeyHash).toBeNull();
  });

  it('returns an object with clientIp derived from CF-Connecting-IP', () => {
    const request = createRequest({ 'CF-Connecting-IP': '10.10.10.10' });
    const ctx = createRequestContext(request);
    expect(ctx.clientIp).toBe('10.10.10.10');
  });

  it('returns an object with clientIp derived from X-Forwarded-For when CF header is absent', () => {
    const request = createRequest({ 'X-Forwarded-For': '172.16.0.1' });
    const ctx = createRequestContext(request);
    expect(ctx.clientIp).toBe('172.16.0.1');
  });

  it('returns an object with userAgent from User-Agent header', () => {
    const request = createRequest({ 'User-Agent': 'UFOBeer/1.0' });
    const ctx = createRequestContext(request);
    expect(ctx.userAgent).toBe('UFOBeer/1.0');
  });

  it('returns null for userAgent when User-Agent header is absent', () => {
    const request = createRequest();
    const ctx = createRequestContext(request);
    expect(ctx.userAgent).toBeNull();
  });
});
