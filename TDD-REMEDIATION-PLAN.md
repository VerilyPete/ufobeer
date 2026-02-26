# TDD Remediation Plan — UFO Beer API

## Overview

This plan addresses all TDD gaps identified in the ufobeer codebase audit. It is
organized into four waves of work, maximizing parallelism while respecting
dependencies. Each item specifies exact files, specific test cases, and the
change required.

All new test files go under `test/`. All tests run with `vitest` via the unit
config (`vitest.unit.config.mts`, Node pool) unless marked as requiring the
Workers pool (Workers pool tests go in `*.spec.ts` or `*.integration.test.ts`).

Factory functions must be used for every test object. No `let` declarations
or `beforeEach` blocks in any new or modified test file.

---

## Wave 1 — Highest Priority, Fully Independent (all parallel)

### 1.1 Create `test/auth.test.ts`

**Priority:** Critical — security-critical code with zero coverage.
**Source:** `/Users/pete/claude/ufobeer/src/auth.ts`
**New file:** `/Users/pete/claude/ufobeer/test/auth.test.ts`

The module exports five pure or near-pure functions. All use the Web Crypto API
(`crypto.subtle`, `crypto.randomUUID`), which is available in Node 19+ and via
`globalThis.crypto` in the vitest unit pool.

**Functions to test:**

#### `timingSafeCompare(a, b): Promise<boolean>`
- Returns `true` when both strings are identical
- Returns `false` when strings differ by one character
- Returns `false` when strings differ in length (both are hashed to 32 bytes first, so length difference is hidden — result is still `false` but via hash mismatch)
- Returns `true` when both are empty strings
- Returns `false` when one is empty and one is not
- Is consistent: calling it twice with the same inputs gives the same result

#### `hashApiKey(apiKey): Promise<string>`
- Returns a 16-character hex string (8 bytes represented as hex)
- Returns only characters `[0-9a-f]`
- Returns a deterministic hash for the same input
- Returns different hashes for different inputs
- Handles empty string input without throwing
- Handles a long key (256+ chars) without throwing

#### `validateApiKey(request, env, reqCtx): Promise<{ valid, apiKeyHash }>`

Use a factory function:
```typescript
const getMockEnv = (overrides?: Partial<{ API_KEY: string }>): Pick<Env, 'API_KEY'> => ({
  API_KEY: 'test-api-key-secret',
  ...overrides,
});

const getMockReqCtx = (): RequestContext => ({
  requestId: 'req-test-123',
  startTime: Date.now(),
  clientIdentifier: 'test-client',
  apiKeyHash: null,
  clientIp: '127.0.0.1',
  userAgent: 'test-agent',
});
```

Test cases:
- Returns `{ valid: false, apiKeyHash: null }` when `X-API-Key` header is missing
- Returns `{ valid: false, apiKeyHash: null }` when `X-API-Key` does not match `env.API_KEY`
- Returns `{ valid: true, apiKeyHash: <16-char-hex> }` when `X-API-Key` matches `env.API_KEY`
- The `apiKeyHash` on success is a 16-character hex string
- Logs a warning (via `console.warn`) when header is missing
- Logs a warning (via `console.warn`) when key is wrong, including first 4 chars of submitted key
- Does NOT log when key is valid (spy on `console.warn` and verify it is not called)

#### `authorizeAdmin(request, env, _reqCtx): Promise<{ authorized, error? }>`

Factory:
```typescript
const getMockEnvWithAdmin = (overrides?: Partial<{ ADMIN_SECRET?: string }>): Pick<Env, 'ADMIN_SECRET'> => ({
  ADMIN_SECRET: 'admin-secret-value',
  ...overrides,
});
```

Test cases:
- Returns `{ authorized: false, error: 'Admin endpoints not configured' }` when `env.ADMIN_SECRET` is falsy/undefined
- Returns `{ authorized: false, error: 'Missing admin credentials' }` when `X-Admin-Secret` header is absent
- Returns `{ authorized: false, error: 'Invalid admin credentials' }` when `X-Admin-Secret` does not match `env.ADMIN_SECRET`
- Returns `{ authorized: true }` when `X-Admin-Secret` matches `env.ADMIN_SECRET`
- Logs an error (via `console.error`) when `ADMIN_SECRET` is not configured

#### `getClientIp(request): string | null`
- Returns the `CF-Connecting-IP` header value when present
- Returns the `X-Forwarded-For` header value when `CF-Connecting-IP` is absent
- Returns `null` when neither header is present
- Prefers `CF-Connecting-IP` over `X-Forwarded-For` when both are present

#### `getClientIdentifier(request): string`
- Returns `X-Client-ID` header value when present (truncated to 64 chars)
- Returns client IP when `X-Client-ID` is absent but `CF-Connecting-IP` is present
- Returns `'unknown'` when neither `X-Client-ID` nor IP headers are present
- Truncates result to exactly 64 characters when input exceeds 64 characters
- Does not truncate when input is exactly 64 characters
- Does not truncate when input is less than 64 characters

#### `createRequestContext(request): RequestContext`
- Returns an object with `requestId` that is a non-empty string (UUID format)
- Returns an object with `startTime` that is a positive number
- Returns an object with `clientIdentifier` derived from request headers
- Returns an object with `apiKeyHash` set to `null`
- Returns an object with `clientIp` derived from `CF-Connecting-IP` or `X-Forwarded-For`
- Returns an object with `userAgent` from `User-Agent` header
- Returns `null` for `userAgent` when `User-Agent` header is absent

---

### 1.2 Create `test/utils/hash.test.ts`

**Priority:** High — used throughout the pipeline for change detection, zero coverage.
**Source:** `/Users/pete/claude/ufobeer/src/utils/hash.ts`
**New file:** `/Users/pete/claude/ufobeer/test/utils/hash.test.ts`

**Function to test:** `hashDescription(text): Promise<string>`

Test cases:
- Returns a string of exactly 32 characters
- Returns only characters `[0-9a-f]` (lowercase hex)
- Returns a deterministic result: same input always produces same output
- Returns different hashes for different inputs
- Handles an empty string input without throwing
- Handles a very long string (10,000+ characters) without throwing
- The returned hash is always 32 characters regardless of input length
- Two distinct strings that differ by one character produce different hashes
- Note: unlike `hashApiKey` in `auth.ts`, this function takes the first 16 bytes
  (32 hex chars), not 8 bytes. Verify this exact length.

---

### 1.3 Create `test/analytics.test.ts`

**Priority:** High — 490 lines of branching analytics logic with zero coverage.
**Source:** `/Users/pete/claude/ufobeer/src/analytics.ts`
**New file:** `/Users/pete/claude/ufobeer/test/analytics.test.ts`

The analytics module is pure: all exported functions accept an optional
`AnalyticsEngineDataset` and call `writeDataPoint` on it. Inject a mock.

Factory:
```typescript
const getMockAnalytics = () => ({
  writeDataPoint: vi.fn(),
});
```

**Private function coverage (tested via public interface):**

`getStatusCategory` is private but drives `blob4` in all exported functions.
`getErrorType` is private but drives `blob5` in `trackRequest`.
`safeWriteDataPoint` is private but its null-guard and error-catch behavior
must be verified through every public function.

**`trackRequest(analytics, metrics)`**

Factory:
```typescript
const getRequestMetrics = (overrides?: Partial<RequestMetrics>): RequestMetrics => ({
  endpoint: '/beers',
  method: 'GET',
  storeId: '13879',
  statusCode: 200,
  clientId: 'client-abc',
  responseTimeMs: 123,
  ...overrides,
});
```

Test cases:
- Calls `analytics.writeDataPoint` once with the correct shape
- `blob4` is `'2xx'` for status 200
- `blob4` is `'2xx'` for status 201
- `blob4` is `'3xx'` for status 301
- `blob4` is `'4xx'` for status 400
- `blob4` is `'4xx'` for status 429
- `blob4` is `'5xx'` for status 500
- `blob4` is `'5xx'` for status 502
- `blob5` (error_type) is `'success'` for status 200
- `blob5` is `'rate_limit'` for status 429 (when no explicit `errorType`)
- `blob5` is `'auth_fail'` for status 401
- `blob5` is `'upstream_error'` for status 502
- `blob5` is `'client_error'` for status 403 (generic 4xx)
- `blob5` is `'server_error'` for status 503 (generic 5xx)
- `blob5` is the explicit `errorType` value when one is provided, overriding derived type
- `double6` (error_count) is `1` for status 400
- `double6` is `0` for status 200
- `double7` (rate_limit_triggered) is `1` for status 429
- `double7` is `0` for status 200
- `double3` (beers_returned) is `0` when `beersReturned` is undefined
- `double3` is the `beersReturned` value when provided
- `double5` (cache_hit) is `1` when `cacheHit` is `true`
- `double5` is `0` when `cacheHit` is `false` or undefined
- `double8` (upstream_latency_ms) is `0` when `upstreamLatencyMs` is undefined
- `indexes[0]` is `'${clientId}:${endpoint}'`
- `blob3` (store_id) is `''` when `storeId` is undefined
- Does NOT throw when `analytics` is `undefined`
- Does NOT call `writeDataPoint` when `analytics` is `undefined`
- Does NOT throw when `writeDataPoint` throws (error is caught and logged)

**`trackEnrichment(analytics, metrics)`**

Factory:
```typescript
const getEnrichmentMetrics = (overrides?: Partial<EnrichmentMetrics>): EnrichmentMetrics => ({
  beerId: 'beer-123',
  source: 'perplexity',
  success: true,
  durationMs: 450,
  ...overrides,
});
```

Test cases:
- Calls `writeDataPoint` once with correct shape
- `blob4` is `'2xx'` when `success` is `true`
- `blob4` is `'5xx'` when `success` is `false`
- `blob5` is `'success'` when `success` is `true`
- `blob5` is `'enrichment_fail'` when `success` is `false`
- `blob8` (enrichment_source) is `'perplexity'` when source is `'perplexity'`
- `blob8` is `'cache'` when source is `'cache'`
- `double5` (cache_hit) is `1` when source is `'cache'`
- `double5` is `0` when source is `'perplexity'`
- `double6` (error_count) is `0` when `success` is `true`
- `double6` is `1` when `success` is `false`
- `indexes[0]` is `'enrichment:perplexity'` or `'enrichment:cache'`
- Does NOT throw when `analytics` is `undefined`

**`trackCron(analytics, metrics)`**

Factory:
```typescript
const getCronMetrics = (overrides?: Partial<CronMetrics>): CronMetrics => ({
  beersQueued: 10,
  dailyRemaining: 490,
  monthlyRemaining: 1990,
  durationMs: 2000,
  success: true,
  ...overrides,
});
```

Test cases:
- Calls `writeDataPoint` once with correct shape
- `blob5` is the `errorType` value when `errorType` is provided (error takes precedence)
- `blob5` is `'skip:kill_switch'` when `skipReason` is `'kill_switch'`
- `blob5` is `'skip:daily_limit'` when `skipReason` is `'daily_limit'`
- `blob5` is `'skip:monthly_limit'` when `skipReason` is `'monthly_limit'`
- `blob5` is `'skip:no_beers'` when `skipReason` is `'no_beers'`
- `blob5` is `'success'` when success is `true` and no errorType or skipReason
- `blob5` is `'cron_error'` when success is `false` and no errorType or skipReason
- `errorType` in `blob5` takes precedence over `skipReason` when both are present
- `double9` (daily_remaining) is the `dailyRemaining` value
- `double10` (monthly_remaining) is the `monthlyRemaining` value
- `double4` (beers_queued / enrichment_count) is the `beersQueued` value
- `indexes[0]` starts with `'cron:'`
- Does NOT throw when `analytics` is `undefined`

**`trackRateLimit(analytics, clientId, endpoint)`**

Test cases:
- Calls `writeDataPoint` once
- `blob5` is `'rate_limit'`
- `blob4` is `'4xx'`
- `double7` (rate_limit_triggered) is `1`
- `double6` (error_count) is `1`
- `indexes[0]` is `'ratelimit:${clientId}'`
- `blob1` (endpoint) is the provided endpoint string
- Does NOT throw when `analytics` is `undefined`

**`trackAdminDlq(analytics, metrics)`**

Factory:
```typescript
const getAdminDlqMetrics = (overrides?: Partial<AdminDlqMetrics>): AdminDlqMetrics => ({
  operation: 'dlq_list',
  success: true,
  messageCount: 5,
  durationMs: 100,
  ...overrides,
});
```

Test cases:
- `blob2` (method) is `'GET'` for `dlq_list` and `dlq_stats` operations
- `blob2` is `'POST'` for `dlq_replay` and `dlq_acknowledge` operations
- `blob4` is `'2xx'` when `success` is `true`
- `blob4` is `'5xx'` when `success` is `false`
- `blob5` is `'success'` when `success` is `true` and no `errorType`
- `blob5` is `'admin_error'` when `success` is `false` and no `errorType`
- `blob5` is the explicit `errorType` when provided
- `double4` (message_count via enrichment_count slot) is the `messageCount` value
- `indexes[0]` is `'admin:${operation}'`
- Does NOT throw when `analytics` is `undefined`

**`trackDlqConsumer(analytics, metrics)`**

Factory:
```typescript
const getDlqConsumerMetrics = (overrides?: Partial<DlqConsumerMetrics>): DlqConsumerMetrics => ({
  beerId: 'beer-abc',
  attempts: 3,
  sourceQueue: 'beer-enrichment',
  success: true,
  durationMs: 50,
  ...overrides,
});
```

Test cases:
- `blob4` is `'2xx'` when `success` is `true`
- `blob4` is `'5xx'` when `success` is `false`
- `blob5` is `'success'` when `success` is `true` and no `errorType`
- `blob5` is `'dlq_store_error'` when `success` is `false` and no `errorType`
- `blob5` is the explicit `errorType` when provided
- `double4` (attempt count via enrichment_count slot) is the `attempts` value
- `indexes[0]` is `'dlq_consumer:${sourceQueue}'`
- Does NOT throw when `analytics` is `undefined`

**`trackAdminTrigger(analytics, metrics)`**

Factory:
```typescript
const getAdminTriggerMetrics = (overrides?: Partial<AdminTriggerMetrics>): AdminTriggerMetrics => ({
  beersQueued: 25,
  dailyRemaining: 475,
  monthlyRemaining: 1975,
  durationMs: 300,
  success: true,
  ...overrides,
});
```

Test cases:
- `blob5` is the `errorType` when provided (error takes precedence)
- `blob5` is `'skip:kill_switch'` when `skipReason` is `'kill_switch'`
- `blob5` is `'skip:daily_limit'` when `skipReason` is `'daily_limit'`
- `blob5` is `'skip:monthly_limit'` when `skipReason` is `'monthly_limit'`
- `blob5` is `'skip:no_eligible_beers'` when `skipReason` is `'no_eligible_beers'`
- `blob5` is `'success'` when success is `true` and no errorType or skipReason
- `blob5` is `'trigger_error'` when success is `false` and no errorType or skipReason
- `double9` is the `dailyRemaining` value
- `double10` is the `monthlyRemaining` value
- `double4` is the `beersQueued` value
- `indexes[0]` is `'admin:enrich_trigger'`
- Does NOT throw when `analytics` is `undefined`

**`trackCleanupTrigger(analytics, metrics)`**

Factory:
```typescript
const getCleanupTriggerMetrics = (overrides?: Partial<CleanupTriggerMetrics>): CleanupTriggerMetrics => ({
  action: 'cleanup_trigger',
  mode: 'missing',
  beersQueued: 10,
  beersSkipped: 2,
  beersReset: 0,
  durationMs: 150,
  dryRun: false,
  ...overrides,
});
```

Test cases:
- `indexes[0]` is `'execute'` when `dryRun` is `false`
- `indexes[0]` is `'dry_run'` when `dryRun` is `true`
- `blob1` is the `action` value
- `blob2` is the `mode` value
- `double1` is the `beersQueued` value
- `double2` is the `beersSkipped` value
- `double3` is the `beersReset` value
- `double4` is the `durationMs` value
- Does NOT throw when `analytics` is `undefined`

---

### 1.4 Create `test/audit.test.ts`

**Priority:** Medium — audit logging is used on every request, zero coverage.
**Source:** `/Users/pete/claude/ufobeer/src/audit.ts`
**New file:** `/Users/pete/claude/ufobeer/test/audit.test.ts`

Factory:
```typescript
const getMockDb = () => ({
  prepare: vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      run: vi.fn().mockResolvedValue(undefined),
    }),
  }),
});

const getMockCtx = (overrides?: Partial<RequestContext>): RequestContext => ({
  requestId: 'req-audit-test',
  startTime: Date.now() - 100,
  clientIdentifier: 'test-client',
  apiKeyHash: 'abc123',
  clientIp: '1.2.3.4',
  userAgent: 'TestAgent/1.0',
  ...overrides,
});
```

**`writeAuditLog(db, ctx, method, path, statusCode, error?)`**

Test cases:
- Calls `db.prepare().bind().run()` once on a normal request
- The SQL contains `INSERT INTO audit_log`
- The bound values include `ctx.requestId`
- The bound values include `ctx.startTime`
- The bound values include the provided `method`
- The bound values include the provided `path`
- The bound values include the provided `statusCode`
- The bound values include `null` for `error` when no error is provided
- The bound values include the `error` string when provided
- `responseTimeMs` passed to bind is non-negative (calculated from `Date.now() - ctx.startTime`)
- Does NOT throw when `db.prepare().bind().run()` rejects — error is caught and logged
- When `Math.random() < 0.001` (spy on Math.random): calls `prepare` a second time with a `DELETE FROM audit_log` statement
- When `Math.random() >= 0.001`: does NOT call `prepare` a second time

**`writeAdminAuditLog(db, ctx, operation, details, adminSecretHash)`**

Test cases:
- Calls `db.prepare().bind().run()` once
- The SQL contains `INSERT INTO audit_log`
- The bound method value is `'ADMIN'`
- The bound path value is the `operation` string
- The `api_key_hash` slot contains the `adminSecretHash`
- The `error` slot contains `JSON.stringify(details)`
- Does NOT throw when `db.prepare().bind().run()` rejects

---

### 1.5 Create `test/context.test.ts`

**Priority:** Medium — shared infrastructure functions used on every request.
**Source:** `/Users/pete/claude/ufobeer/src/context.ts`
**New file:** `/Users/pete/claude/ufobeer/test/context.test.ts`

Factory:
```typescript
const getMockEnv = (overrides?: Partial<Env>): Env => ({
  ALLOWED_ORIGIN: 'https://ufobeer.app',
  DB: {} as D1Database,
  ...overrides,
} as Env);
```

**`getCorsHeaders(env)`**

Test cases:
- Returns an object with `Access-Control-Allow-Origin` set to `env.ALLOWED_ORIGIN`
- Returns an object with `Access-Control-Allow-Methods` containing `GET`
- Returns an object with `Access-Control-Allow-Methods` containing `POST`
- Returns an object with `Access-Control-Allow-Headers` containing `X-API-Key`
- Returns `null` when `env.ALLOWED_ORIGIN` is falsy (empty string or undefined)
- Logs an error (via `console.error`) when `ALLOWED_ORIGIN` is not configured

**`errorResponse(message, code, options)`**

Test cases:
- Returns a `Response` object
- Response body JSON contains `success: false`
- Response body JSON contains `error.message` equal to the provided message
- Response body JSON contains `error.code` equal to the provided code
- Response body JSON contains `requestId` from `options.requestId`
- Response status is `400` when `options.status` is not provided (default)
- Response status is the provided `options.status` when specified
- Response body JSON contains extra fields from `options.extra` when provided

---

### 1.6 Create `test/config.test.ts`

**Priority:** Medium — blocklist logic filters beers in the enrichment trigger.
**Source:** `/Users/pete/claude/ufobeer/src/config.ts`
**New file:** `/Users/pete/claude/ufobeer/test/config.test.ts`

**`shouldSkipEnrichment(brewName)`**

Test cases:
- Returns `true` for exact blocklist match `'Black Velvet'`
- Returns `true` for exact blocklist match `'Texas Flight'`
- Returns `true` for exact blocklist match `'Michelada'`
- Returns `true` for exact blocklist match `'Build Your Flight'`
- Returns `true` for brew name containing `'flight'` (case-insensitive): `'Sour Flight'`
- Returns `true` for brew name containing `'FLIGHT'` (uppercase): `'HOP HEAD FLIGHT 2025'`
- Returns `true` for brew name containing `'Flight'` (mixed case): `'Fall Favorites Flight SL 2025'`
- Returns `true` for brew name containing `'root beer'` (case-insensitive): `'Old Fashion Root Beer'`
- Returns `true` for brew name containing `'Root Beer'`
- Returns `true` for brew name containing `'beer and cheese'` (case-insensitive)
- Returns `false` for a normal beer name: `'Sierra Nevada Pale Ale'`
- Returns `false` for `'Budweiser'`
- Returns `false` for an empty string (no match in blocklist or patterns)
- Returns `false` for a brew name that contains `'light'` but not `'flight'`
- Returns `false` for `'Dealership IPA'` (does not match `"Dealer's Choice Flight"` exactly, and no pattern match)

Note: `"Dealer's Choice Flight"` exact match AND matches `\bflight\b` pattern — both should return `true`.

---

## Wave 2 — Fix Existing Test Anti-Patterns (fully parallel)

These modify existing test files. Each task is independent of the others.

### 2.1 Fix `test/rate-limit.test.ts` — Remove SQL string assertions

**File to modify:** `/Users/pete/claude/ufobeer/test/rate-limit.test.ts`

The `checkRateLimit` describe block contains tests that assert on exact SQL
strings, which is implementation-focused testing. Specifically:

**Lines to remove (implementation assertions):**

1. The test `'should use correct SQL upsert pattern'` (around lines 160–174):
   - Asserts that `db.prepare` was called with a string containing
     `'INSERT INTO rate_limits'`, `'ON CONFLICT'`, and `'RETURNING request_count'`
   - DELETE this entire test. The SQL is an implementation detail; the behavior
     (rate limiting works correctly) is already tested by adjacent tests.

2. The test `'should use atomic upsert pattern in SQL'` (around lines 575–587):
   - Asserts that the SQL call contains `'INSERT INTO rate_limits'`,
     `'ON CONFLICT'`, `'DO UPDATE SET request_count = request_count + 1'`, and
     `'RETURNING'`
   - DELETE this entire test. Same reason: the concurrent-safety concern is a
     design property, not a behavior that tests should assert.

3. The test `'should bind client identifier and minute bucket correctly'` (around
   lines 176–187):
   - This test has a legitimate behavioral concern (correct values are bound) but
     asserts on the internal `bind()` call implementation detail. REPLACE it with
     a behavior test:
   - New test: `'should use a different rate limit bucket when the minute changes'`
   - Verifies that two calls at different minutes produce different `allowed`/`remaining`
     results when the underlying mock returns different counts for each call —
     this tests the bucketing behavior without asserting on SQL internals.

4. The test `'should cleanup records older than 60 minutes'` (around lines 465–479):
   - Asserts on `mockDb.bind.mock.calls` to verify the cleanup threshold.
   - REPLACE with a behavior test: verify that when cleanup runs (random < 0.01),
     the overall result of `checkRateLimit` is still correct (allowed, correct remaining).
   - The specific threshold is an implementation detail; remove the `toHaveBeenNthCalledWith`
     assertion.

5. The tests `'should trigger cleanup when random value is below 0.01'` and
   `'should not trigger cleanup when random value is 0.01 or above'` (around
   lines 431–463):
   - These assert on `prepare.mock.calls.length` and specific SQL strings in the
     second `prepare` call.
   - These are borderline: asserting that cleanup IS triggered (second DB call
     happens) is a behavioral concern. However, asserting on the exact SQL in
     that second call is implementation detail.
   - KEEP the assertion that `prepare` is called twice (cleanup occurs).
   - REMOVE the assertion on the specific SQL string content of the second call.

Additionally, fix the `let`/`beforeEach` anti-pattern:
- The `describe('checkRateLimit')` block uses `let mockDb` + `beforeEach`.
- REPLACE with a factory function:
  ```typescript
  const createMockDb = () => { ... }
  ```
  and call `createMockDb()` at the top of each `it` block that needs it.
- REMOVE the `let mockDb` declaration and the `beforeEach` block.
- Also REMOVE `afterEach(() => vi.restoreAllMocks())` — each test should call
  `vi.restoreAllMocks()` after the assertion, or better, restructure tests so
  spies are created inside the `it` block and don't need global cleanup.

---

### 2.2 Fix `test/handlers/beers.list.test.ts` — Remove `let`/`beforeEach`

**File to modify:** `/Users/pete/claude/ufobeer/test/handlers/beers.list.test.ts`

The file uses `beforeEach` to reset mock state. Replace with factory functions.
Each test that needs a fresh mock should create it via a factory at the top of
the `it` block. The `vi.mock()` module-level mocks remain (they are not
`let`/`beforeEach`).

Specific changes:
- Find every `let` declaration and `beforeEach(() => { ... })` in the file.
- For each `let foo`, convert to a factory `const getFoo = () => ...` and call
  it at the start of each `it` block that uses `foo`.
- For each `beforeEach` that resets mocks, move those resets inside individual
  test bodies where needed.

---

### 2.3 Fix remaining test files using `let`/`beforeEach`

The audit identified 6 files total using the anti-pattern. Files 2.1 and 2.2
cover two of them. Identify and fix the remaining four:

Run a search for `beforeEach` across all test files:
```
test/handle-fallback-batch.test.ts
test/handlers/beers.list.test.ts (covered in 2.2)
test/rate-limit.test.ts (covered in 2.1)
```

For each file that contains `let` declarations or `beforeEach` blocks:
1. Replace each `let varName: Type` with a factory function `const getVarName = (): Type => ({ ... })`
2. Replace `beforeEach(() => { varName = createSomething(); })` by calling the factory at the top of each `it` block
3. If `beforeEach` contains only `vi.clearAllMocks()` or `vi.restoreAllMocks()`,
   evaluate whether individual test isolation already handles this and remove the
   `beforeEach` block

Note to implementor: Run a search before starting:
```
grep -rn "beforeEach\|^  let " test/ --include="*.ts"
```
and fix every occurrence not already covered by tasks 2.1 and 2.2.

---

### 2.4 Consolidate duplicate `withTimeout` tests

**Files involved:**
- `/Users/pete/claude/ufobeer/test/cleanupHelpers.test.ts` — contains a full
  `describe('withTimeout', ...)` block at lines 23–53
- `/Users/pete/claude/ufobeer/test/queue/cleanupHelpers-timeout.test.ts` — a
  separate file that also fully tests `withTimeout`

The behavior cases overlap almost completely. One file should own `withTimeout`
tests; the other should not duplicate them.

**Decision:** Keep the tests in `test/cleanupHelpers.test.ts` (it is the
primary test file for that module). Delete `test/queue/cleanupHelpers-timeout.test.ts`.

If there are any test cases in `cleanupHelpers-timeout.test.ts` NOT covered in
`cleanupHelpers.test.ts`, move them into `cleanupHelpers.test.ts` first, then
delete the file.

Cases in `cleanupHelpers-timeout.test.ts` not in `cleanupHelpers.test.ts`:
- `'clears the timer on success (no lingering timers)'` with `toHaveBeenCalledOnce()`
  (the other file uses `toHaveBeenCalled()`) — the `Once` variant is slightly
  stricter; adopt it in `cleanupHelpers.test.ts`
- `'preserves the resolved value type'` for numeric `42` — add this case to
  `cleanupHelpers.test.ts`

After verifying coverage equivalence, delete
`/Users/pete/claude/ufobeer/test/queue/cleanupHelpers-timeout.test.ts`.

---

## Wave 3 — New Tests for Untested Handlers (parallel after Wave 1)

These handlers have no tests and depend on the DB/queue/analytics infrastructure.
New tests use the unit vitest pool and mock all I/O.

### 3.1 Create `test/handlers/health.test.ts`

**Source:** `/Users/pete/claude/ufobeer/src/handlers/health.ts`
**New file:** `/Users/pete/claude/ufobeer/test/handlers/health.test.ts`

**Exported function:** `handleHealthCheck(env): Promise<Response>`

Factory:
```typescript
const getMockDb = (overrides?: {
  selectOneResult?: unknown;
  dailyResult?: { request_count: number } | null;
  monthlyResult?: { total: number } | null;
}) => {
  const defaults = {
    selectOneResult: { '1': 1 },
    dailyResult: { request_count: 42 },
    monthlyResult: { total: 150 },
  };
  const merged = { ...defaults, ...overrides };
  // Returns a mock that sequences responses for the three DB calls
  // (SELECT 1, enrichment_limits daily, enrichment_limits monthly)
  ...
};

const getMockEnv = (overrides?: Partial<Env>): Env => ({
  DB: getMockDb(),
  DAILY_ENRICHMENT_LIMIT: '500',
  MONTHLY_ENRICHMENT_LIMIT: '2000',
  ENRICHMENT_ENABLED: 'true',
  ...overrides,
} as Env);
```

Test cases:
- Returns a `Response` with status `200` on DB success
- Response body JSON has `status: 'ok'`
- Response body JSON has `database: 'connected'`
- Response body JSON has `enrichment.enabled: true` when `ENRICHMENT_ENABLED` is not `'false'`
- Response body JSON has `enrichment.enabled: false` when `ENRICHMENT_ENABLED` is `'false'`
- Response body JSON has `enrichment.daily.used` matching the DB result
- Response body JSON has `enrichment.daily.limit` matching `parseInt(env.DAILY_ENRICHMENT_LIMIT)`
- Response body JSON has `enrichment.daily.remaining` as `limit - used` (floored at 0)
- Response body JSON has `enrichment.monthly.used` matching the DB result
- Response body JSON has `enrichment.monthly.remaining` as `limit - used` (floored at 0)
- `daily.remaining` is `0` when `used` exceeds `limit` (not negative)
- Uses default daily limit of `500` when `DAILY_ENRICHMENT_LIMIT` is not set
- Uses default monthly limit of `2000` when `MONTHLY_ENRICHMENT_LIMIT` is not set
- Returns `503` when the initial `SELECT 1` DB call throws
- Response body JSON has `status: 'error'` on DB failure
- Response body JSON has `database: 'disconnected'` on DB failure
- Response body JSON has `error` containing the error message on DB failure
- When the `enrichment_limits` queries throw (table might not exist), still returns
  `200` with `daily.used: 0` and `monthly.used: 0` (graceful degradation)

---

### 3.2 Create `test/queue/dlq.test.ts`

**Source:** `/Users/pete/claude/ufobeer/src/queue/dlq.ts`
**New file:** `/Users/pete/claude/ufobeer/test/queue/dlq.test.ts`

This file has four exported functions. Two (`handleDlqBatch` and
`handleCleanupDlqBatch`) orchestrate over queue messages. One (`storeDlqMessage`)
writes to D1. One (`storeCleanupDlqMessage`) is private but reachable via
`handleCleanupDlqBatch`.

Factory for a mock queue message:
```typescript
const getMockMessage = (overrides?: Partial<{
  id: string;
  body: Partial<EnrichmentMessage>;
  attempts: number;
}>) => ({
  id: overrides?.id ?? 'msg-abc-123',
  body: {
    beerId: 'beer-001',
    beerName: 'Test IPA',
    brewer: 'Test Brewery',
    ...overrides?.body,
  },
  attempts: overrides?.attempts ?? 3,
  ack: vi.fn(),
  retry: vi.fn(),
});
```

Factory for mock D1:
```typescript
const getMockDb = (runResult = {}) => ({
  prepare: vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      run: vi.fn().mockResolvedValue(runResult),
    }),
  }),
});
```

**`storeDlqMessage(db, message, sourceQueue)`**

Test cases:
- Calls `db.prepare().bind().run()` once
- The SQL contains `INSERT INTO dlq_messages`
- The SQL contains `ON CONFLICT(message_id) DO UPDATE`
- The bound values include `message.id`
- The bound values include `message.body.beerId`
- The bound values include `message.body.beerName`
- The bound values include `message.body.brewer`
- The bound values include `message.attempts`
- The bound values include the `sourceQueue` string
- The bound values include `JSON.stringify(message.body)` as `raw_message`
- The initial status bound is `'pending'`
- Uses `null` for `beerName` when `body.beerName` is not provided
- Uses `null` for `brewer` when `body.brewer` is not provided

**`handleDlqBatch(batch, env, requestId)`**

Factory for mock batch:
```typescript
const getMockBatch = (messages: ReturnType<typeof getMockMessage>[], queue = 'beer-enrichment-dlq') => ({
  messages,
  queue,
});
```

Test cases:
- Calls `storeDlqMessage` (mocked) for each message in the batch
- Calls `message.ack()` on each message after successful storage
- Does NOT call `message.retry()` on successful storage
- Calls `trackDlqConsumer` (mocked) with `success: true` after successful storage
- When `storeDlqMessage` throws for a specific message: calls `message.retry()` for that message
- When `storeDlqMessage` throws: does NOT call `message.ack()` for that message
- When `storeDlqMessage` throws: calls `trackDlqConsumer` with `success: false`
- Processes all messages in the batch even if one fails (continues the loop)
- The `sourceQueue` passed to `trackDlqConsumer` is `'beer-enrichment'` (not the DLQ name)

**`handleCleanupDlqBatch(batch, env, requestId)`**

Test cases (mirror the above for cleanup messages):
- Calls storage for each message in batch
- Calls `message.ack()` on success
- Calls `message.retry()` on failure
- Calls `trackDlqConsumer` with `sourceQueue: 'description-cleanup'` on success
- Calls `trackDlqConsumer` with `success: false` on failure

**`truncateForLog` (private — test via observable behavior)**

The function is called internally. Its behavior is observable when storage
errors are logged. Write one indirect test:
- When a message body is very long (> 500 chars), the error log truncates it to
  500 chars plus `'... [truncated]'` — verify via `console.error` spy.

---

### 3.3 Create `test/handlers/dlq.handler.test.ts`

**Source:** `/Users/pete/claude/ufobeer/src/handlers/dlq.ts`
**New file:** `/Users/pete/claude/ufobeer/test/handlers/dlq.handler.test.ts`

This handler file is complex. Focus on the behaviors most at risk of regression.

Shared factories:
```typescript
const getMockEnv = (dbOverrides?: Partial<D1Database>): Env => ({
  DB: { prepare: vi.fn(), ...dbOverrides } as unknown as D1Database,
  ENRICHMENT_QUEUE: { send: vi.fn().mockResolvedValue(undefined), sendBatch: vi.fn() } as unknown as Queue,
} as Env);

const getMockReqCtx = (): RequestContext => ({
  requestId: 'dlq-test-req-123',
  startTime: Date.now(),
  clientIdentifier: 'admin-client',
  apiKeyHash: 'admin-hash',
  clientIp: '10.0.0.1',
  userAgent: 'AdminClient/1.0',
});
```

**`handleDlqList`**

Test cases:
- Returns a `Response` with status `200` on success
- Response body has `success: true`
- Response body has `data.messages` as an array
- Response body has `data.total_count`
- Response body has `data.has_more`
- Does NOT include `raw_message` in message objects by default (when `include_raw` is not `'true'`)
- Includes `raw_message` in message objects when `include_raw=true` query param is set
- Returns status `400` when cursor param is malformed (invalid base64 that doesn't parse as `{ id, failed_at }`)
- Returns status `500` when DB throws
- Defaults to `status=pending` filter when no `status` param provided
- Accepts `status=all` to remove status filter

**`handleDlqReplay`**

Test cases:
- Returns `200` with `replayed_count > 0` when messages are found and queued successfully
- The optimistic status update sets status to `'replaying'` before queue send
- On successful queue send, sets status to `'replayed'` and increments `replay_count`
- On queue send failure, rolls back status to `'pending'`
- Returns `200` with `replayed_count: 0` and message when no pending messages found for given IDs
- Limits batch to 50 IDs even if more are provided in request body
- Returns `400` when request body fails schema validation (missing `ids` array)
- Returns `500` when DB throws unexpectedly
- Skips corrupt DLQ rows (where `raw_message` fails schema validation) — includes those IDs in `failed_count`

**`handleDlqAcknowledge`**

Test cases:
- Returns `200` with `acknowledged_count` on success
- Only acknowledges messages with status `'pending'` (the UPDATE has `AND status = 'pending'`)
- Limits to 100 IDs even if more are provided
- Returns `400` when `ids` array is missing from request body
- Returns `500` when DB throws

**`cleanupOldDlqMessages`**

Test cases:
- Calls delete for `'acknowledged'` messages older than 30 days
- Calls delete for `'replayed'` messages older than 30 days
- Loops if a batch deletes exactly `batchLimit` records (continues deleting)
- Stops looping when a batch deletes fewer than `batchLimit` records

---

### 3.4 Create `test/handlers/enrichment.handler.test.ts`

**Source:** `/Users/pete/claude/ufobeer/src/handlers/enrichment.ts`
**New file:** `/Users/pete/claude/ufobeer/test/handlers/enrichment.handler.test.ts`

**`validateForceEnrichmentRequest(body)`**

Test cases:
- Returns `{ valid: false, errorCode: 'INVALID_BODY' }` when `body` is `null`
- Returns `{ valid: false, errorCode: 'INVALID_BODY' }` when `body` is `undefined`
- Returns `{ valid: false, errorCode: 'INVALID_BODY' }` when `body` is a string
- Returns `{ valid: false, errorCode: 'INVALID_BODY' }` when `body` is a number
- Returns `{ valid: true }` when `body` is `{}`
- Returns `{ valid: true }` when `body` has valid `beer_ids: ['abc', 'def']`
- Returns `{ valid: true }` when `body` has valid `criteria.confidence_below: 0.5`
- Returns `{ valid: false }` with an `error` and `errorCode` when `body` has invalid fields
  (e.g., `confidence_below` is negative or > 1)

**`handleEnrichmentTrigger(request, env, headers, reqCtx)`**

Factory:
```typescript
const getEnrichmentEnv = (overrides?: Partial<Env>): Env => ({
  DB: buildMockDb(/* defaults */),
  ENRICHMENT_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) } as unknown as Queue,
  DAILY_ENRICHMENT_LIMIT: '500',
  MONTHLY_ENRICHMENT_LIMIT: '2000',
  ENRICHMENT_ENABLED: 'true',
  ...overrides,
} as Env);
```

Test cases:
- Returns `200` with `data.beers_queued: 0` and `data.skip_reason: 'kill_switch'`
  when `ENRICHMENT_ENABLED === 'false'`
- Returns `200` with `data.skip_reason: 'monthly_limit'` when monthly usage >= limit
- Returns `200` with `data.skip_reason: 'daily_limit'` when daily remaining <= 0
- Returns `200` with `data.skip_reason: 'no_eligible_beers'` when query returns 0 beers
- Returns `200` with `data.skip_reason: 'no_eligible_beers'` when all returned beers
  are on the blocklist (e.g., all are `'Texas Flight'`)
- Returns `200` with `data.beers_queued > 0` when eligible beers are found and queued
- Calls `ENRICHMENT_QUEUE.sendBatch` when beers are queued
- Does NOT call `ENRICHMENT_QUEUE.sendBatch` when skip_reason is set
- Returns `503` when DB is unavailable for quota check
- Returns `400` when request body fails schema validation
- Respects `limit` param: clamps to max 100
- Response `data.quota.daily.remaining` is calculated correctly
- Response `data.enabled` is `true` when `ENRICHMENT_ENABLED` is not `'false'`

---

## Wave 4 — Cross-Cutting Improvements (after Wave 2 + 3)

### 4.1 Verify constants.ts has no test gaps

**Source:** `/Users/pete/claude/ufobeer/src/constants.ts`

The constants file only exports numeric values. These are tested indirectly
through the modules that use them (audit.ts, cleanupHelpers.ts). No dedicated
test file is needed, but verify the `cleanupHelpers.test.ts` test that checks:
```typescript
expect(AI_TIMEOUT_MS).toBe(10_000);
expect(SLOW_THRESHOLD_MS).toBe(5000);
```
This pattern (testing exported constant values) is acceptable — add similar
checks for the constants from `src/constants.ts` in a `test/constants.test.ts`
file:

**New file:** `/Users/pete/claude/ufobeer/test/constants.test.ts`

Test cases:
- `MIN_CLEANUP_LENGTH_RATIO` is `0.7`
- `MAX_CLEANUP_LENGTH_RATIO` is `1.1`
- `ABV_CONFIDENCE_FROM_DESCRIPTION` is `0.9`
- `ABV_CONFIDENCE_FROM_PERPLEXITY` is `0.7`
- `MAX_BEER_ABV` is `70`
- `MIN_BEER_ABV` is `0`
- `AUDIT_CLEANUP_PROBABILITY` is `0.001`
- `AUDIT_RETENTION_DAYS` is `30`
- `D1_MAX_PARAMS_PER_STATEMENT` is `90`
- `D1_MAX_STATEMENTS_PER_BATCH` is `100`

This documents intent and catches inadvertent changes.

---

### 4.2 Add missing edge-case tests to `test/rate-limit.test.ts`

After completing Wave 2.1 (removing SQL assertions and fixing the factory
pattern), add the following missing edge-case test to `checkRateLimit`:

**Missing boundary:** The existing cleanup logic tests verify cleanup is NOT
triggered for rejected requests (when `count > limit`). But there is no test
verifying the cleanup threshold value (`minuteBucket - 60`) is correct. Add:

- `'should clean up records from more than 60 minutes ago'`:
  - Mock `Math.random()` to return `0.001` (triggers cleanup)
  - Mock `Date.now()` to return a known timestamp
  - Verify the second DB call happens (cleanup runs)
  - Verify the final result of `checkRateLimit` is still correct
  - Do NOT assert on the SQL or bind arguments (behavior only)

---

## Implementation Notes

### Test file location conventions
```
test/auth.test.ts                          # Wave 1.1
test/utils/hash.test.ts                    # Wave 1.2
test/analytics.test.ts                     # Wave 1.3
test/audit.test.ts                         # Wave 1.4
test/context.test.ts                       # Wave 1.5
test/config.test.ts                        # Wave 1.6
test/rate-limit.test.ts                    # Wave 2.1 (modify)
test/handlers/beers.list.test.ts           # Wave 2.2 (modify)
[other files with beforeEach]              # Wave 2.3 (modify)
test/queue/cleanupHelpers-timeout.test.ts  # Wave 2.4 (DELETE)
test/handlers/health.test.ts               # Wave 3.1
test/queue/dlq.test.ts                     # Wave 3.2
test/handlers/dlq.handler.test.ts          # Wave 3.3
test/handlers/enrichment.handler.test.ts   # Wave 3.4
test/constants.test.ts                     # Wave 4.1
```

### Factory function template

All factories follow this pattern:
```typescript
const getFoo = (overrides?: Partial<Foo>): Foo => ({
  field1: 'default-value',
  field2: 42,
  ...overrides,
});
```

Never use `let` + `beforeEach`. Create the factory, call it inside the `it` block.

### Mocking the Web Crypto API

`auth.ts` and `utils/hash.ts` use `crypto.subtle.digest` and
`crypto.subtle.timingSafeEqual`. In the vitest unit pool (Node), these are
available via `globalThis.crypto`. No mocking required — use the real
implementation. This is correct because:
- The behavior being tested IS the cryptographic correctness
- The Web Crypto API is available in both Node 19+ and Cloudflare Workers

### Running tests during implementation

Use the unit config for all files in this plan:
```bash
npm run test:unit
```

The Workers pool config (`vitest.config.mts`) is only needed for integration
tests that require actual Worker environment bindings.

### TypeScript strict mode

All new test files must compile under strict mode. Use real imported types
from `../../src/types` rather than redefining them. Use `Partial<T>` in
factory overrides. Never use `any` — use `unknown` if the type is truly unknown,
then narrow with type guards.

---

## Summary of All Changes

| Wave | Task | Action | File |
|------|------|--------|------|
| 1 | 1.1 | CREATE | `test/auth.test.ts` |
| 1 | 1.2 | CREATE | `test/utils/hash.test.ts` |
| 1 | 1.3 | CREATE | `test/analytics.test.ts` |
| 1 | 1.4 | CREATE | `test/audit.test.ts` |
| 1 | 1.5 | CREATE | `test/context.test.ts` |
| 1 | 1.6 | CREATE | `test/config.test.ts` |
| 2 | 2.1 | MODIFY | `test/rate-limit.test.ts` |
| 2 | 2.2 | MODIFY | `test/handlers/beers.list.test.ts` |
| 2 | 2.3 | MODIFY | up to 4 additional files with `beforeEach` |
| 2 | 2.4 | DELETE | `test/queue/cleanupHelpers-timeout.test.ts` |
| 3 | 3.1 | CREATE | `test/handlers/health.test.ts` |
| 3 | 3.2 | CREATE | `test/queue/dlq.test.ts` |
| 3 | 3.3 | CREATE | `test/handlers/dlq.handler.test.ts` |
| 3 | 3.4 | CREATE | `test/handlers/enrichment.handler.test.ts` |
| 4 | 4.1 | CREATE | `test/constants.test.ts` |
| 4 | 4.2 | MODIFY | `test/rate-limit.test.ts` (additive) |
