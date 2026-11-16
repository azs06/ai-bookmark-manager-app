-- Apply:
--   npx wrangler d1 migrations apply bookmarks --local
--   npx wrangler -c wrangler.local.jsonc d1 migrations apply bookmarks --remote
--
-- Bearer tokens for the /mcp endpoint, created and revoked from Settings.
-- Only the SHA-256 of each token is stored; the plaintext is shown once at
-- creation. token_prefix is the first few characters, kept so the settings
-- list can tell tokens apart. Revoking deletes the row.

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,
  token_prefix TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
