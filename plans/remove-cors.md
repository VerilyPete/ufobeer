# Plan: remove CORS from the API

## Why

The API's supported application client is the native iOS app. Monitoring (UptimeRobot) calls the unauthenticated `/health`. The website (`ufobeer.app`, the `ufobeer-site` Worker) never calls the API from a browser, and it couldn't do so safely: the API key can't live in a web page. No supported browser consumer exists.

The 2026-09-01 security review (`plans/cloudflare-security-review-2026-09-01.md:479`) says: "If the API is native-mobile-only, remove unused CORS support rather than widening the rule." Its acceptance criterion (line 600): "CORS is removed and the absence of browser clients is documented. Invalid or high-volume OPTIONS requests create no D1 audit rows."

## Evidence (2026-11-10)

- **Edge blocks preflights.** A live `OPTIONS /beers` preflight from `https://ufobeer.app` got a **Cloudflare-edge 403**, as the security review also observed. The edge mechanism (a WAF rule, bot control or similar) is unconfirmed. This change doesn't depend on it.
- **Authenticated routes need a preflight.** They require `X-API-Key`, which isn't a CORS-safelisted header. While the edge blocks preflights, a browser can't make those calls cross-origin.
- **Unauthenticated routes are simple requests.** `/health` and `/livez` take a simple GET with no preflight. They return no CORS headers today, so a browser can't read their responses cross-origin, and that doesn't change.
- **The grant is still sent.** A live keyed `GET /beers` with `Origin: https://ufobeer.app` returns `Access-Control-Allow-Origin: https://ufobeer.app`.
- **Missing config breaks every authenticated route.** Without `ALLOWED_ORIGIN`, they return 500 "Server misconfigured" (`src/index.ts:276`).
- **No browser has used the API.** The D1 `audit_log` over the 30-day window in `plans/api-subdomain-cutover.md` (Phase 0) shows no browser client ever making a successful authenticated call. That log doesn't record a successful `/health`, so it's no evidence about monitoring traffic.

## Behaviour after the change

1. **No CORS headers.** No response carries any `Access-Control-*` header, whatever `Origin` the request sends.
2. **OPTIONS is refused.** `OPTIONS` on any path, unknown paths included, gets 403 (see the decision below). The response has no body, carries `Cache-Control: no-store` and the shared security headers, and keeps today's properties of the OPTIONS path:
   - outside the try/catch;
   - before the D1-backed pre-auth rate limiter;
   - no `respond()`, so no D1 audit row and no auth;
   - `trackRequest` still called, so Analytics Engine still sees it.
3. **No `ALLOWED_ORIGIN`.** It no longer exists. An env without it serves authenticated routes normally, and the "Server misconfigured" 500 is gone.
4. **Nothing else changes:**
   - auth;
   - rate limits and their `X-RateLimit-*`/`Retry-After` headers;
   - ETag/304 and `Cache-Control`;
   - `X-Request-ID`;
   - audit logging;
   - error bodies;
   - `/health` and `/livez`, including their 405s.

### Decision: OPTIONS gets 403 (Pete, 2026-11-10)

This is a deliberate blanket refusal, not a "method not supported" response. It matches the edge's answer today and the Worker's current answer to an invalid preflight. A 405 would need an `Allow` header listing each route's methods, kept in sync with the router. That isn't worth it for a method no supported client sends.

Out of scope: the edge mechanism that blocks OPTIONS stays as it is. The `workers/error-alerts` Worker has no HTTP handler or CORS config, so it needs no change.

## Code touched

- `src/context.ts`: delete `getCorsHeaders()` and its section. Fix the module header comment.
- `src/constants.ts`: delete `CORS_PREFLIGHT_ROUTES`, `CORS_ALLOWED_REQUEST_HEADERS` and their section.
- `src/index.ts`:
  - delete `isPreflightHeadersAllowed()` and the `corsHeaders` variable;
  - delete the 500 check (`:275–278`);
  - replace the preflight validation with the refusal;
  - change each `...(corsHeaders ?? {})` / `corsHeaders ?? {}` (about 28 sites) to the remaining headers or `{}`;
  - stop the catch-block 500 computing CORS (`:736–742`).

  Handlers already take a generic `headers` parameter, so no handler signature changes.
- `src/types.ts`: drop `ALLOWED_ORIGIN` from `Env`.
- `wrangler.jsonc`: drop `vars.ALLOWED_ORIGIN`. Regenerate `worker-configuration.d.ts` with `npx wrangler types`.
  - The binding diff must be exactly the `ALLOWED_ORIGIN` removal (`Env`, and the `ProcessEnv` pick list).
  - Regeneration can also churn the runtime-types section, and the bindings today already omit `USAGE_ENABLED`. Commit runtime churn only if it comes with the repo's normal generation. If unrelated churn appears, put it in a separate commit, or revert it and hand-edit only the binding lines.
- `AGENTS.md`:
  - drop the `ALLOWED_ORIGIN` line (`:156`);
  - change `context.ts # Request context and CORS` (`:40`);
  - add one line stating the client contract: the API has no browser clients and sends no CORS headers; the native app is the only application client, and monitoring uses `/health`.
- Plans:
  - `plans/cloudflare-security-review-2026-09-01*.md`: mark the preflight item resolved.
  - `plans/cache-research-api.md:9,79`: mark the CORS lines historical.
  - `plans/archive/`: leave it untouched.

## TDD sequence

Each slice goes RED, then GREEN, then a refactor check. **Every new test of changed behaviour must fail against the current code for the intended reason before production code changes.** Tests that only pin preserved behaviour can pass from the start: bare and unknown-path OPTIONS, and the neutral-header passthrough. The suite stays green between slices.

### Slice 1: no CORS anywhere, and OPTIONS refused (one slice)

This is one slice because the preflight branch is the last consumer of `getCorsHeaders()`. Removing the headers first would break it.

1. **Router test that preserves headers.** In `test/index.test.ts`, the `handleBeerList` mock (`:74`) returns a fixed response that ignores the headers it's given, so asserting "no CORS header" on it passes today. Add a test that proves the dispatcher no longer passes CORS headers to handlers. For a keyed `GET /beers` with `Origin: https://ufobeer.app`, either:
   - assert the `headers` argument the handler mock received has no `Access-Control-*` key; or
   - have the mock echo its supplied headers into the response.

   This fails today.
2. **Worker-level absence tests.** Each sends `Origin: https://ufobeer.app` and asserts no `Access-Control-*` header on these responses:
   - a pre-auth 429;
   - an unknown-route 404;
   - a rate-limiter-degraded 503;
   - the catch-block 500 (replacing `:205–238`);
   - a keyed `/beers` 304.

   Each also asserts the other headers are unchanged: `X-RateLimit-*`, `Retry-After`, `ETag`, `Cache-Control`, `X-Request-ID`.
3. **OPTIONS tests** (replacing the preflight block at about `:355–470`). Each sends `OPTIONS` and asserts 403, no `Access-Control-*` headers, `Cache-Control: no-store`, and no body:
   - a full preflight from the old origin;
   - a preflight with no `Origin`;
   - a bare `OPTIONS`;
   - `OPTIONS` on an unknown path;
   - `OPTIONS /admin/dlq`.
4. **New OPTIONS isolation test:** D1 throws on any call. `OPTIONS` still returns 403 with zero D1 calls, zero auth calls and no audit write, and `trackRequest` is still called. Keep the existing repeated-OPTIONS no-audit test.
5. **`test/handlers/beers.list.test.ts:2392`.** This handler-level 304 passthrough test feeds in an `Access-Control-Allow-Origin` header, so it doesn't test CORS policy. Change its input to a neutral header such as `X-Test-Passthrough` and keep the passthrough assertion. Worker-level CORS absence on a 304 is covered in step 2.
6. **GREEN:**
   - delete `getCorsHeaders`, the preflight constants and helper, and every spread;
   - replace the OPTIONS branch;
   - drop the catch-block CORS.
7. **Delete the tests that only covered removed code:**
   - the `getCorsHeaders` cases in `test/context.test.ts`;
   - the CORS constant cases in `test/constants.test.ts`.

   List each deleted test in the PR description.

### Slice 2: no `ALLOWED_ORIGIN`

1. **RED.** Add a test: an env with no `ALLOWED_ORIGIN` serves keyed `GET /beers` with 200. Today it returns 500.
2. **GREEN.** Delete the check, the `Env` field and the var. Regenerate the types.
3. Remove `ALLOWED_ORIGIN` / `allowedOrigin` from the mock envs in its three test files: `test/context.test.ts`, `test/index.test.ts` and `test/services/perplexity.test.ts`. `test/type-checks/interface-to-type.test.ts` changes only if typecheck needs it.

### Slice 3: docs

As listed under Code touched.

## Verification

Run each command and record its output:

- **Tests:** `npx vitest run`.
  - The count changes by exactly the tests added, minus the ones listed as deleted.
  - Changed tests touch only CORS and OPTIONS assertions, plus the passthrough input change.
- **Types:** `npm run typecheck`, `npm run typecheck:test` and `npm run typecheck:contract`.
- **Contract:** `npm run test:contract`, the Golden Taproom and usage-report contracts. They must pass unchanged.
- **Error-alerts Worker:** its existing CI test (`npm test --prefix workers/error-alerts -- run`).
- **Deploy check:** `npx wrangler deploy --dry-run`.
- **Search:** `git grep -n -i "cors\|ALLOWED_ORIGIN\|Access-Control" -- src wrangler.jsonc test AGENTS.md`. The only allowed matches are:
  - the new OPTIONS comment;
  - the AGENTS.md client-contract line;
  - test names and assertions about absence.

  `worker-configuration.d.ts` is checked separately: no `ALLOWED_ORIGIN`, and its runtime-library CORS docs are expected.

After the CI deploy:
- Record the deploy run, the version ID and the merge commit.
- Keyed `GET https://api.ufobeer.app/beers?sid=13879` with `Origin: https://ufobeer.app` returns 200 with no `Access-Control-*` header of any kind. `ETag`, `Cache-Control`, `X-Request-ID` and `X-RateLimit-*` are still present.
- `If-None-Match` with that ETag returns 304.
- `/health` returns 200.
- Keyless `/beers` gets the edge 403.
- Pete confirms build 89 still enriches the taplist.

## Rollback

Revert the PR and let CI deploy. Then check:
- the deployed version ID changed;
- keyed `GET /beers` with `Origin: https://ufobeer.app` returns 200 with `Access-Control-Allow-Origin: https://ufobeer.app`;
- `/health` returns 200, and `If-None-Match` returns 304.

## Risks

- **Low client risk.** No supported client depends on CORS, and the one preflight probed died at the edge.
- **Unrelated header changes.** The main risk is a missed spread, or a test change hiding an unrelated header change. The header assertions in slice 1, the contract tests, and a diff review of every changed header set cover it.
