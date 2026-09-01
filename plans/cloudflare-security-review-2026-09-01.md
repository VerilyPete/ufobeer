# Cloudflare Security Review

**Date:** 2026-09-01
**Revised:** 2026-09-01 (panel review — factual corrections, two new findings, resequenced remediation)

**Scope:** BeerSelector mobile app, `ufobeer` Cloudflare Worker, error-alert Tail Worker, Wrangler configuration, deployment workflows, and observable behavior of `api.ufobeer.app`

**Review type:** Read-only source and public-edge assessment

**Cloudflare entitlement assumption:** Workers Paid is enabled, while the zone and other Cloudflare security products remain on the Free tier. Recommendations must not depend on Enterprise WAF fields, paid API Shield enforcement, or other paid-zone features unless an entitlement change is explicitly approved. The Free-tier rule capacities are now stated as hard numbers in "Medium: rate limiting performs D1 writes before authentication" — several earlier recommendations assumed more capacity than the Free plan provides.

## Executive summary

The project has a good security baseline: both Workers disable their public `workers.dev` hostnames, Worker secrets are kept out of tracked environment files, credential comparisons are timing-safe, CORS uses an exact origin, D1 queries are parameterized, store IDs are allowlisted, outbound calls have timeouts, rate-limit failures fail closed, and the primary queue consumers route terminal failures to dead-letter queues.

The most important remaining risks are:

1. The mobile application's API key is embedded in the distributed app and therefore cannot provide meaningful authentication.
2. `/beers/sync` accepts client-asserted data for existing beer IDs, and asynchronous cleanup results are applied by ID without binding them to the source description version. An extracted key can therefore poison trusted beer metadata and AI-derived fields, not merely consume quota.
3. Beer descriptions are concatenated unescaped into the Workers AI cleanup prompt, and the model's output is persisted and served after only two heuristic checks. This is a prompt-injection path that survives the provenance fixes recommended for risk 2.
4. Request and upstream response bodies are materialized before strict byte, item-count, and string-length limits are applied, creating a memory and cost-amplification risk.
5. The mobile login WebView harvests Flying Saucer session cookies and acts on `postMessage` data without validating the message origin.

The shared mobile key also creates an availability problem: every installation is placed in the same authenticated rate-limit bucket. Anyone who extracts the key can consume that bucket, force upstream refreshes, submit unique beer records that reach D1 and Queues, or target existing IDs with attacker-selected metadata. Queue work can later consume the bounded Workers AI or Perplexity quotas and, for records that have not already been cleaned, persist attacker-influenced cleaned descriptions or ABV data.

Several remediations change active mobile contracts. **Public caching, the `/beers/sync` canonical-field restriction, removal of `/beers/sync`, and splitting the health endpoint** must therefore be delivered as a staged cross-repository migration rather than independent Worker changes. Every other Phase 0 and Phase 1 item below is annotated with its client impact so shippable work can be separated from work that needs an app release.

## Existing strengths

- `workers_dev` is disabled for both the API Worker and Tail Worker.
- The public API uses a verified custom domain.
- API and admin credentials use timing-safe comparisons.
- Authentication and rate-limiter misconfiguration fail closed.
- CORS reflects only the single configured origin.
- SQL values are bound through prepared statements.
- Public store IDs are checked against an explicit allowlist.
- Outbound Flying Saucer and Perplexity requests have timeouts.
- A pre-authentication per-IP rate limiter runs before auth, audit logging, and handler D1 queries (`src/index.ts:131`), at `PRE_AUTH_RPM = 30` (`wrangler.jsonc:81`).
- Primary enrichment and cleanup consumers have retry limits and dead-letter queues.
- Local `.env` and `.dev.vars` files are ignored; only examples are tracked.
- CI includes secret scanning.
- Deployment and backup already use separate Cloudflare API tokens (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_BACKUP_API_TOKEN`, the latter documented as scoped to `D1:Edit` + `Workers R2 Storage:Edit`).
- `contract-golden-taproom.yml:9` already declares explicit workflow `permissions:`.
- An `enriched_beers.description_hash` column already exists, is computed at `src/handlers/beers.ts:730-732`, and is used for change detection at `src/db/helpers.ts:203-208`.
- Client error responses generally avoid exposing exception details.

Three items previously listed as "strengths" were actually findings and have been moved into the findings list below: the DLQ consumers have no further dead-letter destination, successful Worker-handled OPTIONS requests schedule an audit write, and specialized admin audit rows hardcode status 200.

## Findings and recommendations

### High: the mobile API key is a public identifier, not a secret

The mobile app reads `EXPO_PUBLIC_ENRICHMENT_API_KEY` in `BeerSelector/src/config/config.ts:345` and sends it as `X-API-Key` in `BeerSelector/src/services/enrichmentService.ts:348-349`. Expo public variables are embedded in the shipped bundle and can be recovered from an installed application.

The Worker treats that key as its authentication boundary in `src/index.ts`. After authentication, the API key hash replaces the client identifier (`src/index.ts:178-186`), which puts every legitimate installation—and anyone who extracts the key—into the same 60 RPM bucket.

#### Impact

- The key can be copied and used outside the app.
- One abusive client can exhaust the authenticated rate limit for all users.
- The copied key reaches endpoints that can generate D1, Queue, Workers AI, Perplexity, and upstream API work.
- Rotating the key breaks older app versions while they continue to depend on it.

Note that for a **single-IP** attacker the binding constraint is the pre-auth per-IP limiter at 30 RPM, not the shared 60 RPM bucket. The shared-bucket concern is real for distributed abuse and for denying service to legitimate users, not for the simplest single-source case.

#### Recommended changes

1. Decide and document the authorization matrix before changing routes: public reads, client writes, human administration, and automation should have separate identities and budgets.
2. Treat `GET /beers` as public cached data only after removing credential-dependent and per-request fields from the cacheable representation.
3. Restrict `fresh=true` immediately to cron or admin callers. A normal mobile credential should not be able to bypass the cache. **Verified zero client impact:** `fresh` does not appear as a query parameter anywhere in `BeerSelector/src/` as of 2026-09-01; the only taplist call is `?sid=${storeId}` (`enrichmentService.ts:342`).
4. Remove `/beers/sync` only through a coordinated mobile migration. The current mobile client calls it for beers missing from batch enrichment and polls for the resulting work (`dataUpdateService.ts:321,330`).
5. If client-originated writes remain necessary, use short-lived, scoped tokens. **See the Phase 2 non-goals list before committing to this** — for a public beer taplist whose spend is already capped, a full attestation-backed token issuer is likely disproportionate. If it is pursued: Apple App Attest or Google Play Integrity may raise the cost of token issuance abuse, but neither proves a human identity or prevents token farming. The token issuer must include challenge nonces, replay protection, audience and route scopes, short expiry, signing-key rotation, revocation, and platform/version fallback policy.
   - Rate-limit and apply a globally durable issuance/cost budget at the token issuer itself.
   - Define what principal or device the token subject represents and how concurrent issuance is bounded.
6. Version the affected API or support old and new authorization schemes during a measured compatibility window. Track old-client traffic before retiring the shared key.
7. Rotate the current shared key only after released app versions no longer require it.

### High: `/beers/sync` permits trusted-record and asynchronous result poisoning

The sync endpoint accepts a caller-supplied beer ID, name, brewer, and description. On an existing ID, its upsert updates `last_seen_at`, `brew_name`, and `brewer` (`src/handlers/beers.ts:741-744`). If the existing record has not been cleaned and is outside the queue cooldown, the caller-supplied description, name, and brewer are also placed directly on the cleanup queue (`beers.ts:748-760`).

The cleanup consumer later writes `brew_description_cleaned`, ABV, confidence, enrichment source, and status using only the beer ID. `CleanupMessage` (`src/types.ts:68-73`) carries no authoritative source version or description hash, and every terminal `UPDATE` (`src/queue/cleanup.ts:550,570,598,613,730,741`) keys on `WHERE id = ?` alone. A malicious message—or a legitimate message that became stale while queued—can therefore overwrite newer or authoritative state.

#### Impact

- A caller with the extractable app key can overwrite the displayed name or brewer for known IDs.
- Attacker-selected descriptions can influence Workers AI cleanup and persisted ABV values for records that have not already been cleaned.
- A stale cleanup result can overwrite state after the upstream description changes.
- Queue retries and replays can reapply obsolete results because completion is not bound to the input version.

#### Recommended changes

1. Prefer removing client-authored beer metadata. If the client must report missing enrichment, accept only an ID or refresh request and obtain canonical name, brewer, and description from the authoritative Flying Saucer response on the server. **This is a breaking client change** — see the sequencing note below.
2. Until that migration is complete, do not allow the mobile credential to update existing canonical fields. Separate caller observations from trusted taplist records if observations must be retained.
3. Include the authoritative description hash or record version in every cleanup/enrichment message.
4. Apply results with an optimistic condition such as `WHERE id = ? AND description_hash = ?`; treat a mismatch as a stale result, acknowledge it without writing, and enqueue current work only when appropriate.
   - **Prerequisite:** the `description_hash` column already exists but the sync upsert's `ON CONFLICT DO UPDATE` clause (`beers.ts:741-744`) sets only `last_seen_at`, `brew_name`, `brewer` — it does **not** refresh `description_hash`, whereas `insertPlaceholders` does (`src/db/helpers.ts:404`). A naive `WHERE ... AND description_hash = ?` would compare against a column the sync path leaves stale for existing IDs. Fix the upsert as part of this change.
5. Apply the same version check to DLQ replay and fallback paths.
6. Test targeted existing IDs, attacker-chosen metadata, upstream changes while work is queued, duplicate delivery, delayed retry, and replay of an obsolete DLQ message.

**Sequencing:** recommendations 3-5 are server-only and ship independently. Recommendation 1-2 changes the sync contract: under recommendation 1 a beer absent from the Flying Saucer response can no longer be created, so the shipped client's `syncBeersToWorker` → `pollForEnrichmentUpdates` loop never resolves. Split accordingly in the remediation plan.

### High: attacker-controlled text reaches the Workers AI prompt unescaped, and model output is trusted on the way out

`CLEANUP_PROMPT` (`src/queue/cleanup.ts:44-73`) is a delimiter-based instruction block ending in `<TEXT>\n`, and the prompt is assembled as `CLEANUP_PROMPT + original + '\n</TEXT>'` (`src/queue/cleanup.ts:256`). The description is concatenated raw — nothing escapes, strips, or re-encodes a literal `</TEXT>` followed by fresh instructions.

Output validation is two heuristics only (`cleanDescriptionSafely`, `src/queue/cleanup.ts:283-300`): ABV extraction must not regress, and `cleaned.length / original.length` must sit within `MIN_/MAX_CLEANUP_LENGTH_RATIO`. Neither constrains content, and **neither is a barrier to an attacker who controls the input**:

- The length ratio divides by `original`, which the attacker also supplies, so the denominator can be sized to make any desired output pass.
- The ABV guard fires only when `originalAbv !== null`. A description containing **no** ABV, plus an injection that makes the model emit a chosen one, passes both checks.

The output is then persisted and served: `extractABV(cleaned)` sets the stored ABV, and `src/handlers/beers.ts:216` serves `enrichment?.brew_description_cleaned ?? beer.brew_description` to every app client.

The same shape exists on the paid path: `src/services/perplexity.ts:43-44` interpolates `beerName` and `brewer` directly into the Perplexity prompt — exactly the fields `/beers/sync` can overwrite on existing IDs.

Secondary: every failure path in `cleanDescriptionSafely` returns `{ cleaned: original, usedOriginal: true }`, so on AI failure the raw unsanitized description (HTML included) becomes the served "cleaned" value.

#### Why the provenance fixes do not cover this

The `/beers/sync` finding addresses *where the description came from*. This finding is about *what the description can do once it is in a prompt*. After that migration descriptions come from Flying Saucer instead — still third-party, still concatenated unescaped, still trusted on the way out. Hash-binding a stale-result check does nothing about a prompt the authoritative description itself controls.

#### Recommended changes

- Treat every LLM input as hostile regardless of provenance. Escape, strip, or re-encode the closing delimiter sequence before assembly.
- Bound description length before prompt assembly rather than relying on the post-hoc ratio check.
- Validate model output content — not just its length and ABV-extractability — before persisting or serving it.
- Do not derive a persisted ABV from model output when the source text contained none.
- Apply the same treatment to the Perplexity prompt's `beerName` and `brewer` interpolation.

### High: inbound bodies are not bounded before JSON parsing

`BatchLookupRequestSchema`, `SyncBeersRequestOuterSchema`, and the admin ID-list schemas do not cap their array sizes (`src/schemas/request.ts:4,19,23,28`). `/beers/sync` parses the complete JSON document and only then slices the beer array to 50 items (`beers.ts:656` then `:672`); DLQ replay has the same pattern (`src/handlers/dlq.ts:304` then `:314`). Admin enrichment and cleanup triggers also parse JSON and must use the same body guard. No `Content-Length` or inbound `Content-Type` guard exists anywhere in `src/`.

Cloudflare request body limits depend on the **account plan**, not the Workers plan: 100 MB on Free and Pro, 200 MB on Business, 500 MB on Enterprise. Workers have a 128 MB memory limit. Application-level limits therefore need to be substantially lower than Cloudflare's platform maximum.

`wrangler.jsonc` also sets `"limits": { "cpu_ms": 60000 }` — the platform maximum. This is the multiplier that makes each oversized-body request maximally expensive rather than self-terminating. Lower it to the measured requirement.

#### Impact

- A caller with the extractable app key can submit a very large JSON body.
- `request.json()` must materialize and parse the complete body before the application discards excess items.
- Large arrays also add Zod validation and garbage-collection work.

#### Recommended changes

1. Derive a byte limit from the complete UTF-8 wire contract and leave explicit operational headroom. Do not assume 128 KB is sufficient: 50 descriptions of 2,000 characters plus names, JSON overhead, and multibyte UTF-8 can exceed it. A 256–512 KB limit is a more plausible starting point, but it must be validated with contract fixtures. **Record the chosen number as a named constant in `src/constants.ts`** alongside the fixture that justifies it — several acceptance criteria below refer to "the documented byte limit" and it must exist somewhere concrete.
2. Reject requests with an excessive `Content-Length` before parsing.
3. Use a shared bounded streaming body reader so chunked requests or dishonest `Content-Length` values cannot bypass the limit.
4. Require `Content-Type: application/json` for JSON endpoints. Return 415 for unsupported media types, 413 for oversized bodies, and 400 for malformed JSON rather than allowing parse failures to become 500 responses.
5. Apply the guard to every body-bearing route, including admin enrichment and cleanup triggers.
6. Add explicit schema limits and reject excess input rather than silently slicing it:
   - `/beers/batch`: at most 100 IDs, with a maximum ID length (elements of `ids` are currently unbounded, `request.ts:4`).
   - `/beers/sync`: at most 50 beers in the outer schema.
   - Admin replay and acknowledge requests: a bounded number of IDs.
   - Bound `brewer` (`request.ts:10`, currently unbounded) and every other currently unbounded string. `id` (≤50), `brew_name` (≤200), and `brew_description` (≤2000) are already bounded.
   - Add an **upper** bound to `delay_seconds`. Negative values are already rejected — `request.ts:24` is `z.number().int().min(0).optional().default(0)`.
   - Unknown object properties are currently **stripped** on request schemas (Zod `z.object` default) but `FlyingSaucerBeerSchema` is explicitly `.passthrough()` (`src/schemas/external.ts:19`). Decide whether each should reject instead, and test that behavior.
7. Lower `limits.cpu_ms` from 60000 to the measured requirement.
8. A Cloudflare **custom rule** matching on `Content-Length` is feasible on the Free plan (5 custom rules available) and does not consume the single rate-limiting rule. It remains an optional early-rejection optimization, bypassable by chunked or dishonest requests, and does not replace the Worker byte guard. The reliable `http.request.body.size` rules field requires Enterprise and must not be an acceptance dependency.
9. API Shield schema enforcement is not part of the current Free-tier design. Reconsider it only if the account entitlement changes. Even then, treat it as supplementary because schema inspection limits do not replace the Worker byte guard.

References:

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare API Shield schema validation](https://developers.cloudflare.com/api-shield/security/schema-validation/)
- [Cloudflare `http.request.body.size` field](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/http.request.body.size/)

Required tests should cover declared and absent `Content-Length`, chunked transfer, a dishonest short length, UTF-8 multibyte expansion, exact boundary values, every JSON route, and stable 400/413/415 response contracts.

### High: costly cache bypass and sync behavior is available to normal app callers

*(Promoted from Medium — this is the finding that spends real money and is exploitable today.)*

Any caller with the shared key can set `fresh=true` on `GET /beers` (`src/index.ts:242`, honored at `beers.ts:358`), bypassing the Worker-maintained taplist cache. `/beers/sync` permits up to 50 beers per request (`src/types.ts:333`) and 10 requests per minute (`types.ts:337`). Repeated existing IDs are partially deduplicated by cleanup status and a 24-hour requeue cooldown, but they can still overwrite canonical metadata and, where cleanup remains eligible, enqueue attacker-selected content. An attacker can also continually submit unique IDs, producing D1 writes and cleanup queue messages. Those records can later become eligible for quota-bounded Perplexity work.

The risk should be tracked by operation rather than described as one undifferentiated downstream cost:

| Input pattern | Immediate work | Existing bound | Remaining concern |
| --- | --- | --- | --- |
| Repeated `fresh=true` | Flying Saucer fetch, D1 cache/enrichment work | 30 RPM per IP (pre-auth); 60 RPM shared (post-auth) | Upstream and D1 availability; legitimate clients share the authenticated bucket, so distributed abuse denies them service |
| Targeted existing sync IDs | Canonical metadata updates; possible cleanup/AI work | Sync 10 RPM; cleanup cooldown | Trusted-record poisoning, stale result overwrite, prompt injection, write amplification, shared quota exhaustion |
| Continually unique sync IDs | D1 inserts and cleanup queue production | 50 items/request; 10 RPM | Up to 500 attacker-selected records/minute before stronger global budgets |
| Queue consumption | Workers AI or Perplexity work | Daily/monthly consumer quotas | Attacker can consume the legitimate daily budget even where spend is capped |

#### Recommended changes

- Remove public control over `fresh`; use scheduled refreshes or an Access-protected admin operation. **Zero client impact** (verified above).
- Add a separate, globally durable, much smaller cost budget for queue-producing endpoints.
- Preserve the existing beer-ID/cooldown checks, but do not treat them as integrity controls. Accept canonical metadata only from the authoritative source, and bind queue work and result writes to its description hash or record version.
- Alert on unexpected cache-bypass, queue-production, Workers AI, and Perplexity volumes.
- Consider account-level spending notifications or kill switches for paid downstream services.

### Medium-high: the mobile login WebView acts on page-supplied messages without validating their origin

The Flying Saucer login flow runs in a `WebView` (`BeerSelector/components/LoginWebView.tsx:281-324`) with `javaScriptEnabled`, `domStorageEnabled`, `sharedCookiesEnabled`, `thirdPartyCookiesEnabled`, `incognito={false}`, and `cacheMode="LOAD_CACHE_ELSE_NETWORK"`. Injected JS reads `document.cookie` — the user's live Flying Saucer session credentials — and posts it over the React Native bridge (`LoginWebView.tsx:122-141`, `:168-187`; the visitor variant also posts `rawCookies` verbatim). Credentials then land in SecureStore via `src/api/sessionManager.ts:168-180`.

`handleLoginMessage` (`BeerSelector/src/api/loginMessageHandler.ts:98-120`) does `JSON.parse(raw)` on page-originated data with **no origin check**, then dispatches on `data.type` and feeds the page-supplied `data.url` into `injectUrlVerification(data.url)` and `injectPageSpecificJavaScript(data.url)`. The gate on cookie harvesting is a **substring** match on that page-asserted URL — `url.includes('member-dash.php')` / `url.includes('visitor.php')` (`LoginWebView.tsx:102`, `:154`) — not an origin check, so `https://host/x?q=member-dash.php` matches.

`injectUrlVerification` does inject a `window.location.href === url` check (`LoginWebView.tsx:213`), but that check runs *in the page* and the page also sends the `URL_VERIFIED` reply. The app never records that it issued a challenge, so a hostile page can post `URL_VERIFIED` directly and skip verification entirely.

#### Scope of exposure

`originWhitelist={['https://*.beerknurd.com']}` (`LoginWebView.tsx:303`) governs which URLs load in-WebView, so this is **not** reachable from an arbitrary website. Exploitation requires content control on some `beerknurd.com` subdomain — XSS on a Flying Saucer page, a subdomain takeover, or a compromised page. That is a meaningful constraint, and why this is rated medium-high rather than high. It is still the one place in the app that handles real user credentials, and it currently has no independent defense.

#### Recommended changes

- Validate the message origin before acting on any `postMessage`; do not trust a page-asserted `data.url`.
- Replace the `url.includes(...)` substring gates with parsed-origin plus exact-path checks.
- Track challenge issuance server-side of the bridge so a `URL_VERIFIED` reply cannot arrive without a matching outstanding challenge.
- Justify or drop `thirdPartyCookiesEnabled`, `sharedCookiesEnabled`, and `cacheMode="LOAD_CACHE_ELSE_NETWORK"` on a credential-entry page.
- Narrow `originWhitelist` to the exact hosts the login flow needs rather than a subdomain wildcard.

### Medium: upstream JSON responses are also unbounded

Flying Saucer responses are read with `response.json()` and then serialized again with `JSON.stringify()` for hashing. The external schema accepts unlimited arrays, strings, and passthrough fields (`src/schemas/external.ts:19`). A compromised upstream, an unexpected upstream format, or a bad configured hostname can therefore create the same memory amplification as a hostile request body. Perplexity responses are also fully materialized before schema validation.

#### Recommended changes

- Hardcode or strictly allowlist the Flying Saucer HTTPS origin and construct its path and query with `URL` rather than interpolating an arbitrary configured base string.
- Bound upstream response bytes while streaming before JSON parsing.
- Add maximum Flying Saucer item counts and string lengths, and reject unexpected oversized records before hashing or caching.
- Avoid retaining both a full parsed object graph and a second full JSON serialization solely to compute a hash; hash bounded bytes or a normalized bounded representation.
- Apply a much smaller response cap to Perplexity and truncate logged upstream error bodies independently of the parser limit (`src/services/perplexity.ts:78-79` currently logs complete response bodies).
- Test oversized, slow, malformed, and schema-invalid upstream responses and confirm stale-cache fallback remains available.

### Medium: rate limiting performs D1 writes before authentication

Every non-OPTIONS request performs an atomic D1 rate-limit upsert before API-key validation (`src/rate-limit.ts:111-118`, invoked at `src/index.ts:131`). This correctly throttles rejected credentials and fails closed, but distributed unwanted traffic still reaches the Worker and creates D1 work.

The authenticated limiter then keys on the shared application-key hash, creating a global quota for all installed applications.

#### Free-tier capacity — hard numbers

Earlier drafts of this review assumed more edge capacity than the Free plan provides. The actual entitlement:

| Capability | Free plan |
| --- | --- |
| WAF **rate-limiting** rules | **1** |
| Rate-limit counting characteristics | **IP only** |
| Rate-limit expression fields | **Path and Verified Bot only** |
| Counting period | **10 s** |
| Mitigation timeout | **10 s** |
| WAF **custom** rules (separate quota) | **5** |

This materially constrains the design. The single rate-limiting rule cannot match method, `Origin`, `Content-Length`, hostname, or query string — which rules out edge mitigation for `fresh=true` abuse, OPTIONS floods, and oversized POSTs. With a 10-second window and 10-second block, a distributed or merely patient attacker sustains abuse indefinitely.

**The Worker-side durable budget, not the edge rule, is the real control.** The edge rule is worth spending on exactly one broad path-scoped abuse case, and the acceptance criteria have been rewritten to say so.

#### Recommended changes

1. Spend the single Free-tier rate-limiting rule on one path-scoped, unauthenticated abuse case, and name which one. Record the exact expression. Do not assume paid-zone features merely because Workers Paid is enabled.
2. Consider a Free-tier **custom** rule (5 available, a separate quota) for early `Content-Length` rejection.
3. Replace D1-backed route limits with Workers Rate Limiting bindings only for coarse abuse control where per-location, eventually consistent counters are acceptable. These bindings execute after the Worker starts and do not satisfy the separate goal of rejecting traffic before Worker invocation.
4. Retain a globally durable budget for queue production and other cost-bearing operations. Keep the queue consumers' atomic daily/monthly quota enforcement as the final spending boundary.
5. Treat IP rate limits as coarse protection. Mobile carriers, offices, households, and privacy relays can place many users behind one address — and Free-tier rate limiting can count by nothing else.
6. Once scoped client credentials exist, use their validated token subject as the application rate-limit key. Do not trust the client-supplied `X-Client-ID`.

References:

- [Cloudflare WAF rate limiting rules — availability](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability)
- [Cloudflare WAF custom rules — availability](https://developers.cloudflare.com/waf/custom-rules/#availability)
- [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare traffic sequence](https://developers.cloudflare.com/fundamentals/reference/traffic-sequence/) — for WAF-before-Workers ordering
- [WAF feature interoperability](https://developers.cloudflare.com/waf/feature-interoperability/) — for custom-rules-before-rate-limiting ordering only; Workers do not appear on this page

### Medium: unbounded `rate_limits` and `audit_log` growth is a storage-availability risk

The finding above counts rate-limit write *operations* as the cost. Accumulated *rows* are a separate cost that nothing currently bounds reliably.

- `src/index.ts:130-135` upserts one row per distinct client IP per minute; `schema.sql` `rate_limits` has `PRIMARY KEY (client_identifier, minute_bucket)` with no cap on distinct identifiers.
- `src/rate-limit.ts:127-130` — cleanup fires on `Math.random() < 0.01` and deletes only `minute_bucket < minuteBucket - 60`. A distributed source rotating IPs accumulates freely inside that rolling 60-minute window.
- `src/audit.ts:51-54` — audit trimming fires on `AUDIT_CLEANUP_PROBABILITY = 0.001` (`src/constants.ts:89`), `LIMIT 10000`, 30-day cutoff (`AUDIT_RETENTION_DAYS = 30`, line 94) — and sits **inside the same `try` as the INSERT, after it**. If audit inserts start failing, trimming stops too, exactly when the table is under stress.
- A cron already runs every 20 minutes (`wrangler.jsonc` `crons: ["*/20 * * * *"]`, `src/index.ts:509-512`) and already reaps `enrichment_limits` (`src/handlers/scheduled.ts:244`), but includes neither `audit_log` nor `rate_limits`.

#### Recommended changes

- Move both reapers onto the existing cron as deterministic jobs rather than probabilistic in-request work.
- Take the audit trim out of the insert's success path so a failing insert does not disable trimming.
- Record D1 size against plan limits in the dashboard checklist.

### Medium: OPTIONS bypasses rate limiting but still schedules a D1 audit write

OPTIONS is handled before the pre-auth limiter (`src/index.ts:120-122` vs `:131`). It calls the shared `respond()` helper, which schedules `writeAuditLog()` against D1 (`src/index.ts:99`), despite the adjacent comment at `src/index.ts:119` stating that the path has no D1 dependency. The currently observed edge 403 masks this behavior. Narrowly allowing preflights at the edge without first fixing the Worker would expose an unauthenticated, unthrottled D1 write-amplification path.

#### Recommended changes

1. Fix the Worker before relaxing the edge rule.
2. Validate the API hostname, route, `Origin`, `Access-Control-Request-Method`, and `Access-Control-Request-Headers`; return 403 or 404 for invalid preflights.
3. Do not persist a D1 audit row for every routine successful preflight. Use bounded analytics, sampling, or a coarse edge counter if preflight visibility is required.
4. Return CORS headers only for the documented browser contract and remove unused methods or headers, including `X-Admin-Secret` if browser administration is not supported.
5. Correct the misleading comment at `src/index.ts:119`.
6. Test that invalid or high-volume OPTIONS traffic cannot create unbounded D1 rows and that legitimate preflights still succeed.

### Medium: no security response headers on any route

A repository-wide search for `nosniff`, `X-Content-Type-Options`, `Strict-Transport-Security`, `Referrer-Policy`, and `X-Frame-Options` across `src/`, `test/`, and `contract-test/` returns **zero** hits. None of the three response paths — `src/index.ts:93-116` (`respond`), `src/context.ts:43-62` (`errorResponse`), `src/handlers/health.ts:66-88` — sets any of them.

The live-edge section below observed this on `/health`, but it is not a health-endpoint issue; it is every route.

#### Recommended changes

- Set `X-Content-Type-Options: nosniff` and an appropriate `Referrer-Policy` on all responses from the shared helpers.
- Add HSTS at the zone level after confirming all covered subdomains support HTTPS (see the dashboard checklist).
- Add an explicit cache directive to every response — this becomes load-bearing if Workers Caching is ever enabled (see the caching design note).

### Medium: the Tail Worker alert channel can be flooded

- `workers/error-alerts/src/cooldown.ts:5` — `const state = new Map<string, CooldownEntry>()` is module-global. Tail Workers run per-isolate and per-location, so the 5-minute `COOLDOWN_MS` holds only within one warm isolate; errors spread across POPs, or a cold isolate, each get a fresh window.
- `workers/error-alerts/src/index.ts:37-47` — the outer `catch` builds and sends a fallback email **without calling `shouldSendAlert`**. Any tail-processing error emails unconditionally, once per trace batch.
- The producing side makes this reachable: `wrangler.jsonc` sets `observability.logs.head_sampling_rate: 1` with `invocation_logs: true` and `tail_consumers: [ufobeer-error-alerts]`; `src/index.ts:489` `console.error`s on every unhandled 500, which `filterErrorTraces` picks up.

An attacker who can provoke Worker errors therefore floods the alert mailbox, degrading the only error-notification channel precisely during an incident, and consuming the Email Routing allowance.

#### Recommended changes

- Back the cooldown with a durable counter (KV or D1) rather than isolate memory, or impose a per-batch cap.
- Apply a cooldown to the fallback path.
- Alert on alert volume itself.

### Medium: admin routes should be protected by Cloudflare Access

Admin routes require both the shared app key and a static `X-Admin-Secret`. The second secret is meaningfully stronger than the mobile key, but it remains a single long-lived credential.

#### Recommended changes

1. Put `/admin/*` or a dedicated admin API hostname behind a hostname/path-specific Cloudflare Access application. More-specific rules override broader ones.
2. Use a human identity policy for interactive administration. This consumes a Zero Trust seat — confirm the free seat allowance in the dashboard (see checklist); it is not published in Cloudflare's docs.
3. Use scoped, expiring Access service tokens for automation. Service tokens **do not consume seats**; the account limit is 50.
4. Keep `ADMIN_SECRET` temporarily as defense in depth during migration.
5. Remove `X-Admin-Secret` from `Access-Control-Allow-Headers` unless browser-based admin tooling actually requires it.

References:

- [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Zero Trust seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/)
- [Cloudflare One account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/)

### Medium: privileged audit records misreport operation outcomes

Successful admin routing writes a specialized audit record, but `writeAdminAuditLog()` hardcodes status code 200 (`src/audit.ts:91`). A handler that returns an error or partial result can therefore be represented as a successful privileged operation in the audit table. The recorded details also emphasize aggregate counts and do not consistently preserve the requested targets, actual outcome, or failure reason.

#### Recommended changes

- Pass the actual handler status and structured outcome to the admin audit writer.
- Record the validated Cloudflare Access identity after Access is introduced, plus the operation, bounded target identifiers or a digest of them, requested count, succeeded count, failed count, and reason.
- Distinguish attempted, denied, partially successful, successful, and failed privileged operations.
- Test failed and partial replay, acknowledge, cleanup, and enrichment operations against the persisted audit row—not only Analytics Engine events.

### Medium: public health checks are more expensive and informative than necessary

`/health` is unauthenticated but runs a `SELECT 1` connection query plus daily and monthly quota queries and returns enrichment configuration and quota consumption (`src/handlers/health.ts:37,48-57,66-82`). Routing checks only the path (`src/index.ts:161-163`), so the endpoint also responds successfully to POST and other methods, and returns directly without a normal audit row.

The current Golden Taproom contract explicitly requires the quota blocks (`contract-test/goldenTaproom.contract.test.ts:175-176,398-408`), and the mobile client has a detailed-health parser (`enrichmentService.ts:1214-1252`), so removing those fields unilaterally would break an enforced cross-repository contract.

#### Recommended changes

- Add a new cheap GET/HEAD liveness endpoint without D1 access, or version `/health`, before changing the existing contract.
- Return `405 Method Not Allowed` for unsupported methods and include an `Allow` header.
- Put detailed readiness, database, and quota information behind Cloudflare Access after updating the mobile contract, contract harness, and any operational monitors.
- Add `Cache-Control: no-store` to detailed health responses.
- Release and observe compatible clients before retiring the old public health shape.

### Medium: the DLQ consumers have no further dead-letter destination

The primary enrichment and cleanup consumers correctly route terminal failures to dead-letter queues. The DLQ consumers themselves have finite retries but no onward destination, so a message that exhausts retries there is discarded silently.

#### Recommended changes

- Define terminal behavior for DLQ consumer exhaustion: persist to D1, alert, or both.
- Alert on DLQ depth and on DLQ-consumer retry exhaustion.

### Medium: deployment, backup, and secret-management hardening

The deployment workflow uses one Cloudflare API token for Tail Worker deployment, D1 migrations, and API Worker deployment (`deploy.yml:47,55`). A separate backup workflow uses a **distinct, already-scoped** token (`backup.yml:36,45`, `CLOUDFLARE_BACKUP_API_TOKEN`, documented as `D1:Edit` + `Workers R2 Storage:Edit`) and exports the complete D1 database—including audit IP addresses and user agents—to R2 in the same Cloudflare account. This is a useful restore copy but not an independent failure domain: sufficiently privileged Cloudflare account compromise can affect both production D1 and its R2 backup. Workflow actions use mutable major-version tags, and CI downloads a gitleaks archive without verifying its checksum.

`contract-golden-taproom.yml:9` already declares explicit `permissions:`; `ci.yml`, `deploy.yml`, and `backup.yml` do not.

#### Recommended changes

- Restrict the deployment Cloudflare token to the exact account and minimum necessary Workers Scripts and D1 permissions.
- Consider separate migration and Worker-deployment credentials if operationally practical. (Backup credentials are already separate.)
- Use a protected GitHub production environment with reviewer controls.
- Set explicit `permissions: contents: read` on the `ci`, `deploy`, and `backup` workflows unless a narrower job-specific permission set is required.
- Pin all GitHub Actions, including GitHub-owned actions, to reviewed full commit SHAs.
- Verify the gitleaks download checksum or use a pinned, verified action.
- Add Wrangler `secrets.required` declarations so deployments fail when required secrets are absent. Shape: `{ "secrets": { "required": ["API_KEY", "ADMIN_SECRET"] } }`.
- Keep sensitive values in Worker Secrets or Secrets Store, never Wrangler `vars`.
- Validate or hardcode the Flying Saucer upstream HTTPS hostname rather than treating an arbitrary configured URL as trusted indefinitely.
- Verify that the R2 backup bucket is private and accessible only to the narrowly scoped backup identity and recovery operators.
- **Resolve the lifecycle/lock interaction before configuring either.** A bucket lock prevents deletion and overwriting by all identities including the uploader — which is the point — but bucket lock rules **take precedence over lifecycle rules**, so a 90-day lifecycle deletion will not execute against objects a lock still retains, and **a bucket cannot be emptied while any lock rule is configured**. Decide the intended retention as one number and configure the lock and lifecycle consistently.
- For recovery from a Cloudflare account compromise, maintain a separately credentialed copy in another account or provider if the data's recovery objective justifies it. Document explicitly if the same-account residual risk is accepted instead.
- Test restoration periodically and record the most recent successful restore test. A backup that has only been uploaded is not yet proven recoverable.
- Include backup copies in the project's data classification, privacy retention, incident response, and access-review procedures.
- Assess `observability.logs` (`head_sampling_rate: 1`, `persist: true`, unsampled) under the same PII and retention analysis applied to the R2 backup — the Worker logs full request context (`src/index.ts:422,468,489`) and complete Perplexity error bodies (`src/services/perplexity.ts:78-79`).

References:

- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)

### Low: Tail Worker emails may carry more diagnostic data than necessary

The Tail Worker includes full request URLs, including query strings, plus raw exception messages and error-level log messages in alert emails. Current public query parameters are low sensitivity, but future credentials or user data in query strings could be forwarded outside Cloudflare's logging boundary.

#### Recommended changes

- Strip query strings or allowlist specific safe query parameters.
- Redact authorization headers, API keys, cookies, IP addresses, email addresses, and token-like strings.
- Truncate every exception and log field independently.
- Avoid logging complete upstream error bodies.
- Document retention and access controls for the alert mailbox.

### Low: the mobile client sends an unused persistent identifier

The mobile enrichment service creates and persists an `X-Client-ID` (`enrichmentService.ts:249-292`), and its comments describe the value as a per-device rate-limit identity. The Worker intentionally ignores that header because it is client-controlled and spoofable (`src/auth.ts:162,191`); authenticated requests are instead keyed by the shared API-key hash. The identifier therefore provides no security control while adding unnecessary persistent client metadata to requests and potentially to future logs.

#### Recommended changes

- Remove `X-Client-ID` and its local persistence from the current client.
- If scoped client tokens are introduced, use the validated token subject for rate limiting and audit correlation rather than reviving a self-asserted identifier.
- Document whether device-level identifiers are personal data, their purpose, and retention before collecting a replacement.

## Design note: public taplist caching

*This is not a finding.* `Cache-Control: private, max-age=300` is correct and safe today. Everything below is conditional on a redesign that has not been committed to, and should be read only if pre-Worker caching is actually pursued. It is recorded here so the constraints are known before anyone starts.

**Why the Worker runs on every request.** Not because the response is `private` — Workers execute *before* the zone cache architecturally, so switching to `public` would not by itself avoid invocation. Cloudflare's **Workers Caching** configuration (`cache.enabled`) is the only mechanism that checks cache before invoking the Worker. The in-Worker Cache API does not avoid Worker execution.

**What would have to be true first.** The taplist appears public and scoped only by an allowlisted store ID, making it a plausible candidate for short-lived edge caching. It is not currently safe to cache unchanged: the body contains a per-request request ID, headers contain rate-limit state and request ID, and authentication and audit logic run before the response is produced. Enabling pre-Worker caching would bypass the Worker's authentication, rate limiting, analytics, and audit logic on a hit — that must be an explicit decision, not an accident.

**Cache key mechanics.** Workers Caching computes its key before the Worker runs. The key **includes**: the target named entrypoint, the raw path and query string (query parameter order matters — `?a=1&b=2` and `?b=2&a=1` are different keys), the **Worker version** by default (unless `cache.cross_version_cache` is set), `ctx.props` when invoked through a service binding or RPC, and anti-cache-poisoning security headers. The key **excludes**: the request host, and **the HTTP method — GET and HEAD share cache entries**.

Three consequences that are easy to miss:

- **Version-keyed by default** means every deploy invalidates the cache. Any "verified cache hit" evidence must be gathered against a stable version.
- **GET and HEAD sharing entries** means a cheap HEAD liveness path is not cache-distinct from its GET.
- **The automatic authenticated-request bypass keys on `Authorization`.** This Worker authenticates with `X-API-Key`, so that safety net never applies to any authenticated route. Emitting explicit `Cache-Control: no-store` from every non-taplist GET/HEAD response is therefore load-bearing, not belt-and-braces.

**Fail-open hazard.** Cacheability is determined by the response headers the Worker returns, including heuristic freshness for responses carrying no `Cache-Control`. Health and error responses never designed for shared caching can therefore acquire heuristic TTLs. Never cached regardless of directives: status 206 and 520–526; only GET and HEAD are cached at all.

**The RPC trap.** An uncached outer gateway still executes even if an inner entrypoint hits cache — that part of the split architecture works. But custom RPC methods (`ctx.exports.Backend.getUser(id)`) **bypass the cache and always run the callee**, regardless of the entrypoint's `cache.enabled` setting. Only `fetch` through the entrypoint is cached. A gateway that delegates by RPC method silently never engages the cache at all.

**Version floor.** Basic caching requires Wrangler ≥ 4.69.0; **per-entrypoint control and cross-version caching require ≥ 4.107.0**. Since the recommended architecture is the per-entrypoint split, the real floor is 4.107.0. Keys: `cache.enabled` (required), `cache.cross_version_cache` (optional).

**If pursued, in order:**

- Decide that `GET /beers` is intentionally public and complete the mobile authentication migration first.
- Define a stable cacheable representation excluding `requestId`, `X-Request-ID`, rate-limit headers, credentials, and any client-specific data.
- Prefer a dedicated public taplist Worker or named public entrypoint with caching enabled only for that entrypoint; keep the gateway/admin/health entrypoint uncached; delegate by `fetch`, not RPC.
- Expose one canonical public URL shape, such as exactly `GET /beers?sid=<allowlisted-id>` with a documented parameter order. Noncanonical variants may miss the pre-Worker cache and must be rejected or redirected when the Worker runs; they cannot be normalized before the outer lookup.
- Explicitly emit `Cache-Control: no-store` from every other GET/HEAD response before enabling caching.
- Because the key excludes hostname, ensure the cached entrypoint is not shared by preview URLs, service bindings, alternate custom domains, or future admin hostnames with different authorization semantics. Partition intentional multi-ingress with separate entrypoints or trusted `ctx.props`.
- Ensure `fresh` cannot create an attacker-controlled set of cache variants.
- Define purge/invalidation behavior for cron refreshes and enrichment changes; use a short TTL.
- Verify with cache-status headers and Worker analytics against a stable Worker version.

References:

- [Cloudflare Workers Caching](https://developers.cloudflare.com/workers/cache/configuration/)
- [Cloudflare Workers Caching keys](https://developers.cloudflare.com/workers/cache/cache-keys/)
- [Cloudflare Workers Caching limitations](https://developers.cloudflare.com/workers/cache/limitations/)
- [How the cache works](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)

## Live edge observations

The following behavior was observed against `https://api.ufobeer.app` on 2026-09-01 and independently reconfirmed at approximately 16:33 UTC:

- `/health` returned HTTP 200 through Cloudflare over HTTP/2.
- The health response did not include HSTS, `X-Content-Type-Options: nosniff`, or an explicit cache policy. (Source review confirms this applies to every route, not just `/health` — see the response-headers finding.)
- A POST to `/health` also returned HTTP 200.
- Unauthorized application requests reached the Worker and returned its expected JSON response.
- When the request Origin matched `https://ufobeer.app`, unauthorized responses included the expected exact-origin CORS headers.
- Browser-style OPTIONS preflights, including one from the configured origin, returned a Cloudflare-generated HTML 403 rather than the Worker's expected 204.

The confirming probes observed `CF-Ray` values `a345ac89d9b669d3-DFW` for `GET /health`, `a345acd93e0be68e-DFW` for `POST /health`, and `a345acdabcdaafb9-ATL` for the OPTIONS request. The current report does not include the complete probe transcript, so these observations are not independently reproducible from this document alone. Store and link a dated evidence artifact containing the exact commands, UTC timestamps, request headers, response headers and bodies, POP/Ray IDs, expected result, and the identity or mechanism of the independent confirmation. Redact credentials without removing the request shape needed to reproduce the result.

The OPTIONS result indicates that an edge security rule, bot control, or other zone-level policy is terminating preflights before Worker execution. If a web client uses this API, inspect Cloudflare Security Events around the test time. Fix the Worker's unthrottled OPTIONS audit-write behavior before narrowly allowing OPTIONS for the API hostname, intended paths, and expected origin. If the API is native-mobile-only, remove unused CORS support rather than widening the rule.

## Cloudflare dashboard verification checklist

Source configuration and public responses cannot prove all zone/account settings. Verify the following directly in Cloudflare:

- [ ] SSL/TLS mode is **Full (strict)**.
- [ ] **Always Use HTTPS** is enabled.
- [ ] Minimum TLS version is at least TLS 1.2.
- [ ] HSTS is enabled after confirming all covered subdomains support HTTPS.
- [ ] Appropriate Cloudflare Managed WAF rules are enabled.
- [ ] Any WAF exceptions are narrowly scoped and documented.
- [ ] The **one** Free-tier rate-limiting rule is spent on a named path-scoped abuse case, and its exact expression is recorded.
- [ ] Free-tier custom-rule usage is recorded separately (5 available).
- [ ] No control claims to use the Enterprise-only `http.request.body.size` field or paid API Shield enforcement under the current entitlement.
- [ ] Security Events explain the observed OPTIONS 403 behavior.
- [ ] Bot controls do not break legitimate native or browser API traffic.
- [ ] Cloudflare Access protects admin paths or an admin hostname.
- [ ] The free Zero Trust seat allowance is recorded (not published in Cloudflare docs — read it from the dashboard). Service tokens do not consume seats; the account limit is 50.
- [ ] DNSSEC is enabled.
- [ ] Account owners and privileged members require phishing-resistant MFA where possible.
- [ ] API tokens are account-scoped, least-privilege, expiring/rotated where supported, and inventoried.
- [ ] Worker preview URLs remain disabled or Access-protected.
- [ ] D1 current size is recorded against the plan limit.
- [ ] D1, Queue, Workers AI, Perplexity, Worker error-rate, and rate-limit alerts are configured.
- [ ] Alert-volume alerting exists so a flooded mailbox is itself visible.
- [ ] Log and audit retention matches the documented policy, including `observability.logs.persist`.
- [ ] The D1 backup R2 bucket is private, least-privilege, inventoried as sensitive, and covered by a recent successful restore test.
- [ ] The R2 retention lock and lifecycle rule express one consistent retention period (locks take precedence over lifecycle).
- [ ] Same-account Cloudflare compromise is either covered by a separately credentialed cross-account/provider copy or explicitly accepted as a residual recovery risk.
- [ ] GitHub workflow `GITHUB_TOKEN` permissions are explicitly minimal on `ci`, `deploy`, and `backup` (`contract-golden-taproom` already declares them).

## Suggested remediation order

Each item is annotated with **client impact** — whether it can ship without an App Store release.

### Phase 0: same-day hardening (est. ~4 hours, no client impact)

Non-breaking configuration and small code edits that close a realistic supply-chain and disclosure path. These were previously scheduled last, behind a multi-release cross-repository migration, which in practice meant they would never happen.

| # | Item | Client impact |
| --- | --- | --- |
| 1 | Declare Wrangler `secrets.required` | None |
| 2 | Set explicit `permissions:` on `ci`, `deploy`, `backup` | None |
| 3 | Pin all `uses:` to full commit SHAs | None |
| 4 | Verify the gitleaks download checksum | None |
| 5 | Strip query strings and truncate fields in Tail Worker emails | None |
| 6 | Add `X-Content-Type-Options: nosniff` and `Referrer-Policy` to shared response helpers | None |
| 7 | Correct the misleading "no D1 dependency" comment at `src/index.ts:119` | None |
| 8 | Remove `X-Client-ID` and its persistence from the mobile client | Ships with next release; Worker already ignores it |

### Phase 1: immediate cost and availability controls

| # | Item | Client impact |
| --- | --- | --- |
| 1 | Restrict `fresh=true` to admin/cron callers | **None** — verified: no `fresh` parameter in `BeerSelector/src/` as of 2026-09-01 |
| 2a | Bind every cleanup/enrichment queue message and result `UPDATE` to an authoritative description hash; a mismatch acks without writing. Includes fixing the sync upsert to refresh `description_hash`. | **None** — server-only |
| 2b | Stop accepting client-supplied `brew_name`/`brewer`/`brew_description` for existing IDs | **Breaking** — needs a released client tolerating an ID-only sync response and a bounded poll timeout. Move to Phase 2 unless 2a alone proves insufficient. |
| 3 | Escape the prompt delimiter, bound description length before prompt assembly, and validate model output before persisting; do not derive ABV from output when the source had none | **None** — server-only |
| 4 | Add the shared bounded body reader, content-type enforcement, and complete schema limits to every JSON route; record the byte limit as a named constant | **None** if limits exceed the real contract; validate with fixtures first |
| 5 | Bound and validate upstream response bodies; hardcode or allowlist the Flying Saucer origin | **None** |
| 6 | Lower `limits.cpu_ms` from 60000 to the measured requirement | **None** |
| 7 | Move the `rate_limits` and `audit_log` reapers onto the existing cron; take the audit trim off the insert success path | **None** |
| 8 | Add a new cheap, method-specific liveness endpoint | **Additive** — does not touch the existing `/health` contract |
| 9 | Fix OPTIONS validation and D1 audit amplification, and record reproducible evidence | **None** |
| 10 | Correct privileged audit rows so they persist actual failure and partial-success outcomes | **None** |
| 11 | Validate the login WebView message origin; replace substring URL gates with parsed-origin checks | Mobile-only; ships with next release |
| 12 | Durable cooldown for Tail Worker alerts, including the fallback path | **None** |

**Prerequisite for the edge-rule work:** read the remaining Free-tier rule quota from the dashboard (checklist item) *before* Phase 1 planning, not after. With only one rate-limiting rule available, matching on Path and Verified Bot only, decide deliberately which single abuse case it buys.

### Phase 2: authentication and scope decisions (est. 1–2 days plus one app release)

1. Document that `EXPO_PUBLIC_ENRICHMENT_API_KEY` is a public identifier, not a secret. It exists for traffic attribution and coarse quota, not authentication.
2. Define the route authorization matrix: every endpoint classified as public read, scoped client write, human admin, or automation, with its authentication and rate/cost budget named.
3. Put `/admin/*` behind Cloudflare Access with a human policy and a service token for automation; keep `ADMIN_SECRET` as defense in depth.
4. Add a globally durable daily spend budget for queue-producing endpoints and Workers AI / Perplexity, with an alert.
5. Ship Phase 1 item 2b once a compatible client is released.
6. Update the mobile and Golden Taproom health contracts, then move detailed health behind Access.

#### Explicit non-goals for this project

Revisit only if the stated trigger fires. These were previously listed as Phase 2 work; at the current scale they are disproportionate to a public beer taplist whose spend is already capped.

| Non-goal | Revisit if |
| --- | --- |
| App Attest / Play Integrity token issuance, with nonces, rotation, revocation, and anti-farming tests | Spend budget (item 4) proves insufficient, or the data stops being public |
| Pre-Worker edge caching / Workers Caching redesign | Worker invocations exceed a recorded threshold, or D1 reads become a real cost line |
| Removing `/beers/sync` entirely | The Phase 1 description-hash binding proves insufficient |
| Retiring the shared key and rotating it | A scoped credential scheme actually ships |

### Phase 3: remaining operational hardening

1. Resolve the R2 retention lock and lifecycle period as one consistent number, then configure both.
2. Perform and date a restore test; add an independent-account copy or document acceptance of the same-account residual risk.
3. Define terminal behavior and alerting for DLQ-consumer retry exhaustion.
4. Assess `observability.logs` retention and PII under the project's data classification.
5. Review remaining Cloudflare token permissions.
6. Complete and document the dashboard verification checklist.

## Acceptance criteria

Each criterion names the artifact, command, or test that proves it. Criteria conditional on undecided Phase 2 work are listed separately at the end and cannot be evaluated today.

### Phase 0

- Every `uses:` in `.github/workflows/*.yml` matches `owner/repo@[0-9a-f]{40}`, asserted by a CI grep that fails the build.
- `ci.yml`, `deploy.yml`, and `backup.yml` each declare an explicit `permissions:` block.
- `wrangler.jsonc` declares `secrets.required`, and a deploy with a required secret unset fails.
- The gitleaks download is checksum-verified or replaced by a pinned, verified action.
- A test asserts `X-Content-Type-Options: nosniff` on responses from all three response helpers.

### Phase 1

- **Byte limits.** Every JSON endpoint returns 415 for unsupported media types, 413 before JSON parsing when the documented byte limit is exceeded—including chunked or dishonestly sized input—and 400 for malformed JSON. The limit is a named constant in `src/constants.ts` with the contract fixture that justifies it.
- **Boundary tests.** Contract tests exercise exact byte, item-count, string-length, UTF-8, and unknown-property boundaries for every body-bearing route.
- **Stale-result binding.** Four passing tests in `test/queue/cleanup.test.ts`: a mismatched `description_hash` acks without writing; duplicate delivery writes once; a message enqueued before an upstream description change acks without writing; a DLQ replay older than the current row acks without writing. A fifth asserts the sync upsert refreshes `description_hash`.
- **Prompt injection.** A description containing the literal closing delimiter followed by injected instructions cannot change what is written to `brew_description_cleaned` or `abv`. A description containing no ABV cannot cause a non-null `abv` to be persisted.
- **Upstream bounds.** A mocked upstream stream that would yield 200 MB causes the bounded reader to throw after N bytes, and the handler returns the stale cache row.
- **Spend budget atomicity.** The daily quota `UPDATE` in `src/db/quota.ts` is atomic under concurrency: N parallel increments grant exactly the cap. Daily Workers AI and Perplexity caps are named constants in `src/constants.ts`, enforced in the consumer.
- **Cache bypass.** `fresh=true` requires an identity unavailable from the public app bundle; an unauthenticated and an app-key request both receive 403.
- **Preflight.** Legitimate browser preflights succeed only for the documented origin, methods, headers, hostname, and paths, or CORS is removed and the absence of browser clients is documented. Invalid or high-volume OPTIONS requests create no D1 audit rows.
- **Liveness.** A GET/HEAD liveness endpoint performs no D1 query, and unsupported methods return 405 with an `Allow` header.
- **Audit fidelity.** Persisted admin audit rows contain the actual outcome/status and distinguish denied, failed, partial, and successful operations. Tests cover a failed and a partial replay against the persisted row, not only Analytics Engine events.
- **Row growth.** `rate_limits` and `audit_log` reapers run from the cron deterministically; the audit trim executes even when the preceding insert throws.
- **WebView origin.** A `postMessage` from a page whose origin is not the expected Flying Saucer host does not trigger the cookie-harvest injection, and a `URL_VERIFIED` message with no matching outstanding challenge is ignored.
- **Edge rule.** The single Free-tier rate-limiting rule is configured for one named path-scoped abuse case, verified in Security Events with no corresponding Worker invocation or D1 rate-limit row for blocked requests. Body-size enforcement remains correct inside the Worker without Enterprise WAF fields and rejects chunked or dishonestly sized bodies.

### Phase 2

- **Route matrix.** `plans/route-matrix.md` exists; a test enumerates routes from `src/index.ts` and fails if any is absent from the matrix or lacks an auth class and budget.
- **Public key.** `npx expo export` output is grepped for `EXPO_PUBLIC_` values; each is replayed against `GET /beers?sid=<id>&fresh=true`, `POST /beers/sync`, and `POST /admin/dlq/replay` and receives 401 or 403. Dated transcript stored in `plans/evidence/`.
- **Admin access.** Admin access records a validated Access identity and is revocable per user or automation client; it no longer depends solely on a shared long-lived header.
- **Canonical fields.** A mobile caller cannot update canonical `brew_name`, `brewer`, `brew_description`, or derived enrichment fields for an existing beer ID.

### Phase 3

- **Backups.** The R2 backup bucket is private and protected by a retention lock the routine backup identity cannot change; the lock period and the lifecycle rule state the same retention. A dated restore exercise proves a backup can be recovered. A separate-account/provider copy exists, or a dated ADR in `plans/` records the accepted same-account recovery risk and the recovery objective it was weighed against.
- **Token scopes.** Cloudflare token inventory evidence records exact account/resource scopes for the deploy token. (Backup credentials are already separate.)
- **Evidence.** The live-edge section links a redacted probe artifact containing the exact commands, UTC timestamps, request and response evidence, POP/Ray IDs, expected outcomes, and independent-confirmation method.

### Conditional — not evaluable until the corresponding Phase 2 decision is made

- **If scoped client write tokens are adopted:** they have a documented maximum lifetime, audience and route scopes, nonce/replay controls, a signing-key rotation procedure, and a per-subject revocation test. The issuer has its own durable rate/cost budget. *(The original "a parallel multi-account/device/location farming test cannot exceed the budget" clause has been removed — it is not runnable by a solo maintainer and blocked the criterion from ever being ticked.)*
- **If public taplist caching is adopted:** the cached representation contains no request ID, credential, rate-limit state, or client-specific data. The canonical raw path/query cache key and entrypoint/ingress isolation are documented. Against a stable Worker version, a recorded probe shows a cache hit avoiding the intended entrypoint, and `cf-cache-status` of `BYPASS` or `DYNAMIC` for `/health`, the liveness path, `/beers` with an invalid key, `/beers?fresh=true`, `/admin/dlq`, a 404, and a 405. A test enumerating routes from `src/index.ts` asserts every non-taplist GET/HEAD response carries `Cache-Control: no-store`.

## Revision history

**2026-09-01 — panel review.** Four review lenses (source-code fidelity, Cloudflare platform accuracy, gap coverage, actionability) audited the original draft. Changes:

- **Corrected:** Free-tier WAF capacity stated as hard numbers (1 rate-limiting rule, IP-only, Path/Verified-Bot fields, 10 s window; 5 custom rules as a separate quota) — several original recommendations and one acceptance criterion assumed capacity the plan does not have. The `private`-blocks-caching causal chain (Workers run before the cache regardless). The `feature-interoperability` citation (does not mention Workers). Body limits are per account plan. Workers Caching key details (version-keyed, GET/HEAD shared, `Authorization`-only auto-bypass, RPC cache bypass, Wrangler 4.107.0 floor). R2 lock/lifecycle precedence conflict. Access seat facts. `delay_seconds` already rejects negatives. Backup credentials are already separate. `contract-golden-taproom.yml` already declares permissions. The pre-auth 30 RPM per-IP limiter was missing from the risk table. `description_hash` already exists but the sync upsert does not refresh it, so the recommended `WHERE` clause needed a prerequisite. `secrets.required` verified correct as originally written.
- **Added:** prompt injection into Workers AI (High); the login WebView origin-validation gap (Medium-high); D1 row accumulation and probabilistic reapers (Medium); missing security response headers on all routes (Medium); Tail Worker alert flooding (Medium); `cpu_ms: 60000` and unsampled persisted logs.
- **Recalibrated:** public taplist caching demoted from a High finding to a design note (the current header is correct and safe; every hazard was conditional on an uncommitted redesign); cache bypass and sync abuse promoted to High in its place. Three items previously buried in "Existing strengths" moved into findings.
- **Resequenced:** new Phase 0 (~4 h, non-breaking) promoted from the old Phase 3; every Phase 0 and Phase 1 item annotated with client impact; the old Phase 1 item 2 split into a server-only part and a breaking part; Phase 2 de-scoped with an explicit non-goals table.
- **Rewritten:** acceptance criteria grouped by phase, each naming a concrete artifact or test. Nine unfalsifiable criteria replaced; two conditional criteria moved to their own section; one criterion that fused Phase 1 and Phase 2 deliverables split.
