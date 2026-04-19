import { Hono } from 'hono';
import type { Env } from '../types';
import { embedQuery } from '../lib/vector';
import { answerWithContext, type ChatContext } from '../lib/haiku';

const app = new Hono<{ Bindings: Env }>();

const TOP_K = 8;
const MIN_CONTEXT_SCORE = 0.4;  // lower than search's 0.5 — we'd rather hand Haiku thin context than none

interface ContextRow {
  id: number;
  url: string;
  title: string | null;
  ai_summary: string | null;
  ai_tags: string;
  importance: number;
  created_at: number;
}

app.post('/', async (c) => {
  const body = await c.req.json<{ question?: string }>();
  const question = body.question?.trim();
  if (!question) return c.json({ error: 'question required' }, 400);

  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: 'chat requires ANTHROPIC_API_KEY configured' }, 503);
  }

  const rows = await gatherContext(c.env, question);
  const context: ChatContext[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    summary: row.ai_summary,
    tags: safeTags(row.ai_tags),
  }));

  try {
    const { answer, citedIds } = await answerWithContext(c.env, question, context);
    // Expose just the cited rows as "sources" — the UI surfaces these as linked cards.
    const sources = rows.filter((r) => citedIds.includes(r.id));
    return c.json({ answer, sources, question });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// Semantic-first context retrieval. If Vectorize is unavailable or the library
// has no embeddings yet, fall back to top-importance recent bookmarks so the
// feature still works in a cold-start state.
async function gatherContext(env: Env, question: string): Promise<ContextRow[]> {
  const ids = await semanticIds(env, question);

  const query = ids.length
    ? env.DB.prepare(`
        SELECT id, url, title, ai_summary, ai_tags, importance, created_at
        FROM bookmarks
        WHERE id IN (${ids.map(() => '?').join(',')}) AND status != 'archived'
      `).bind(...ids)
    : env.DB.prepare(`
        SELECT id, url, title, ai_summary, ai_tags, importance, created_at
        FROM bookmarks
        WHERE status IN ('active', 'partial')
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).bind(TOP_K);

  const rows = await query.all<ContextRow>();
  const results = rows.results ?? [];

  // Re-order D1 results to match the semantic ranking (IN (...) doesn't preserve order).
  if (ids.length) {
    const order = new Map(ids.map((id, i) => [id, i]));
    results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }
  return results;
}

async function semanticIds(env: Env, question: string): Promise<number[]> {
  if (!env.VECTORIZE || !env.AI) return [];
  const vector = await embedQuery(env, question);
  if (!vector) return [];
  const resp = await env.VECTORIZE.query(vector, { topK: TOP_K });
  return resp.matches
    .filter((m) => m.score >= MIN_CONTEXT_SCORE)
    .map((m) => Number(m.id))
    .filter((n) => Number.isFinite(n));
}

function safeTags(raw: string): string[] {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((t): t is string => typeof t === 'string') : [];
  } catch { return []; }
}

export default app;
