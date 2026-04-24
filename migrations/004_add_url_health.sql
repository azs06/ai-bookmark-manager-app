-- Apply:
--   npx wrangler d1 migrations apply bookmarks --local
--   npx wrangler -c wrangler.local.jsonc d1 migrations apply bookmarks --remote
--
-- URL health tracking. http_status is the final status code after redirects
-- from the most recent probe; NULL means never checked. last_checked_at lets
-- the scanner pick the oldest-checked rows first (or skip rows checked since
-- a given cursor) so a single sweep can be split across many bounded Worker
-- invocations without re-checking the same row twice.

ALTER TABLE bookmarks ADD COLUMN http_status     INTEGER;
ALTER TABLE bookmarks ADD COLUMN last_checked_at INTEGER;

-- Partial-style index: covers the dead-link lookup (404/410) without bloating
-- on the much larger set of healthy/unchecked rows. SQLite picks this up for
-- WHERE http_status IN (404, 410) AND status != 'archived'.
CREATE INDEX IF NOT EXISTS idx_bookmarks_http_status
  ON bookmarks(http_status)
  WHERE http_status IS NOT NULL;
