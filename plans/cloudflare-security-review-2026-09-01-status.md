# Cloudflare Security Review — Implementation Status

**Plan:** [cloudflare-security-review-2026-09-01.md](cloudflare-security-review-2026-09-01.md)
**Implemented:** 2026-09-01
**Branch:** `security/cloudflare-review-2026-09-01` (ufobeer), `security/webview-origin-2026-09-01` (BeerSelector)
**State:** uncommitted in both repos

## Verification at time of writing

| Check | Result |
| --- | --- |
| `npm run typecheck` / `:test` / `:contract` | exit 0 |
| `npm run test:unit -- --run` | 1112/1112 (baseline 907) |
| `npm test -- --run` (Workers pool) | 1234/1234 |
| `npm run test:contract` (Golden Taproom) | 15/15 |
| `workers/error-alerts` typecheck + tests | exit 0, 90/90 |
| BeerSelector vitest / jest-expo / tsc | 2320/2320, 239/239, exit 0 |
| iOS device build — member + visitor login, re-login | passed |

`npm test` and `npm run test:contract` require the sandbox disabled — workerd writes to
`~/Library/Preferences`. They do **not** require Cloudflare credentials.

In BeerSelector, `src/__tests__/utils/mockServer.test.ts` and `integration.mockServer.test.ts`
(62 tests) bind a real port and fail with `listen EPERM` under a sandbox. They pass outside it.
A sandboxed run reports 59 failures that are not real.

## Shipped

### Phase 0
All eight items. Workflow `permissions:`, full-SHA action pinning with a CI guard that fails on
any unpinned `uses:`, gitleaks checksum verification, `secrets.required`, `nosniff` +
`Referrer-Policy` on all three response helpers, the corrected `src/index.ts` OPTIONS comment,
Tail Worker query-stripping and truncation, and `X-Client-ID` removal from the mobile client.

### Phase 1
All items except **2b**, which the plan itself defers to Phase 2 (breaking without a released client).

Notable: `fresh=true` now requires admin auth; cleanup **and** enrichment result writes are bound to
`description_hash`; the Workers AI and Perplexity prompts are escaped, length-bounded and
output-validated, with ABV never derived from model output when the source had none; every JSON
route enforces content-type, byte and item bounds; the Flying Saucer fetch is origin-allowlisted,
`URL`-constructed and byte-bounded; the `rate_limits` and `audit_log` reapers moved to the cron;
admin audit rows carry real status and outcome; `/livez` added; the Tail Worker cooldown is
KV-durable with a per-window volume cap; the login WebView validates message origin and tracks
verification challenges app-side.

## Pre-deploy blockers — both cleared 2026-09-01

1. **KV namespace for the Tail Worker — done.** Namespace `ufobeer-error-alerts-cooldown`
   (`17b1265c5e704ff883700aceed8a8808`) provisioned and bound.

   **Gotcha worth remembering:** `wrangler kv namespace create` does *not* fill in an existing
   placeholder — it **appends a second binding** derived from the namespace title. The config
   briefly carried both a placeholder `COOLDOWN_KV` and a live `ufobeer_error_alerts_cooldown`.
   Since `src/cooldown.ts` and `src/emailCap.ts` read `env.COOLDOWN_KV`, that would have deployed
   cleanly and run the cooldown **permanently degraded** (KV absent → in-isolate fallback), with no
   error anywhere. Merged to a single `COOLDOWN_KV` binding; verified via
   `wrangler deploy --dry-run`, which now reports
   `env.COOLDOWN_KV (17b1265c...) → KV Namespace`.

2. **Mobile login smoke test — done, and narrower than expected.** Verified on an iOS build:
   member login, visitor login, and re-login after logout all complete, with a successful data
   refresh afterward confirming session cookies are captured and stored.

   **Android is not a ship target**, which removed most of this blocker. Both flags originally
   flagged as unverifiable — `thirdPartyCookiesEnabled={false}` and the removed
   `cacheMode="LOAD_CACHE_ELSE_NETWORK"` — are `@platform android` per
   `react-native-webview`'s `WebViewTypes.d.ts`, so they are **inert on iOS**. They are kept set
   correctly for whenever Android is revived; `components/LoginWebView.tsx` now records this, and
   that login has never been exercised on a real Android device. The changes that *do* affect iOS
   — the narrowed `originWhitelist`, the message-origin gate, and the challenge-nonce tracking —
   are what the smoke test above exercised.

## Known consequences of this change

- **One-time cache invalidation.** The taplist `content_hash` is now computed from the raw upstream
  bytes rather than `JSON.stringify(JSON.parse(text))`. On first live fetch per store after deploy,
  the hash will likely differ, causing one extra `setCachedTaplist` write and one changed ETag.
  Self-healing. `enriched_beers.description_hash` is a separate hash and is unaffected.
- **One-time in-flight message drop.** Cleanup messages queued before this deploy carry no
  `descriptionHash` and are acked without writing, with a distinct warning. Window is minutes.
- **`/beers/batch` and `/beers/sync` now reject oversized input** rather than silently truncating.
  Verified the mobile client already chunks batch lookups at 100.
- **Unknown request properties now 400** instead of being stripped (`.strict()` on client-authored
  schemas). Golden contract passes; mobile client sends no extra fields.
- **`https://flying-saucer.golden-taproom.test` is in the production upstream allowlist.**
  `contract-test/goldenTaproom.contract.test.ts` hardcodes it as `TEST_ORIGIN` and the contract file
  is off-limits to edit. `.test` is IANA-reserved and never resolves publicly, so residual risk is
  negligible — but the clean fix is to parameterise the contract test's origin and drop the entry.

## Not done — console/account work, not code

Read the Free-tier rule quota from the dashboard **before** planning the edge rule; the plan names
this as a prerequisite.

- [ ] Spend the single Free-tier rate-limiting rule on one named path-scoped abuse case; record the
      exact expression (Free tier: 1 rule, IP-only counting, Path/Verified-Bot fields, 10s window).
- [ ] Optional Free-tier custom rule (5 available, separate quota) for early `Content-Length` rejection.
- [ ] Cloudflare Access on `/admin/*` — human policy for interactive use, service token for automation.
      Keep `ADMIN_SECRET` as defence in depth during migration. Record the free Zero Trust seat
      allowance from the dashboard.
- [ ] Investigate the observed OPTIONS 403 in Security Events; the Worker-side fix has shipped, so the
      edge rule can now be narrowed safely.
- [ ] R2 backup: resolve the lock/lifecycle retention period as **one** number (locks take precedence
      over lifecycle; a bucket cannot be emptied while any lock rule is configured). Confirm the bucket
      is private. Perform and date a restore test.
- [ ] Decide and record: separately credentialed cross-account backup copy, or a dated ADR accepting
      the same-account recovery risk.
- [ ] Restrict the deploy Cloudflare token to minimum Workers Scripts + D1 scopes; inventory all tokens.
- [ ] Assess `observability.logs` (`head_sampling_rate: 1`, `persist: true`) under the project's PII
      and retention policy — the Worker logs full request context.
- [ ] Remaining dashboard checklist in the plan: SSL Full (strict), Always Use HTTPS, min TLS 1.2,
      HSTS, DNSSEC, managed WAF rules, MFA, preview URLs disabled, D1 size vs plan limit, alerting.

## Deferred by decision

- **Phase 1 item 2b** — stop accepting client-supplied `brew_name`/`brewer`/`brew_description` for
  existing IDs. Needs a released client tolerating an ID-only sync response. Phase 1 item 2a
  (hash binding) shipped and may prove sufficient; the plan's non-goals table says revisit only if
  it does not.
- **Phase 2 non-goals** stand as written: App Attest / Play Integrity, pre-Worker caching redesign,
  removing `/beers/sync`, retiring the shared key.

## Follow-ups worth doing, not blocking

- Parameterise the golden contract's `TEST_ORIGIN` so the `.test` allowlist entry can be dropped.
- GitHub Actions are pinned at their **current** majors; `actions/checkout` v7 and `setup-node` v7
  exist. A version bump is separate work from this security pass.
- `wrangler` warns that `secrets.required` is experimental on the installed 4.69.0.
- Clearing the now-inert stored `enrichment_client_id` preference in the mobile app on upgrade.
