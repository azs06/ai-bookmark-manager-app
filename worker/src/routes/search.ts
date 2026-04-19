import { Hono } from 'hono';
import type { Env } from '../types';
import { embedQuery } from '../lib/vector';

const app = new Hono<{ Bindings: Env }>();

const TOP_K = 20;
const KEYWORD_LIMIT = 30;
const RRF_K = 60;
// Minimum cosine score for a semantic match. BGE roughly: 0.7+ strong, 0.5-0.7 loose,
// <0.5 noise. Keyword matches are never filtered by score — substring hit is definitive.
const DEFAULT_MIN_SEMANTIC_SCORE = 0.5;

interface HydratedRow {
  id: number;
  url: string;
  title: string | null;
  note: string;
  og_image_url: string | null;
  domain: string | null;
  ai_summary: string | null;
  ai_tags: string;
  importance: number;
  status: string;
  created_at: number;
}

app.get('/', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ results: [], q: '' });

  const minParam = Number(c.req.query('min') ?? '');
  const minScore = Number.isFinite(minParam) && minParam >= 0 && minParam <= 1
    ? minParam
    : DEFAULT_MIN_SEMANTIC_SCORE;

  // Fire keyword and semantic in parallel — neither blocks the other.
  const [keywordIds, semanticMatches] = await Promise.all([
    keywordSearch(c.env, q),
    semanticSearch(c.env, q, minScore),
  ]);

  // Reciprocal Rank Fusion: each ranked list contributes 1/(k + rank) per doc.
  // Docs appearing in both lists get summed signal and rise to the top.
  const rrfScores = new Map<number, number>();
  const semanticScore = new Map<number, number>();

  keywordIds.forEach((id, rank) => {
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  });

  semanticMatches.forEach((m, rank) => {
    const id = Number(m.id);
    if (!Number.isFinite(id)) return;
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    semanticScore.set(id, m.score);
  });

  if (!rrfScores.size) return c.json({ results: [], q, minScore });

  const ids = [...rrfScores.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await c.env.DB
    .prepare(`
      SELECT id, url, title, note, og_image_url, domain, ai_summary, ai_tags,
             importance, status, created_at
      FROM bookmarks
      WHERE id IN (${placeholders}) AND status != 'archived'
    `)
    .bind(...ids)
    .all<HydratedRow>();

  const results = (rows.results ?? [])
    .map((row) => {
      const base = rrfScores.get(row.id) ?? 0;
      const importanceBoost = 1 + row.importance * 0.05;
      return {
        ...row,
        score: base * importanceBoost,
        semantic_score: semanticScore.get(row.id),
        matched_by: matchSources(row.id, keywordIds, semanticScore),
      };
    })
    .sort((a, b) => b.score - a.score);

  return c.json({ results, q, minScore });
});

async function keywordSearch(env: Env, q: string): Promise<number[]> {
  const pattern = `%${q.toLowerCase()}%`;
  const rows = await env.DB
    .prepare(`
      SELECT id FROM bookmarks
      WHERE status != 'archived'
        AND (LOWER(title)     LIKE ?
          OR LOWER(ai_summary) LIKE ?
          OR LOWER(ai_tags)    LIKE ?
          OR LOWER(domain)     LIKE ?
          OR LOWER(note)       LIKE ?)
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `)
    .bind(pattern, pattern, pattern, pattern, pattern, KEYWORD_LIMIT)
    .all<{ id: number }>();
  return (rows.results ?? []).map((r) => r.id);
}

interface VecMatch { id: string; score: number; }

async function semanticSearch(env: Env, q: string, minScore: number): Promise<VecMatch[]> {
  if (!env.VECTORIZE || !env.AI) return [];
  const vector = await embedQuery(env, q);
  if (!vector) return [];
  const resp = await env.VECTORIZE.query(vector, { topK: TOP_K });
  return resp.matches.filter((m) => m.score >= minScore);
}

function matchSources(
  id: number,
  keywordIds: number[],
  semanticScore: Map<number, number>,
): string[] {
  const sources: string[] = [];
  if (keywordIds.includes(id)) sources.push('keyword');
  if (semanticScore.has(id)) sources.push('semantic');
  return sources;
}

export default app;
