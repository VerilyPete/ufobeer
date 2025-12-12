-- ============================================================================
-- enriched_beers: Core table storing beer enrichment data
-- ============================================================================
-- Column names match Flying Saucer API / mobile app convention for consistency
-- id = Flying Saucer beer ID (global across all locations)
CREATE TABLE IF NOT EXISTS enriched_beers (
    id TEXT PRIMARY KEY,
    brew_name TEXT NOT NULL,
    brewer TEXT,
    abv REAL,
    confidence REAL DEFAULT 0.5,
    enrichment_source TEXT DEFAULT 'perplexity',  -- 'description' | 'perplexity'
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    last_seen_at INTEGER,                          -- When beer was last on a taplist
    last_verified_at INTEGER DEFAULT NULL,
    is_verified INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_beer_name ON enriched_beers(brew_name);
CREATE INDEX IF NOT EXISTS idx_brewer ON enriched_beers(brewer);
CREATE INDEX IF NOT EXISTS idx_needs_enrichment ON enriched_beers(abv) WHERE abv IS NULL;
CREATE INDEX IF NOT EXISTS idx_source_last_seen ON enriched_beers(enrichment_source, last_seen_at);

-- ============================================================================
-- system_state: Key-value store for locks and configuration
-- ============================================================================
CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- ============================================================================
-- rate_limits: Tracks requests per client per minute
-- ============================================================================
CREATE TABLE IF NOT EXISTS rate_limits (
    client_identifier TEXT NOT NULL,
    minute_bucket INTEGER NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (client_identifier, minute_bucket)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_bucket ON rate_limits(minute_bucket);

-- ============================================================================
-- audit_log: Request tracking for debugging and security
-- ============================================================================
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

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_log(request_id);

-- ============================================================================
-- enrichment_limits: Circuit breaker tracking for Perplexity API costs
-- ============================================================================
-- Tracks daily request counts to enforce spending limits
-- PRIMARY KEY on date creates an index automatically
CREATE TABLE IF NOT EXISTS enrichment_limits (
    date TEXT PRIMARY KEY,  -- "2025-01-15" format
    request_count INTEGER NOT NULL DEFAULT 0,
    last_updated INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- ============================================================================
-- dlq_messages: Dead Letter Queue message storage for admin inspection
-- ============================================================================
-- Stores messages that failed enrichment after exhausting retries
-- Enables persistent history, filtering, and manual replay/acknowledgment
CREATE TABLE IF NOT EXISTS dlq_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Message identification
    message_id TEXT NOT NULL UNIQUE,       -- Original queue message ID

    -- Beer data from message body
    beer_id TEXT NOT NULL,
    beer_name TEXT,
    brewer TEXT,

    -- Failure metadata
    failed_at INTEGER NOT NULL,            -- Timestamp when message hit DLQ (ms)
    failure_count INTEGER DEFAULT 3,       -- Number of retries before DLQ (from message.attempts)
    failure_reason TEXT,                   -- Last error message if captured

    -- Source tracking
    source_queue TEXT NOT NULL DEFAULT 'beer-enrichment',  -- Queue that sent to DLQ

    -- Status tracking
    -- pending: awaiting action
    -- replaying: optimistic status during replay (prevents race conditions)
    -- replayed: successfully sent back to main queue
    -- acknowledged: manually dismissed
    status TEXT NOT NULL DEFAULT 'pending',

    -- Replay tracking
    replay_count INTEGER DEFAULT 0,        -- Number of times message has been replayed

    -- Action timestamps (NULL until action taken)
    replayed_at INTEGER,                   -- When message was replayed to main queue
    acknowledged_at INTEGER,               -- When message was acknowledged/dismissed

    -- Full message for debugging
    raw_message TEXT                       -- JSON stringified original message body
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_dlq_status ON dlq_messages(status);
CREATE INDEX IF NOT EXISTS idx_dlq_beer_id ON dlq_messages(beer_id);
CREATE INDEX IF NOT EXISTS idx_dlq_failed_at ON dlq_messages(failed_at);
CREATE INDEX IF NOT EXISTS idx_dlq_status_failed ON dlq_messages(status, failed_at);

-- Indexes for cleanup queries (important for efficient DELETE operations)
CREATE INDEX IF NOT EXISTS idx_dlq_acknowledged_at ON dlq_messages(acknowledged_at);
CREATE INDEX IF NOT EXISTS idx_dlq_replayed_at ON dlq_messages(replayed_at);

-- Index for cursor-based pagination
CREATE INDEX IF NOT EXISTS idx_dlq_status_failed_id ON dlq_messages(status, failed_at, id);