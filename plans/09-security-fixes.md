# Plan: Security Scan Fixes

Six independent work streams, all following TDD. Can be parallelized.

---

## Work Stream A: Health check error message leak (Finding 1)

**Files:** `src/handlers/health.ts:81`, `test/handlers/health.test.ts`

**Problem:** D1 errors leak `error.message` to clients in health check responses.

**Note:** The existing code does NOT log the error server-side. Adding `console.error` is a behavior addition for observability.

### RED
Update existing test (line ~244) to assert generic message:
```typescript
expect(body.error).toBe('Database connection failed');
```

### GREEN
In `src/handlers/health.ts` catch block:
```typescript
} catch (error) {
    console.error('Health check DB error:', error);
    return Response.json(
      { status: 'error', database: 'disconnected', error: 'Database connection failed' },
      { status: 503 }
    );
}
```

---

## Work Stream B: Rate limiting degraded tracking (Finding 2)

**Files:** `src/rate-limit.ts:116-119`, `test/rate-limit.test.ts`, `test/type-checks/interface-to-type.test.ts`

**Problem:** Rate limiting silently fails open on D1 error with no tracking.

**Approach:** Add `degraded: boolean` field to `RateLimitResult`. Full in-memory fallback is disproportionate for a single-tenant API. The `degraded` field enables callers to log/track when rate limiting is bypassed. The existing `console.error` in the catch block already triggers the tail worker error alerts — the field is for programmatic detection.

### RED
```typescript
it('returns degraded: true on database error', async () => {
    // mock DB to throw
    const result = await checkRateLimit(mockDb, 'client-1', 100);
    expect(result.degraded).toBe(true);
});

it('returns degraded: false on successful check', async () => {
    const result = await checkRateLimit(mockDb, 'client-1', 100);
    expect(result.degraded).toBe(false);
});
```

### GREEN
Add `degraded: boolean` to `RateLimitResult` type. Return `degraded: false` on success paths, `degraded: true` on error path.

### Tests to update
- `test/type-checks/interface-to-type.test.ts:92` — `RateLimitResult` literal needs `degraded: false` added (type check test constructs a literal that must include all required fields).

---

## Work Stream C: Client identifier hardening (Finding 3)

**Files:** `src/auth.ts:159-163`, `test/auth.test.ts`, `src/index.ts`

**Problem:** `X-Client-ID` header is client-supplied and spoofable, allowing rate limit bypass.

**Fix:** Remove `X-Client-ID` from `getClientIdentifier`, use IP only. After auth, override with `apiKeyHash` in `index.ts`. Also remove `X-Client-ID` from CORS `Access-Control-Allow-Headers` (cross-cutting with Work Stream D).

**Note on `getClientIp` safety:** `getClientIp` reads `CF-Connecting-IP` first (set by Cloudflare's edge, not spoofable by clients), then falls back to `X-Forwarded-For`. The fallback is safe in production because Cloudflare always sets `CF-Connecting-IP` on every request. The `X-Forwarded-For` fallback exists only for local dev/test environments where `CF-Connecting-IP` is absent. No code change needed.

### RED
```typescript
it('ignores X-Client-ID header and uses IP', () => {
    const request = createRequest({
      'X-Client-ID': 'spoofed-value',
      'CF-Connecting-IP': '10.0.0.1',
    });
    expect(getClientIdentifier(request)).toBe('10.0.0.1');
});
```

### GREEN
```typescript
export function getClientIdentifier(request: Request): string {
  const clientIp = getClientIp(request);
  return (clientIp || 'unknown').substring(0, 64);
}
```

In `index.ts` after auth, override clientIdentifier:
```typescript
const authedContext = {
  ...requestContext,
  apiKeyHash: authResult.apiKeyHash,
  clientIdentifier: authResult.apiKeyHash ?? requestContext.clientIdentifier,
};
```

### Tests to update (6 tests in `test/auth.test.ts`)
- Line 321-323: `'returns X-Client-ID header value when present'` — rewrite to test IP-only
- Line 336-341: truncation test uses `X-Client-ID` — change to use `CF-Connecting-IP`
- Lines 344-348: exact-64 test uses `X-Client-ID` — change to use IP
- Lines 351-355: short-id test uses `X-Client-ID` — change to use IP

### CORS change (coordinate with Work Stream D)
Remove `X-Client-ID` from `Access-Control-Allow-Headers` in `src/context.ts:32`:
```typescript
'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
```

---

## Work Stream D: CORS header tightening (Finding 4)

**Files:** `src/context.ts:24-35`, `test/context.test.ts`, `src/index.ts`

**Problem:** CORS headers sent on all responses regardless of request Origin.

**Fix:** Add `requestOrigin` parameter to `getCorsHeaders`, return `null` when Origin doesn't match.

### Type safety concern

`getCorsHeaders` will now return `Record<string, string> | null`. The `respond()` helper expects `Record<string, string>`. All call sites in `index.ts` must use `corsHeaders ?? {}` to handle null safely.

### Behavior change: server-to-server calls

Non-browser clients (curl, mobile apps) don't send `Origin` headers. After this change, responses to those clients will omit CORS headers entirely. This is correct behavior — CORS headers are meaningless without a browser.

### RED
```typescript
it('returns CORS headers when Origin matches', () => {
    const result = getCorsHeaders(env, 'https://ufobeer.app');
    expect(result!['Access-Control-Allow-Origin']).toBe('https://ufobeer.app');
});

it('returns null when Origin does not match', () => {
    expect(getCorsHeaders(env, 'https://evil.com')).toBeNull();
});

it('returns null when Origin is undefined', () => {
    expect(getCorsHeaders(env, undefined)).toBeNull();
});
```

### GREEN
```typescript
export function getCorsHeaders(env: Env, requestOrigin?: string | null): Record<string, string> | null {
  if (!env.ALLOWED_ORIGIN || requestOrigin !== env.ALLOWED_ORIGIN) return null;
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Access-Control-Max-Age': '86400',
  };
}
```

### Callers to update in `src/index.ts`
- Line 84: `getCorsHeaders(env)` → `getCorsHeaders(env, request.headers.get('Origin'))`
- All usages of `corsHeaders` passed to `respond()` → use `corsHeaders ?? {}`
- OPTIONS preflight (line 120-122): continues to work because browsers always send `Origin` in preflight

### Top-level catch block (`src/index.ts:442-445`)
Also tighten to check request Origin:
```typescript
} catch (error) {
    console.error('Unhandled fetch error', error);
    const origin = request.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGIN;
    const corsHeader = origin === allowed ? { 'Access-Control-Allow-Origin': origin } : {};
    // ...
}
```
(This already does Origin checking — confirm it matches the new pattern.)

### Tests to update (7 tests in `test/context.test.ts`)
All existing tests call `getCorsHeaders(env)` with one argument — update to pass a matching Origin.

### Tests in `test/index.test.ts`
- Lines 178-196: error boundary CORS tests — verify they send `Origin` header in requests.

---

## Work Stream E: Error message leaks + auth prefix (Findings 5, 6)

### Finding 5: Sync batch error leaks D1 internals

**Files:** `src/handlers/beers.ts:526-536`, `test/handlers/beers.sync.test.ts`

#### RED
Assert generic messages, assert errors do NOT contain D1 internals:
```typescript
expect(result.errors[0]).toBe('Statement 1 failed');
expect(result.errors[0]).not.toContain('UNIQUE constraint');
```

#### GREEN
```typescript
// Per-statement failure (line 526)
errors.push(`Statement ${i} failed`);
console.error(`Sync statement ${i} failed:`, result.error);

// Batch failure (line 532)
errors.push('Database write failed for batch');
console.error('Sync batch failed:', error);
```

#### Tests to update in `test/handlers/beers.sync.test.ts`
- Line 172: `expect(result.errors[0]).toContain('Constraint violation')` — remove (leaked detail)
- Lines 207-209: `expect(result.errors[0]).toContain('D1 unavailable')` — remove
- Lines 252-253: `expect(result.errors[0]).toContain('String error')` — remove

### Finding 6: API key prefix 4 chars -> 2 chars

**Files:** `src/auth.ts:85`, `test/auth.test.ts`

#### RED
Update test description from "first 4 chars" to "first 2 chars":
```typescript
it('logs a warning with first 2 chars of submitted key when key is wrong', async () => {
    // ...
    expect(logged.apiKeyPrefix).toBe('ba...');
});
```

#### GREEN
```typescript
apiKeyPrefix: apiKey.substring(0, 2) + '...',
```

---

## Work Stream F: Email from env + store ID consolidation (Findings 9, 10)

### Finding 9: Email address hardcoded in tail worker

**Files:** `workers/error-alerts/src/format.ts`, `workers/error-alerts/src/index.ts`, `workers/error-alerts/src/types.ts`, `workers/error-alerts/wrangler.jsonc`

**Problem:** `pete@verily.org` hardcoded in source code and committed to repo.

**Fix:**
1. Remove `TO_ADDRESS` constant from `format.ts`
2. Add `toAddress` parameter to `buildRawEmail`
3. Add `TO_ADDRESS: string` to `Env` type in `types.ts`
4. Update `sendEmail` function in `index.ts` to use `env.TO_ADDRESS` in `EmailMessage` constructor
5. Pass `env.TO_ADDRESS` to `buildRawEmail` calls in `index.ts`
6. Add `TO_ADDRESS` as a var in `wrangler.jsonc` (NOT a secret — it's not sensitive, just PII we don't want in source code)

**Note on `destination_address` in wrangler.jsonc:** This field is required by Cloudflare's `send_email` binding and acts as a security constraint (Cloudflare only delivers to this address). It cannot be removed. The git history cleanup will scrub it from past commits, but it will reappear in the commit that sets it as a var. This is an acceptable tradeoff — the binding constraint is a Cloudflare infrastructure concern, not application source code.

#### RED
```typescript
it('uses the provided toAddress in To header', () => {
    const raw = buildRawEmail('Test', 'body', 'dest@example.com');
    expect(raw).toContain('To: dest@example.com');
});
```

#### GREEN
```typescript
export function buildRawEmail(subject: string, body: string, toAddress: string): string {
  // ... use toAddress instead of TO_ADDRESS constant
}
```

#### All callers to update in `workers/error-alerts/src/index.ts`
- Line 14: `new EmailMessage(FROM_ADDRESS, TO_ADDRESS, raw)` → `new EmailMessage(FROM_ADDRESS, env.TO_ADDRESS, raw)`
- Line 31: `buildRawEmail(subject, body)` → `buildRawEmail(subject, body, env.TO_ADDRESS)`
- Line 42: `buildRawEmail(subject, body)` (fallback catch) → `buildRawEmail(subject, body, env.TO_ADDRESS)`

#### Tests to update
- `workers/error-alerts/test/format.test.ts:8` — remove `TO_ADDRESS` import, use test values
- `workers/error-alerts/test/format.test.ts:292` — `expect(raw).toContain('To: ${TO_ADDRESS}')` → use test address
- `workers/error-alerts/test/index.test.ts:10` — remove `TO_ADDRESS` import
- `workers/error-alerts/test/index.test.ts:70` — update `EmailMessage` assertion to use `env.TO_ADDRESS` value from mock

### Finding 10: Dual store ID validation sets

**Files:** `src/config.ts`, `src/validation/storeId.ts`

**Fix:** Rename for clarity:
- `config.ts`: `VALID_STORE_IDS` → `ENABLED_STORE_IDS` (active stores)
- `validation/storeId.ts`: `VALID_STORE_IDS` → `KNOWN_STORE_IDS` (all FS locations)

#### All imports to update
- `src/index.ts:34` — imports `VALID_STORE_IDS` from `./config` → `ENABLED_STORE_IDS`
- `src/handlers/scheduled.ts:20` — imports `VALID_STORE_IDS` from `../config` → `ENABLED_STORE_IDS`
- `test/validation/storeId.test.ts:2` — imports `VALID_STORE_IDS` from validation → `KNOWN_STORE_IDS`
- `test/handlers/scheduled.test.ts:142` — references `VALID_STORE_IDS` in test description

### Git history cleanup: remove email address

After the code changes are merged, scrub `pete@verily.org` from git history using `git filter-repo`:

```bash
# Install if needed
brew install git-filter-repo

# Replace the email in all historical commits
git filter-repo --replace-text <(echo 'pete@verily.org==>REDACTED') --force
```

This rewrites history, so it requires a force push. Must be coordinated:
1. Ensure all branches are merged or rebased first
2. All collaborators must re-clone after the rewrite
3. Run from a fresh clone (git filter-repo requires this)

**Note:** The `destination_address` field in `wrangler.jsonc` will still contain the email after git filter-repo runs on old commits. In the new commit (post-fix), it will be set via `vars` in `wrangler.jsonc`. The `destination_address` binding is a Cloudflare infrastructure requirement and will continue to contain the address — this is unavoidable.

**Follow-up (infrastructure):** To permanently resolve PII scanner warnings, create a generic alias (e.g., `ufobeer-alerts@verily.org`) and update both `destination_address` in `wrangler.jsonc` and the Cloudflare Email Routing destination. This is an ops task outside the scope of this plan.

---

## Implementation Order

All work streams are independent. Recommended priority:

1. **A** - Health check leak (5 min, highest visibility)
2. **E** - Sync leak + auth prefix (10 min, two quick fixes)
3. **C** - Client identifier (15 min, rate limit bypass)
4. **D** - CORS tightening (15 min, updates callers — highest risk, most callers)
5. **B** - Rate limit degraded tracking (10 min)
6. **F** - Email env + store ID + git history cleanup (20 min + coordination)

**Cross-cutting dependency:** Work Streams C and D both touch CORS `Allow-Headers`. If parallelized, coordinate the `X-Client-ID` removal.
