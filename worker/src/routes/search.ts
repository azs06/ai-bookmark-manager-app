import { Hono } from 'hono';
import type { Env } from '../types';
import { DEFAULT_MIN_SEMANTIC_SCORE, hybridSearch } from '../lib/search';

const app = new Hono<{ Bindings: Env }>();

app.get('/', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ results: [], q: '' });

  const minParam = Number(c.req.query('min') ?? '');
  const minScore = Number.isFinite(minParam) && minParam >= 0 && minParam <= 1
    ? minParam
    : DEFAULT_MIN_SEMANTIC_SCORE;

  const results = await hybridSearch(c.env, q, minScore);
  return c.json({ results, q, minScore });
});

export default app;
