---
title: Security hardening across API and tail worker
implemented: 2026-02-27
commit: 2e94cca
tags: [security, cors, rate-limit, auth, error-leaks, email, store-ids]
---

## Problem

Security scan identified six independent findings: error message leaks to clients (health check, sync batch), rate limiting fails open with no tracking, `X-Client-ID` header is client-supplied and spoofable for rate limit bypass, CORS headers sent unconditionally regardless of request origin, API key prefix logged at 4 chars (too much exposure), and destination email address hardcoded in source.

## Decision

**A — Health check error leak**: Catch block now returns generic `'Database connection failed'` message. Added `console.error` for server-side observability (previously not logged at all).

**B — Rate limit degraded tracking**: Added `degraded: boolean` to `RateLimitResult`. Returns `true` on D1 error (fail-open path), `false` on success. Enables callers to detect when rate limiting is bypassed. Existing `console.error` in catch already triggers tail worker alerts.

**C — Client identifier hardening**: Removed `X-Client-ID` from `getClientIdentifier()` — now uses IP only. After auth, `clientIdentifier` is overridden with `apiKeyHash` in `index.ts`. `CF-Connecting-IP` is set by Cloudflare's edge (not spoofable); `X-Forwarded-For` fallback exists only for local dev where `CF-Connecting-IP` is absent. Removed `X-Client-ID` from `Access-Control-Allow-Headers`.

**D — CORS tightening**: `getCorsHeaders()` now requires `requestOrigin` parameter, returns `null` when origin doesn't match `ALLOWED_ORIGIN` or is absent. All call sites in `index.ts` use `corsHeaders ?? {}`. Non-browser clients (mobile app, curl) correctly receive no CORS headers.

**E — Error leaks + auth prefix**: Sync batch errors now return `'Statement N failed'` / `'Database write failed for batch'` (generic). D1 internals logged server-side only. API key prefix in warning logs reduced from 4 to 2 characters.

**F — Email from env**: Removed `pete@verily.org` constant from tail worker source. `buildRawEmail` now takes `toAddress` parameter; `index.ts` reads from `env.TO_ADDRESS`. Added `TO_ADDRESS` to `Env` type and `wrangler.jsonc` vars. Git history scrubbed with `git filter-repo`. The `destination_address` binding in `wrangler.jsonc` (Cloudflare infrastructure requirement) still contains the address — unavoidable.

**F — Store ID naming**: Renamed `VALID_STORE_IDS` → `ENABLED_STORE_IDS` in `config.ts` (active stores) and `KNOWN_STORE_IDS` in `validation/storeId.ts` (all FS locations) to clarify the distinction.

## Trade-offs

- CORS change is a behavior change for non-browser clients: they previously received CORS headers, now they don't. Correct behavior — CORS headers are meaningless without a browser.
- Full in-memory rate limit fallback not implemented — disproportionate for a single-tenant API. `degraded` field is sufficient for detection.
- `destination_address` in `wrangler.jsonc` will reappear in git after filter-repo cleanup. A generic alias (`ufobeer-alerts@verily.org`) would permanently resolve this but is an ops task outside scope.
- C and D both touch `Access-Control-Allow-Headers` — coordinated in the same commit to avoid conflict.
