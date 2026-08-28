# Security Runbook — api.ufobeer.app

Operational checklist for the controls that live outside the repo (Cloudflare
dashboard, GitHub settings, secrets). Code-level controls are in `src/` and
documented in `AGENTS.md`. Last reviewed: 2026-08-28.

## Surface summary

| Surface | Auth | Notes |
|---|---|---|
| `api.ufobeer.app` | `X-API-Key` (all routes) | Only intended public surface |
| `/health` | none | Contract-locked (Golden Taproom); throttled by the pre-auth per-IP limiter (`PRE_AUTH_RPM`, default 30/min) |
| `/admin/*` | `X-API-Key` + `X-Admin-Secret` | Second timing-safe check layered on the client key |
| `*.workers.dev` | — | **Main worker: disabled flag set**, effective next deploy (§1). Tail worker: disabled (no HTTP surface) |
| Cron `*/20 * * * *` | n/a | Not reachable via HTTP; admin triggers are the manual equivalents |
| Queues / tail worker | n/a | No HTTP surface |

## 1. Zone controls (Cloudflare dashboard, ufobeer.app zone)

In-worker limiting is the first line (pre-auth 30/min/IP, post-auth 60/min per
key); these edge rules are the backstop and cover anything the worker misses.

- [x] **Add the custom domain** (Workers & Pages → ufobeer → Settings →
      Domains & Routes → Add Custom Domain): `api.ufobeer.app`.
      **Done & verified live 2026-08-28** — `/health` returns 200 with the
      contract payload.
- [x] **Disable the workers.dev URL**: `"workers_dev": false` is set in
      `wrangler.jsonc`. **Deployed & verified 2026-08-28** —
      `ufobeer.pete-147.workers.dev/health` returns 404; custom domain serves.
- [ ] **WAF rate-limit rule** (free plan includes exactly 1) — spend it on
      `/health`, the only unauthenticated route:
      - Expression: `http.request.uri.path eq "/health"`
      - Count: 20 requests per **10 s** (free tier's only window), counted
        per IP, characteristic = IP
      - Action: Block, mitigation timeout **10 s** (also fixed on free)
      Free-tier rate-limit rules can only match path/Verified-Bot and only
      use 10 s windows — no per-minute shaping at the edge. That's fine: the
      in-worker pre-auth limiter (`PRE_AUTH_RPM`, 30/min/IP) is the real
      shaper; this rule just flattens floods before they reach D1.
      Gotcha (hit 2026-08-28): any other field in the expression — even
      `http.host` — fails with "The available fields do not support rate
      limiting based on request count". The expression must be path-only;
      hostname scoping is only possible in Custom rules. If the bare path
      expression is still rejected, skip this rule — the in-worker limiter
      is the primary control.
- [x] **Custom WAF rule** (free includes 5; this uses 1): reject `/beers*`
      requests lacking `X-API-Key` at the edge, keeping junk off the worker.
      Custom rules (unlike free rate-limiting rules) can use the hostname
      field, so scope it to the API subdomain:
      `(http.host eq "api.ufobeer.app" and starts_with(http.request.uri.path, "/beers") and not any(http.request.headers["x-api-key"][*] != ""))` → Block.
      **Deployed & verified 2026-08-28** — keyless `/beers` → 403 at edge;
      with key → worker's JSON 401.
- [ ] **Bot Fight Mode — deliberately left OFF.** On the free tier it is
      zone-wide with no path exclusions, and it challenges "definitely
      automated" traffic — i.e., every API client (the app, curl, monitors).
      Enabling it risks breaking legitimate API calls; revisit only if
      scraping becomes a real problem, and re-verify the app still connects
      immediately after turning it on.
- [ ] Optional: **Cloudflare Access** (Zero Trust, free ≤50 users) service-token
      policy in front of `api.ufobeer.app/admin/*` — adds a third credential
      layer beyond `X-API-Key` + `X-Admin-Secret`. Skip unless threat model
      justifies the call friction.

**Free-plan limits worth knowing** (not blockers): the full Cloudflare/OWASP
managed rulesets and advanced rate limiting (header/ASN/JA4 matching, longer
windows) are paid-only; free gets the small "Free Managed Ruleset". With
in-worker auth + validation + fail-closed limiting already in place, the
missing pieces matter little at this traffic level.

## 2. Deploy verification (run after every deploy that changes config)

```bash
# Custom domain serves the worker (only after §1 domain setup — currently
# api.ufobeer.app has no DNS record)
curl -s https://api.ufobeer.app/health | jq .status          # "ok"

# After enabling "workers_dev": false, the preview must be gone
# (expect 404 / DNS error, NOT a JSON response)
curl -s -o /dev/null -w '%{http_code}\n' https://ufobeer.<subdomain>.workers.dev/health

# Unauthenticated request rejected, no internals leaked
curl -s https://api.ufobeer.app/beers?sid=13879              # {"error":"Unauthorized"}

# Migrations applied
npm run migrate:list
```

## 3. GitHub Actions tokens (GitHub → repo Settings → Secrets and variables → Actions)

`CLOUDFLARE_API_TOKEN` currently deploys both workers and applies D1
migrations. Scope tokens by job:

- [ ] **Deploy token** (used by `deploy.yml`): account → Workers Scripts:Edit,
      D1:Edit. No zone, R2, or account-level permissions.
- [ ] **Backup token** (used by `backup.yml`, secret name
      `CLOUDFLARE_BACKUP_API_TOKEN`): account → D1:Edit (export needs write —
      it snapshots), Workers R2 Storage:Edit. Nothing else.
- [ ] `CLOUDFLARE_ACCOUNT_ID` is not a secret (it's an identifier) but keep it
      as a secret for consistency.
- [ ] Rotate both tokens annually or on any suspicion of leakage
      (Dashboard → My Profile → API Tokens → roll).

## 4. Secret rotation procedure

All three secrets are set via `wrangler secret put` from a machine with an
authorized Cloudflare login. Rotation is instant (next request uses the new
value); there are currently **no production clients holding `API_KEY`**, so
rotation requires no coordination today. When BeerSelector starts consuming
the API, add a dual-key grace window (`API_KEY_PREVIOUS`) before rotating.

```bash
# Generate a high-entropy value
openssl rand -base64 32

wrangler secret put API_KEY             # client key (X-API-Key)
wrangler secret put ADMIN_SECRET        # admin (X-Admin-Secret)
wrangler secret put PERPLEXITY_API_KEY  # external Perplexity key — rotate in the Perplexity dashboard too
```

- [x] Verify current `API_KEY` / `ADMIN_SECRET` entropy; rotate immediately if
      either is human-chosen or short. **Rotated 2026-08-28** (both regenerated
      with `openssl rand -base64 32` and installed via `wrangler secret put`).
- [ ] After rotating, confirm: valid key works, old key returns 401, admin
      routes still authorize, audit log shows new `api_key_hash` prefix.
- [ ] Cadence: annually, or immediately after any machine with `wrangler`
      logins/`.dev.vars` is compromised or decommissioned.

## 5. Backups & recovery

- **D1 Time Travel**: 30-day point-in-time restore, always on. Primary
  recovery path for bad writes/migrations (documented in AGENTS.md).
- **Weekly logical export**: `.github/workflows/backup.yml` (Mondays 06:00
  UTC) → `wrangler d1 export` → R2 bucket `ufobeer-backups`.

- [ ] Create the R2 bucket `ufobeer-backups` and set a **90-day object
      lifecycle rule** (Dashboard → R2 → bucket → Settings).
- [x] Add the `CLOUDFLARE_BACKUP_API_TOKEN` GitHub secret (§3), then run
      `backup.yml` once via **Run workflow** and confirm an object lands in
      the bucket. **Done & verified 2026-08-28** — export + R2 upload green.
      (First attempt failed on a paste-corrupted token: a Cyrillic homoglyph
      in the secret caused a ByteString header error. Copy tokens only via
      the dashboard Copy button and check `pbpaste` for non-ASCII.)
- [ ] Restore drill (quarterly, ~10 min): download an export, load it into a
      scratch local DB (`wrangler d1 execute beer-db --local --file=...`
      against a temp database) and sanity-check row counts. Time Travel
      restores go through Cloudflare support/dashboard — know the path before
      you need it.

## 6. Logging, audit, retention

- `audit_log` (D1): per-request rows including `client_ip`, `user_agent`,
  truncated `api_key_hash`. Auto-purged after 30 days (`src/constants.ts`).
  Failed-auth rows are the brute-force signal — the pre-auth limiter caps how
  many an attacker can generate (30/min/IP).
- Workers observability (`persist: true`, 100% sampling): retains operational
  metadata in Cloudflare's log store.
- [ ] Record chosen observability retention (Dashboard → Workers → ufobeer →
      Logs; default retention applies if unset).
- [ ] Tail worker emails error traces to `alerts-to@ufobeer.app`
      (`TO_ADDRESS` var). Confirm delivery with a one-off test: temporarily
      push a bad deploy to a preview branch? — simpler: `wrangler tail` while
      hitting a 401 and watch for the trace.

## 7. Known accepted trade-offs

- Edge protection is free-tier only (one 10 s rate-limit rule, five custom
  rules, no managed-ruleset depth). The in-worker controls — API-key auth,
  pre-auth + per-endpoint limits, fail-closed degradation, zod validation —
  are the primary security boundary; the edge is flood insurance.
- `/health` is unauthenticated and exposes quota usage/limits (contract-locked;
  payload contains no secrets). Throttled, not gated.
- Fixed-window rate limiting allows a ~2x burst at minute boundaries. Durable
  Object token buckets would fix this; unnecessary at current traffic.
- Rate limiter **fails closed** (503) on D1 errors — deliberate: D1 is a hard
  dependency for every data path anyway.
- `X-Forwarded-For` IP fallback exists for local dev only; production clients
  always present `CF-Connecting-IP` (set by the edge, not spoofable).

## 8. Follow-ups outside this repo (BeerSelector)

- [x] **PII removed from BeerSelector repo** (2026-08-28): `mockSession.ts`
      and the `mybeers.json` fixture sanitized in the working tree, and all
      personal data (email, member ID, name, card numbers, session ID)
      purged from git history across `main`, three feature branches, and two
      tags via `git filter-repo`; force-pushed and verified from a fresh
      clone. The exposed beerknurd session token should be treated as
      compromised — change the Flying Saucer account password if not
      already done.
- [x] `auth_cookies` no longer stored in plaintext SQLite (2026-08-28):
      captured login cookies now go to SecureStore
      (`sessionManager.saveAuthCookies`), a startup migration moves legacy
      preference rows to SecureStore on next Settings visit
      (`src/services/authCookieMigration.ts`), and the Settings screen masks
      values for sensitive-looking preference keys.
- [ ] No certificate pinning; all traffic relies on standard TLS.
