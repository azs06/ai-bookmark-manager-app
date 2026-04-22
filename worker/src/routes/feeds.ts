import { Hono } from 'hono';
import type { Env } from '../types';
import { discover, insertNewItems, pollFeed, pollAllFeeds, type FeedPollRow } from '../lib/feeds';
import { summarizeAndTag } from '../lib/haiku';

const app = new Hono<{ Bindings: Env }>();

interface FeedRow {
  id: number;
  url: string;
  title: string | null;
  site_url: string | null;
  favicon_url: string | null;
  last_fetched_at: number | null;
  error: string | null;
  created_at: number;
}

// List feeds with unread counts. The sidebar queries this on mount.
app.get('/', async (c) => {
  const feeds = await c.env.DB.prepare(`
    SELECT
      f.id, f.url, f.title, f.site_url, f.favicon_url,
      f.last_fetched_at, f.error, f.created_at,
      COUNT(CASE WHEN fi.read_at IS NULL THEN 1 END) AS unread_count,
      COUNT(fi.id) AS total_count
    FROM feeds f
    LEFT JOIN feed_items fi ON fi.feed_id = f.id
    GROUP BY f.id
    ORDER BY f.title COLLATE NOCASE ASC, f.id ASC
  `).all<FeedRow & { unread_count: number; total_count: number }>();

  const totalUnread = (feeds.results ?? []).reduce(
    (sum, f) => sum + (f.unread_count ?? 0),
    0,
  );
  return c.json({ feeds: feeds.results ?? [], total_unread: totalUnread });
});

// Add a feed by URL. Accepts either a canonical feed URL or a site URL
// (autodiscovery scans for <link rel="alternate">). Inserts the feed row
// and the first batch of items in one go; returns the feed + item counts.
app.post('/', async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }));
  const raw = body.url?.trim();
  if (!raw) return c.json({ error: 'url required' }, 400);

  let inputUrl: string;
  try {
    inputUrl = new URL(raw).toString();
  } catch {
    return c.json({ error: 'invalid URL' }, 400);
  }

  let result;
  try {
    result = await discover(inputUrl);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  // Multi-feed site: return 300 with the candidate list so the UI can ask
  // the user which one to follow. No state mutated here.
  if (result.kind === 'candidates') {
    return c.json({ candidates: result.candidates }, 300);
  }

  const { metadata, items, etag, lastModified } = result;

  const existing = await c.env.DB
    .prepare('SELECT id FROM feeds WHERE url = ?')
    .bind(metadata.url)
    .first<{ id: number }>();
  if (existing) {
    return c.json({ error: 'Feed already subscribed', feed_id: existing.id }, 409);
  }

  const now = Date.now();
  const insert = await c.env.DB.prepare(`
    INSERT INTO feeds (url, title, site_url, favicon_url, etag, last_modified, last_fetched_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    metadata.url,
    metadata.title,
    metadata.site_url,
    metadata.favicon_url,
    etag,
    lastModified,
    now,
    now,
  ).run();
  const feedId = insert.meta.last_row_id;
  if (typeof feedId !== 'number') {
    return c.json({ error: 'Failed to insert feed' }, 500);
  }

  const insertedIds = await insertNewItems(c.env, feedId, items);

  return c.json({
    ok: true,
    feed: {
      id: feedId,
      url: metadata.url,
      title: metadata.title,
      site_url: metadata.site_url,
      favicon_url: metadata.favicon_url,
    },
    items_added: insertedIds.length,
  });
});

app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const r = await c.env.DB
    .prepare('DELETE FROM feeds WHERE id = ?')
    .bind(id)
    .run();
  // ON DELETE CASCADE on feed_items.feed_id handles the items.
  return c.json({ ok: true, deleted: r.meta.changes ?? 0 });
});

// Items listing. Two scopes: a single feed, or the cross-feed inbox.
// ?feed_id=<n>  scope to one feed
// ?unread=1     only unread items (default: include both)
// ?limit=&offset= pagination
app.get('/items', async (c) => {
  const feedId = c.req.query('feed_id');
  const unreadOnly = c.req.query('unread') === '1';
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);

  const where: string[] = [];
  const binds: unknown[] = [];
  if (feedId) {
    const n = Number(feedId);
    if (!Number.isFinite(n)) return c.json({ error: 'invalid feed_id' }, 400);
    where.push('fi.feed_id = ?');
    binds.push(n);
  }
  if (unreadOnly) {
    where.push('fi.read_at IS NULL');
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await c.env.DB.prepare(`
    SELECT
      fi.id, fi.feed_id, fi.url, fi.title, fi.author,
      fi.published_at, fi.content_excerpt, fi.ai_summary, fi.ai_importance,
      fi.read_at, fi.saved_bookmark_id, fi.created_at,
      f.title AS feed_title, f.favicon_url AS feed_favicon_url
    FROM feed_items fi
    JOIN feeds f ON f.id = fi.feed_id
    ${whereSql}
    ORDER BY fi.published_at DESC, fi.id DESC
    LIMIT ? OFFSET ?
  `).bind(...binds, limit, offset).all();

  const countRow = await c.env.DB.prepare(`
    SELECT COUNT(*) AS n FROM feed_items fi ${whereSql}
  `).bind(...binds).first<{ n: number }>();

  return c.json({
    items: rows.results ?? [],
    total: countRow?.n ?? 0,
  });
});

// Mark item(s) as read. Accepts a single id via :id, or a batch via body
// {"ids": [...]} for "mark all visible as read" UX.
app.post('/items/:id/read', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
  const r = await c.env.DB
    .prepare('UPDATE feed_items SET read_at = ? WHERE id = ? AND read_at IS NULL')
    .bind(Date.now(), id)
    .run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});

// Manual refresh — same path the hourly cron takes. Runs synchronously so
// the caller sees the new-item count in the response. At MVP feed counts
// this finishes in a few seconds; we don't bother with waitUntil here
// because the UI wants to refresh its listing right after.
app.post('/refresh', async (c) => {
  const result = await pollAllFeeds(c.env);
  return c.json({ ok: true, ...result });
});

// Single-feed refresh. Used by the sidebar's per-feed refresh affordance.
app.post('/:id/refresh', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const feed = await c.env.DB
    .prepare('SELECT id, url, etag, last_modified FROM feeds WHERE id = ?')
    .bind(id)
    .first<FeedPollRow>();
  if (!feed) return c.json({ error: 'feed not found' }, 404);

  const r = await pollFeed(c.env, feed);
  return c.json({
    ok: true,
    not_modified: r.not_modified,
    new_items: r.new_item_ids.length,
    error: r.error,
  });
});

// On-demand summary. Haiku is only called the first time; subsequent hits
// return the cached `ai_summary`. Marks the item read as a side effect
// because summarizing it is a clear signal the user considered it.
app.post('/items/:id/summarize', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const row = await c.env.DB.prepare(`
    SELECT id, title, content_excerpt, ai_summary
    FROM feed_items WHERE id = ?
  `).bind(id).first<{
    id: number;
    title: string | null;
    content_excerpt: string | null;
    ai_summary: string | null;
  }>();
  if (!row) return c.json({ error: 'item not found' }, 404);

  if (row.ai_summary) {
    return c.json({ ok: true, summary: row.ai_summary, cached: true });
  }
  if (!row.content_excerpt) {
    return c.json({ error: 'No content to summarize.' }, 422);
  }

  let summary: string;
  try {
    const result = await summarizeAndTag(c.env, {
      title: row.title ?? undefined,
      excerpt: row.content_excerpt,
    });
    summary = result.summary.trim();
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }

  if (!summary) {
    return c.json({ error: 'Summary came back empty.' }, 502);
  }

  await c.env.DB.prepare(`
    UPDATE feed_items
    SET ai_summary = ?, read_at = COALESCE(read_at, ?)
    WHERE id = ?
  `).bind(summary, Date.now(), id).run();

  return c.json({ ok: true, summary, cached: false });
});

app.post('/items/read-batch', async (c) => {
  const body = await c.req.json<{ ids?: number[] }>().catch(() => ({} as { ids?: number[] }));
  const ids = (body.ids ?? []).filter((n: number) => Number.isFinite(n));
  if (!ids.length) return c.json({ ok: true, changed: 0 });

  const now = Date.now();
  const placeholders = ids.map(() => '?').join(',');
  const r = await c.env.DB.prepare(`
    UPDATE feed_items SET read_at = ?
    WHERE id IN (${placeholders}) AND read_at IS NULL
  `).bind(now, ...ids).run();
  return c.json({ ok: true, changed: r.meta.changes ?? 0 });
});

export default app;
