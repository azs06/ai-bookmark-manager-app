import { Hono } from 'hono';
import type { BookmarkStatus, Env } from '../types';
import { hashUrl, normalizeUrl } from '../lib/url';
import { enrich } from '../lib/enrich';
import { deleteEmbedding, embedAndUpsert } from '../lib/vector';
import { detectYouTube } from '../lib/youtube';
import { detectX } from '../lib/x';
import { detectReddit, fetchRedditPost, type RedditPostData } from '../lib/reddit';
import { probeUrl } from '../lib/health';
import { assignShortCode, buildShortUrl, generateShortCode, validateAlias } from '../lib/shortlinks';

const app = new Hono<{ Bindings: Env }>();

interface ExistingBookmark {
  id: number;
  status: BookmarkStatus;
  title: string | null;
  note: string;
  ai_summary: string | null;
  ai_tags: string;
  content_excerpt: string | null;
  short_code: string | null;
}

app.post('/', async (c) => {
  const body = await c.req.json<{ url?: string; title?: string; note?: string; auto_shorten?: boolean }>();
  if (!body.url) return c.json({ error: 'url required' }, 400);

  const normalized = normalizeUrl(body.url);
  const urlHash = await hashUrl(normalized);
  const domain = new URL(normalized).hostname;
  const now = Date.now();
  const wantsShorten = body.auto_shorten === true;

  const existing = await c.env.DB
    .prepare(`
      SELECT id, status, title, note, ai_summary, ai_tags, content_excerpt, short_code
      FROM bookmarks
      WHERE url_hash = ?
    `)
    .bind(urlHash)
    .first<ExistingBookmark>();

  if (existing) {
    if (existing.status === 'archived') {
      const restoredStatus = deriveRestoredStatus(existing);
      const restoredTitle = body.title ?? existing.title;
      const restoredNote = body.note ?? existing.note;

      await c.env.DB
        .prepare(`
          UPDATE bookmarks
          SET title = ?, note = ?, status = ?, updated_at = ?
          WHERE id = ?
        `)
        .bind(restoredTitle, restoredNote, restoredStatus, now, existing.id)
        .run();

      c.executionCtx.waitUntil(
        repairRestoredBookmark(c.env, {
          ...existing,
          title: restoredTitle,
          note: restoredNote,
          status: restoredStatus,
        }).catch((err) => {
          console.error('restore repair failed', err);
        }),
      );

      const shortFields = wantsShorten
        ? await mintShortFields(c.env, existing.id, c.req.url)
        : null;

      return c.json({
        id: existing.id,
        duplicate: false,
        restored: true,
        status: restoredStatus,
        ...(shortFields ?? {}),
      });
    }

    await c.env.DB
      .prepare('UPDATE bookmarks SET updated_at = ? WHERE id = ?')
      .bind(now, existing.id)
      .run();

    const shortFields = wantsShorten
      ? existing.short_code
        ? { short_code: existing.short_code, short_url: buildShortUrl(c.req.url, existing.short_code) }
        : await mintShortFields(c.env, existing.id, c.req.url)
      : null;

    return c.json({
      id: existing.id,
      duplicate: true,
      status: existing.status,
      ...(shortFields ?? {}),
    });
  }

  // Stamp content_type + minimal metadata at insert time so the list view
  // can show "Videos (N)" counts and a play-icon placeholder while the
  // async enricher is still running. enrich() will overwrite metadata with
  // richer fields (channel, duration, publishedAt) when it finishes.
  const yt = detectYouTube(normalized);
  const xPost = !yt ? detectX(normalized) : null;
  const contentType = yt ? 'video' : xPost ? 'x' : null;
  const initialMetadata = yt
    ? JSON.stringify({ videoId: yt.videoId })
    : xPost
      ? JSON.stringify({ statusId: xPost.statusId, ...(xPost.user ? { handle: xPost.user } : {}) })
      : '{}';

  const result = await c.env.DB
    .prepare(`
      INSERT INTO bookmarks (url, url_hash, title, note, domain, content_type, metadata, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `)
    .bind(normalized, urlHash, body.title ?? null, body.note ?? '', domain, contentType, initialMetadata, now, now)
    .run();

  const id = result.meta.last_row_id as number;

  c.executionCtx.waitUntil(enrich(c.env, id));

  const shortFields = wantsShorten
    ? await mintShortFields(c.env, id, c.req.url)
    : null;

  return c.json({
    id,
    duplicate: false,
    status: 'pending',
    content_type: contentType,
    ...(shortFields ?? {}),
  });
});

// Idempotent shortening for an existing bookmark. The extension calls this
// indirectly via auto_shorten on POST /; the webapp calls it directly when
// the user clicks a card-level shorten button.
app.post('/:id{[0-9]+}/shorten', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  try {
    const { code, created } = await assignShortCode(c.env, id);
    return c.json({
      id,
      short_code: code,
      short_url: buildShortUrl(c.req.url, code),
      created,
    });
  } catch (err) {
    const message = (err as Error).message ?? 'shorten failed';
    if (message === 'bookmark not found') return c.json({ error: message }, 404);
    return c.json({ error: message }, 500);
  }
});

async function mintShortFields(
  env: Env,
  bookmarkId: number,
  requestUrl: string,
): Promise<{ short_code: string; short_url: string }> {
  const { code } = await assignShortCode(env, bookmarkId);
  return { short_code: code, short_url: buildShortUrl(requestUrl, code) };
}

// Revoke a short link. Hard reset: NULL the code, drop click history, zero
// the counter. The bookmark itself survives — only the shortener attribute
// is removed. Re-shortening later starts from a clean slate so old metrics
// don't bleed into the new code's stats.
app.delete('/:id{[0-9]+}/shorten', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const exists = await c.env.DB
    .prepare('SELECT id, short_code FROM bookmarks WHERE id = ?')
    .bind(id)
    .first<{ id: number; short_code: string | null }>();
  if (!exists) return c.json({ error: 'not found' }, 404);
  if (!exists.short_code) return c.json({ ok: true, revoked: false });

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare('DELETE FROM shortlink_clicks WHERE bookmark_id = ?')
      .bind(id),
    c.env.DB
      .prepare(`
        UPDATE bookmarks
        SET short_code = NULL, shortened_at = NULL, click_count = 0, updated_at = ?
        WHERE id = ?
      `)
      .bind(now, id),
  ]);

  return c.json({ ok: true, revoked: true });
});

// Regenerate the short code while keeping click history. The old code
// becomes a 404 immediately. Use case: code leaked, want a fresh share URL
// without losing the visibility/reach metrics for that bookmark.
app.post('/:id{[0-9]+}/shorten/regenerate', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const exists = await c.env.DB
    .prepare('SELECT id, short_code FROM bookmarks WHERE id = ?')
    .bind(id)
    .first<{ id: number; short_code: string | null }>();
  if (!exists) return c.json({ error: 'not found' }, 404);
  if (!exists.short_code) return c.json({ error: 'bookmark has no short code yet — use POST /shorten instead' }, 400);

  const now = Date.now();
  let newCode: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = generateShortCode();
    try {
      const result = await c.env.DB
        .prepare(`
          UPDATE bookmarks
          SET short_code = ?, shortened_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .bind(candidate, now, now, id)
        .run();
      if ((result.meta.changes ?? 0) > 0) {
        newCode = candidate;
        break;
      }
    } catch (err) {
      if (!/UNIQUE/i.test((err as Error).message ?? '')) throw err;
    }
  }
  if (!newCode) return c.json({ error: 'failed to allocate short code after retries' }, 500);

  return c.json({
    id,
    short_code: newCode,
    short_url: buildShortUrl(c.req.url, newCode),
    previous_code: exists.short_code,
  });
});

// Set a custom alias for the short code. Also serves as the rename path —
// PATCH replaces whatever code is currently there. 3-32 chars, alphanumerics
// + - + _, not pure-numeric. Returns 409 if the alias is taken by another
// bookmark, 400 on charset violation. Click history is preserved (rename,
// not reset).
app.patch('/:id{[0-9]+}/shorten', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const body = await c.req.json<{ alias?: string }>();
  if (!body.alias || typeof body.alias !== 'string') {
    return c.json({ error: 'alias (string) required' }, 400);
  }
  const alias = body.alias.trim();
  const validation = validateAlias(alias);
  if (!validation.ok) {
    return c.json({
      error: validation.reason === 'numeric_only'
        ? 'alias cannot be all digits'
        : 'alias must be 3-32 chars, letters/digits/hyphen/underscore only',
    }, 400);
  }

  const exists = await c.env.DB
    .prepare('SELECT id, short_code FROM bookmarks WHERE id = ?')
    .bind(id)
    .first<{ id: number; short_code: string | null }>();
  if (!exists) return c.json({ error: 'not found' }, 404);
  if (exists.short_code === alias) {
    return c.json({
      id,
      short_code: alias,
      short_url: buildShortUrl(c.req.url, alias),
      changed: false,
    });
  }

  const collision = await c.env.DB
    .prepare('SELECT id FROM bookmarks WHERE short_code = ? AND id != ?')
    .bind(alias, id)
    .first<{ id: number }>();
  if (collision) return c.json({ error: 'alias already in use', existing_id: collision.id }, 409);

  const now = Date.now();
  await c.env.DB
    .prepare(`
      UPDATE bookmarks
      SET short_code = ?, shortened_at = COALESCE(shortened_at, ?), updated_at = ?
      WHERE id = ?
    `)
    .bind(alias, now, now, id)
    .run();

  return c.json({
    id,
    short_code: alias,
    short_url: buildShortUrl(c.req.url, alias),
    previous_code: exists.short_code,
    changed: true,
  });
});

app.get('/', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '50'), 1), 100);
  const offset = Math.max(Number(c.req.query('offset') ?? '0'), 0);

  const { from, where, params } = buildScopedWhere(c.req.query('scope'));
  const filters = applyFilters(
    c.req.query('min_importance'),
    c.req.query('domain'),
    c.req.query('year'),
    c.req.query('content_type'),
  );
  const finalWhere = filters.clauses.length ? `${where} AND ${filters.clauses.join(' AND ')}` : where;
  const allParams = [...params, ...filters.params];

  const totalRow = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n ${from} WHERE ${finalWhere}`)
    .bind(...allParams)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const rows = await c.env.DB
    .prepare(`
      SELECT b.id, b.url, b.title, b.note, b.og_image_url, b.domain,
             b.ai_summary, b.ai_tags, b.category_id, b.importance, b.status,
             b.content_type, b.metadata, b.short_code, b.click_count,
             b.created_at
      ${from}
      WHERE ${finalWhere}
      ORDER BY b.importance DESC, b.created_at DESC, b.id DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...allParams, limit, offset)
    .all();

  return c.json({ bookmarks: rows.results, total, offset, limit });
});

// Facets for the filter bar. Counts reflect the current scope only (not other
// active filters) so the lists stay stable as the user toggles filters — same
// behavior as raindrop's collection sidebar counts.
app.get('/facets', async (c) => {
  const { from, where, params } = buildScopedWhere(c.req.query('scope'));

  const [domains, years, contentTypes] = await Promise.all([
    c.env.DB
      .prepare(`
        SELECT b.domain AS name, COUNT(*) AS count
        ${from}
        WHERE ${where} AND b.domain IS NOT NULL AND b.domain != ''
        GROUP BY b.domain
        ORDER BY count DESC, b.domain ASC
        LIMIT 50
      `)
      .bind(...params)
      .all<{ name: string; count: number }>(),
    c.env.DB
      .prepare(`
        SELECT strftime('%Y', b.created_at / 1000, 'unixepoch') AS year,
               COUNT(*) AS count
        ${from}
        WHERE ${where}
        GROUP BY year
        ORDER BY year DESC
      `)
      .bind(...params)
      .all<{ year: string; count: number }>(),
    c.env.DB
      .prepare(`
        SELECT b.content_type AS name, COUNT(*) AS count
        ${from}
        WHERE ${where} AND b.content_type IS NOT NULL
        GROUP BY b.content_type
        ORDER BY count DESC
      `)
      .bind(...params)
      .all<{ name: string; count: number }>(),
  ]);

  return c.json({
    domains: domains.results ?? [],
    years: years.results ?? [],
    content_types: contentTypes.results ?? [],
  });
});

// `:id{[0-9]+}` constrains the param to digits so non-numeric single-segment
// GETs (/dead, /pending-count, /hashes) fall through to their static handlers
// instead of being swallowed here. Without the constraint, Hono's router
// matches /:id first by registration order and returns "invalid id" 400s.
app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
  const row = await c.env.DB
    .prepare(`
      SELECT id, url, title, note, og_image_url, domain,
             ai_summary, ai_tags, category_id, importance, status,
             content_type, metadata, short_code, click_count, shortened_at,
             created_at
      FROM bookmarks
      WHERE id = ?
    `)
    .bind(id)
    .first();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ bookmark: row });
});

// Per-bookmark click analytics for the stats modal. 30-day daily series is
// zero-filled in JS rather than via a SQL CTE — D1's recursive CTE syntax
// works but the JS path is simpler and keeps the SQL focused on aggregation.
app.get('/:id{[0-9]+}/clicks', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const exists = await c.env.DB
    .prepare('SELECT id, click_count FROM bookmarks WHERE id = ?')
    .bind(id)
    .first<{ id: number; click_count: number }>();
  if (!exists) return c.json({ error: 'not found' }, 404);

  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const [totalRow, dailyRows, refererRows, countryRows, uaRows] = await Promise.all([
    c.env.DB
      .prepare('SELECT COUNT(*) AS n FROM shortlink_clicks WHERE bookmark_id = ?')
      .bind(id)
      .first<{ n: number }>(),
    c.env.DB
      .prepare(`
        SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, COUNT(*) AS count
        FROM shortlink_clicks
        WHERE bookmark_id = ? AND ts >= ?
        GROUP BY day
        ORDER BY day ASC
      `)
      .bind(id, since)
      .all<{ day: string; count: number }>(),
    c.env.DB
      .prepare(`
        SELECT COALESCE(referer, '(direct)') AS referer, COUNT(*) AS count
        FROM shortlink_clicks
        WHERE bookmark_id = ?
        GROUP BY referer
        ORDER BY count DESC
        LIMIT 10
      `)
      .bind(id)
      .all<{ referer: string; count: number }>(),
    c.env.DB
      .prepare(`
        SELECT COALESCE(country, '??') AS country, COUNT(*) AS count
        FROM shortlink_clicks
        WHERE bookmark_id = ?
        GROUP BY country
        ORDER BY count DESC
        LIMIT 10
      `)
      .bind(id)
      .all<{ country: string; count: number }>(),
    c.env.DB
      .prepare(`
        SELECT COALESCE(ua_class, 'unknown') AS ua_class, COUNT(*) AS count
        FROM shortlink_clicks
        WHERE bookmark_id = ?
        GROUP BY ua_class
      `)
      .bind(id)
      .all<{ ua_class: string; count: number }>(),
  ]);

  const daily = zeroFillDaily(dailyRows.results ?? [], 30);

  return c.json({
    id,
    total: totalRow?.n ?? 0,
    counted: exists.click_count, // excludes bots; matches the leaderboard
    daily,
    topReferers: refererRows.results ?? [],
    byCountry: countryRows.results ?? [],
    byUaClass: uaRows.results ?? [],
  });
});

function zeroFillDaily(rows: Array<{ day: string; count: number }>, days: number): Array<{ day: string; count: number }> {
  const have = new Map(rows.map((r) => [r.day, r.count]));
  const out: Array<{ day: string; count: number }> = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: have.get(key) ?? 0 });
  }
  return out;
}

app.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const body = await c.req.json<{ importance?: 0 | 1 | 2; note?: string; category_id?: number | null }>();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.importance !== undefined) {
    if (![0, 1, 2].includes(body.importance)) {
      return c.json({ error: 'importance must be 0, 1, or 2' }, 400);
    }
    updates.push('importance = ?');
    values.push(body.importance);
  }
  if (body.note !== undefined) {
    updates.push('note = ?');
    values.push(body.note);
  }
  if (body.category_id !== undefined) {
    const next = body.category_id === null ? null : Number(body.category_id);
    if (next !== null && (!Number.isFinite(next) || next <= 0)) {
      return c.json({ error: 'invalid category_id' }, 400);
    }
    if (next !== null) {
      const exists = await c.env.DB
        .prepare(`SELECT id FROM categories WHERE id = ?`)
        .bind(next)
        .first<{ id: number }>();
      if (!exists) return c.json({ error: 'category not found' }, 400);
    }
    updates.push('category_id = ?');
    values.push(next);
  }
  if (!updates.length) return c.json({ error: 'nothing to update' }, 400);

  updates.push('updated_at = ?');
  values.push(Date.now(), id);

  await c.env.DB
    .prepare(`UPDATE bookmarks SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return c.json({ ok: true });
});

// Bulk import from Chrome extension. Skips URLs already in the library (by url_hash).
// Does NOT auto-enrich — a 1000-item import would blow the Anthropic budget. User
// re-enriches on demand via the UI ↻ button (or a future batch endpoint).
app.post('/import', async (c) => {
  const body = await c.req.json<{
    items?: Array<{ url: string; title?: string | null; tags?: string[] }>;
  }>();
  const items = body.items ?? [];
  if (!items.length) return c.json({ error: 'items required' }, 400);
  if (items.length > 200) return c.json({ error: 'max 200 items per batch' }, 400);

  const now = Date.now();
  let imported = 0;
  let skipped = 0;
  const errors: Array<{ url: string; error: string }> = [];

  for (const item of items) {
    if (!item.url) { skipped++; continue; }
    try {
      const normalized = normalizeUrl(item.url);
      const urlHash = await hashUrl(normalized);
      const domain = new URL(normalized).hostname;

      const existing = await c.env.DB
        .prepare('SELECT id FROM bookmarks WHERE url_hash = ?')
        .bind(urlHash)
        .first<{ id: number }>();
      if (existing) { skipped++; continue; }

      const tags = JSON.stringify(item.tags ?? []);
      await c.env.DB
        .prepare(`
          INSERT INTO bookmarks (url, url_hash, title, note, domain, ai_tags, status, created_at, updated_at)
          VALUES (?, ?, ?, '', ?, ?, 'imported', ?, ?)
        `)
        .bind(normalized, urlHash, item.title ?? null, domain, tags, now, now)
        .run();
      imported++;
    } catch (e) {
      errors.push({ url: item.url, error: (e as Error).message });
    }
  }

  return c.json({ imported, skipped, errors });
});

app.post('/:id/re-enrich', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
  c.executionCtx.waitUntil(enrich(c.env, id));
  return c.json({ ok: true, id, queued: true });
});

// Fetches a markdown rendering of the bookmark's URL. Cache-first: a hit
// returns immediately. On miss (or ?revalidate=1) we try Cloudflare's
// "Markdown for Agents" content negotiation first — instant and zero cost
// when the origin opted in — then fall back to Jina Reader (r.jina.ai/<url>)
// which works on arbitrary URLs. Skipped for video/X content; those have
// dedicated metadata flows.
type MarkdownSource = 'cf-markdown' | 'jina' | 'reddit';

const JINA_READER_PREFIX = 'https://r.jina.ai/';
const MD_USER_AGENT = 'ai-bookmark-manager (+markdown-for-agents)';

interface MarkdownRow {
  url: string;
  content_type: string | null;
  markdown_cached: string | null;
  markdown_cached_at: number | null;
  markdown_source: string | null;
}

app.get('/:id{[0-9]+}/markdown', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const revalidate = c.req.query('revalidate') === '1';

  const row = await c.env.DB
    .prepare(`
      SELECT url, content_type, markdown_cached, markdown_cached_at, markdown_source
      FROM bookmarks WHERE id = ?
    `)
    .bind(id)
    .first<MarkdownRow>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.content_type === 'video' || row.content_type === 'x') {
    return c.json({ ok: false, reason: 'ineligible_content_type', contentType: row.content_type }, 400);
  }

  if (!revalidate && row.markdown_cached) {
    return c.json({
      ok: true,
      markdown: row.markdown_cached,
      source: row.markdown_source as MarkdownSource | null,
      cachedAt: row.markdown_cached_at,
      cached: true,
    });
  }

  const result = await fetchMarkdown(row.url);
  if (!result.ok) return c.json(result, result.status === 502 ? 502 : 200);

  const now = Date.now();
  await c.env.DB
    .prepare(`
      UPDATE bookmarks
      SET markdown_cached = ?, markdown_cached_at = ?, markdown_source = ?, updated_at = ?
      WHERE id = ?
    `)
    .bind(result.markdown, now, result.source, now, id)
    .run();

  return c.json({
    ok: true,
    markdown: result.markdown,
    source: result.source,
    cachedAt: now,
    cached: false,
  });
});

interface MarkdownFetchOk {
  ok: true;
  markdown: string;
  source: MarkdownSource;
}
interface MarkdownFetchFail {
  ok: false;
  reason: 'unsupported' | 'fetch_failed';
  status?: number;
  detail?: string;
}

// Three-stage lookup. Reddit goes first because the modern reddit.com
// gates scrapers behind a JS bot wall — both content negotiation and Jina
// return near-empty results. The .json endpoint sidesteps that. For everything
// else: try Cloudflare Markdown for Agents on the origin (free, instant, but
// opt-in by zone); on miss, fall back to Jina Reader which extracts readable
// markdown from arbitrary URLs anonymously.
async function fetchMarkdown(url: string): Promise<MarkdownFetchOk | MarkdownFetchFail> {
  // Stage 0 (Reddit-only): hit the .json endpoint and format as markdown.
  const redditHit = detectReddit(url);
  if (redditHit) {
    const data = await fetchRedditPost(redditHit);
    if (data) {
      return { ok: true, markdown: formatRedditMarkdown(data), source: 'reddit' };
    }
    // .json failed — fall through to the generic stages.
  }

  // Stage 1: content-negotiate against the origin.
  try {
    const r = await fetch(url, {
      headers: { Accept: 'text/markdown, text/html;q=0.1', 'User-Agent': MD_USER_AGENT },
      redirect: 'follow',
    });
    if (r.ok) {
      const ct = (r.headers.get('content-type') ?? '').toLowerCase();
      if (ct.startsWith('text/markdown')) {
        return { ok: true, markdown: await r.text(), source: 'cf-markdown' };
      }
    }
  } catch {
    // fall through to Jina
  }

  // Stage 2: Jina Reader. Anonymous use is rate-limited (~20 req/min); a
  // future JINA_API_KEY env var can lift that — header is x-api-key.
  try {
    const r = await fetch(JINA_READER_PREFIX + url, {
      headers: { Accept: 'text/markdown', 'User-Agent': MD_USER_AGENT },
      redirect: 'follow',
    });
    if (!r.ok) {
      return { ok: false, reason: 'fetch_failed', status: r.status, detail: 'jina' };
    }
    return { ok: true, markdown: await r.text(), source: 'jina' };
  } catch (err) {
    return { ok: false, reason: 'fetch_failed', detail: (err as Error).message };
  }
}

// Marks a video as watched / unwatched. Stored as a timestamp in
// metadata.watchedAt so the UI can later surface "watched this week" etc.
// Scoped to content_type='video' — trying to mark an article as watched is
// a client bug, not a meaningful semantic, so we 400 instead of silently
// storing the field on a non-video row.
app.post('/:id/watched', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const body = await c.req.json<{ watched?: boolean }>();
  if (typeof body.watched !== 'boolean') {
    return c.json({ error: 'watched (boolean) required' }, 400);
  }

  const row = await c.env.DB
    .prepare('SELECT content_type FROM bookmarks WHERE id = ?')
    .bind(id)
    .first<{ content_type: string | null }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.content_type !== 'video') {
    return c.json({ error: 'watched status only applies to videos' }, 400);
  }

  const now = Date.now();
  // json_set handles both insert and overwrite of the key; json_remove
  // drops it when unwatching so the stored JSON stays tidy.
  const sql = body.watched
    ? `UPDATE bookmarks SET metadata = json_set(metadata, '$.watchedAt', ?), updated_at = ? WHERE id = ?`
    : `UPDATE bookmarks SET metadata = json_remove(metadata, '$.watchedAt'), updated_at = ? WHERE id = ?`;

  await c.env.DB.prepare(sql).bind(...(body.watched ? [now, now, id] : [now, id])).run();

  return c.json({ ok: true, watched: body.watched, watchedAt: body.watched ? now : null });
});

// Batch-enrich bookmarks that were imported (from the Chrome extension) or
// stuck in 'pending' (save succeeded but enrichment didn't finish). Bounded
// per call so the client can loop and cancel; Worker stays inside subrequest
// + CPU limits no matter how large the backlog is.
const BATCH_DEFAULT = 20;
const BATCH_MAX = 50;
const BATCH_CONCURRENCY = 4;

app.post('/enrich-imported', async (c) => {
  const requested = Number(c.req.query('limit') ?? BATCH_DEFAULT);
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : BATCH_DEFAULT, 1), BATCH_MAX);

  const rows = await c.env.DB
    .prepare(`
      SELECT id FROM bookmarks
      WHERE status IN ('imported', 'pending')
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .bind(limit)
    .all<{ id: number }>();

  const ids = (rows.results ?? []).map((r) => r.id);

  const totalRow = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE status IN ('imported', 'pending')`)
    .first<{ n: number }>();
  const totalBefore = totalRow?.n ?? 0;

  if (ids.length) {
    c.executionCtx.waitUntil(runEnrichBatch(c.env, ids, BATCH_CONCURRENCY));
  }

  return c.json({
    queued: ids.length,
    remaining: Math.max(0, totalBefore - ids.length),
  });
});

app.get('/pending-count', async (c) => {
  const row = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE status IN ('imported', 'pending')`)
    .first<{ n: number }>();
  return c.json({ pending: row?.n ?? 0 });
});

// URL-health scanner. Probes up to `limit` non-archived bookmarks per call;
// the client is expected to loop until `remaining === 0`. The `since` cursor
// (epoch ms; pass the timestamp the client started its sweep) lets us skip
// rows already checked in this sweep, so the loop terminates even though we
// rewrite last_checked_at on every probe. Strict 404/410 → "dead"; everything
// else (including network failures, recorded as 0) just gets the timestamp.
const HEALTH_BATCH_DEFAULT = 25;
const HEALTH_BATCH_MAX = 50;
const HEALTH_BATCH_CONCURRENCY = 8;

app.post('/check-health', async (c) => {
  const requested = Number(c.req.query('limit') ?? HEALTH_BATCH_DEFAULT);
  const limit = Math.min(
    Math.max(Number.isFinite(requested) ? requested : HEALTH_BATCH_DEFAULT, 1),
    HEALTH_BATCH_MAX,
  );
  const sinceRaw = Number(c.req.query('since'));
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : Date.now();

  const rows = await c.env.DB
    .prepare(`
      SELECT id, url FROM bookmarks
      WHERE status != 'archived'
        AND (last_checked_at IS NULL OR last_checked_at < ?)
      ORDER BY last_checked_at IS NULL DESC, last_checked_at ASC
      LIMIT ?
    `)
    .bind(since, limit)
    .all<{ id: number; url: string }>();

  const targets = rows.results ?? [];

  const remainingRow = await c.env.DB
    .prepare(`
      SELECT COUNT(*) AS n FROM bookmarks
      WHERE status != 'archived'
        AND (last_checked_at IS NULL OR last_checked_at < ?)
    `)
    .bind(since)
    .first<{ n: number }>();
  const remainingBefore = remainingRow?.n ?? 0;

  let dead = 0;

  if (targets.length) {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(HEALTH_BATCH_CONCURRENCY, targets.length) },
      async () => {
        while (cursor < targets.length) {
          const i = cursor++;
          const row = targets[i];
          if (!row) return;
          const status = await probeUrl(row.url);
          if (status === 404 || status === 410) dead++;
          await c.env.DB
            .prepare('UPDATE bookmarks SET http_status = ?, last_checked_at = ? WHERE id = ?')
            .bind(status, Date.now(), row.id)
            .run();
        }
      },
    );
    await Promise.all(workers);
  }

  return c.json({
    checked: targets.length,
    dead,
    remaining: Math.max(0, remainingBefore - targets.length),
  });
});

// Lists every bookmark that came back 404 or 410 on its last probe. Returns
// minimal fields — the dead-links UI only needs to render a row + checkbox.
app.get('/dead', async (c) => {
  const rows = await c.env.DB
    .prepare(`
      SELECT id, url, title, domain, http_status, last_checked_at, created_at
      FROM bookmarks
      WHERE status != 'archived'
        AND http_status IN (404, 410)
      ORDER BY domain ASC, created_at DESC
    `)
    .all();
  return c.json({ bookmarks: rows.results ?? [] });
});

// Bulk soft-delete by id. Mirrors DELETE /:id semantics (status='archived' +
// vector cleanup) so an archived-here bookmark behaves the same as one
// archived from the card menu — including being restorable via re-save.
app.post('/archive-bulk', async (c) => {
  const body = await c.req.json<{ ids?: unknown }>();
  if (!Array.isArray(body.ids)) return c.json({ error: 'ids (array) required' }, 400);
  const ids = body.ids
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return c.json({ error: 'no valid ids' }, 400);
  if (ids.length > 500) return c.json({ error: 'max 500 ids per call' }, 400);

  const now = Date.now();
  const placeholders = ids.map(() => '?').join(',');
  const result = await c.env.DB
    .prepare(`
      UPDATE bookmarks SET status = 'archived', updated_at = ?
      WHERE id IN (${placeholders}) AND status != 'archived'
    `)
    .bind(now, ...ids)
    .run();

  c.executionCtx.waitUntil(
    Promise.all(ids.map((id) => deleteEmbedding(c.env, id).catch((err) => {
      console.error('vector delete failed', id, err);
    }))).then(() => undefined),
  );

  return c.json({ archived: result.meta.changes ?? 0 });
});

// Replace a bookmark's URL — used by the dead-links flow when a page moved
// rather than disappeared (slug change on Medium, GitHub repo rename, etc.).
// Touches identity columns (url, url_hash, domain) so it's a separate verb
// from PATCH /:id, which only edits soft fields. Clears http_status so the
// row drops out of the dead-links query immediately; status → 'pending' so
// the UI shows "enriching" until re-enrichment finishes; metadata wiped so
// stale YouTube/X JSON from the old URL doesn't render against the new one.
app.post('/:id{[0-9]+}/url', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const body = await c.req.json<{ url?: string }>();
  if (!body.url || typeof body.url !== 'string') {
    return c.json({ error: 'url required' }, 400);
  }

  let normalized: string;
  let domain: string;
  try {
    normalized = normalizeUrl(body.url);
    domain = new URL(normalized).hostname;
  } catch {
    return c.json({ error: 'invalid url' }, 400);
  }
  const newHash = await hashUrl(normalized);

  const current = await c.env.DB
    .prepare('SELECT id, url_hash FROM bookmarks WHERE id = ?')
    .bind(id)
    .first<{ id: number; url_hash: string }>();
  if (!current) return c.json({ error: 'not found' }, 404);

  if (current.url_hash === newHash) {
    return c.json({ id, changed: false });
  }

  // Collision check covers archived rows too — url_hash is UNIQUE in the
  // schema, so an archived ghost with the same hash would fail the UPDATE
  // with a constraint error if we didn't catch it here first.
  const collision = await c.env.DB
    .prepare(`
      SELECT id, url, title, status
      FROM bookmarks
      WHERE url_hash = ? AND id != ?
    `)
    .bind(newHash, id)
    .first<{ id: number; url: string; title: string | null; status: BookmarkStatus }>();
  if (collision) {
    return c.json({
      error: 'url already exists in library',
      existing: collision,
    }, 409);
  }

  const now = Date.now();
  await c.env.DB
    .prepare(`
      UPDATE bookmarks
      SET url             = ?,
          url_hash        = ?,
          domain          = ?,
          http_status     = NULL,
          last_checked_at = NULL,
          status          = 'pending',
          content_type    = NULL,
          metadata        = '{}',
          markdown_cached    = NULL,
          markdown_cached_at = NULL,
          markdown_source    = NULL,
          updated_at      = ?
      WHERE id = ?
    `)
    .bind(normalized, newHash, domain, now, id)
    .run();

  // Re-enrichment refreshes title, og:image, summary, and tags against the
  // new URL. The vector for the old URL is left in place — embedAndUpsert()
  // inside enrich() overwrites the same id, so the index stays consistent.
  c.executionCtx.waitUntil(enrich(c.env, id));

  return c.json({ id, changed: true, url: normalized });
});

// Returns every non-archived bookmark's url_hash so the extension can maintain
// a local "is this page saved?" cache without querying per-tab-change. Full
// dump, not paginated — single-user scale and hashes compress well under gzip.
app.get('/hashes', async (c) => {
  const rows = await c.env.DB
    .prepare(`SELECT url_hash FROM bookmarks WHERE status != 'archived'`)
    .all<{ url_hash: string }>();
  const hashes = (rows.results ?? []).map((r) => r.url_hash);
  return c.json({ hashes, ts: Date.now() });
});

app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  await c.env.DB
    .prepare(`UPDATE bookmarks SET status = 'archived', updated_at = ? WHERE id = ?`)
    .bind(Date.now(), id)
    .run();

  c.executionCtx.waitUntil(
    deleteEmbedding(c.env, id).catch((err) => {
      console.error('vector delete failed', err);
    }),
  );

  return c.json({ ok: true });
});

// Archive by URL — used by the Chrome extension, which tracks URLs (not ids)
// via the /hashes cache. Mirrors DELETE /:id semantics: soft delete so the
// enrichment metadata survives a re-save. Idempotent: missing URL returns
// { removed: false } rather than 404.
app.post('/remove', async (c) => {
  const body = await c.req.json<{ url?: string }>();
  if (!body.url) return c.json({ error: 'url required' }, 400);

  const normalized = normalizeUrl(body.url);
  const urlHash = await hashUrl(normalized);

  const existing = await c.env.DB
    .prepare(`SELECT id FROM bookmarks WHERE url_hash = ? AND status != 'archived'`)
    .bind(urlHash)
    .first<{ id: number }>();

  if (!existing) return c.json({ ok: true, removed: false });

  await c.env.DB
    .prepare(`UPDATE bookmarks SET status = 'archived', updated_at = ? WHERE id = ?`)
    .bind(Date.now(), existing.id)
    .run();

  c.executionCtx.waitUntil(
    deleteEmbedding(c.env, existing.id).catch((err) => {
      console.error('vector delete failed', err);
    }),
  );

  return c.json({ ok: true, removed: true, id: existing.id });
});

// Scope:
//   (missing | __all__)       → every non-archived bookmark
//   __uncategorized__         → bookmarks with NULL category_id
//   <numeric id>              → that category AND all its descendants (recursive CTE)
function buildScopedWhere(scope: string | undefined): {
  from: string;
  where: string;
  params: unknown[];
} {
  const categoryId = scope && scope !== '__all__' && scope !== '__uncategorized__'
    ? Number(scope)
    : null;

  let where = `b.status != 'archived'`;
  let from = `FROM bookmarks b`;
  const params: unknown[] = [];

  if (scope === '__uncategorized__') {
    where += ` AND b.category_id IS NULL`;
  } else if (categoryId !== null && Number.isFinite(categoryId)) {
    from = `
      FROM bookmarks b
      INNER JOIN (
        WITH RECURSIVE subtree(id) AS (
          SELECT ? UNION ALL
          SELECT c.id FROM categories c INNER JOIN subtree s ON c.parent_id = s.id
        )
        SELECT id FROM subtree
      ) sc ON sc.id = b.category_id
    `;
    params.push(categoryId);
  }

  return { from, where, params };
}

// Parses + validates the three filter query params. Unknown/invalid values
// are silently dropped so a malformed URL never 500s — the list just comes
// back unfiltered on that dimension.
const KNOWN_CONTENT_TYPES = new Set(['video', 'x']);

function applyFilters(
  rawImportance: string | undefined,
  rawDomain: string | undefined,
  rawYear: string | undefined,
  rawContentType: string | undefined,
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const minImportance = Number(rawImportance);
  if (minImportance === 1 || minImportance === 2) {
    clauses.push('b.importance >= ?');
    params.push(minImportance);
  }

  const domain = rawDomain?.trim();
  if (domain) {
    clauses.push('b.domain = ?');
    params.push(domain);
  }

  const year = rawYear?.trim();
  if (year && /^\d{4}$/.test(year)) {
    clauses.push(`strftime('%Y', b.created_at / 1000, 'unixepoch') = ?`);
    params.push(year);
  }

  const contentType = rawContentType?.trim();
  if (contentType && KNOWN_CONTENT_TYPES.has(contentType)) {
    clauses.push('b.content_type = ?');
    params.push(contentType);
  }

  return { clauses, params };
}

// Simple N-at-a-time worker pool. Each slot pulls the next id off a shared
// cursor until drained. Failures don't abort siblings — enrich() already
// downgrades rows to 'partial' on its own, so one bad URL won't strand the
// batch.
async function runEnrichBatch(env: Env, ids: number[], concurrency: number): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (cursor < ids.length) {
      const i = cursor++;
      const id = ids[i];
      if (id === undefined) return;
      try {
        await enrich(env, id);
      } catch (err) {
        console.error('batch enrich failed', id, err);
      }
    }
  });
  await Promise.all(workers);
}

function deriveRestoredStatus(row: Pick<ExistingBookmark, 'ai_summary' | 'ai_tags' | 'content_excerpt'>): BookmarkStatus {
  if (row.ai_summary) return 'active';
  if (row.content_excerpt) return 'partial';
  if (hasStoredTags(row.ai_tags)) return 'imported';
  return 'pending';
}

function hasStoredTags(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.some((item) => typeof item === 'string' && item.trim());
  } catch {
    return false;
  }
}

async function repairRestoredBookmark(env: Env, row: ExistingBookmark): Promise<void> {
  if (row.ai_summary) {
    await embedAndUpsert(env, row.id, {
      title: row.title,
      summary: row.ai_summary,
      excerpt: row.content_excerpt,
    });
    return;
  }

  await enrich(env, row.id);
}

// Reddit JSON → markdown. We render the post (title, OP, body) and the top
// comments as a blockquote thread so the reader sees discussion context, not
// just the OP — which is usually what makes a Reddit link worth saving.
function formatRedditMarkdown(d: RedditPostData): string {
  const lines: string[] = [];
  lines.push(`# ${d.title}`);
  lines.push('');
  const meta: string[] = [];
  if (d.subreddit) meta.push(`r/${d.subreddit}`);
  if (d.author) meta.push(`by u/${d.author}`);
  if (d.score != null) meta.push(`${d.score} points`);
  if (d.numComments != null) meta.push(`${d.numComments} comments`);
  if (d.postedAt) meta.push(new Date(d.postedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }));
  if (meta.length) lines.push(`*${meta.join(' · ')}*`);
  lines.push('');

  if (d.linkUrl) {
    lines.push(`**Linked:** ${d.linkUrl}`);
    lines.push('');
  }
  if (d.thumbnail) {
    lines.push(`![](${d.thumbnail})`);
    lines.push('');
  }
  if (d.selftext) {
    lines.push(d.selftext.trim());
    lines.push('');
  }

  if (d.topComments.length) {
    lines.push('---');
    lines.push('');
    lines.push('## Top comments');
    lines.push('');
    for (const c of d.topComments) {
      lines.push(`**u/${c.author}** · ${c.score} points`);
      lines.push('');
      // Indent the comment body as a blockquote so it visually nests under
      // the author line.
      const body = c.body.split('\n').map((l) => `> ${l}`).join('\n');
      lines.push(body);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export default app;
