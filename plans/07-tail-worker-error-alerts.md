# Tail Worker Error Alerting via Email

## Status: Complete ✓

Deployed and verified end-to-end on 2026-02-27. 47 tests across 4 files.

## Context

Errors in Cloudflare observability go unnoticed because there are no alerts. The main UFO Beer worker logs errors beautifully, but nobody sees them until they manually check the dashboard. A Tail Worker monitors every invocation and emails us when something goes wrong.

## Prerequisites

- **Email Routing enabled** on `ufobeer.app` zone (adds MX + SPF records automatically)
- **At least one routing rule** configured (even a catch-all) — without this, `send_email` rejects with "destination address is not a verified address"
- **`pete@verily.org` verified** as destination address in Email Routing → Destination Addresses

## Architecture

A **separate Cloudflare Worker** (`ufobeer-error-alerts`) with a `tail()` handler. The main worker references it via `tail_consumers`. The tail worker uses Cloudflare's native `send_email` binding to email `pete@verily.org` from `alerts@ufobeer.app`. No runtime dependencies — email MIME is hand-built RFC 5322.

```
Main Worker (ufobeer)
  └── tail_consumers → ufobeer-error-alerts
                          ├── filter: is this an error?
                          ├── cooldown: in-memory 5-min dedup
                          ├── format: build readable email
                          └── send: send_email binding → pete@verily.org
```

## Directory Structure

```
workers/error-alerts/
├── src/
│   ├── index.ts        # tail() handler
│   ├── filter.ts       # isErrorTrace / filterErrorTraces
│   ├── format.ts       # buildSubject / buildBody / buildRawEmail
│   ├── cooldown.ts     # in-memory rate limiting
│   └── types.ts        # Env type
├── test/
│   ├── filter.test.ts    (9 tests)
│   ├── format.test.ts    (23 tests)
│   ├── cooldown.test.ts  (8 tests)
│   └── index.test.ts     (7 tests)
├── package.json
├── tsconfig.json
├── vitest.config.mts
├── worker-configuration.d.ts
└── wrangler.jsonc
```

## Error Detection (`filter.ts`)

Uses an allowlist of known-benign outcomes (unknown future outcomes default to error):

```typescript
const NON_ERROR_OUTCOMES = new Set(['ok', 'canceled', 'responseStreamDisconnected']);
```

A trace is an error if ANY of:
- outcome is NOT in the non-error set (covers `exception`, `exceededCpu`, `exceededMemory`, unknown outcomes)
- `exceptions.length > 0` (even if outcome is `ok`)
- Any log with `level === 'error'`

Excluded: `canceled` (client disconnect) and `responseStreamDisconnected` (stream hangup) — normal in production.

## Rate Limiting / Cooldown (`cooldown.ts`)

In-memory cooldown prevents email floods during error bursts. Module-level `Map` state persists across invocations within the same isolate.

- 5-minute cooldown window (`COOLDOWN_MS`)
- Keyed by error fingerprint: `${outcome}:${firstExceptionName || 'error-logs'}`
- `getSuppressedCount` is a destructive read (resets after access) — suppressed count included in next email that sends
- If isolate recycles, cooldown resets — acceptable tradeoff

## Email Format (`format.ts`)

### Subject (`buildSubject`)
- Fetch events: `[UFO Beer] exception — GET /beers?sid=13`
- Queue events: `[UFO Beer] exception — queue: beer-enrichment`
- Cron events: `[UFO Beer] exception — scheduled`
- Unknown events: `[UFO Beer] exception`

### Body (`buildBody`)
Plain text, one email per `tail()` invocation. Each trace formatted as:

```
Worker: ufobeer
Outcome: exception
Time: 2026-02-27T14:30:00Z
Request: GET https://api.ufobeer.app/beers?sid=13

--- Exceptions ---
TypeError: Cannot read property 'results' of undefined

--- Error Logs ---
[14:30:00] Unhandled fetch error TypeError: Cannot read property...

CPU: 12ms | Wall: 450ms
```

- Multiple traces separated by `========` divider, capped at 10 per email (`MAX_TRACES_PER_EMAIL`)
- Appends "... and N more errors omitted" when batch exceeds cap
- Notes `[logs truncated]` when `trace.truncated` is true
- Prepends suppressed count when > 0
- Non-string log messages handled via `JSON.stringify` with `[unserializable]` fallback
- Sections (Exceptions, Error Logs) omitted when empty
- Uses `trace.scriptName` (fallback `'unknown'`)

### Raw Email (`buildRawEmail`)
Hand-built RFC 5322 (no runtime dependencies):
- `\r\n` line endings throughout, `\r\n\r\n` header/body separator
- Required headers: From, To, Date, Subject, Message-ID, MIME-Version, Content-Type
- **Message-ID is required** — Cloudflare's `send_email` rejects without it (undocumented)

## Handler (`index.ts`)

Orchestrates filter → cooldown → format → send with two levels of error handling:

1. **Inner try/catch** around `SEND_EMAIL.send()` — logs failure but doesn't throw
2. **Outer try/catch** around entire handler — sends a fallback "failed to process N trace(s)" email when filter/format itself throws; if even the fallback fails, logs and swallows

## Deployment

**Critical ordering**: the tail worker MUST exist before the main worker references it via `tail_consumers`. Deploying with a reference to a non-existent tail worker fails.

```bash
# 1. Deploy tail worker first
cd workers/error-alerts && npm install && npx wrangler deploy

# 2. Then redeploy main worker (has tail_consumers in wrangler.jsonc)
cd ../.. && npx wrangler deploy
```

CI/CD integration is a follow-up — the tail worker changes rarely and has no migrations.

## Testing Approach

Plain vitest (no `@cloudflare/vitest-pool-workers`). The tail worker has no D1/KV/queues — just pure functions and a mocked `send_email` binding. Tests run fast with no Cloudflare auth.

- `cloudflare:email` mocked via `vi.mock` in handler tests
- Filter, format, and cooldown tests are pure — no mocks needed
- Module-level cooldown state reset via `resetForTesting()` in `beforeEach`

## Decisions Made During Implementation

| Decision | Rationale |
|----------|-----------|
| Hand-built RFC 5322 instead of `mimetext` | Zero runtime deps; only ~10 lines of header assembly |
| Allowlist (`NON_ERROR_OUTCOMES`) instead of `outcome !== 'ok'` | Unknown future outcomes default to alerting (safe default) |
| `Message-ID` header added | Cloudflare `send_email` rejects without it — undocumented requirement discovered during testing |
| Email Routing catch-all rule required | Without at least one routing rule, `send_email` fails with "destination address is not a verified address" even when address is verified |
| `cooldownKey` from first error trace only | One email per `tail()` invocation; first error trace represents the batch |
| `getSuppressedCount` is destructive read | Count resets on access — matches the use case of including it in the next outgoing email |
