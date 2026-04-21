-- Migration: add hierarchical categories (raindrop.io-style collections).
-- Run once against existing databases:
--   wrangler d1 execute bookmarks --local  --file=./migrations/001_add_categories.sql
--   wrangler d1 execute bookmarks --remote --file=./migrations/001_add_categories.sql
-- SQLite has no "ADD COLUMN IF NOT EXISTS"; running this twice will error on the
-- ALTER. That's fine — re-running a migration is a mistake worth surfacing.

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  parent_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_sibling
  ON categories(COALESCE(parent_id, 0), name COLLATE NOCASE);

ALTER TABLE bookmarks ADD COLUMN category_id INTEGER REFERENCES categories(id);

CREATE INDEX IF NOT EXISTS idx_bookmarks_category_id ON bookmarks(category_id);
