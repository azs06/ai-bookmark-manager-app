import { Hono } from 'hono';
import type { Env } from '../types';
import { getTodaysSuggestions, runDailySuggestions } from '../lib/suggestions';

const app = new Hono<{ Bindings: Env }>();

// Return today's cached picks, hydrated with bookmark rows. Frontend filters
// out archived/deleted bookmarks here rather than refusing to serve the list.
app.get('/today', async (c) => {
  const payload = await getTodaysSuggestions(c.env);
  if (!payload.picks.length) {
    return c.json({ date: payload.date, picks: [], generated_at: null });
  }

  const ids = payload.picks.map((p) => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = await c.env.DB
    .prepare(`
      SELECT id, url, title, note, og_image_url, domain, ai_summary, ai_tags,
             importance, status, created_at
      FROM bookmarks
      WHERE id IN (${placeholders}) AND status != 'archived'
    `)
    .bind(...ids)
    .all();

  type BookmarkRow = { id: number } & Record<string, unknown>;
  const byId = new Map<number, BookmarkRow>();
  for (const row of (rows.results ?? []) as BookmarkRow[]) {
    byId.set(row.id, row);
  }

  // Preserve Haiku's ordering — it reflects the model's ranking.
  const picks = payload.picks
    .map((p) => {
      const bookmark = byId.get(p.id);
      return bookmark ? { reason: p.reason, bookmark } : null;
    })
    .filter((x): x is { reason: string; bookmark: BookmarkRow } => x !== null);

  return c.json({ date: payload.date, picks, generated_at: payload.generated_at });
});

// Manual trigger — useful for first-run and debugging. The daily cron calls
// runDailySuggestions directly (see index.ts scheduled handler), not this route.
app.post('/refresh', async (c) => {
  const result = await runDailySuggestions(c.env);
  if (!result) return c.json({ ok: false, reason: 'not enough active bookmarks (need 3+)' }, 200);
  return c.json({ ok: true, ...result });
});

export default app;
