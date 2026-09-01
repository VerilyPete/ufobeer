import { COOLDOWN_MS, type CooldownStore } from './cooldown';

// Hard backstop on total alert-email volume, independent of and applied
// underneath the per-error-key cooldown in cooldown.ts. The per-key
// cooldown alone does not bound total volume: each *distinct* cooldown key
// (outcome + exception name) gets its own independent budget, so an
// attacker or incident that provokes many distinct error identities could
// otherwise still flood the mailbox — just one email per identity instead
// of one per identical error. This caps the total regardless of how many
// distinct keys are behind it.
//
// Small on purpose — this worker's job is a handful of alerts per window,
// not a feed.
export const MAX_EMAILS_PER_WINDOW = 3;

// Reuse the cooldown's store shape and window size — one alerting cadence,
// not a second magic number to keep in sync.
export type EmailCapStore = CooldownStore;

const CAP_KEY = 'email-cap:window';

type WindowState = { readonly windowStart: number; readonly count: number };

export type EmailCapResult = {
  readonly allowed: boolean;
  // True when the durable store was unavailable and this result came from
  // the in-isolate fallback below instead.
  readonly degraded: boolean;
};

function parseState(raw: string | null): WindowState | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as WindowState).windowStart === 'number' &&
      typeof (parsed as WindowState).count === 'number'
    ) {
      return parsed as WindowState;
    }
    return null;
  } catch {
    return null;
  }
}

// In-isolate fallback counter, used only when the durable store throws —
// same rationale as cooldown.ts's fallback tier.
const fallbackWindow = new Map<string, WindowState>();

function reserveFallbackSlot(now: number): EmailCapResult {
  const state = fallbackWindow.get(CAP_KEY);

  if (state === undefined || now - state.windowStart >= COOLDOWN_MS) {
    fallbackWindow.set(CAP_KEY, { windowStart: now, count: 1 });
    return { allowed: true, degraded: true };
  }

  if (state.count >= MAX_EMAILS_PER_WINDOW) {
    return { allowed: false, degraded: true };
  }

  fallbackWindow.set(CAP_KEY, { windowStart: state.windowStart, count: state.count + 1 });
  return { allowed: true, degraded: true };
}

export function resetFallbackForTesting(): void {
  fallbackWindow.clear();
}

/**
 * Reserves one slot in the rolling email-volume window and reports whether
 * this send is allowed. Call only once cooldown.ts has already approved
 * the send — this counts actual emails, not suppressed attempts.
 *
 * Degrades to an in-isolate counter on a durable-store failure, for the
 * same reason cooldown.ts does: silence is worse than a slightly looser
 * bound during exactly the kind of incident this exists to report.
 */
export async function reserveEmailSlot(store: EmailCapStore, now: number = Date.now()): Promise<EmailCapResult> {
  try {
    const state = parseState(await store.get(CAP_KEY));

    if (state === null || now - state.windowStart >= COOLDOWN_MS) {
      await store.put(CAP_KEY, JSON.stringify({ windowStart: now, count: 1 }), {
        expirationTtl: Math.ceil((COOLDOWN_MS / 1000) * 2),
      });
      return { allowed: true, degraded: false };
    }

    if (state.count >= MAX_EMAILS_PER_WINDOW) {
      return { allowed: false, degraded: false };
    }

    await store.put(CAP_KEY, JSON.stringify({ windowStart: state.windowStart, count: state.count + 1 }), {
      expirationTtl: Math.ceil((COOLDOWN_MS / 1000) * 2),
    });
    return { allowed: true, degraded: false };
  } catch (err) {
    console.error('Email-cap store read/write failed; falling back to in-isolate cap', err);
    return reserveFallbackSlot(now);
  }
}
