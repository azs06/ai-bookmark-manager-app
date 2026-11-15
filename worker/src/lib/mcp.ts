import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from '../types';
import { hybridSearch } from './search';
import { createOrRestoreBookmark } from './createBookmark';
import { applyFilters, buildScopedWhere } from './bookmarkQuery';

// Excerpts can be whole transcripts. Cap what one get_bookmark call hands the
// model so a single long video doesn't eat the client's context window.
const EXCERPT_MAX_CHARS = 4000;

interface BookmarkSummaryRow {
  id: number;
  url: string;
  title: string | null;
  note: string;
  domain: string | null;
  ai_summary: string | null;
  ai_tags: string;
  category_id: number | null;
  importance: number;
  status: string;
  content_type: string | null;
  created_at: number;
}

interface BookmarkDetailRow extends BookmarkSummaryRow {
  category_name: string | null;
  og_description: string | null;
  content_excerpt: string | null;
  metadata: string;
  short_code: string | null;
  view_count: number;
  click_count: number;
  last_viewed_at: number | null;
  updated_at: number;
}

// Builds a fresh MCP server per request (createMcpHandler is stateless). env
// and ctx are closed over so tools reach D1/Vectorize and can schedule
// background enrichment the same way the HTTP routes do.
export function createBookmarkMcpServer(
  env: Env,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
): McpServer {
  const server = new McpServer(
    { name: 'ai-bookmark-manager', version: '0.1.0' },
    {
      instructions:
        'Personal bookmark library with AI summaries and tags. Use search_bookmarks to find saved links by topic '
        + '(hybrid keyword + semantic), list_bookmarks to browse recent saves, get_bookmark for full details of one '
        + 'bookmark, list_categories to see the collection tree, and save_bookmark to add a new URL.',
    },
  );

  server.registerTool(
    'search_bookmarks',
    {
      title: 'Search bookmarks',
      description:
        'Search saved bookmarks by meaning and keywords across titles, AI summaries, tags, domains, and notes. '
        + 'Returns the best matches first.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500).describe('What to look for, in natural language or keywords'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results to return'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const hits = await hybridSearch(env, query);
      return json({
        query,
        results: hits.slice(0, limit).map((hit) => ({
          ...formatSummary(hit),
          matched_by: hit.matched_by,
        })),
      });
    },
  );

  server.registerTool(
    'list_bookmarks',
    {
      title: 'List bookmarks',
      description: 'List saved bookmarks, newest first, with optional filters.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
        category_id: z.number().int().optional()
          .describe('Only bookmarks in this category or its subcategories (see list_categories)'),
        tag: z.string().trim().min(1).optional().describe('Exact AI tag to match'),
        domain: z.string().trim().min(1).optional().describe('Exact hostname, e.g. "github.com"'),
        content_type: z.enum(['video', 'x']).optional().describe('"video" for YouTube, "x" for X/Twitter posts'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, offset, category_id, tag, domain, content_type }) => {
      const { from, where, params } = buildScopedWhere(
        category_id === undefined ? undefined : String(category_id),
      );
      const filters = applyFilters(undefined, domain, undefined, content_type, tag);
      const finalWhere = filters.clauses.length ? `${where} AND ${filters.clauses.join(' AND ')}` : where;
      const allParams = [...params, ...filters.params];

      const [totalRow, rows] = await Promise.all([
        env.DB
          .prepare(`SELECT COUNT(*) AS n ${from} WHERE ${finalWhere}`)
          .bind(...allParams)
          .first<{ n: number }>(),
        env.DB
          .prepare(`
            SELECT b.id, b.url, b.title, b.note, b.domain, b.ai_summary, b.ai_tags,
                   b.category_id, b.importance, b.status, b.content_type, b.created_at
            ${from}
            WHERE ${finalWhere}
            ORDER BY b.created_at DESC, b.id DESC
            LIMIT ? OFFSET ?
          `)
          .bind(...allParams, limit, offset)
          .all<BookmarkSummaryRow>(),
      ]);

      return json({
        total: totalRow?.n ?? 0,
        offset,
        limit,
        bookmarks: (rows.results ?? []).map(formatSummary),
      });
    },
  );

  server.registerTool(
    'get_bookmark',
    {
      title: 'Get bookmark',
      description: 'Get full details for one bookmark, including its content excerpt and metadata.',
      inputSchema: z.object({
        id: z.number().int().positive(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const row = await env.DB
        .prepare(`
          SELECT b.id, b.url, b.title, b.note, b.domain, b.ai_summary, b.ai_tags,
                 b.category_id, c.name AS category_name, b.importance, b.status,
                 b.content_type, b.og_description, b.content_excerpt, b.metadata,
                 b.short_code, b.view_count, b.click_count, b.last_viewed_at,
                 b.created_at, b.updated_at
          FROM bookmarks b
          LEFT JOIN categories c ON c.id = b.category_id
          WHERE b.id = ?
        `)
        .bind(id)
        .first<BookmarkDetailRow>();
      if (!row) return error(`No bookmark with id ${id}.`);

      const excerpt = row.content_excerpt;
      return json({
        ...formatSummary(row),
        category: row.category_name,
        description: row.og_description,
        content_excerpt: excerpt && excerpt.length > EXCERPT_MAX_CHARS
          ? `${excerpt.slice(0, EXCERPT_MAX_CHARS)}…`
          : excerpt,
        content_excerpt_truncated: (excerpt?.length ?? 0) > EXCERPT_MAX_CHARS,
        metadata: parseJson(row.metadata, {}),
        short_code: row.short_code,
        view_count: row.view_count,
        click_count: row.click_count,
        last_viewed_at: isoOrNull(row.last_viewed_at),
        updated_at: isoOrNull(row.updated_at),
      });
    },
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List categories',
      description: 'List bookmark categories with their full path and direct bookmark counts.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const rows = await env.DB
        .prepare(`
          SELECT c.id, c.name, c.parent_id, COALESCE(b.cnt, 0) AS count
          FROM categories c
          LEFT JOIN (
            SELECT category_id, COUNT(*) AS cnt
            FROM bookmarks
            WHERE status != 'archived' AND category_id IS NOT NULL
            GROUP BY category_id
          ) b ON b.category_id = c.id
          ORDER BY c.name COLLATE NOCASE
        `)
        .all<{ id: number; name: string; parent_id: number | null; count: number }>();

      const categories = rows.results ?? [];
      const byId = new Map(categories.map((cat) => [cat.id, cat]));
      const pathOf = (id: number): string => {
        const names: string[] = [];
        const seen = new Set<number>();
        let cur = byId.get(id);
        while (cur && !seen.has(cur.id)) {
          seen.add(cur.id);
          names.unshift(cur.name);
          cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id);
        }
        return names.join(' / ');
      };

      return json({
        categories: categories
          .map((cat) => ({ id: cat.id, path: pathOf(cat.id), parent_id: cat.parent_id, count: cat.count }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      });
    },
  );

  server.registerTool(
    'save_bookmark',
    {
      title: 'Save bookmark',
      description:
        'Save a URL to the bookmark library. If the URL is already saved, nothing changes and the existing bookmark '
        + 'is returned. If it was archived, it is restored, and any title or note you pass replaces the stored one. '
        + 'For new URLs, title, summary, and tags are generated in the background; call get_bookmark later to see them.',
      inputSchema: z.object({
        url: z.string().trim().url().max(2048).describe('http(s) URL to save'),
        title: z.string().trim().min(1).max(500).optional(),
        note: z.string().trim().max(2000).optional().describe('Personal note to attach'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, title, note }) => {
      const protocol = new URL(url).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') {
        return error('Only http and https URLs can be saved.');
      }

      const result = await createOrRestoreBookmark(env, ctx, { url, title, note });
      const message = result.kind === 'duplicate'
        ? 'Already saved.'
        : result.kind === 'restored'
          ? 'Restored from archive.'
          : 'Saved. Enrichment is running in the background.';
      return json({ id: result.id, result: result.kind, status: result.status, message });
    },
  );

  return server;
}

function formatSummary(row: BookmarkSummaryRow) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    domain: row.domain,
    summary: row.ai_summary,
    tags: parseJson<unknown>(row.ai_tags, []),
    note: row.note || undefined,
    category_id: row.category_id,
    importance: row.importance,
    content_type: row.content_type,
    status: row.status,
    saved_at: new Date(row.created_at).toISOString(),
  };
}

function json(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function error(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
