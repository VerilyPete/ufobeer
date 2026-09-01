/**
 * Tests for src/queue/helpers.ts's queueBeersForCleanup, focused on the
 * descriptionHash stamping added for consumer-side stale-result binding
 * (Cloudflare security review Phase 1, item 2a).
 *
 * @module test/queue/helpers.test
 */

import { describe, it, expect, vi } from 'vitest';
import { queueBeersForCleanup } from '../../src/queue/helpers';
import { hashDescription } from '../../src/utils/hash';
import type { Env, CleanupMessage } from '../../src/types';

function createEnv() {
  const sendBatch = vi.fn().mockResolvedValue(undefined);
  const env = {
    CLEANUP_QUEUE: { sendBatch },
  } as unknown as Env;
  return { env, sendBatch };
}

describe('queueBeersForCleanup', () => {
  it('stamps a computed descriptionHash when the caller does not supply one', async () => {
    const { env, sendBatch } = createEnv();
    const description = 'A hoppy IPA with citrus notes';
    const expectedHash = await hashDescription(description);

    await queueBeersForCleanup(
      env,
      [{ id: 'beer-1', brew_name: 'Test IPA', brewer: 'Test Brewery', brew_description: description }],
      'req-1'
    );

    expect(sendBatch).toHaveBeenCalledOnce();
    const sent = sendBatch.mock.calls[0][0] as Array<{ body: CleanupMessage }>;
    expect(sent[0]!.body.descriptionHash).toBe(expectedHash);
  });

  it('uses the caller-supplied descriptionHash when provided, without recomputing', async () => {
    const { env, sendBatch } = createEnv();

    await queueBeersForCleanup(
      env,
      [{
        id: 'beer-2',
        brew_name: 'Test IPA',
        brewer: 'Test Brewery',
        brew_description: 'A hoppy IPA with citrus notes',
        descriptionHash: 'caller-precomputed-hash',
      }],
      'req-2'
    );

    const sent = sendBatch.mock.calls[0][0] as Array<{ body: CleanupMessage }>;
    expect(sent[0]!.body.descriptionHash).toBe('caller-precomputed-hash');
  });

  it('computes matching hashes for beers with the same description and distinct hashes for different descriptions', async () => {
    const { env, sendBatch } = createEnv();

    await queueBeersForCleanup(
      env,
      [
        { id: 'beer-3', brew_name: 'A', brewer: 'X', brew_description: 'Same text' },
        { id: 'beer-4', brew_name: 'B', brewer: 'Y', brew_description: 'Same text' },
        { id: 'beer-5', brew_name: 'C', brewer: 'Z', brew_description: 'Different text' },
      ],
      'req-3'
    );

    const sent = sendBatch.mock.calls[0][0] as Array<{ body: CleanupMessage }>;
    const [a, b, c] = sent.map(m => m.body.descriptionHash);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('still sends beerId, beerName, brewer, and brewDescription unchanged', async () => {
    const { env, sendBatch } = createEnv();

    await queueBeersForCleanup(
      env,
      [{ id: 'beer-6', brew_name: 'Test IPA', brewer: 'Test Brewery', brew_description: 'A description' }],
      'req-4'
    );

    const sent = sendBatch.mock.calls[0][0] as Array<{ body: CleanupMessage }>;
    expect(sent[0]!.body).toMatchObject({
      beerId: 'beer-6',
      beerName: 'Test IPA',
      brewer: 'Test Brewery',
      brewDescription: 'A description',
    });
  });

  it('returns queued=0 and an empty queuedIds array for an empty beer list', async () => {
    const { env, sendBatch } = createEnv();

    const result = await queueBeersForCleanup(env, [], 'req-5');

    expect(result).toEqual({ queued: 0, queuedIds: [] });
    expect(sendBatch).not.toHaveBeenCalled();
  });
});
