import type { Env } from '../types';

// MCP bearer tokens. Generated server-side, shown to the user once, and stored
// only as a SHA-256 hash. 32 random bytes make brute force pointless, so a
// plain (unsalted) hash is enough and keeps lookup a single indexed query.
const TOKEN_PREFIX = 'bmk_';
const DISPLAY_PREFIX_CHARS = TOKEN_PREFIX.length + 6;
// Skip the last_used_at write when it was updated this recently, so a busy
// client doesn't write to D1 on every tool call.
const LAST_USED_RESOLUTION_MS = 60_000;

export interface McpTokenRow {
  id: number;
  name: string;
  token_prefix: string;
  created_at: number;
  last_used_at: number | null;
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return TOKEN_PREFIX + toHex(bytes);
}

export function displayPrefix(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_CHARS);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

// Returns true when `presented` matches either a token stored in D1 or the
// optional MCP_AUTH_TOKEN secret (kept for setups configured before tokens
// moved into Settings).
export async function verifyMcpToken(
  env: Env,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
  presented: string,
): Promise<boolean> {
  const hash = await hashToken(presented);

  if (env.MCP_AUTH_TOKEN) {
    const expected = await hashToken(env.MCP_AUTH_TOKEN);
    if (timingSafeEqualHex(hash, expected)) return true;
  }

  const row = await env.DB
    .prepare('SELECT id, last_used_at FROM mcp_tokens WHERE token_hash = ?')
    .bind(hash)
    .first<{ id: number; last_used_at: number | null }>();
  if (!row) return false;

  const now = Date.now();
  if (row.last_used_at === null || now - row.last_used_at > LAST_USED_RESOLUTION_MS) {
    ctx.waitUntil(
      env.DB
        .prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?')
        .bind(now, row.id)
        .run()
        .catch((err) => console.error('mcp token last_used update failed', err)),
    );
  }
  return true;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  return ab.byteLength === bb.byteLength && crypto.subtle.timingSafeEqual(ab, bb);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
