# Plan: make api.ufobeer.app the only API host and give the apex to the website

Status: draft, not started. Written 2026-10-29. Revised the same day: no apex compatibility. Pete forces the update by expiring the old TestFlight builds.
Companion: the app-side handoff is at
`/Users/pete/claude/BeerSelector/plans/handoff-app-api-subdomain.md`.

## End state

- `https://api.ufobeer.app` is the API's only hostname.
- `https://ufobeer.app` belongs to the static website: an assets-only Worker with no script, so asset requests are free and not billed as invocations. Every apex path, including `/beers`, `/health` and `/admin/*`, gets the site, not the API.
- No legacy routes, no redirects from apex API paths, no host-specific branches in the Worker.

## What is already true (verified 2026-10-29)

- `api.ufobeer.app` is a Custom Domain on the `ufobeer` Worker, live since 2026-08-28.
- The apex `ufobeer.app` reaches the same Worker. `/health` returns 200 on both.
- `wrangler.jsonc` has no `routes` key, so the domains are managed in the dashboard.
- The WAF keyless-`/beers*` rule is already scoped to `api.ufobeer.app`. It needs no change.
- Shipped app builds call the apex because their configured `EnrichmentURL` is `https://ufobeer.app`. No Swift code hardcodes the host.
- When enrichment fails, the app falls back to the direct Flying Saucer taplist (`native-ios/Docs/PARITY.md`, "fallback direct"; the app session confirms this). So an old build left behind after the cutover loses ABV and cleaned descriptions but still works. That makes the forced update a quality issue, not an outage.

## Sequence

The only hard ordering constraint: **the apex comes off the API after the new build is out and Pete has forced the update.** Everything else is independent.

### Phase 0: inventory (read-only)

- List the `ufobeer` Worker's custom domains and routes via the Cloudflare API. Record them here.
- Confirm nothing else depends on the apex reaching the API: monitors, the GitHub workflows, contract tests, scripts in this repo, and Pete's own shortcuts. The test suites already use `https://api.ufobeer.app` in their request URLs.
- Confirm the apex's MX/email records (for `alerts@ufobeer.app`) are separate from the Worker Custom Domain records, so moving the domain doesn't touch mail.
- Check whether the GitHub Actions `CLOUDFLARE_API_TOKEN` has Zone > Workers Routes > Write for `ufobeer.app`. It's needed once Wrangler manages domains.

#### Phase 0 results (2026-10-29)

- **Custom Domains** (`GET /accounts/{acct}/workers/domains`): `ufobeer.app` → `ufobeer` and `api.ufobeer.app` → `ufobeer`, both production. Zone id `60e04d5b906cac9648efc32edfadaed5`.
- **Zone routes:** none. Nothing else in the account claims a `ufobeer.app` hostname. `ufobeer-error-alerts` has no HTTP surface.
- **DNS:** apex MX is `route{1,2,3}.mx.cloudflare.net` and SPF is `include:_spf.mx.cloudflare.net`, i.e. Email Routing records that are separate from the Worker's A/AAAA records. Moving the Custom Domain doesn't touch mail. `www.ufobeer.app` has no record.
- **Clients (D1 `audit_log`, 30 days, oldest row 2026-09-29, 28,284 rows):** the only legitimate API client is the native app (`BeerSelector/1.1.0 (iOS; Native)`): `/beers/batch` 208, `/beers` 169, `/beers/sync` 5. There are 2 hits on 2026-10-07 from a bare `BeerSelector/1.1.0` user agent. Every `/admin/*` request was a scanner (401/429). **Correction (tail, 2026-10-29):** UptimeRobot polls `https://ufobeer.app/health`. The audit log didn't show it because a successful `/health` isn't audited (only the 429s were), so audit-log absence is not evidence of no traffic on unaudited routes. No browser client made a successful API call, which is evidence for the Phase 4 CORS removal. The rest of the volume is scanners probing `/`, `/.env`, `/wp-admin` and so on. After cutover that traffic lands on the static site and stops costing D1 audit writes.
- **References to the apex in tracked files:** only `ALLOWED_ORIGIN` (in `wrangler.jsonc`, `worker-configuration.d.ts`, the CORS tests and AGENTS.md), plus one test request URL (`test/handlers/beers.list.test.ts:230`; cosmetic, could become `api.`). The admin curl docs under `docs/` are **gitignored, local-only** files, so the Phase 2 edits to them are local. App docs are owned by the handoff.
- **CI token:** `CLOUDFLARE_API_TOKEN` (created 2026-02-27) deploys successfully, but its scopes can't be read from here. **Pete to check:** in the dashboard under API Tokens, it needs *Zone > Workers Routes > Edit* on `ufobeer.app` before Phase 1 merges. Without it, the first deploy that declares `routes` fails after uploading the script. That's harmless because the code is unchanged, but the deploy goes red.
- **Precedent for the static site:** `/Users/pete/Documents/verilytech-site` (`VerilyPete/verilytech-site`) already uses this pattern: `assets.directory: ./public`, `not_found_handling: "404-page"`, Custom Domains for the apex and www, and CI. The ufobeer site copies it without `main` or `send_email`. It can also claim `www.ufobeer.app`.

### Phase 1: put the existing domains in wrangler.jsonc (no-op)

Finding (2026-10-29): Wrangler publishes Custom Domains with `POST .../workers/scripts/ufobeer/domains/changeset?replace_state=true` followed by `PUT .../domains/records`. That **replaces the Worker's entire domain set**. Calling the changeset endpoint (read-only, it only computes a diff) with only `api.ufobeer.app` returned `removed: ["ufobeer.app"]`. So an api-only config would take the apex down on the next deploy, breaking every shipped build.

So Phase 1 declares **both** current domains. The changeset for `[api.ufobeer.app, ufobeer.app]` returned no additions, removals or modifications, i.e. an exact no-op. The apex leaves the config at cutover.

- Branch `chore/api-domain-in-config` (worktree `../ufobeer-api-host`), from `origin/main` 6dcdbe6.
- `wrangler deploy --dry-run` passes. 1,431 tests pass.
- After the CI deploy: run probes A–C on both hosts and re-list the domains. Expect the same two, both on `ufobeer`.

### Phase 2: docs

- Change the admin curl examples in `docs/admin-trigger-cleanup.md` and `docs/cleanup-trigger-phases/03-routing.md` to `https://api.ufobeer.app`.
- In `plans/security-runbook.md`: the surface table gets an apex row ("website Worker, not the API"), and the stale "api.ufobeer.app has no DNS record" note in §2 goes.
- Update AGENTS.md wherever it names a host.

### Phase 3: cutover (gated on the app release and forced update)

Gate: the app session has reported the first build on `api.ufobeer.app`, that build is on TestFlight, and Pete has expired every older build.

Gate status (app session report, 2026-10-29):
- [x] First build on the api host: **1.1.0 (89)**, from BeerSelector #54 (283025e4). It's in Xcode Cloud post-actions and hasn't reached testers yet.
- [x] Xcode Cloud secret updated. External mode stops the build if the secret is invalid, and build 89 got past it.
- [x] Live checks on `api.ufobeer.app` with the app's User-Agent: `/health` 200, `/beers` 200 with ABV, 304 on `If-None-Match`, 401 on a wrong key.
- [x] Old builds after cutover fall back to the direct taplist and keep cached ABV. They don't follow redirects, so they never send the key to the site. Covered by `NetworkTests.testRetiredEnrichmentHostFallsBackToDirectTaplistAndKeepsCachedEnrichment`.
- [x] Build 89 seen in practice calling only `api.ufobeer.app`: in a `wrangler tail` on 2026-10-29 at 17:51Z, all 7 requests with the `BeerSelector/1.1.0 (iOS; Native)` user agent (`/beers` 304, `/beers/batch` 200) went to the api host. None went to the apex.
- [x] UptimeRobot repointed to `https://api.ufobeer.app/health`. Seen in the tail at 17:54Z, returning 200.
- [ ] Pete expires every TestFlight build older than 89.

Hazard: in CI, Wrangler runs non-interactively and automatically sets `override_existing_origin`. Any `ufobeer` deploy whose config still lists `ufobeer.app` will **silently take the apex back** from the site. The `ufobeer` config change therefore has to land at the same time as the handover. Freeze other `ufobeer` merges during the cutover.

1. Open the `ufobeer` PR that removes `ufobeer.app` from `routes`, and get it reviewed but not merged.
2. Deploy the static site (`ufobeer-site`: `wrangler.jsonc` with `assets.directory` and no `main`) with `{"pattern": "ufobeer.app", "custom_domain": true}`. Accept the prompt to take the domain over from `ufobeer`. That reassigns it in one step with no DNS gap. Add `www.ufobeer.app` too if wanted.
   - If the site isn't ready by the gate, skip this step. Merging step 3 alone detaches the apex, and it serves nothing until the site lands.
3. Merge the step-1 PR right away. Before merging, re-run the changeset check with api-only. After the handover, expect `removed: []`, because the apex no longer belongs to `ufobeer`.
4. Run probes A–D and re-list the domains: `ufobeer.app` → `ufobeer-site`, `api.ufobeer.app` → `ufobeer`.

Rollback: revert the step-3 PR. Its CI deploy re-claims the apex through the automatic override, which is the same mechanism as the hazard.

### Phase 4: follow-ups (optional, each its own TDD change)

- **CORS:** `ALLOWED_ORIGIN` is `https://ufobeer.app`, and the Worker returns 500 when it's unset. No browser client should ever call the API, because the key can't live in a web page. Consider removing CORS handling entirely. It's a behavior change, so it needs a failing test first. Not required for the cutover.
- Watch Observability for a week after cutover for API traffic that 404s on the api host (it would indicate a client on a wrong path). Apex traffic now goes to the site Worker's metrics, not the API's.

## Verification

Use the real key from a secure source and never print it.

- A. `GET https://api.ufobeer.app/health` → 200 with the Golden Taproom contract payload.
- B. `GET https://api.ufobeer.app/beers?sid=13879` with no key → edge 403.
- C. Same request with the key → 200. `If-None-Match` with the returned ETag → 304. Admin `GET /admin/dlq/stats` with both secrets → 200.
- D. After cutover: `https://ufobeer.app/`, `/health`, `/beers` and `/admin/dlq` all come from the site Worker (HTML or the site's 404), never JSON from the API. A build on the new config still enriches the taplist (the app session checks this).

## Open questions for Pete

- Where should the static site's source live: its own repo, or a `site/` directory in this one?
