-- Migration 0013: daily cap on Exa calls for the Untappd ABV fallback.
-- One row per UTC day; reserveAbvFallbackSlot (src/db/quota.ts) grants a slot
-- only through a conditional increment. Rows older than 90 days are reaped by
-- the cron, like enrichment_limits.
CREATE TABLE IF NOT EXISTS abv_fallback_limits (
    date TEXT PRIMARY KEY,
    request_count INTEGER NOT NULL DEFAULT 0,
    last_updated INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
