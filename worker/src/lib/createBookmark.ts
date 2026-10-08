import type { BookmarkStatus, Env } from '../types';
import { hashUrl, normalizeUrl } from './url';
import { enrich } from './enrich';
import { embedAndUpsert } from './vector';
import { detectYouTube } from './youtube';
import { detectX } from './x';

export interface ExistingBookmark {
  id: number;
  status: BookmarkStatus;
  title: string | null;
  note: string;
  ai_summary: string | null;
  ai_tags: string;
  content_excerpt: string | null;
  short_code: string | null;
}

export interface CreateBookmarkInput {
  url: string;
  title?: string | null;
  note?: string;
  // Optional on-device summary from the extension. When present, it lands in
  // the row immediately so the UI shows a summary before enrich() finishes,
  // and enrich() preserves it instead of overwriting with the AI tier's summary.
  ai_summary?: string;
  summary_source?: 'on-device';
}

export type CreateBookmarkResult =
  | { kind: 'duplicate'; id: number; status: BookmarkStatus; existing: ExistingBookmark }
  | { kind: 'restored'; id: number; status: BookmarkStatus; existing: ExistingBookmark }
  | { kind: 'new'; id: number; status: 'pending' | 'partial'; contentType: 'video' | 'x' | null };

// Single ingest path shared by the HTTP POST /api/bookmarks handler and the
// Telegram webhook. Encapsulates: URL normalization, dedupe by url_hash,
// archived-restore, fresh insert, and the waitUntil(enrich) kickoff. Callers
// layer transport-specific concerns (auto_shorten for HTTP, reply formatting
// for Telegram) on top of the result.
//
// ctx is structurally typed for the same reason shortlinkRedirect's is — Hono's
// c.executionCtx and Cloudflare's ExecutionContext<unknown> disagree on whether
// `exports` is optional. We only need waitUntil here.
export async function createOrRestoreBookmark(
  env: Env,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
  input: CreateBookmarkInput,
): Promise<CreateBookmarkResult> {
  const normalized = normalizeUrl(input.url);
  const urlHash = await hashUrl(normalized);
  const domain = new URL(normalized).hostname;
  const now = Date.now();

  const existing = await env.DB
    .prepare(`
      SELECT id, status, title, note, ai_summary, ai_tags, content_excerpt, short_code
      FROM bookmarks
      WHERE url_hash = ?
    `)
    .bind(urlHash)
    .first<ExistingBookmark>();

  if (existing) {
    if (existing.status === 'archived') {
      const restoredStatus = deriveRestoredStatus(existing);
      const restoredTitle = input.title ?? existing.title;
      const restoredNote = input.note ?? existing.note;

      await env.DB
        .prepare(`
          UPDATE bookmarks
          SET title = ?, note = ?, status = ?, updated_at = ?
          WHERE id = ?
        `)
        .bind(restoredTitle, restoredNote, restoredStatus, now, existing.id)
        .run();

      const restored: ExistingBookmark = {
        ...existing,
        title: restoredTitle,
        note: restoredNote,
        status: restoredStatus,
      };

      ctx.waitUntil(
        repairRestoredBookmark(env, restored).catch((err) => {
          console.error('restore repair failed', err);
        }),
      );

      return { kind: 'restored', id: existing.id, status: restoredStatus, existing: restored };
    }

    await env.DB
      .prepare('UPDATE bookmarks SET updated_at = ? WHERE id = ?')
      .bind(now, existing.id)
      .run();

    return { kind: 'duplicate', id: existing.id, status: existing.status, existing };
  }

  // Stamp content_type + minimal metadata at insert time so the list view
  // can show "Videos (N)" counts and a play-icon placeholder while the
  // async enricher is still running. enrich() will overwrite metadata with
  // richer fields (channel, duration, publishedAt) when it finishes.
  const yt = detectYouTube(normalized);
  const xPost = !yt ? detectX(normalized) : null;
  const contentType = yt ? 'video' : xPost ? 'x' : null;
  const baseMetadata: Record<string, unknown> = yt
    ? { videoId: yt.videoId }
    : xPost
      ? { statusId: xPost.statusId, ...(xPost.user ? { handle: xPost.user } : {}) }
      : {};
  if (input.ai_summary && input.summary_source) {
    baseMetadata.summary_source = input.summary_source;
    baseMetadata.summary_at = now;
  }
  const initialMetadata = JSON.stringify(baseMetadata);
  const initialSummary = input.ai_summary?.trim() || null;
  // If the extension already gave us an on-device summary, mark the row
  // 'partial' (renderable) at insert time so the popup confirmation shows
  // the summary right away. enrich() promotes to 'active' once tags + embed
  // are in place.
  const initialStatus = initialSummary ? 'partial' : 'pending';

  const result = await env.DB
    .prepare(`
      INSERT INTO bookmarks (url, url_hash, title, note, domain, content_type, metadata, ai_summary, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(normalized, urlHash, input.title ?? null, input.note ?? '', domain, contentType, initialMetadata, initialSummary, initialStatus, now, now)
    .run();

  const id = result.meta.last_row_id as number;

  // First pass only: ask enrich to keep the on-device summary the client just
  // handed us. Every other enrich caller (re-enrich, batch) omits the flag and
  // regenerates, so this summary is replaceable later.
  ctx.waitUntil(enrich(env, id, { preserveClientSummary: !!initialSummary }));

  return { kind: 'new', id, status: initialStatus, contentType };
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
