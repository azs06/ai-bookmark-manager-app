import { Hono } from 'hono';
import type { BookmarkStatus, Env } from '../types';
import { hashUrl, normalizeUrl } from '../lib/url';
import { enrich } from '../lib/enrich';
import { deleteEmbedding, embedAndUpsert } from '../lib/vector';

const app = new Hono<{ Bindings: Env }>();

interface ExistingBookmark {
  id: number;
  status: BookmarkStatus;
  title: string | null;
  note: string;
  ai_summary: string | null;
  ai_tags: string;
  content_excerpt: string | null;
}

app.post('/', async (c) => {
  const body = await c.req.json<{ url?: string; title?: string; note?: string }>();
  if (!body.url) return c.json({ error: 'url required' }, 400);

  const normalized = normalizeUrl(body.url);
  const urlHash = await hashUrl(normalized);
  const domain = new URL(normalized).hostname;
  const now = Date.now();

  const existing = await c.env.DB
    .prepare(`
      SELECT id, status, title, note, ai_summary, ai_tags, content_excerpt
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

      return c.json({ id: existing.id, duplicate: false, restored: true, status: restoredStatus });
    }

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
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '50'), 1), 100);
  const offset = Math.max(Number(c.req.query('offset') ?? '0'), 0);

  const { from, where, params } = buildScopedWhere(c.req.query('scope'));
  const filters = applyFilters(c.req.query('min_importance'), c.req.query('domain'), c.req.query('year'));
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
             b.ai_summary, b.ai_tags, b.category_id, b.importance, b.status, b.created_at
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

  const [domains, years] = await Promise.all([
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
  ]);

  return c.json({
    domains: domains.results ?? [],
    years: years.results ?? [],
  });
});

app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
  const row = await c.env.DB
    .prepare(`
      SELECT id, url, title, note, og_image_url, domain,
             ai_summary, ai_tags, category_id, importance, status, created_at
      FROM bookmarks
      WHERE id = ?
    `)
    .bind(id)
    .first();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ bookmark: row });
});

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
function applyFilters(
  rawImportance: string | undefined,
  rawDomain: string | undefined,
  rawYear: string | undefined,
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

export default app;
