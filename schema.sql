-- AI Bookmark Manager — D1 schema
-- Run: npm run db:init:local   (local dev)
--      npm run db:init:remote  (production)

CREATE TABLE IF NOT EXISTS bookmarks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT    NOT NULL,
  url_hash        TEXT    NOT NULL UNIQUE,
  title           TEXT,
  note            TEXT    NOT NULL DEFAULT '',
  og_image_url    TEXT,
  og_description  TEXT,
  domain          TEXT,
  ai_summary      TEXT,
  ai_tags         TEXT    NOT NULL DEFAULT '[]',
  importance      INTEGER NOT NULL DEFAULT 0,   -- 0 normal, 1 important, 2 pinned
  view_count      INTEGER NOT NULL DEFAULT 0,
  last_viewed_at  INTEGER,
  content_excerpt TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending', -- pending, active, partial, failed, archived
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at  ON bookmarks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_importance  ON bookmarks(importance DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_status      ON bookmarks(status);
CREATE INDEX IF NOT EXISTS idx_bookmarks_domain      ON bookmarks(domain);

CREATE TABLE IF NOT EXISTS import_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  total       INTEGER NOT NULL DEFAULT 0,
  completed   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Cached daily "what matters today" picks from Haiku
CREATE TABLE IF NOT EXISTS daily_suggestions (
  date          TEXT    PRIMARY KEY,  -- YYYY-MM-DD
  bookmark_ids  TEXT    NOT NULL,     -- JSON array of ints
  reasons       TEXT    NOT NULL,     -- JSON object {id: "why"}
  created_at    INTEGER NOT NULL
);
