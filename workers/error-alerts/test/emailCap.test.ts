import { describe, it, expect, beforeEach } from 'vitest';
import { reserveEmailSlot, resetFallbackForTesting, MAX_EMAILS_PER_WINDOW, type EmailCapStore } from '../src/emailCap';
import { COOLDOWN_MS } from '../src/cooldown';

function makeFakeStore(): EmailCapStore & { readonly data: Map<string, string> } {
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

function makeThrowingStore(): EmailCapStore {
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

describe('reserveEmailSlot: healthy KV', () => {
  it('allows sends up to MAX_EMAILS_PER_WINDOW within a window', async () => {
    const store = makeFakeStore();
    const now = Date.now();

    const results = [];
    for (let i = 0; i < MAX_EMAILS_PER_WINDOW; i++) {
      results.push(await reserveEmailSlot(store, now + i));
    }

    expect(results.every((r) => r.allowed)).toBe(true);
  });

  it('denies a send beyond MAX_EMAILS_PER_WINDOW within the same window', async () => {
    const store = makeFakeStore();
    const now = Date.now();

    for (let i = 0; i < MAX_EMAILS_PER_WINDOW; i++) {
      await reserveEmailSlot(store, now + i);
    }
    const overflow = await reserveEmailSlot(store, now + MAX_EMAILS_PER_WINDOW);

    expect(overflow.allowed).toBe(false);
    expect(overflow.degraded).toBe(false);
  });

  it('allows sends again once a new window starts', async () => {
    const store = makeFakeStore();
    const now = Date.now();

    for (let i = 0; i < MAX_EMAILS_PER_WINDOW; i++) {
      await reserveEmailSlot(store, now + i);
    }
    const nextWindow = await reserveEmailSlot(store, now + COOLDOWN_MS + 1);

    expect(nextWindow.allowed).toBe(true);
  });

  it('bounds volume across many distinct callers sharing the same window', async () => {
    // Simulates many distinct cooldown keys each independently clearing
    // their own per-key cooldown — this cap is the backstop that still
    // limits total sent volume in that case. Calls are sequential here,
    // matching how tail() actually drives this (one reservation per
    // invocation) — KV has no atomic increment, so concurrent callers are
    // not this module's job to serialize.
    const store = makeFakeStore();
    const now = Date.now();

    const results = [];
    for (let i = 0; i < MAX_EMAILS_PER_WINDOW + 5; i++) {
      results.push(await reserveEmailSlot(store, now + i));
    }
    const allowedCount = results.filter((r) => r.allowed).length;

    expect(allowedCount).toBe(MAX_EMAILS_PER_WINDOW);
  });
});

describe('reserveEmailSlot: durable store failure', () => {
  it('still allows sends (degraded) via the in-isolate fallback, rather than blocking everything', async () => {
    const store = makeThrowingStore();
    const result = await reserveEmailSlot(store);
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it('enforces MAX_EMAILS_PER_WINDOW via the in-isolate fallback', async () => {
    const store = makeThrowingStore();
    const now = Date.now();

    const results = [];
    for (let i = 0; i < MAX_EMAILS_PER_WINDOW + 2; i++) {
      results.push(await reserveEmailSlot(store, now + i));
    }

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(MAX_EMAILS_PER_WINDOW);
    expect(results.every((r) => r.degraded)).toBe(true);
  });

  it('allows sends again via the fallback once a new window starts', async () => {
    const store = makeThrowingStore();
    const now = Date.now();

    for (let i = 0; i < MAX_EMAILS_PER_WINDOW; i++) {
      await reserveEmailSlot(store, now + i);
    }
    const nextWindow = await reserveEmailSlot(store, now + COOLDOWN_MS + 1);

    expect(nextWindow.allowed).toBe(true);
  });
});
