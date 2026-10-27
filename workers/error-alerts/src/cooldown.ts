// How long to suppress repeat alerts for the same cooldown key after one is sent.
export const COOLDOWN_MS = 5 * 60 * 1000;

// KV entries expire a bit after the cooldown window closes, so a key that
// goes quiet is not held in the namespace forever.
const COOLDOWN_TTL_SECONDS = Math.ceil((COOLDOWN_MS / 1000) * 2);

// The subset of KVNamespace this module needs, restated as plain (rather
// than overloaded) call signatures — narrow on purpose so tests can supply
// a small in-memory fake instead of the full binding surface. A real
// KVNamespace satisfies this structurally, so env.COOLDOWN_KV can be
// passed directly.
export type CooldownStore = {
  readonly get: (key: string) => Promise<string | null>;
  readonly put: (
    key: string,
    value: string,
    options?: { readonly expirationTtl?: number },
  ) => Promise<void>;
};

type CooldownEntry = { readonly lastSent: number; readonly suppressedCount: number };

export type CooldownResult = {
  readonly shouldSend: boolean;
  readonly suppressedCount: number;
  // True when the durable store was unavailable and this result came from
  // the in-isolate fallback below instead.
  readonly degraded: boolean;
};

function storageKey(key: string): string {
  return `cooldown:${key}`;
}

function parseEntry(raw: string | null): CooldownEntry | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as CooldownEntry).lastSent === 'number' &&
      typeof (parsed as CooldownEntry).suppressedCount === 'number'
    ) {
      return parsed as CooldownEntry;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-isolate fallback tier
//
// Used only when the durable KV store throws. A module-global Map is
// per-isolate and per-Cloudflare-location — it does not hold across warm
// isolates or POPs the way KV does — but it still bounds volume to
// roughly one alert per warm isolate per window, rather than either
// suppressing every alert (silencing the channel during exactly the kind
// of incident that motivates it) or sending unbounded ones.
// ---------------------------------------------------------------------------

const fallbackState = new Map<string, CooldownEntry>();

function checkFallbackCooldown(key: string, now: number): CooldownResult {
  const entry = fallbackState.get(key);

  if (entry === undefined || now - entry.lastSent >= COOLDOWN_MS) {
    fallbackState.set(key, { lastSent: now, suppressedCount: 0 });
    return { shouldSend: true, suppressedCount: entry?.suppressedCount ?? 0, degraded: true };
  }

  const suppressedCount = entry.suppressedCount + 1;
  fallbackState.set(key, { lastSent: entry.lastSent, suppressedCount });
  return { shouldSend: false, suppressedCount, degraded: true };
}

export function resetFallbackForTesting(): void {
  fallbackState.clear();
}

/**
 * Checks whether an alert for `key` should be sent, backed by a durable KV
 * store so the cooldown holds across isolates and Cloudflare locations —
 * Tail Workers run per-isolate and per-location, so an in-memory Map only
 * ever holds the cooldown within one warm isolate.
 *
 * Degrades rather than fails safe-by-silence: if the KV read or write
 * throws, this falls back to the in-isolate cooldown above instead of
 * suppressing outright. A KV outage plausibly correlates with the kind of
 * broader incident these alerts exist to report, so going silent is worse
 * than the flooding risk this module defends against.
 */
export async function checkCooldown(
  store: CooldownStore,
  key: string,
  now: number = Date.now(),
): Promise<CooldownResult> {
  const storedKey = storageKey(key);
  try {
    const entry = parseEntry(await store.get(storedKey));

    if (entry === null || now - entry.lastSent >= COOLDOWN_MS) {
      await store.put(storedKey, JSON.stringify({ lastSent: now, suppressedCount: 0 }), {
        expirationTtl: COOLDOWN_TTL_SECONDS,
      });
      return { shouldSend: true, suppressedCount: entry?.suppressedCount ?? 0, degraded: false };
    }

    const suppressedCount = entry.suppressedCount + 1;
    await store.put(storedKey, JSON.stringify({ lastSent: entry.lastSent, suppressedCount }), {
      expirationTtl: COOLDOWN_TTL_SECONDS,
    });
    return { shouldSend: false, suppressedCount, degraded: false };
  } catch (err) {
    console.error('Cooldown store read/write failed; falling back to in-isolate cooldown', err);
    return checkFallbackCooldown(key, now);
  }
}
