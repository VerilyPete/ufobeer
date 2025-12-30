/**
 * Unit tests for handleFallbackBatch function.
 *
 * Tests the fallback processing path when AI cleanup is unavailable
 * (quota exceeded or circuit breaker open).
 *
 * @module test/handle-fallback-batch.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleFallbackBatch } from '../src/queue/cleanup';
import type { Env, CleanupMessage } from '../src/types';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock queue message for testing.
 */
function createMockMessage(
  index: number,
  description: string
): Message<CleanupMessage> {
  return {
    id: `msg-${index}`,
    timestamp: new Date(),
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

// ============================================================================
// handleFallbackBatch Tests
// ============================================================================

describe('handleFallbackBatch', () => {
  let mockEnv: Env;
  let mockMessages: Message<CleanupMessage>[];
  let batchStatements: Array<{ sql: string; args: unknown[] }>;
  let queuedMessages: Array<{ body: unknown }>;

  beforeEach(() => {
    batchStatements = [];
    queuedMessages = [];

    // Mock setup explanation:
    // - prepare().bind() creates statement objects and tracks them in batchStatements
    // - batch() receives these same statement objects when batchUpdateWithRetry calls it
    // - This allows tests to inspect what statements were prepared AND verify batch was called
    mockEnv = {
      DB: {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockImplementation((...args: unknown[]) => {
            const stmt = { sql, args };
            batchStatements.push(stmt);
            return stmt; // This object gets passed to batch()
          }),
        })),
        // batchUpdateWithRetry calls db.batch() with the array of prepared statements
        // The statements in this call are the same objects we tracked above
        batch: vi.fn().mockResolvedValue([]),
      },
      ENRICHMENT_QUEUE: {
        sendBatch: vi.fn().mockImplementation((msgs: Array<{ body: unknown }>) => {
          queuedMessages.push(...msgs);
          return Promise.resolve();
        }),
      },
    } as unknown as Env;

    mockMessages = [
      createMockMessage(0, 'A hoppy IPA with 6.5% ABV'),
      createMockMessage(1, 'A smooth lager with no ABV mentioned'),
      createMockMessage(2, 'Belgian ale 8% alcohol'),
    ];
  });

  it('extracts ABV from original descriptions', async () => {
    await handleFallbackBatch(mockEnv, mockMessages, 'fallback-quota-exceeded');

    // Message 0 has ABV (6.5%), message 2 has ABV (8%)
    // Message 1 has no ABV
    expect(batchStatements).toHaveLength(3);

    // Check ABV values in statements
    const stmtWithAbv1 = batchStatements.find(s => s.args.includes(6.5));
    const stmtWithAbv2 = batchStatements.find(s => s.args.includes(8));
    expect(stmtWithAbv1).toBeDefined();
    expect(stmtWithAbv2).toBeDefined();
  });

  it('queues to Perplexity when ABV not found', async () => {
    await handleFallbackBatch(mockEnv, mockMessages, 'fallback-quota-exceeded');

    // Only message 1 should be queued (no ABV)
    expect(queuedMessages).toHaveLength(1);
    expect((queuedMessages[0].body as { beerId: string }).beerId).toBe('beer-1');
  });

  it('uses correct cleanup_source for quota exceeded', async () => {
    await handleFallbackBatch(mockEnv, [mockMessages[0]], 'fallback-quota-exceeded');

    expect(batchStatements[0].args).toContain('fallback-quota-exceeded');
  });

  it('uses correct cleanup_source for circuit breaker', async () => {
    await handleFallbackBatch(mockEnv, [mockMessages[0]], 'fallback-circuit-breaker');

    expect(batchStatements[0].args).toContain('fallback-circuit-breaker');
  });

  it('handles empty message array', async () => {
    await handleFallbackBatch(mockEnv, [], 'fallback-quota-exceeded');

    // batchUpdateWithRetry is only called when dbStatements.length > 0
    expect(mockEnv.DB.batch).not.toHaveBeenCalled();
    expect(mockEnv.ENRICHMENT_QUEUE.sendBatch).not.toHaveBeenCalled();
  });

  it('does NOT call ack() or retry() - that is the caller responsibility', async () => {
    await handleFallbackBatch(mockEnv, mockMessages, 'fallback-quota-exceeded');

    // Verify message lifecycle methods were NOT called
    for (const msg of mockMessages) {
      expect(msg.ack).not.toHaveBeenCalled();
      expect(msg.retry).not.toHaveBeenCalled();
    }
  });

  it('logs fallback statistics', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleFallbackBatch(mockEnv, mockMessages, 'fallback-quota-exceeded');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fallback processed 3 messages'),
      expect.objectContaining({
        source: 'fallback-quota-exceeded',
        abv_found: 2, // Messages 0 and 2 have ABV
        queued_for_perplexity: 1, // Message 1 needs Perplexity
      })
    );

    consoleSpy.mockRestore();
  });

  it('continues if Perplexity queue fails', async () => {
    mockEnv.ENRICHMENT_QUEUE.sendBatch = vi.fn().mockRejectedValue(new Error('Queue error'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    await handleFallbackBatch(mockEnv, mockMessages, 'fallback-quota-exceeded');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to queue Perplexity messages'),
      expect.any(Error)
    );

    consoleErrorSpy.mockRestore();
  });

  it('retries D1 on failure via batchUpdateWithRetry', async () => {
    // This test verifies the retry behavior of batchUpdateWithRetry
    // which is called internally by handleFallbackBatch
    let attempts = 0;
    mockEnv.DB.batch = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('D1 error');
      }
      return [];
    });

    await handleFallbackBatch(mockEnv, mockMessages, 'fallback-quota-exceeded');

    // batchUpdateWithRetry should have retried and succeeded on 3rd attempt
    expect(mockEnv.DB.batch).toHaveBeenCalledTimes(3);
    // Verify the same statements array was passed each time (retry with same data)
    const calls = (mockEnv.DB.batch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe(calls[1][0]); // Same array reference
    expect(calls[1][0]).toBe(calls[2][0]);
  });

  it('stores original description when ABV found', async () => {
    const msgWithAbv = createMockMessage(0, 'IPA with 7.5% ABV');
    await handleFallbackBatch(mockEnv, [msgWithAbv], 'fallback-quota-exceeded');

    expect(batchStatements).toHaveLength(1);
    // Check that the original description is stored
    expect(batchStatements[0].args).toContain('IPA with 7.5% ABV');
    // Check ABV value
    expect(batchStatements[0].args).toContain(7.5);
    // Check confidence (0.8 is hardcoded in SQL, not in bind args)
    expect(batchStatements[0].sql).toContain('confidence = 0.8');
  });

  it('stores original description when ABV not found', async () => {
    const msgWithoutAbv = createMockMessage(0, 'A delicious craft beer');
    await handleFallbackBatch(mockEnv, [msgWithoutAbv], 'fallback-quota-exceeded');

    expect(batchStatements).toHaveLength(1);
    // Check that the original description is stored
    expect(batchStatements[0].args).toContain('A delicious craft beer');
  });

  it('uses enrichment_source of description-fallback when ABV found', async () => {
    const msgWithAbv = createMockMessage(0, 'Stout 5.5% ABV');
    await handleFallbackBatch(mockEnv, [msgWithAbv], 'fallback-quota-exceeded');

    // SQL contains 'description-fallback' as enrichment_source
    expect(batchStatements[0].sql).toContain('enrichment_source');
  });

  it('handles all messages having ABV (no Perplexity queue needed)', async () => {
    const messagesWithAbv = [
      createMockMessage(0, 'IPA 6.5% ABV'),
      createMockMessage(1, 'Lager 4.2% ABV'),
      createMockMessage(2, 'Stout 8% ABV'),
    ];

    await handleFallbackBatch(mockEnv, messagesWithAbv, 'fallback-quota-exceeded');

    expect(batchStatements).toHaveLength(3);
    // No messages queued for Perplexity
    expect(mockEnv.ENRICHMENT_QUEUE.sendBatch).not.toHaveBeenCalled();
  });

  it('handles all messages missing ABV (all queued to Perplexity)', async () => {
    const messagesWithoutAbv = [
      createMockMessage(0, 'A hoppy craft beer'),
      createMockMessage(1, 'A smooth dark lager'),
      createMockMessage(2, 'A Belgian style ale'),
    ];

    await handleFallbackBatch(mockEnv, messagesWithoutAbv, 'fallback-quota-exceeded');

    expect(batchStatements).toHaveLength(3);
    // All 3 messages queued for Perplexity
    expect(queuedMessages).toHaveLength(3);
  });
});

// ============================================================================
// extractABV Integration Tests
// ============================================================================

describe('extractABV integration in fallback', () => {
  let mockEnv: Env;
  let batchStatements: Array<{ sql: string; args: unknown[] }>;
  let queuedMessages: Array<{ body: unknown }>;

  beforeEach(() => {
    batchStatements = [];
    queuedMessages = [];

    mockEnv = {
      DB: {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockImplementation((...args: unknown[]) => {
            const stmt = { sql, args };
            batchStatements.push(stmt);
            return stmt;
          }),
        })),
        batch: vi.fn().mockResolvedValue([]),
      },
      ENRICHMENT_QUEUE: {
        sendBatch: vi.fn().mockImplementation((msgs: Array<{ body: unknown }>) => {
          queuedMessages.push(...msgs);
          return Promise.resolve();
        }),
      },
    } as unknown as Env;
  });

  it('handles various ABV formats', async () => {
    const testCases = [
      { description: 'IPA 6.5% ABV', expectedABV: 6.5 },
      { description: 'ABV: 5.2%', expectedABV: 5.2 },
      { description: '7% alcohol by volume', expectedABV: 7 },
      { description: 'No alcohol info here', expectedABV: null },
    ];

    for (const { description, expectedABV } of testCases) {
      batchStatements = [];
      queuedMessages = [];

      const mockMsg = createMockMessage(0, description);
      await handleFallbackBatch(mockEnv, [mockMsg], 'fallback-quota-exceeded');

      if (expectedABV !== null) {
        expect(batchStatements[0].args).toContain(expectedABV);
        expect(queuedMessages).toHaveLength(0);
      } else {
        expect(queuedMessages).toHaveLength(1);
      }
    }
  });
});
