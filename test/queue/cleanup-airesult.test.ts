/**
 * Tests for AIResult discriminated union and its consumption in buildBatchOperations.
 *
 * Verifies that the three-way discriminated union (success/fallback/failure)
 * eliminates non-null assertions at cleanup.ts:443-444.
 *
 * @module test/queue/cleanup-airesult.test
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  AIResult,
  AIResultSuccess,
  AIResultFallback,
  AIResultFailure,
} from '../../src/queue/cleanup';
import { processAIConcurrently } from '../../src/queue/cleanup';
import { createCircuitBreaker } from '../../src/queue/circuitBreaker';
import type { CleanupMessage } from '../../src/types';

// ============================================================================
// Compile-time type checks
// ============================================================================

describe('AIResult discriminated union type safety', () => {
  it('AIResultSuccess requires cleaned and usedOriginal fields', () => {
    const result: AIResultSuccess = {
      index: 0,
      success: true,
      cleaned: 'test',
      usedOriginal: false,
      extractedABV: null,
      latencyMs: 100,
    };
    expect(result.success).toBe(true);
    expect(result.cleaned).toBe('test');
    expect(result.usedOriginal).toBe(false);
  });

  it('AIResultFallback requires useFallback: true and error', () => {
    const result: AIResultFallback = {
      index: 0,
      success: false,
      useFallback: true,
      error: 'Circuit breaker open',
    };
    expect(result.success).toBe(false);
    expect(result.useFallback).toBe(true);
    expect(result.error).toBe('Circuit breaker open');
  });

  it('AIResultFailure has success: false without useFallback: true', () => {
    const result: AIResultFailure = {
      index: 0,
      success: false,
      error: 'Inference failed',
      latencyMs: 5000,
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Inference failed');
  });

  it('narrowing on success: true gives access to cleaned without assertion', () => {
    const result: AIResult = {
      index: 0,
      success: true,
      cleaned: 'cleaned text',
      usedOriginal: false,
      extractedABV: 5.2,
      latencyMs: 200,
    };

    if (result.success) {
      // After narrowing, these are guaranteed present -- no ! needed
      const cleaned: string = result.cleaned;
      const usedOriginal: boolean = result.usedOriginal;
      const abv: number | null = result.extractedABV;
      expect(cleaned).toBe('cleaned text');
      expect(usedOriginal).toBe(false);
      expect(abv).toBe(5.2);
    }
  });

  it('narrowing on !success then useFallback narrows to AIResultFallback', () => {
    const result: AIResult = {
      index: 0,
      success: false,
      useFallback: true,
      error: 'Circuit breaker open',
    };

    if (!result.success) {
      if (result.useFallback) {
        const error: string = result.error;
        expect(error).toBe('Circuit breaker open');
      }
    }
  });
});

// ============================================================================
// processAIConcurrently return type tests
// ============================================================================

describe('processAIConcurrently returns correct AIResult variants', () => {
  function createMessage(index: number, description: string): Message<CleanupMessage> {
    return {
      body: {
        beerId: `beer-${index}`,
        beerName: `Beer ${index}`,
        brewer: `Brewer ${index}`,
        brewDescription: description,
      },
      ack: vi.fn(),
      retry: vi.fn(),
    } as unknown as Message<CleanupMessage>;
  }

  const mockAi = {} as Ai;

  it('returns AIResultSuccess when cleanFn succeeds', async () => {
    const messages = [createMessage(0, 'A nice IPA 5.5% ABV')];
    const results = await processAIConcurrently(messages, mockAi, 1, {
      cleanFn: async () => ({
        cleaned: 'A nice IPA 5.5% ABV',
        usedOriginal: false,
        extractedABV: 5.5,
      }),
      timeoutMs: 5000,
      breaker: createCircuitBreaker(),
    });

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.cleaned).toBe('A nice IPA 5.5% ABV');
      expect(result.usedOriginal).toBe(false);
      expect(result.extractedABV).toBe(5.5);
      expect(result.latencyMs).toBeTypeOf('number');
    }
  });

  it('returns AIResultFailure when cleanFn throws', async () => {
    const messages = [createMessage(0, 'some description')];
    const results = await processAIConcurrently(messages, mockAi, 1, {
      cleanFn: async () => { throw new Error('Inference failed'); },
      timeoutMs: 5000,
      breaker: createCircuitBreaker(),
    });

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Inference failed');
    }
  });

  it('returns empty array for empty messages', async () => {
    const results = await processAIConcurrently([], mockAi, 1, {
      breaker: createCircuitBreaker(),
    });
    expect(results).toEqual([]);
  });
});
