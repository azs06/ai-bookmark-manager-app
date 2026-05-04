import type { Env } from '../types';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LEN = 6;
const COLLISION_RETRIES = 3;
const REFERER_MAX = 512;

export type UaClass = 'mobile' | 'desktop' | 'bot' | 'unknown';

export function generateShortCode(): string {
  const bytes = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

// Custom-alias validator. Stricter than the auto-mint charset because aliases
// are user-typed and need to survive being shouted across a room (no homoglyph
// risk from `_` vs `-` vs space). 3-32 chars, alphanumerics + hyphen +
// underscore. Reject pure-numeric to avoid collisions with potential future
// `/s/<id>` shortcuts.
const ALIAS_RE = /^[A-Za-z0-9_-]{3,32}$/;

export interface AliasValidation {
  ok: boolean;
  reason?: 'invalid_format' | 'numeric_only';
}

export function validateAlias(raw: string): AliasValidation {
  if (!ALIAS_RE.test(raw)) return { ok: false, reason: 'invalid_format' };
  if (/^\d+$/.test(raw)) return { ok: false, reason: 'numeric_only' };
  return { ok: true };
}

// Idempotent. Returns the existing code on a row that already has one — the
// extension's "Shorten & copy" button is allowed to re-trigger this without
// minting fresh codes. Collisions on the UNIQUE index are retried a few
// times; at 6-char base62 (~56B codes) and single-user volume, a real
// collision is essentially impossible — the retry just guards against the
// once-in-a-blue-moon birthday surprise.
export async function assignShortCode(
  env: Env,
  bookmarkId: number,
): Promise<{ code: string; created: boolean }> {
  const existing = await env.DB
    .prepare('SELECT short_code FROM bookmarks WHERE id = ?')
    .bind(bookmarkId)
    .first<{ short_code: string | null }>();
  if (!existing) throw new Error('bookmark not found');
  if (existing.short_code) return { code: existing.short_code, created: false };

  const now = Date.now();
  for (let attempt = 0; attempt < COLLISION_RETRIES; attempt++) {
    const code = generateShortCode();
    try {
      const result = await env.DB
        .prepare(`
          UPDATE bookmarks
          SET short_code = ?, shortened_at = ?, updated_at = ?
          WHERE id = ? AND short_code IS NULL
        `)
        .bind(code, now, now, bookmarkId)
        .run();
      if ((result.meta.changes ?? 0) > 0) {
        return { code, created: true };
      }
      // Zero changes = someone else just minted a code for this row in a
      // concurrent request. Re-read and return that.
      const refreshed = await env.DB
        .prepare('SELECT short_code FROM bookmarks WHERE id = ?')
        .bind(bookmarkId)
        .first<{ short_code: string | null }>();
      if (refreshed?.short_code) return { code: refreshed.short_code, created: false };
    } catch (err) {
      // UNIQUE constraint violation on short_code — try a fresh code.
      const message = (err as Error).message ?? '';
      if (!/UNIQUE/i.test(message)) throw err;
    }
  }
  throw new Error('failed to allocate short code after retries');
}

export function classifyUserAgent(ua: string | null): UaClass {
  if (!ua) return 'unknown';
  // Bot detection runs first — Slackbot/Discordbot/Twitterbot pre-fetch
  // every shared link for previews. Counting those as real clicks would
  // make every Slack-pasted short URL look like an instant hit.
  if (/bot|crawler|spider|preview|fetch|facebookexternalhit|slackbot|discord|twitter|linkedin/i.test(ua)) {
    return 'bot';
  }
  if (/Mobi|Android|iPhone|iPad|iPod/.test(ua)) return 'mobile';
  return 'desktop';
}

export function sanitizeReferer(raw: string | null): string | null {
  if (!raw) return null;
  // Strip query string from the referer so we don't accidentally store
  // search queries or session tokens leaked from the referring page.
  let cleaned = raw;
  try {
    const u = new URL(raw);
    u.search = '';
    cleaned = u.toString();
  } catch {
    // Non-URL referer (rare but possible): pass through as-is, just truncate.
  }
  return cleaned.slice(0, REFERER_MAX);
}

interface ClickContext {
  referer: string | null;
  country: string | null;
  uaClass: UaClass;
}

function readClickContext(request: Request): ClickContext {
  const ua = request.headers.get('User-Agent');
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  return {
    referer: sanitizeReferer(request.headers.get('Referer')),
    country: cf?.country ?? null,
    uaClass: classifyUserAgent(ua),
  };
}

// Records a click for analytics. Bot-class hits get logged so the stats
// modal can show "X% of clicks were link previews" but do NOT bump
// click_count, which feeds the /shortlinks leaderboard ordering.
export async function recordClick(
  env: Env,
  bookmarkId: number,
  request: Request,
): Promise<void> {
  const ctx = readClickContext(request);
  const ts = Date.now();

  const insert = env.DB
    .prepare(`
      INSERT INTO shortlink_clicks (bookmark_id, ts, referer, country, ua_class)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(bookmarkId, ts, ctx.referer, ctx.country, ctx.uaClass);

  if (ctx.uaClass === 'bot') {
    await insert.run();
    return;
  }

  await env.DB.batch([
    insert,
    env.DB
      .prepare('UPDATE bookmarks SET click_count = click_count + 1 WHERE id = ?')
      .bind(bookmarkId),
  ]);
}

export function buildShortUrl(requestUrl: string, code: string): string {
  return `${new URL(requestUrl).origin}/s/${code}`;
}
