-- Usage telemetry for POST /usage (plans/usage-telemetry.md).
-- usage_daily:        per-install daily feature counts, keyed by dimension tuple
-- usage_installs:     install IDs seen, for the daily new-install budget and retention
-- usage_batches:      (install, batch) pairs already counted, so a resent batch is ignored
-- usage_ingest_daily: posts accepted per UTC day, for the daily post budget

CREATE TABLE IF NOT EXISTS usage_daily (
  day         TEXT    NOT NULL,
  install_id  TEXT    NOT NULL,
  event       TEXT    NOT NULL,
  app_version TEXT    NOT NULL,
  ai_status   TEXT    NOT NULL,
  os_major    INTEGER NOT NULL,
  count       INTEGER NOT NULL,
  PRIMARY KEY (day, install_id, event, app_version, ai_status, os_major)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_install ON usage_daily (install_id, day);

CREATE TABLE IF NOT EXISTS usage_installs (
  install_id     TEXT NOT NULL PRIMARY KEY,
  first_seen_day TEXT NOT NULL,
  last_seen_day  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_installs_first_seen ON usage_installs (first_seen_day);
CREATE INDEX IF NOT EXISTS idx_usage_installs_last_seen  ON usage_installs (last_seen_day);

CREATE TABLE IF NOT EXISTS usage_batches (
  install_id  TEXT    NOT NULL,
  batch_id    TEXT    NOT NULL,
  request_id  TEXT    NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (install_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_batches_received ON usage_batches (received_at);

CREATE TABLE IF NOT EXISTS usage_ingest_daily (
  day   TEXT    NOT NULL PRIMARY KEY,
  posts INTEGER NOT NULL
);
