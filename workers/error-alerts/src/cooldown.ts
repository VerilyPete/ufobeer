export const COOLDOWN_MS = 5 * 60 * 1000;

type CooldownEntry = { lastSent: number; suppressedCount: number };

const state = new Map<string, CooldownEntry>();

export function shouldSendAlert(key: string, now: number = Date.now()): boolean {
  const entry = state.get(key);
  if (entry === undefined || now - entry.lastSent >= COOLDOWN_MS) {
    state.set(key, { lastSent: now, suppressedCount: 0 });
    return true;
  }
  entry.suppressedCount += 1;
  return false;
}

export function getSuppressedCount(key: string): number {
  const entry = state.get(key);
  if (entry === undefined) return 0;
  const count = entry.suppressedCount;
  entry.suppressedCount = 0;
  return count;
}

export function resetForTesting(): void {
  state.clear();
}
