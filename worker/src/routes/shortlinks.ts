import { Hono } from 'hono';
import type { Env } from '../types';
import { buildShortUrl, recordClick } from '../lib/shortlinks';

const app = new Hono<{ Bindings: Env }>();

// Lists every shortened, non-archived bookmark for the /shortlinks view.
// recent_7d / prior_7d let the UI show a small "trend" arrow without a
// per-row subquery — both windows are aggregated in one pass via FILTER.
app.get('/', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '50'), 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? '0'), 0);
  const sort = c.req.query('sort') === 'created' ? 'b.shortened_at DESC' : 'b.click_count DESC';

  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  const recentSince = now - week;
  const priorSince = now - 2 * week;

  const totalRow = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE short_code IS NOT NULL AND status != 'archived'`)
    .first<{ n: number }>();

  const rows = await c.env.DB
    .prepare(`
      SELECT b.id, b.url, b.title, b.domain, b.short_code, b.click_count,
             b.shortened_at, b.created_at,
             COALESCE(r.recent_7d, 0)  AS recent_7d,
             COALESCE(r.prior_7d, 0)   AS prior_7d
      FROM bookmarks b
      LEFT JOIN (
        SELECT bookmark_id,
               COUNT(*) FILTER (WHERE ts >= ?) AS recent_7d,
               COUNT(*) FILTER (WHERE ts >= ? AND ts < ?) AS prior_7d
        FROM shortlink_clicks
        GROUP BY bookmark_id
      ) r ON r.bookmark_id = b.id
      WHERE b.short_code IS NOT NULL AND b.status != 'archived'
      ORDER BY ${sort}
      LIMIT ? OFFSET ?
    `)
    .bind(recentSince, priorSince, recentSince, limit, offset)
    .all<{
      id: number;
      url: string;
      title: string | null;
      domain: string | null;
      short_code: string;
      click_count: number;
      shortened_at: number | null;
      created_at: number;
      recent_7d: number;
      prior_7d: number;
    }>();

  const results = (rows.results ?? []).map((r) => ({
    ...r,
    short_url: buildShortUrl(c.req.url, r.short_code),
  }));

  return c.json({
    shortlinks: results,
    total: totalRow?.n ?? 0,
    limit,
    offset,
  });
});

// Aggregate analytics across every shortened bookmark. Powers the dashboard
// summary card. counted_total reflects the leaderboard semantic (bot clicks
// excluded); raw_total includes them so the user can see the gap. The 30-day
// daily series is zero-filled in JS, mirroring the per-bookmark stats.
app.get('/summary', async (c) => {
  const since30d = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const [linksRow, totalsRow, dailyRows, topLinksRows, topReferersRows] = await Promise.all([
    c.env.DB
      .prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE short_code IS NOT NULL AND status != 'archived'`)
      .first<{ n: number }>(),
    c.env.DB
      .prepare(`
        SELECT
          COUNT(*) AS raw_total,
          COUNT(*) FILTER (WHERE ua_class != 'bot' OR ua_class IS NULL) AS counted_total
        FROM shortlink_clicks
      `)
      .first<{ raw_total: number; counted_total: number }>(),
    c.env.DB
      .prepare(`
        SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS day, COUNT(*) AS count
        FROM shortlink_clicks
        WHERE ts >= ? AND (ua_class != 'bot' OR ua_class IS NULL)
        GROUP BY day
        ORDER BY day ASC
      `)
      .bind(since30d)
      .all<{ day: string; count: number }>(),
    c.env.DB
      .prepare(`
        SELECT b.id, b.title, b.url, b.short_code, b.click_count
        FROM bookmarks b
        WHERE b.short_code IS NOT NULL AND b.status != 'archived' AND b.click_count > 0
        ORDER BY b.click_count DESC
        LIMIT 5
      `)
      .all<{ id: number; title: string | null; url: string; short_code: string; click_count: number }>(),
    c.env.DB
      .prepare(`
        SELECT COALESCE(referer, '(direct)') AS referer, COUNT(*) AS count
        FROM shortlink_clicks
        WHERE ua_class != 'bot' OR ua_class IS NULL
        GROUP BY referer
        ORDER BY count DESC
        LIMIT 5
      `)
      .all<{ referer: string; count: number }>(),
  ]);

  const daily = zeroFillDaily(dailyRows.results ?? [], 30);

  return c.json({
    links: linksRow?.n ?? 0,
    counted_total: totalsRow?.counted_total ?? 0,
    raw_total: totalsRow?.raw_total ?? 0,
    daily,
    top_links: topLinksRows.results ?? [],
    top_referers: topReferersRows.results ?? [],
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

export default app;

// Standalone handler used by the root /s/:code route in index.ts. Returns a
// 302 (not 301) so browsers re-hit us on every visit and click counts stay
// accurate. recordClick is fire-and-forget via waitUntil so the redirect
// itself is one DB read + a redirect — sub-50ms in CF's edge.
//
// The ctx param is structurally typed (just `waitUntil`) because Hono's
// `c.executionCtx` reports its `exports` as optional, while Cloudflare's
// `ExecutionContext<unknown>` requires it. We only need waitUntil here.
export async function shortlinkRedirect(
  request: Request,
  env: Env,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.pathname.replace(/^\/s\//, '');
  if (!code || code.includes('/')) return new Response('not found', { status: 404 });

  const row = await env.DB
    .prepare('SELECT id, url, status FROM bookmarks WHERE short_code = ?')
    .bind(code)
    .first<{ id: number; url: string; status: string }>();

  // no-store on every response (404, 410, redirect) so a future broken-window
  // state can't leave a misrouted /s/:code in any browser's cache. Without
  // this, a transient SPA-fallback at this path bakes into the browser as a
  // cached 200 HTML response that overrides later 302s until the user
  // hard-refreshes.
  const noCache = { 'Cache-Control': 'no-store' };

  if (!row) return new Response('not found', { status: 404, headers: noCache });
  if (row.status === 'archived') return new Response('gone', { status: 410, headers: noCache });

  ctx.waitUntil(
    recordClick(env, row.id, request).catch((err) => {
      console.error('recordClick failed', err);
    }),
  );

  return new Response(null, {
    status: 302,
    headers: { ...noCache, Location: row.url },
  });
}
