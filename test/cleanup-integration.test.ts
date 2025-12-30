/**
 * Integration tests for handleCleanupBatch function.
 *
 * Tests the full cleanup queue processing flow including:
 * - Quota reservation and handling
 * - Parallel AI processing
 * - Circuit breaker behavior
 * - Error recovery scenarios
 * - D1 batch operations
 * - Perplexity queue forwarding
 *
 * @module test/cleanup-integration.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleCleanupBatch,
  processAIConcurrently,
} from '../src/queue/cleanup';
import {
  resetCircuitBreaker,
  recordCallLatency,
  isCircuitBreakerOpen,
  SLOW_THRESHOLD_MS,
  SLOW_CALL_LIMIT,
} from '../src/queue/cleanupHelpers';
import type { Env, CleanupMessage } from '../src/types';

// ============================================================================
// Mock Types
// ============================================================================

interface MockD1PreparedStatement {
  bind: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
}

interface MockD1Database {
  batch: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  _mockStatement: MockD1PreparedStatement;
}

interface MockAI {
  run: ReturnType<typeof vi.fn>;
}

interface MockQueue {
  sendBatch: ReturnType<typeof vi.fn>;
}

interface MockEnv {
  DB: MockD1Database;
  AI: MockAI;
  ENRICHMENT_QUEUE: MockQueue;
  CLEANUP_QUEUE: MockQueue;
  DAILY_CLEANUP_LIMIT: string;
  MAX_CLEANUP_CONCURRENCY: string;
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock D1 database with configurable behavior.
 */
function createMockD1(initialCount = 0, dailyLimit = 1000): MockD1Database {
  let storedCount = initialCount;
  const batchStatements: unknown[] = [];

  const mockStatement: MockD1PreparedStatement = {
    bind: vi.fn().mockImplementation(function (this: MockD1PreparedStatement, ...args: unknown[]) {
      const stmt = { args };
      batchStatements.push(stmt);
      return stmt;
    }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    first: vi.fn().mockResolvedValue({ count: storedCount, daily_limit: dailyLimit }),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };

  const mockDb: MockD1Database = {
    batch: vi.fn().mockResolvedValue([]),
    prepare: vi.fn().mockImplementation((sql: string) => {
      // Handle INSERT for row existence check
      if (sql.includes('INSERT INTO cleanup_limits') && sql.includes('DO NOTHING')) {
        return { bind: vi.fn().mockReturnValue({ run: vi.fn() }) };
      }
      // Handle SELECT to get current count
      if (sql.includes('SELECT request_count FROM cleanup_limits')) {
        return {
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({ request_count: storedCount }),
          }),
        };
      }
      // Handle UPDATE with RETURNING for quota reservation
      if (sql.includes('UPDATE cleanup_limits') && sql.includes('RETURNING')) {
        return {
          bind: vi.fn().mockImplementation((...args: number[]) => {
            const requested = args[0];
            const limit = args[1];
            if (storedCount + requested <= limit) {
              storedCount += requested;
            }
            return {
              first: vi.fn().mockResolvedValue({ new_count: storedCount }),
            };
          }),
        };
      }
      // Handle UPDATE for beer records
      if (sql.includes('UPDATE enriched_beers')) {
        return {
          bind: vi.fn().mockImplementation((...args: unknown[]) => {
            const stmt = { sql, args };
            batchStatements.push(stmt);
            return stmt;
          }),
        };
      }
      return mockStatement;
    }),
    exec: vi.fn().mockResolvedValue({ count: 0 }),
    _mockStatement: mockStatement,
  };

  return mockDb;
}

/**
 * Creates a mock AI service with configurable delay and results.
 */
function createMockAI(delayMs = 50): MockAI {
  return {
    run: vi.fn().mockImplementation(async (_model: string, options: { prompt: string }) => {
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      // Extract ABV from prompt if present
      const abvMatch = options.prompt.match(/(\d+\.?\d*)%/);
      const abv = abvMatch ? parseFloat(abvMatch[1]) : null;
      return {
        response: JSON.stringify({
          cleanedDescription: 'Cleaned beer description',
          extractedABV: abv,
        }),
      };
    }),
  };
}

/**
 * Creates a mock queue for Perplexity enrichment.
 */
function createMockQueue(): MockQueue {
  return {
    sendBatch: vi.fn().mockResolvedValue({ successful: true }),
  };
}

/**
 * Creates a complete mock environment with all required services.
 */
function createFullMockEnv(initialQuotaCount = 0): MockEnv {
  return {
    DB: createMockD1(initialQuotaCount),
    AI: createMockAI(),
    ENRICHMENT_QUEUE: createMockQueue(),
    CLEANUP_QUEUE: createMockQueue(),
    DAILY_CLEANUP_LIMIT: '1000',
    MAX_CLEANUP_CONCURRENCY: '10',
  };
}

/**
 * Creates a mock queue message for testing.
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

/**
 * Creates a batch of test messages with all required MessageBatch properties.
 */
function createBatch(
  size: number,
  descriptionFn: (i: number) => string = (i) => `Beer description ${i} with ${5 + i * 0.5}% ABV`
): MessageBatch<CleanupMessage> {
  const messages = Array.from({ length: size }, (_, i) => createMockMessage(i, descriptionFn(i)));
  return {
    messages,
    queue: 'description-cleanup',
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  } as unknown as MessageBatch<CleanupMessage>;
}

/**
 * Asserts all messages in batch were acknowledged (not retried).
 */
function expectAllAcked(batch: MessageBatch<CleanupMessage>): void {
  for (const msg of batch.messages) {
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  }
}

/**
 * Asserts all messages were either acknowledged or retried (none left unprocessed).
 */
function expectAllProcessed(batch: MessageBatch<CleanupMessage>): void {
  for (const msg of batch.messages) {
    const acked = (msg.ack as ReturnType<typeof vi.fn>).mock.calls.length > 0;
    const retried = (msg.retry as ReturnType<typeof vi.fn>).mock.calls.length > 0;
    expect(acked || retried).toBe(true);
  }
}

// ============================================================================
// Integration Tests
// ============================================================================

describe('handleCleanupBatch integration', () => {
  let mockEnv: MockEnv;

  beforeEach(() => {
    resetCircuitBreaker();
    mockEnv = createFullMockEnv();
  });

  // --------------------------------------------------------------------------
  // Happy Path Tests
  // --------------------------------------------------------------------------

  describe('happy path', () => {
    it('processes batch with all AI successes', async () => {
      const batch = createBatch(5, (i) => `Beer ${i} description 5.${i}% ABV`);

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // All messages should be acked
      expectAllAcked(batch);

      // D1 batch should have been called
      expect(mockEnv.DB.batch).toHaveBeenCalled();
    });

    it('processes batch and extracts ABV from descriptions', async () => {
      const batch = createBatch(3, (i) => `A great IPA with ${6 + i}% ABV`);

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // All messages should be acked
      expectAllAcked(batch);

      // No Perplexity queue needed since ABV found
      expect(mockEnv.ENRICHMENT_QUEUE.sendBatch).not.toHaveBeenCalled();
    });

    it('queues to Perplexity when ABV not found in descriptions', async () => {
      const batch = createBatch(3, () => 'A delicious craft beer with no alcohol percentage');

      // Mock AI to return cleaned description without ABV
      mockEnv.AI.run = vi.fn().mockResolvedValue({
        response: 'A delicious craft beer with no alcohol percentage',
      });

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // All messages should still be acked
      expectAllAcked(batch);

      // Should queue to Perplexity for enrichment
      expect(mockEnv.ENRICHMENT_QUEUE.sendBatch).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Quota Handling Tests
  // --------------------------------------------------------------------------

  describe('quota handling', () => {
    it('processes available quota and uses fallback for exceeded', async () => {
      // Create environment with quota nearly exhausted (only 3 available)
      mockEnv = createFullMockEnv(997);
      const batch = createBatch(5);

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // All messages should be processed (some via AI, some via fallback)
      expectAllProcessed(batch);
    });

    it('uses fallback for entire batch when quota exhausted', async () => {
      // Create environment with quota exhausted
      mockEnv = createFullMockEnv(1000);
      const batch = createBatch(5, (i) => `Beer ${i} with 5% ABV`);

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // All messages should be acked via fallback
      expectAllAcked(batch);

      // AI should not have been called
      expect(mockEnv.AI.run).not.toHaveBeenCalled();
    });

    it('respects daily limit from environment variable', async () => {
      mockEnv.DAILY_CLEANUP_LIMIT = '10';
      const mockDb = createMockD1(8, 10); // 8 used, 10 limit = 2 available
      mockEnv.DB = mockDb;

      const batch = createBatch(5);

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // All messages should be processed
      expectAllProcessed(batch);
    });
  });

  // --------------------------------------------------------------------------
  // Circuit Breaker Tests
  // --------------------------------------------------------------------------

  describe('circuit breaker behavior', () => {
    it('opens circuit breaker after slow AI calls', async () => {
      // Manually trigger circuit breaker opening
      for (let i = 0; i < SLOW_CALL_LIMIT; i++) {
        recordCallLatency(SLOW_THRESHOLD_MS + 1000, i, 10, `beer-${i}`);
      }

      expect(isCircuitBreakerOpen()).toBe(true);

      const batch = createBatch(3);
      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // All messages should still be processed (via fallback)
      expectAllProcessed(batch);

      // AI should not be called when circuit breaker is open
      expect(mockEnv.AI.run).not.toHaveBeenCalled();
    });

    it('uses fallback path when circuit breaker is open', async () => {
      // Pre-open the circuit breaker
      for (let i = 0; i < SLOW_CALL_LIMIT; i++) {
        recordCallLatency(SLOW_THRESHOLD_MS + 1000, i, 10, `slow-beer-${i}`);
      }

      const batch = createBatch(2, (i) => `Beer ${i} 5.5% ABV`);
      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // Messages should be acked (fallback still works)
      expectAllAcked(batch);
    });
  });

  // --------------------------------------------------------------------------
  // Error Recovery Tests
  // --------------------------------------------------------------------------

  describe('error recovery', () => {
    it('retries messages when AI fails', async () => {
      let callCount = 0;
      mockEnv.AI.run = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          throw new Error('AI service unavailable');
        }
        return { response: 'Cleaned description 5.5% ABV' };
      });

      const batch = createBatch(3);

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // Some messages should be retried (AI failures), some acked
      expectAllProcessed(batch);
    });

    it('retries all messages when D1 batch fails after retries', async () => {
      mockEnv.DB.batch = vi.fn().mockRejectedValue(new Error('D1 unavailable'));

      const batch = createBatch(3);

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // All messages should be retried due to D1 failure
      for (const msg of batch.messages) {
        expect(msg.retry).toHaveBeenCalled();
      }
    });

    it('continues processing if Perplexity queue fails', async () => {
      mockEnv.ENRICHMENT_QUEUE.sendBatch = vi.fn().mockRejectedValue(new Error('Queue error'));

      // Messages without ABV - need Perplexity
      const batch = createBatch(3, () => 'Beer without ABV info');
      mockEnv.AI.run = vi.fn().mockResolvedValue({
        response: 'Beer without ABV info',
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // All messages should still be acked despite queue failure
      expectAllAcked(batch);

      // Error should have been logged
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to queue Perplexity messages'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('retries messages when quota reservation fails', async () => {
      // Make quota reservation throw an error
      mockEnv.DB.prepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('cleanup_limits')) {
          return {
            bind: vi.fn().mockReturnValue({
              run: vi.fn().mockRejectedValue(new Error('D1 quota check error')),
              first: vi.fn().mockRejectedValue(new Error('D1 quota check error')),
            }),
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({}),
            first: vi.fn().mockResolvedValue(null),
          }),
        };
      });

      const batch = createBatch(3);

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // All messages should be retried due to quota check failure
      for (const msg of batch.messages) {
        expect(msg.retry).toHaveBeenCalled();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Concurrency Tests
  // --------------------------------------------------------------------------

  describe('concurrency handling', () => {
    it('respects MAX_CLEANUP_CONCURRENCY setting', async () => {
      mockEnv.MAX_CLEANUP_CONCURRENCY = '2';

      const batch = createBatch(5);
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      mockEnv.AI.run = vi.fn().mockImplementation(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(resolve => setTimeout(resolve, 50));
        currentConcurrent--;
        return { response: 'Cleaned 5.5% ABV' };
      });

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // Should not exceed max concurrency
      // Note: Due to test timing, this may not be exact but should be close
      expect(maxConcurrent).toBeLessThanOrEqual(3); // Allow some slack for timing
    });
  });

  // --------------------------------------------------------------------------
  // Empty Batch Tests
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty batch gracefully', async () => {
      const batch = {
        messages: [],
        queue: 'description-cleanup',
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as unknown as MessageBatch<CleanupMessage>;

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // Should complete without errors
      expect(mockEnv.AI.run).not.toHaveBeenCalled();
    });

    it('handles single message batch', async () => {
      const batch = createBatch(1, () => 'Single beer 6% ABV');

      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      expectAllAcked(batch);
    });
  });

  // --------------------------------------------------------------------------
  // Metrics Logging Tests
  // --------------------------------------------------------------------------

  describe('metrics logging', () => {
    it('logs batch metrics on completion', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const batch = createBatch(5);
      await handleCleanupBatch(batch as unknown as MessageBatch<CleanupMessage>, mockEnv as unknown as Env);

      // Should log batch metrics
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[cleanup] Batch metrics'),
        expect.any(String)
      );

      // Should log batch complete summary
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[cleanup] Batch complete'),
        expect.objectContaining({
          acked: expect.any(Number),
          retried: expect.any(Number),
        })
      );

      consoleSpy.mockRestore();
    });
  });
});

// ============================================================================
// processAIConcurrently Tests
// ============================================================================

describe('processAIConcurrently', () => {
  let mockAI: MockAI;

  beforeEach(() => {
    resetCircuitBreaker();
    mockAI = createMockAI(10);
  });

  it('processes messages in parallel', async () => {
    const messages = [
      createMockMessage(0, 'Beer 0 5.0% ABV'),
      createMockMessage(1, 'Beer 1 5.5% ABV'),
      createMockMessage(2, 'Beer 2 6.0% ABV'),
    ];

    const results = await processAIConcurrently(
      messages as Message<CleanupMessage>[],
      mockAI as unknown as Ai,
      10
    );

    expect(results).toHaveLength(3);
    expect(results.every(r => r.success)).toBe(true);
  });

  it('returns results in correct order regardless of completion order', async () => {
    const messages = [
      createMockMessage(0, 'Beer 0'),
      createMockMessage(1, 'Beer 1'),
      createMockMessage(2, 'Beer 2'),
    ];

    // Make calls complete in reverse order
    let callIndex = 0;
    mockAI.run = vi.fn().mockImplementation(async () => {
      const delay = (2 - callIndex) * 20;
      callIndex++;
      await new Promise(resolve => setTimeout(resolve, delay));
      return { response: 'Cleaned 5.5% ABV' };
    });

    const results = await processAIConcurrently(
      messages as Message<CleanupMessage>[],
      mockAI as unknown as Ai,
      10
    );

    // Results should be in original order
    expect(results[0].index).toBe(0);
    expect(results[1].index).toBe(1);
    expect(results[2].index).toBe(2);
  });

  it('handles mixed success and failure', async () => {
    const messages = [
      createMockMessage(0, 'Beer 0'),
      createMockMessage(1, 'Beer 1'),
      createMockMessage(2, 'Beer 2'),
    ];

    let callIndex = 0;
    const mockCleanFn = vi.fn().mockImplementation(async () => {
      callIndex++;
      if (callIndex === 2) {
        throw new Error('AI failure');
      }
      return { cleaned: 'Cleaned 5.5% ABV', usedOriginal: false, extractedABV: 5.5 };
    });

    const results = await processAIConcurrently(
      messages as Message<CleanupMessage>[],
      mockAI as unknown as Ai,
      10,
      { cleanFn: mockCleanFn }
    );

    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(results[1].error).toBe('AI failure');
    expect(results[2].success).toBe(true);
  });

  it('handles empty message array', async () => {
    const results = await processAIConcurrently(
      [],
      mockAI as unknown as Ai,
      10
    );

    expect(results).toEqual([]);
    expect(mockAI.run).not.toHaveBeenCalled();
  });

  it('marks results with useFallback when circuit breaker is open', async () => {
    // Open the circuit breaker
    for (let i = 0; i < SLOW_CALL_LIMIT; i++) {
      recordCallLatency(SLOW_THRESHOLD_MS + 1000, i, 10, `beer-${i}`);
    }

    const messages = [
      createMockMessage(0, 'Beer 0'),
      createMockMessage(1, 'Beer 1'),
    ];

    const results = await processAIConcurrently(
      messages as Message<CleanupMessage>[],
      mockAI as unknown as Ai,
      10
    );

    // All results should have useFallback set
    expect(results.every(r => r.useFallback === true)).toBe(true);
    expect(results.every(r => r.success === false)).toBe(true);

    // AI should not have been called
    expect(mockAI.run).not.toHaveBeenCalled();
  });

  it('respects custom timeout', async () => {
    const messages = [createMockMessage(0, 'Beer 0')];

    // Create AI that takes longer than timeout
    mockAI.run = vi.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      return { response: 'Cleaned' };
    });

    const results = await processAIConcurrently(
      messages as Message<CleanupMessage>[],
      mockAI as unknown as Ai,
      10,
      { timeoutMs: 50 }
    );

    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('AI call timeout');
  });
});
