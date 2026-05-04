-- Apply:
--   npx wrangler d1 migrations apply bookmarks --local
--   npx wrangler -c wrangler.local.jsonc d1 migrations apply bookmarks --remote
--
-- URL shortener with click analytics. Every shortened bookmark gets a 6-char
-- base62 code on the bookmarks row itself (not in metadata JSON) because
-- /s/:code redirects are lookup-by-code on every request — a JSON scan would
-- be wrong here. click_count is denormalized so the /api/shortlinks listing
-- can ORDER BY without a per-row aggregate. shortlink_clicks holds the
-- timestamped events used for the per-bookmark stats modal (daily chart, top
-- referers, top countries) and stays small at single-user volume — no
-- retention policy in MVP.

ALTER TABLE bookmarks ADD COLUMN short_code   TEXT;
ALTER TABLE bookmarks ADD COLUMN click_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookmarks ADD COLUMN shortened_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bookmarks_short_code
  ON bookmarks(short_code) WHERE short_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS shortlink_clicks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  referer     TEXT,        -- truncated to 512 chars
  country     TEXT,        -- ISO-2 from request.cf.country, nullable
  ua_class    TEXT         -- 'mobile'|'desktop'|'bot'|'unknown'
);

CREATE INDEX IF NOT EXISTS idx_shortlink_clicks_bookmark_ts
  ON shortlink_clicks(bookmark_id, ts DESC);
