/**
 * Queue consumer settings, read from wrangler.jsonc on the Node side of
 * Vitest (test/support/queueConsumers.mts) and passed in with `provide`.
 * Editing wrangler.jsonc needs a fresh Vitest run; watch mode keeps the old
 * value.
 */
import { describe, expect, inject, it } from 'vitest';
import { MAX_DLQ_CONSUMER_ATTEMPTS } from '../src/constants';

describe('queue consumer settings in wrangler.jsonc', () => {
  it('retries each work queue, then dead-letters it to the queue whose consumer stores it in D1', () => {
    expect(inject('queueConsumers')).toEqual([
      { queue: 'beer-enrichment', max_retries: 3, dead_letter_queue: 'beer-enrichment-dlq' },
      { queue: 'beer-enrichment-dlq', max_retries: MAX_DLQ_CONSUMER_ATTEMPTS, dead_letter_queue: undefined },
      { queue: 'description-cleanup', max_retries: 2, dead_letter_queue: 'description-cleanup-dlq' },
      { queue: 'description-cleanup-dlq', max_retries: MAX_DLQ_CONSUMER_ATTEMPTS, dead_letter_queue: undefined },
    ]);
  });
});
