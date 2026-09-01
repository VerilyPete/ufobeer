import { describe, it, expect, beforeEach } from 'vitest';
import { checkCooldown, resetFallbackForTesting, COOLDOWN_MS, type CooldownStore } from '../src/cooldown';

// ---------------------------------------------------------------------------
// Fake KV store
// ---------------------------------------------------------------------------

function makeFakeStore(): CooldownStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async put(key: string, value: string) {
      data.set(key, typeof value === 'string' ? value : String(value));
    },
  };
}

function makeThrowingStore(): CooldownStore {
  return {
    get: async () => {
      throw new Error('KV unavailable');
    },
    put: async () => {
      throw new Error('KV unavailable');
    },
  };
}

beforeEach(() => {
  resetFallbackForTesting();
});

// ---------------------------------------------------------------------------
// checkCooldown — healthy KV
// ---------------------------------------------------------------------------

describe('checkCooldown', () => {
  it('returns shouldSend: true, degraded: false on first call for a key', async () => {
    const store = makeFakeStore();
    const result = await checkCooldown(store, 'error:TypeError');
    expect(result.shouldSend).toBe(true);
    expect(result.degraded).toBe(false);
  });

  it('suppresses a second alert within the cooldown window', async () => {
    const store = makeFakeStore();
    const now = Date.now();
    await checkCooldown(store, 'error:TypeError', now);
    const second = await checkCooldown(store, 'error:TypeError', now + 1000);
    expect(second.shouldSend).toBe(false);
  });

  it('allows a new alert once the cooldown window expires', async () => {
    const store = makeFakeStore();
    const now = Date.now();
    await checkCooldown(store, 'error:TypeError', now);
    const later = await checkCooldown(store, 'error:TypeError', now + COOLDOWN_MS + 1);
    expect(later.shouldSend).toBe(true);
  });

  it('tracks independent cooldowns per key', async () => {
    const store = makeFakeStore();
    const now = Date.now();
    await checkCooldown(store, 'error:TypeError', now);
    const other = await checkCooldown(store, 'error:RangeError', now + 1000);
    expect(other.shouldSend).toBe(true);
  });

  it('persists state through the store so a fresh call sees prior suppressions', async () => {
    const store = makeFakeStore();
    const now = Date.now();
    await checkCooldown(store, 'error:TypeError', now);
    await checkCooldown(store, 'error:TypeError', now + 1000);
    await checkCooldown(store, 'error:TypeError', now + 2000);
    const result = await checkCooldown(store, 'error:TypeError', now + COOLDOWN_MS + 1);
    expect(result.shouldSend).toBe(true);
    expect(result.suppressedCount).toBe(2);
  });

  it('resets the suppressed count once a new window starts', async () => {
    const store = makeFakeStore();
    const now = Date.now();
    await checkCooldown(store, 'error:TypeError', now);
    await checkCooldown(store, 'error:TypeError', now + 1000);
    await checkCooldown(store, 'error:TypeError', now + COOLDOWN_MS + 1);
    const result = await checkCooldown(store, 'error:TypeError', now + COOLDOWN_MS + 2000);
    expect(result.shouldSend).toBe(false);
    expect(result.suppressedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// checkCooldown — durable store failure: degrade, don't silence
// ---------------------------------------------------------------------------

describe('checkCooldown: durable store failure', () => {
  it('still allows the alert (degraded), rather than suppressing it, on a KV failure', async () => {
    const store = makeThrowingStore();
    const result = await checkCooldown(store, 'error:TypeError');
    expect(result.shouldSend).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it('bounds repeat alerts for the same key via the in-isolate fallback', async () => {
    const store = makeThrowingStore();
    const now = Date.now();
    const first = await checkCooldown(store, 'error:TypeError', now);
    const second = await checkCooldown(store, 'error:TypeError', now + 1000);
    expect(first.shouldSend).toBe(true);
    expect(second.shouldSend).toBe(false);
    expect(second.degraded).toBe(true);
  });

  it('allows a new alert via the fallback once its cooldown window expires', async () => {
    const store = makeThrowingStore();
    const now = Date.now();
    await checkCooldown(store, 'error:TypeError', now);
    const later = await checkCooldown(store, 'error:TypeError', now + COOLDOWN_MS + 1);
    expect(later.shouldSend).toBe(true);
  });

  it('does not let a KV failure produce unbounded sends across many rapid calls for the same key', async () => {
    const store = makeThrowingStore();
    const now = Date.now();
    const results = [
      await checkCooldown(store, 'error:TypeError', now),
      await checkCooldown(store, 'error:TypeError', now + 100),
      await checkCooldown(store, 'error:TypeError', now + 200),
      await checkCooldown(store, 'error:TypeError', now + 300),
    ];
    const sentCount = results.filter((r) => r.shouldSend).length;
    expect(sentCount).toBe(1);
  });
});
