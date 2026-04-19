import { Hono } from 'hono';
import type { Env } from '../types';
import { hashUrl, normalizeUrl } from '../lib/url';
import { enrich } from '../lib/enrich';

const app = new Hono<{ Bindings: Env }>();

app.post('/', async (c) => {
  const body = await c.req.json<{ url?: string; title?: string; note?: string }>();
  if (!body.url) return c.json({ error: 'url required' }, 400);

  const normalized = normalizeUrl(body.url);
  const urlHash = await hashUrl(normalized);
  const domain = new URL(normalized).hostname;
  const now = Date.now();

  const existing = await c.env.DB
    .prepare('SELECT id, status FROM bookmarks WHERE url_hash = ?')
    .bind(urlHash)
    .first<{ id: number; status: string }>();

  if (existing) {
    await c.env.DB
      .prepare('UPDATE bookmarks SET updated_at = ? WHERE id = ?')
      .bind(now, existing.id)
      .run();
    return c.json({ id: existing.id, duplicate: true, status: existing.status });
  }

  const result = await c.env.DB
    .prepare(`
      INSERT INTO bookmarks (url, url_hash, title, note, domain, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `)
    .bind(normalized, urlHash, body.title ?? null, body.note ?? '', domain, now, now)
    .run();

  const id = result.meta.last_row_id as number;

  c.executionCtx.waitUntil(enrich(c.env, id));

  return c.json({ id, duplicate: false, status: 'pending' });
});

app.get('/', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? '50'), 200);
  const rows = await c.env.DB
    .prepare(`
      SELECT id, url, title, note, og_image_url, domain, ai_summary, ai_tags,
             importance, status, created_at
      FROM bookmarks
      WHERE status != 'archived'
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `)
    .bind(limit)
    .all();

  return c.json({ bookmarks: rows.results });
});

app.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const body = await c.req.json<{ importance?: 0 | 1 | 2; note?: string }>();
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

app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  await c.env.DB
    .prepare(`UPDATE bookmarks SET status = 'archived', updated_at = ? WHERE id = ?`)
    .bind(Date.now(), id)
    .run();

  return c.json({ ok: true });
});

export default app;
