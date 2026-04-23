-- Classify bookmarks by content type so enrichment, rendering, and filtering
-- can specialize per kind. `metadata` is a JSON bag for type-specific fields
-- (video: { videoId, durationSec, channel, publishedAt, watchedAt, … }) so
-- new content types don't need another schema migration.
--
-- Apply:
--   wrangler d1 execute bookmarks --local  --file=./migrations/003_add_content_type.sql
--   wrangler d1 execute bookmarks --remote --file=./migrations/003_add_content_type.sql

ALTER TABLE bookmarks ADD COLUMN content_type TEXT;
ALTER TABLE bookmarks ADD COLUMN metadata     TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_bookmarks_content_type ON bookmarks(content_type);
