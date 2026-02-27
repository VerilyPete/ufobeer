import { describe, it, expect, beforeEach } from 'vitest';
import { shouldSendAlert, getSuppressedCount, resetForTesting, COOLDOWN_MS } from '../src/cooldown';

beforeEach(() => {
  resetForTesting();
});

describe('shouldSendAlert', () => {
  it('returns true on first call for a key', () => {
    expect(shouldSendAlert('error:TypeError')).toBe(true);
  });

  it('returns false within cooldown window for same key', () => {
    const now = Date.now();
    shouldSendAlert('error:TypeError', now);
    expect(shouldSendAlert('error:TypeError', now + 1000)).toBe(false);
  });

  it('returns true after cooldown expires', () => {
    const now = Date.now();
    shouldSendAlert('error:TypeError', now);
    expect(shouldSendAlert('error:TypeError', now + COOLDOWN_MS + 1)).toBe(true);
  });

  it('different keys have independent cooldowns', () => {
    const now = Date.now();
    shouldSendAlert('error:TypeError', now);
    expect(shouldSendAlert('error:RangeError', now + 1000)).toBe(true);
  });
});

describe('getSuppressedCount', () => {
  it('returns 0 when no alerts were suppressed', () => {
    const now = Date.now();
    shouldSendAlert('error:TypeError', now);
    expect(getSuppressedCount('error:TypeError')).toBe(0);
  });

  it('returns count of suppressed alerts', () => {
    const now = Date.now();
    shouldSendAlert('error:TypeError', now);
    shouldSendAlert('error:TypeError', now + 1000);
    shouldSendAlert('error:TypeError', now + 2000);
    expect(getSuppressedCount('error:TypeError')).toBe(2);
  });

  it('resets count after reading', () => {
    const now = Date.now();
    shouldSendAlert('error:TypeError', now);
    shouldSendAlert('error:TypeError', now + 1000);
    getSuppressedCount('error:TypeError');
    expect(getSuppressedCount('error:TypeError')).toBe(0);
  });
});

describe('resetForTesting', () => {
  it('clears all state so keys are treated as unseen', () => {
    const now = Date.now();
    shouldSendAlert('error:TypeError', now);
    shouldSendAlert('error:RangeError', now);
    resetForTesting();
    expect(shouldSendAlert('error:TypeError', now)).toBe(true);
    expect(shouldSendAlert('error:RangeError', now)).toBe(true);
  });
});
