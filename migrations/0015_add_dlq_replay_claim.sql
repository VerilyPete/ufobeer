-- Migration 0015: a lease on DLQ replay claims (plans/enriched-beers-write-paths.md,
-- slice 1 addendum). replay_claim is the claiming request's random token: every
-- write a replay makes is guarded on it, so a request whose claim was reaped or
-- taken over changes nothing. replay_claimed_at is the claim time, used only by
-- the cron reaper to return claims older than DLQ_REPLAY_CLAIM_STALE_MS to
-- pending. Both are NULL outside a claim.
-- NOT IDEMPOTENT: relies on migration tracking to prevent re-runs
ALTER TABLE dlq_messages ADD COLUMN replay_claim TEXT;
-- NOT IDEMPOTENT: relies on migration tracking to prevent re-runs
ALTER TABLE dlq_messages ADD COLUMN replay_claimed_at INTEGER;
