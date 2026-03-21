---
title: Tail worker for error alerting via email
implemented: 2026-02-27
commit: 7823cb6
tags: [tail-worker, alerting, email, cloudflare, observability]
---

## Problem

Errors in the main UFO Beer worker went unnoticed — logs existed but nobody saw them until manually checking the Cloudflare dashboard. No proactive alerting.

## Decision

A separate Cloudflare Worker (`ufobeer-error-alerts`) with a `tail()` handler. The main worker references it via `tail_consumers`. Email sent via Cloudflare's native `send_email` binding (no runtime dependencies) from `alerts@ufobeer.app` to a configurable destination.

**Error detection** uses an allowlist of known-benign outcomes (`ok`, `canceled`, `responseStreamDisconnected`) — unknown future outcomes default to alerting (safe default). A trace is an error if outcome is not in the allowlist, OR `exceptions.length > 0`, OR any log entry has `level === 'error'`.

**Cooldown**: In-memory 5-minute dedup keyed by `${outcome}:${firstExceptionName || 'error-logs'}`. Isolate recycle resets cooldown — acceptable tradeoff. `getSuppressedCount` is a destructive read; suppressed count appears in the next outgoing email.

**Email format**: Hand-built RFC 5322 (`\r\n` throughout). No `mimetext` dependency. Critical undocumented Cloudflare requirement: `Message-ID` header is required or `send_email` rejects the message. Email Routing also requires at least one routing rule configured (even a catch-all) or `send_email` fails with "destination address is not a verified address."

**Deployment ordering**: Tail worker MUST be deployed before the main worker references it via `tail_consumers`. If the tail worker doesn't exist, the main worker deploy fails.

**Error handling**: Two-level try/catch — inner around `SEND_EMAIL.send()` (logs failure, doesn't throw), outer around the entire handler (sends a fallback "failed to process N traces" email; if even that fails, logs and swallows).

**Tests**: Plain vitest (not `@cloudflare/vitest-pool-workers`) — the tail worker has no D1/KV/queues, only pure functions and a mocked binding. 47 tests across 4 files.

## Trade-offs

- In-memory cooldown resets on isolate recycle — could send burst of emails after a cold start during an error storm. Acceptable given rarity.
- `destination_address` in `wrangler.jsonc` is a Cloudflare infrastructure requirement and cannot be removed. See 09-security-fixes for moving the email address to an env var.
- CI/CD integration deferred (tail worker changes rarely, no migrations). Done in 08.
