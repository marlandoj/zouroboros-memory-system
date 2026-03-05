-- Zo Persona Memory System Schema
-- SQLite with FTS5 for full-text search
-- No external dependencies required

-- Main facts table
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  persona TEXT NOT NULL DEFAULT 'shared',    -- 'shared' or persona name
  entity TEXT NOT NULL,                       -- 'user', 'project', 'decision', etc.
  key TEXT,                                   -- attribute name
  value TEXT NOT NULL,                        -- the fact itself
  text TEXT,                                  -- full context for FTS
  category TEXT DEFAULT 'fact',               -- 'preference', 'fact', 'decision', 'convention'
  decay_class TEXT DEFAULT 'stable',          -- 'permanent', 'stable', 'active', 'session', 'checkpoint'
  importance REAL DEFAULT 1.0,                -- 0.0 to 1.0
  source TEXT,                                -- where this came from
  created_at INTEGER NOT NULL,                -- unix timestamp ms
  expires_at INTEGER,                         -- unix timestamp seconds, NULL = never
  last_accessed INTEGER,                      -- unix timestamp seconds
  confidence REAL DEFAULT 1.0,                -- 0.0 to 1.0, decays over time
  metadata TEXT                               -- JSON for extra fields
);

-- FTS5 virtual table for text search
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  text,
  entity,
  key,
  value,
  category,
  content='facts',
  content_rowid='rowid'
);

-- Triggers to keep FTS5 in sync
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, text, entity, key, value, category)
  VALUES (new.rowid, new.text, new.entity, new.key, new.value, new.category);
END;

CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text, entity, key, value, category)
  VALUES ('delete', old.rowid, old.text, old.entity, old.key, old.value, old.category);
END;

CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text, entity, key, value, category)
  VALUES ('delete', old.rowid, old.text, old.entity, old.key, old.value, old.category);
  INSERT INTO facts_fts(rowid, text, entity, key, value, category)
  VALUES (new.rowid, new.text, new.entity, new.key, new.value, new.category);
END;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_facts_persona ON facts(persona);
CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class);
CREATE INDEX IF NOT EXISTS idx_facts_expires ON facts(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at);
CREATE INDEX IF NOT EXISTS idx_facts_lookup ON facts(entity, key);

-- TTL defaults table (in seconds)
CREATE TABLE IF NOT EXISTS ttl_defaults (
  decay_class TEXT PRIMARY KEY,
  ttl_seconds INTEGER  -- NULL means never expires
);

INSERT OR IGNORE INTO ttl_defaults VALUES
  ('permanent', NULL),
  ('stable', 7776000),      -- 90 days
  ('active', 1209600),      -- 14 days
  ('session', 86400),       -- 24 hours
  ('checkpoint', 14400);    -- 4 hours

-- Associative links between facts (graph intelligence)
CREATE TABLE IF NOT EXISTS fact_links (
  source_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'related',
  weight REAL DEFAULT 1.0,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (source_id, target_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_fact_links_source ON fact_links(source_id);
CREATE INDEX IF NOT EXISTS idx_fact_links_target ON fact_links(target_id);

-- Auto-capture history log
CREATE TABLE IF NOT EXISTS capture_log (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  transcript_hash TEXT NOT NULL,
  facts_extracted INTEGER,
  facts_skipped INTEGER,
  contradictions INTEGER,
  model TEXT,
  duration_ms INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);
