/**
 * Tests for withTimeout helper -- verifying the timeoutId! fix.
 *
 * These tests specifically verify that withTimeout works correctly
 * without using a non-null assertion on timeoutId.
 *
 * @module test/queue/cleanupHelpers-timeout.test
 */

import { describe, it, expect, vi } from 'vitest';
import { withTimeout } from '../../src/queue/cleanupHelpers';

describe('withTimeout (timeoutId safety)', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve('done'), 1000);
    expect(result).toBe('done');
  });

  it('rejects with AI call timeout when promise exceeds timeout', async () => {
    const slow = new Promise<string>(resolve =>
      setTimeout(() => resolve('late'), 500)
    );
    await expect(withTimeout(slow, 50)).rejects.toThrow('AI call timeout');
  });

  it('clears the timer on success (no lingering timers)', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    await withTimeout(Promise.resolve('ok'), 1000);
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    clearTimeoutSpy.mockRestore();
  });

  it('clears the timer on timeout rejection (no lingering timers)', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const slow = new Promise<string>(resolve =>
      setTimeout(() => resolve('late'), 500)
    );
    await expect(withTimeout(slow, 50)).rejects.toThrow('AI call timeout');
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('clears the timer when the promise itself rejects', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1000)
    ).rejects.toThrow('boom');
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    clearTimeoutSpy.mockRestore();
  });

  it('preserves the resolved value type', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });
});
