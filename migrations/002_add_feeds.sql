-- Migration: RSS/Atom feed subscriptions + items.
-- Run once against existing databases:
--   wrangler d1 execute bookmarks --local  --file=./migrations/002_add_feeds.sql
--   wrangler d1 execute bookmarks --remote --file=./migrations/002_add_feeds.sql

CREATE TABLE IF NOT EXISTS feeds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT    NOT NULL UNIQUE,     -- canonical feed URL (post-discovery)
  title           TEXT,
  site_url        TEXT,
  favicon_url     TEXT,
  last_fetched_at INTEGER,
  etag            TEXT,
  last_modified   TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL
);

-- One row per article. `guid` is whatever the feed calls stable (RSS <guid>,
-- Atom <id>); we fall back to <link> when missing. UNIQUE(feed_id, guid)
-- makes re-polling a no-op on unchanged feeds.
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
  ai_importance      INTEGER NOT NULL DEFAULT 0,  -- 0 normal, 1 important, 2 must-read
  read_at            INTEGER,                      -- NULL = unread
  saved_bookmark_id  INTEGER REFERENCES bookmarks(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_items_guid
  ON feed_items(feed_id, guid);

-- Inbox query: WHERE read_at IS NULL ORDER BY published_at DESC
CREATE INDEX IF NOT EXISTS idx_feed_items_unread
  ON feed_items(read_at, published_at DESC);

-- Per-feed reader: WHERE feed_id = ? ORDER BY published_at DESC
CREATE INDEX IF NOT EXISTS idx_feed_items_feed
  ON feed_items(feed_id, published_at DESC);

-- Briefing / importance feed: WHERE ai_importance >= 1 ORDER BY published_at DESC
CREATE INDEX IF NOT EXISTS idx_feed_items_importance
  ON feed_items(ai_importance DESC, published_at DESC);
