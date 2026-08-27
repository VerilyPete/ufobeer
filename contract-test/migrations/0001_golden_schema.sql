-- Test fixture copied from schema.sql and migrations/0005_add_store_taplist_cache.sql,
-- migrations/0008_add_cache_etag_columns.sql, and migrations/0009_add_enrichment_hash.sql.
-- This file is intentionally isolated from production migrations.

CREATE TABLE IF NOT EXISTS enriched_beers (
  id TEXT PRIMARY KEY,
  brew_name TEXT NOT NULL,
  brewer TEXT,
  abv REAL,
  confidence REAL DEFAULT 0.5,
  enrichment_source TEXT DEFAULT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  last_seen_at INTEGER,
  last_verified_at INTEGER DEFAULT NULL,
  is_verified INTEGER DEFAULT 0,
  brew_description_original TEXT,
  brew_description_cleaned TEXT,
  description_hash TEXT,
  description_cleaned_at INTEGER,
  cleanup_source TEXT,
  queued_for_cleanup_at INTEGER,
  enrichment_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS store_taplist_cache (
  store_id TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  cached_at INTEGER NOT NULL,
  content_hash TEXT,
  enrichment_hash TEXT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  client_identifier TEXT NOT NULL,
  minute_bucket INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (client_identifier, minute_bucket)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  api_key_hash TEXT,
  client_ip TEXT,
  user_agent TEXT,
  status_code INTEGER,
  response_time_ms INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS enrichment_limits (
  date TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_updated INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS cleanup_limits (
  date TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_updated INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
