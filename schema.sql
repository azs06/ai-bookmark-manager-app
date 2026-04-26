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
  content_type    TEXT,                                -- 'video' | NULL (future: 'podcast', 'pdf', …)
  metadata        TEXT    NOT NULL DEFAULT '{}',       -- JSON bag for type-specific fields
  http_status     INTEGER,                             -- last URL probe result (404/410 = dead)
  last_checked_at INTEGER,                             -- when the URL was last probed
  markdown_cached    TEXT,                             -- last fetched markdown (View as Markdown)
  markdown_cached_at INTEGER,                          -- when the cache was populated
  markdown_source    TEXT,                             -- 'cf-markdown' | 'jina' | 'reddit'
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at   ON bookmarks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_importance   ON bookmarks(importance DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_status       ON bookmarks(status);
CREATE INDEX IF NOT EXISTS idx_bookmarks_domain       ON bookmarks(domain);
CREATE INDEX IF NOT EXISTS idx_bookmarks_category_id  ON bookmarks(category_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_content_type ON bookmarks(content_type);
CREATE INDEX IF NOT EXISTS idx_bookmarks_http_status
  ON bookmarks(http_status)
  WHERE http_status IS NOT NULL;

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

-- RSS / Atom feed subscriptions. `url` is the canonical feed URL after
-- auto-discovery (a user may paste a site URL; we follow <link rel="alternate">).
CREATE TABLE IF NOT EXISTS feeds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT    NOT NULL UNIQUE,
  title           TEXT,
  site_url        TEXT,
  favicon_url     TEXT,
  last_fetched_at INTEGER,
  etag            TEXT,
  last_modified   TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL
);

-- One row per article. UNIQUE(feed_id, guid) makes re-polling idempotent.
-- read_at IS NULL = unread. saved_bookmark_id links a feed item to the
-- bookmarks row it was promoted into (items stay in the feed view).
CREATE TABLE IF NOT EXISTS feed_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id            INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid               TEXT    NOT NULL,
  url                TEXT,
  title              TEXT,
  author             TEXT,
  published_at       INTEGER,
  content_excerpt    TEXT,
  ai_summary         TEXT,
  ai_importance      INTEGER NOT NULL DEFAULT 0,
  read_at            INTEGER,
  saved_bookmark_id  INTEGER REFERENCES bookmarks(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_items_guid      ON feed_items(feed_id, guid);
CREATE INDEX        IF NOT EXISTS idx_feed_items_unread   ON feed_items(read_at, published_at DESC);
CREATE INDEX        IF NOT EXISTS idx_feed_items_feed     ON feed_items(feed_id, published_at DESC);
CREATE INDEX        IF NOT EXISTS idx_feed_items_importance
  ON feed_items(ai_importance DESC, published_at DESC);
