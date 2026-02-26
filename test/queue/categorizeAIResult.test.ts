/**
 * Tests for categorizeAIResult pure function.
 *
 * Verifies that each AIResult variant is categorized correctly
 * for buildBatchOperations consumption.
 *
 * @module test/queue/categorizeAIResult.test
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  AIResult,
  AIResultSuccess,
  AIResultFallback,
  AIResultFailure,
} from '../../src/queue/cleanup';
import { categorizeAIResult } from '../../src/queue/cleanup';
import type { CleanupMessage } from '../../src/types';

function createMessage(
  overrides: Partial<CleanupMessage> = {}
): Message<CleanupMessage> {
  return {
    body: {
      beerId: 'beer-1',
      beerName: 'Test IPA',
      brewer: 'Test Brewery',
      brewDescription: 'A hoppy IPA with 5.5% ABV',
      ...overrides,
    },
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<CleanupMessage>;
}

describe('categorizeAIResult', () => {
  describe('success with ABV found', () => {
    it('returns success_with_abv category', () => {
      const result: AIResultSuccess = {
        index: 0,
        success: true,
        cleaned: 'A hoppy IPA with 5.5% ABV',
        usedOriginal: false,
        extractedABV: 5.5,
        latencyMs: 100,
      };
      const message = createMessage();

      const category = categorizeAIResult(result, message);

      expect(category.type).toBe('success_with_abv');
      if (category.type === 'success_with_abv') {
        expect(category.cleaned).toBe('A hoppy IPA with 5.5% ABV');
        expect(category.usedOriginal).toBe(false);
        expect(category.abv).toBe(5.5);
        expect(category.beerId).toBe('beer-1');
        expect(category.message).toBe(message);
        expect(category.latencyMs).toBe(100);
      }
    });
  });

  describe('success without ABV', () => {
    it('returns success_no_abv category and includes enrichment info', () => {
      const result: AIResultSuccess = {
        index: 0,
        success: true,
        cleaned: 'A hoppy IPA',
        usedOriginal: false,
        extractedABV: null,
        latencyMs: 200,
      };
      const message = createMessage();

      const category = categorizeAIResult(result, message);

      expect(category.type).toBe('success_no_abv');
      if (category.type === 'success_no_abv') {
        expect(category.cleaned).toBe('A hoppy IPA');
        expect(category.usedOriginal).toBe(false);
        expect(category.beerId).toBe('beer-1');
        expect(category.beerName).toBe('Test IPA');
        expect(category.brewer).toBe('Test Brewery');
        expect(category.message).toBe(message);
        expect(category.latencyMs).toBe(200);
      }
    });
  });

  describe('fallback with ABV found from original description', () => {
    it('returns fallback_with_abv category', () => {
      const result: AIResultFallback = {
        index: 0,
        success: false,
        useFallback: true,
        error: 'Circuit breaker open',
      };
      const message = createMessage({ brewDescription: 'An IPA 5.5% ABV' });

      const category = categorizeAIResult(result, message);

      expect(category.type).toBe('fallback_with_abv');
      if (category.type === 'fallback_with_abv') {
        expect(category.abv).toBe(5.5);
        expect(category.brewDescription).toBe('An IPA 5.5% ABV');
        expect(category.beerId).toBe('beer-1');
        expect(category.message).toBe(message);
      }
    });
  });

  describe('fallback without ABV from original description', () => {
    it('returns fallback_no_abv category with enrichment info', () => {
      const result: AIResultFallback = {
        index: 0,
        success: false,
        useFallback: true,
        error: 'Circuit breaker open',
      };
      const message = createMessage({ brewDescription: 'A great beer' });

      const category = categorizeAIResult(result, message);

      expect(category.type).toBe('fallback_no_abv');
      if (category.type === 'fallback_no_abv') {
        expect(category.brewDescription).toBe('A great beer');
        expect(category.beerId).toBe('beer-1');
        expect(category.beerName).toBe('Test IPA');
        expect(category.brewer).toBe('Test Brewery');
        expect(category.message).toBe(message);
      }
    });
  });

  describe('AI failure', () => {
    it('returns failure category', () => {
      const result: AIResultFailure = {
        index: 0,
        success: false,
        error: 'Inference failed',
        latencyMs: 5000,
      };
      const message = createMessage();

      const category = categorizeAIResult(result, message);

      expect(category.type).toBe('failure');
      if (category.type === 'failure') {
        expect(category.message).toBe(message);
        expect(category.latencyMs).toBe(5000);
      }
    });

    it('handles failure without latency', () => {
      const result: AIResultFailure = {
        index: 0,
        success: false,
        error: 'Timeout',
      };
      const message = createMessage();

      const category = categorizeAIResult(result, message);

      expect(category.type).toBe('failure');
      if (category.type === 'failure') {
        expect(category.latencyMs).toBeUndefined();
      }
    });
  });

  describe('latency tracking', () => {
    it('preserves latencyMs from success results', () => {
      const result: AIResultSuccess = {
        index: 0,
        success: true,
        cleaned: 'text',
        usedOriginal: false,
        extractedABV: 5.0,
        latencyMs: 150,
      };

      const category = categorizeAIResult(result, createMessage());
      expect(category.latencyMs).toBe(150);
    });

    it('preserves latencyMs from fallback results (may be undefined)', () => {
      const result: AIResultFallback = {
        index: 0,
        success: false,
        useFallback: true,
        error: 'breaker open',
        latencyMs: 50,
      };

      const category = categorizeAIResult(result, createMessage());
      expect(category.latencyMs).toBe(50);
    });
  });
});
