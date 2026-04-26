-- Apply:
--   npx wrangler d1 migrations apply bookmarks --local
--   npx wrangler -c wrangler.local.jsonc d1 migrations apply bookmarks --remote
--
-- Markdown cache for the "View as Markdown" feature. Blobs go in their own
-- columns (not metadata) because the list endpoint pulls metadata back on
-- every page; stuffing 50–200KB markdown there would balloon every query.
-- Source is the provider that produced the cached copy so the UI can label
-- it ("via Cloudflare Markdown for Agents" vs "via Jina Reader").

ALTER TABLE bookmarks ADD COLUMN markdown_cached    TEXT;
ALTER TABLE bookmarks ADD COLUMN markdown_cached_at INTEGER;
ALTER TABLE bookmarks ADD COLUMN markdown_source    TEXT; -- 'cf-markdown' | 'jina' | 'reddit'
