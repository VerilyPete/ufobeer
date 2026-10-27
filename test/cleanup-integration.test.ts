/**
 * Failure-handling tests for handleCleanupBatch: D1 and queue failures that
 * the real-D1 consumer tests (test/queue/cleanup-consumer.integration.test.ts)
 * cannot provoke.
 *
 * @module test/cleanup-integration.test
 */

import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { handleCleanupBatch } from '../src/queue/cleanup';
import type { Env, CleanupMessage } from '../src/types';

// ============================================================================
// Test Helpers
// ============================================================================

type MockEnv = {
  readonly DB: { readonly batch: Mock; readonly prepare: Mock };
  readonly ENRICHMENT_QUEUE: { readonly sendBatch: Mock };
};

function createMockEnv(): MockEnv {
  return {
    DB: {
      batch: vi.fn().mockResolvedValue([]),
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockImplementation((...args: unknown[]) => ({ sql, args })),
      })),
    },
    ENRICHMENT_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) },
  };
}

function createMockMessage(index: number, description: string): Message<CleanupMessage> {
  return {
    id: `msg-${index}`,
    timestamp: new Date(),
    body: {
      beerId: `beer-${index}`,
      beerName: `Beer ${index}`,
      brewer: `Brewer ${index}`,
      brewDescription: description,
      descriptionHash: 'test-hash',
    },
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<CleanupMessage>;
}

function createBatch(
  size: number,
  descriptionFn: (i: number) => string = (i) => `Beer description ${i} with ${5 + i * 0.5}% ABV`
): MessageBatch<CleanupMessage> {
  return {
    messages: Array.from({ length: size }, (_, i) => createMockMessage(i, descriptionFn(i))),
    queue: 'description-cleanup',
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  } as unknown as MessageBatch<CleanupMessage>;
}

function expectAllAcked(batch: MessageBatch<CleanupMessage>): void {
  for (const msg of batch.messages) {
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('handleCleanupBatch failure handling', () => {
  it('retries all messages when D1 batch fails after retries', async () => {
    const mockEnv = createMockEnv();
    mockEnv.DB.batch.mockRejectedValue(new Error('D1 unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = createBatch(3);

    await handleCleanupBatch(batch, mockEnv as unknown as Env);

    for (const msg of batch.messages) {
      expect(msg.retry).toHaveBeenCalled();
      expect(msg.ack).not.toHaveBeenCalled();
    }
    expect(mockEnv.ENRICHMENT_QUEUE.sendBatch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('acks every message even if the Perplexity queue fails', async () => {
    const mockEnv = createMockEnv();
    mockEnv.ENRICHMENT_QUEUE.sendBatch.mockRejectedValue(new Error('Queue error'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = createBatch(3, () => 'Beer without ABV info');

    await handleCleanupBatch(batch, mockEnv as unknown as Env);

    expectAllAcked(batch);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to queue Perplexity messages'),
      expect.any(Error)
    );
    consoleErrorSpy.mockRestore();
  });

  it('handles an empty batch without touching D1', async () => {
    const mockEnv = createMockEnv();
    const batch = createBatch(0);

    await handleCleanupBatch(batch, mockEnv as unknown as Env);

    expect(mockEnv.DB.batch).not.toHaveBeenCalled();
  });

  it('logs batch metrics and a completion summary', async () => {
    const mockEnv = createMockEnv();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const batch = createBatch(4, (i) => (i < 2 ? `Lager at ${5 + i}% ABV` : 'No strength given'));

    await handleCleanupBatch(batch, mockEnv as unknown as Env);

    const metrics = consoleSpy.mock.calls.find(([label]) => label === '[cleanup] Batch metrics:');
    expect(JSON.parse(String(metrics?.[1]))).toEqual({ total: 4, abv_extracted: 2, abv_rate: 50 });
    expect(consoleSpy).toHaveBeenCalledWith('[cleanup] Batch complete', { acked: 4 });
    consoleSpy.mockRestore();
  });
});
