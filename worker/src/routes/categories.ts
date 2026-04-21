import { Hono } from 'hono';
import type { Env } from '../types';

const app = new Hono<{ Bindings: Env }>();

interface CategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
  count: number;
}

// Flat list with direct counts. Client walks parent_id to build the tree and
// rolls up recursive counts — keeps the server query cheap and the tree state
// entirely in the UI, which matches how raindrop handles expand/collapse.
app.get('/', async (c) => {
  const rows = await c.env.DB
    .prepare(`
      SELECT c.id, c.name, c.parent_id,
             COALESCE(b.cnt, 0) AS count
      FROM categories c
      LEFT JOIN (
        SELECT category_id, COUNT(*) AS cnt
        FROM bookmarks
        WHERE status != 'archived' AND category_id IS NOT NULL
        GROUP BY category_id
      ) b ON b.category_id = c.id
      ORDER BY c.name COLLATE NOCASE
    `)
    .all<CategoryRow>();

  const uncategorized = await c.env.DB
    .prepare(`
      SELECT COUNT(*) AS n FROM bookmarks
      WHERE status != 'archived' AND category_id IS NULL
    `)
    .first<{ n: number }>();

  const total = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE status != 'archived'`)
    .first<{ n: number }>();

  return c.json({
    categories: rows.results ?? [],
    uncategorized: uncategorized?.n ?? 0,
    total: total?.n ?? 0,
  });
});

app.post('/', async (c) => {
  const body = await c.req.json<{ name?: string; parent_id?: number | null }>();
  const name = (body.name ?? '').trim();
  if (!name) return c.json({ error: 'name required' }, 400);
  if (name.length > 64) return c.json({ error: 'name too long (max 64 chars)' }, 400);

  const parent = normalizeParent(body.parent_id);
  if (parent !== null) {
    const exists = await c.env.DB
      .prepare(`SELECT id FROM categories WHERE id = ?`)
      .bind(parent)
      .first<{ id: number }>();
    if (!exists) return c.json({ error: 'parent not found' }, 400);
  }

  try {
    const result = await c.env.DB
      .prepare(`INSERT INTO categories (name, parent_id, created_at) VALUES (?, ?, ?)`)
      .bind(name, parent, Date.now())
      .run();
    return c.json({ id: result.meta.last_row_id, name, parent_id: parent });
  } catch (err) {
    // Unique-sibling violation surfaces here — return the existing id so callers
    // can treat create-or-reuse uniformly.
    const existing = await c.env.DB
      .prepare(`SELECT id FROM categories WHERE COALESCE(parent_id, 0) = ? AND name = ? COLLATE NOCASE`)
      .bind(parent ?? 0, name)
      .first<{ id: number }>();
    if (existing) return c.json({ id: existing.id, name, parent_id: parent, duplicate: true });
    throw err;
  }
});

// Rename and/or re-parent. Prevents a category from being moved under its own
// descendant (which would create a cycle — the recursive CTE in the bookmarks
// filter would spin forever).
app.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const body = await c.req.json<{ name?: string; parent_id?: number | null }>();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ error: 'name cannot be empty' }, 400);
    if (name.length > 64) return c.json({ error: 'name too long (max 64 chars)' }, 400);
    updates.push('name = ?');
    values.push(name);
  }
  if (body.parent_id !== undefined) {
    const parent = normalizeParent(body.parent_id);
    if (parent === id) return c.json({ error: 'cannot nest category under itself' }, 400);
    if (parent !== null && await isDescendant(c.env, id, parent)) {
      return c.json({ error: 'cannot nest category under one of its own descendants' }, 400);
    }
    updates.push('parent_id = ?');
    values.push(parent);
  }
  if (!updates.length) return c.json({ error: 'nothing to update' }, 400);

  values.push(id);
  await c.env.DB
    .prepare(`UPDATE categories SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return c.json({ ok: true });
});

// Delete a category: lift its children and bookmarks up to its own parent
// (NULL → top-level / uncategorized). Matches raindrop's "delete without losing
// your library" behavior.
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const target = await c.env.DB
    .prepare(`SELECT parent_id FROM categories WHERE id = ?`)
    .bind(id)
    .first<{ parent_id: number | null }>();
  if (!target) return c.json({ ok: true });

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare(`UPDATE categories SET parent_id = ? WHERE parent_id = ?`)
      .bind(target.parent_id, id),
    c.env.DB
      .prepare(`UPDATE bookmarks SET category_id = ?, updated_at = ? WHERE category_id = ?`)
      .bind(target.parent_id, now, id),
    c.env.DB
      .prepare(`DELETE FROM categories WHERE id = ?`)
      .bind(id),
  ]);
  return c.json({ ok: true });
});

// Parse categories from imported bookmarks' tag paths.
// The Chrome extension stores folder path as tags[] — e.g. ["Dev", "React",
// "Hooks"] — so walking the array gives us the full hierarchy. For each
// uncategorized bookmark we find-or-create a chain and assign the leaf.
app.post('/parse', async (c) => {
  const rows = await c.env.DB
    .prepare(`
      SELECT id, ai_tags FROM bookmarks
      WHERE status != 'archived'
        AND category_id IS NULL
        AND ai_tags != '[]'
        AND ai_tags != ''
    `)
    .all<{ id: number; ai_tags: string }>();

  const now = Date.now();
  let assigned = 0;
  const leafCache = new Map<string, number>();  // path joined by '\0' → leaf id

  for (const row of rows.results ?? []) {
    const path = parsePath(row.ai_tags);
    if (!path.length) continue;

    const key = path.join('\0');
    let leafId = leafCache.get(key);
    if (leafId === undefined) {
      leafId = await ensureChain(c.env, path, now);
      leafCache.set(key, leafId);
    }

    await c.env.DB
      .prepare(`UPDATE bookmarks SET category_id = ?, updated_at = ? WHERE id = ?`)
      .bind(leafId, now, row.id)
      .run();
    assigned++;
  }

  const total = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM categories`)
    .first<{ n: number }>();

  return c.json({ assigned, categories: total?.n ?? 0 });
});

function normalizeParent(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

async function isDescendant(env: Env, ancestorId: number, candidateId: number): Promise<boolean> {
  // Walk up from candidate: if we hit ancestorId, candidate is a descendant.
  const row = await env.DB
    .prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT parent_id FROM categories WHERE id = ?
        UNION ALL
        SELECT c.parent_id FROM categories c
        INNER JOIN ancestors a ON c.id = a.id
        WHERE c.parent_id IS NOT NULL
      )
      SELECT 1 AS hit FROM ancestors WHERE id = ? LIMIT 1
    `)
    .bind(candidateId, ancestorId)
    .first<{ hit: number }>();
  return !!row;
}

async function ensureChain(env: Env, path: string[], now: number): Promise<number> {
  let parentId: number | null = null;
  for (const raw of path) {
    const name = raw.trim().slice(0, 64);
    if (!name) continue;
    const existing: { id: number } | null = await env.DB
      .prepare(`SELECT id FROM categories WHERE COALESCE(parent_id, 0) = ? AND name = ? COLLATE NOCASE`)
      .bind(parentId ?? 0, name)
      .first<{ id: number }>();
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const result = await env.DB
      .prepare(`INSERT INTO categories (name, parent_id, created_at) VALUES (?, ?, ?)`)
      .bind(name, parentId, now)
      .run();
    parentId = result.meta.last_row_id as number;
  }
  if (parentId === null) {
    throw new Error('empty category path');
  }
  return parentId;
}

function parsePath(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  } catch {
    return [];
  }
}

export default app;
