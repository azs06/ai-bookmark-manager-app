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
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  importance      INTEGER NOT NULL DEFAULT 0,   -- 0 normal, 1 important, 2 pinned
  view_count      INTEGER NOT NULL DEFAULT 0,
  last_viewed_at  INTEGER,
  content_excerpt TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending', -- pending, active, partial, failed, imported, archived
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at  ON bookmarks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_importance  ON bookmarks(importance DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_status      ON bookmarks(status);
CREATE INDEX IF NOT EXISTS idx_bookmarks_domain      ON bookmarks(domain);
CREATE INDEX IF NOT EXISTS idx_bookmarks_category_id ON bookmarks(category_id);

-- Raindrop-style hierarchical collections. parent_id = NULL → top-level.
-- ON DELETE of a category: bookmarks go to "Uncategorized" (ON DELETE SET NULL
-- on bookmarks.category_id). Child categories are re-parented in application
-- code (DELETE /api/categories/:id) so the tree survives rather than cascades.
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  parent_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

-- Sibling names must be unique. SQLite's UNIQUE treats NULLs as distinct, so
-- COALESCE(parent_id, 0) collapses top-level siblings into a single bucket.
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_sibling
  ON categories(COALESCE(parent_id, 0), name COLLATE NOCASE);

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
