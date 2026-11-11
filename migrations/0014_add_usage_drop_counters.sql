-- Migration 0014: per-day drop counters on usage_ingest_daily
-- (plans/usage-dashboards.md, slice 2). Each counts posts or event entries
-- POST /usage did not store that UTC day, and stops at a daily ceiling
-- (USAGE_DROP_COUNTER_DAILY_CEILING), so a value at the ceiling means
-- "at least". duplicates, dropped_post_cap, dropped_new_install and
-- dropped_all_events count reports; dropped_events counts event entries
-- dropped from reports whose other events were stored.
ALTER TABLE usage_ingest_daily ADD COLUMN duplicates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_ingest_daily ADD COLUMN dropped_post_cap INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_ingest_daily ADD COLUMN dropped_new_install INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_ingest_daily ADD COLUMN dropped_all_events INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_ingest_daily ADD COLUMN dropped_events INTEGER NOT NULL DEFAULT 0;
