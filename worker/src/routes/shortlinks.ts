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

  if (!row) return new Response('not found', { status: 404 });
  if (row.status === 'archived') return new Response('gone', { status: 410 });

  ctx.waitUntil(
    recordClick(env, row.id, request).catch((err) => {
      console.error('recordClick failed', err);
    }),
  );

  return Response.redirect(row.url, 302);
}
