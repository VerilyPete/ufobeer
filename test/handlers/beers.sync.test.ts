/**
 * Unit tests for beer sync endpoint handlers.
 *
 * Per-item validation (SyncBeerItemSchema) and the bounded body guard.
 * Write, race and queueing behaviour runs against real D1 in
 * beers.sync.description.integration.test.ts and test/db/seenBeers.integration.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleBeerSync } from '../../src/handlers/beers';
import type { Env, RequestContext } from '../../src/types';

vi.mock('../../src/queue', () => ({
  queueBeersForEnrichment: vi.fn().mockResolvedValue({ queued: 0, skipped: 0 }),
  queueBeersForCleanup: vi.fn().mockResolvedValue({ queued: 0, queuedIds: [] }),
  sendCleanupAndMark: vi.fn().mockResolvedValue({ queued: 0, markError: null }),
}));
import { SYNC_CONSTANTS } from '../../src/types';
import { SyncBeerItemSchema } from '../../src/schemas/request';
import { SYNC_BODY_MAX_BYTES } from '../../src/constants';

describe('handleBeerSync', () => {
  describe('SyncBeerItemSchema validation', () => {
    it('should reject empty id', () => {
      const result = SyncBeerItemSchema.safeParse({ id: '', brew_name: 'Test' });
      expect(result.success).toBe(false);
    });

    it('should reject missing id', () => {
      const result = SyncBeerItemSchema.safeParse({ brew_name: 'Test' });
      expect(result.success).toBe(false);
    });

    it('should reject non-string id', () => {
      const result = SyncBeerItemSchema.safeParse({ id: 123, brew_name: 'Test' });
      expect(result.success).toBe(false);
    });

    it('should reject id exceeding max length', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: 'x'.repeat(SYNC_CONSTANTS.MAX_ID_LENGTH + 1),
        brew_name: 'Test'
      });
      expect(result.success).toBe(false);
    });

    it('should accept id at max length', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: 'x'.repeat(SYNC_CONSTANTS.MAX_ID_LENGTH),
        brew_name: 'Test Beer'
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing brew_name', () => {
      const result = SyncBeerItemSchema.safeParse({ id: '123' });
      expect(result.success).toBe(false);
    });

    it('should reject empty brew_name', () => {
      const result = SyncBeerItemSchema.safeParse({ id: '123', brew_name: '' });
      expect(result.success).toBe(false);
    });

    it('should reject non-string brew_name', () => {
      const result = SyncBeerItemSchema.safeParse({ id: '123', brew_name: 456 });
      expect(result.success).toBe(false);
    });

    it('should reject brew_name exceeding max length', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'x'.repeat(SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH + 1)
      });
      expect(result.success).toBe(false);
    });

    it('should accept brew_name at max length', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'x'.repeat(SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH)
      });
      expect(result.success).toBe(true);
    });

    it('should reject brew_description exceeding max length', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'Test',
        brew_description: 'x'.repeat(SYNC_CONSTANTS.MAX_DESC_LENGTH + 1)
      });
      expect(result.success).toBe(false);
    });

    it('should accept brew_description at max length', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'Test',
        brew_description: 'x'.repeat(SYNC_CONSTANTS.MAX_DESC_LENGTH)
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with all fields', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'Test Beer',
        brewer: 'Test Brewery',
        brew_description: 'A great beer'
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input with minimal fields', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'Test Beer'
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid input without brew_description', () => {
      const result = SyncBeerItemSchema.safeParse({
        id: '123',
        brew_name: 'Test Beer',
        brewer: 'Test Brewery'
      });
      expect(result.success).toBe(true);
    });

    it('should reject null input', () => {
      const result = SyncBeerItemSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('should reject undefined input', () => {
      const result = SyncBeerItemSchema.safeParse(undefined);
      expect(result.success).toBe(false);
    });

    it('should reject non-object input', () => {
      const result = SyncBeerItemSchema.safeParse('not an object');
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// handleBeerSync — bounded body guard integration
// ============================================================================

describe('handleBeerSync bounded body guard', () => {
  const reqCtx: RequestContext = {
    requestId: 'sync-body-guard-test',
    startTime: Date.now(),
    clientIdentifier: 'test-client',
    apiKeyHash: null,
    clientIp: null,
    userAgent: null,
  };

  function createEnv(): Env {
    const db = {
      prepare: vi.fn(),
      batch: vi.fn(),
    } as unknown as D1Database;
    return { DB: db } as unknown as Env;
  }

  it('returns 415 when Content-Type is not application/json', async () => {
    const request = new Request('https://api.example.com/beers/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ beers: [] }),
    });

    const response = await handleBeerSync(request, createEnv(), {}, reqCtx);
    expect(response.status).toBe(415);
  });

  it('returns 413 when the body exceeds SYNC_BODY_MAX_BYTES', async () => {
    // The bounded reader rejects on raw byte count before any schema (or
    // even JSON.parse) is attempted, so the body's actual validity against
    // SyncBeersRequestOuterSchema is irrelevant here -- only its size is.
    const oversizedBody = JSON.stringify({ beers: ['x'.repeat(SYNC_BODY_MAX_BYTES + 1000)] });
    expect(new TextEncoder().encode(oversizedBody).length).toBeGreaterThan(SYNC_BODY_MAX_BYTES);

    const request = new Request('https://api.example.com/beers/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedBody,
    });

    const response = await handleBeerSync(request, createEnv(), {}, reqCtx);
    expect(response.status).toBe(413);
  });

  it('returns 400 for malformed JSON', async () => {
    const request = new Request('https://api.example.com/beers/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });

    const response = await handleBeerSync(request, createEnv(), {}, reqCtx);
    expect(response.status).toBe(400);
  });

  it('returns 400 (schema rejection) when more than 50 beers are submitted', async () => {
    const beers = Array.from({ length: 51 }, (_, i) => ({ id: `beer-${i}`, brew_name: 'Beer' }));
    const request = new Request('https://api.example.com/beers/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers }),
    });

    const response = await handleBeerSync(request, createEnv(), {}, reqCtx);
    expect(response.status).toBe(400);
  });
});
