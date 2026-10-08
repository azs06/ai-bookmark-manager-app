import type { Env } from '../types';
import { suggestTopPicks, type PickCandidate } from './haiku';

// The pool is half most-recent saves, half least-recently-opened, both
// ranked by importance first — so the model sees both kinds the prompt asks
// it to balance, instead of 30 recent saves.
const RECENT_POOL = 15;
const STALE_POOL = 15;
// Bookmarks picked in the last week sit out, so the shortlist rotates.
const REPICK_COOLDOWN_DAYS = 7;
const DAY_MS = 86_400_000;

interface CandidateRow {
  id: number;
  title: string | null;
  ai_summary: string | null;
  ai_tags: string;
  importance: number;
  created_at: number;
  last_viewed_at: number | null;
}

// Generate today's picks and persist them. Idempotent — re-running on the same
// UTC day overwrites the row. Returns null if the library is too thin to bother.
export async function runDailySuggestions(env: Env): Promise<{ date: string; ids: number[] } | null> {
  const date = todayUtc();

  // A small library can't sit everything out — fall back to the full pool.
  let rows = await loadCandidates(env, await recentlyPickedIds(env, date));
  if (rows.length < 3) rows = await loadCandidates(env, []);

  const candidates = rows.map(toCandidate);
  if (candidates.length < 3) return null;  // not enough signal to be useful

  const picks = await suggestTopPicks(env, candidates);
  if (!picks.length) return null;

  const ids = picks.map((p) => p.id);
  const reasons = Object.fromEntries(picks.map((p) => [p.id, p.reason]));

  await env.DB
    .prepare(`
      INSERT OR REPLACE INTO daily_suggestions (date, bookmark_ids, reasons, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .bind(date, JSON.stringify(ids), JSON.stringify(reasons), Date.now())
    .run();

  return { date, ids };
}

async function loadCandidates(env: Env, excludeIds: number[]): Promise<CandidateRow[]> {
  const exclusion = excludeIds.length
    ? `AND id NOT IN (${excludeIds.map(() => '?').join(',')})`
    : '';
  const select = (orderBy: string, limit: number) => env.DB
    .prepare(`
      SELECT id, title, ai_summary, ai_tags, importance, created_at, last_viewed_at
      FROM bookmarks
      WHERE status IN ('active', 'partial') ${exclusion}
      ORDER BY ${orderBy}
      LIMIT ?
    `)
    .bind(...excludeIds, limit)
    .all<CandidateRow>();

  const [recent, stale] = await Promise.all([
    select('importance DESC, created_at DESC', RECENT_POOL),
    select('importance DESC, COALESCE(last_viewed_at, 0) ASC, created_at ASC', STALE_POOL),
  ]);

  const byId = new Map<number, CandidateRow>();
  for (const row of [...(recent.results ?? []), ...(stale.results ?? [])]) byId.set(row.id, row);
  return [...byId.values()];
}

// Ids picked on the previous REPICK_COOLDOWN_DAYS days. Today's own row is
// excluded so a same-day re-run stays idempotent rather than dodging itself.
async function recentlyPickedIds(env: Env, today: string): Promise<number[]> {
  const since = new Date(Date.now() - REPICK_COOLDOWN_DAYS * DAY_MS).toISOString().slice(0, 10);
  const rows = await env.DB
    .prepare('SELECT bookmark_ids FROM daily_suggestions WHERE date >= ? AND date < ?')
    .bind(since, today)
    .all<{ bookmark_ids: string }>();
  const ids = (rows.results ?? []).flatMap((r) => safeJsonArray<number>(r.bookmark_ids));
  return [...new Set(ids.filter((n) => typeof n === 'number'))];
}

export interface TodayPayload {
  date: string;
  picks: Array<{ id: number; reason: string }>;
  generated_at: number | null;
}

export async function getTodaysSuggestions(env: Env): Promise<TodayPayload> {
  const date = todayUtc();
  const row = await env.DB
    .prepare('SELECT bookmark_ids, reasons, created_at FROM daily_suggestions WHERE date = ?')
    .bind(date)
    .first<{ bookmark_ids: string; reasons: string; created_at: number }>();

  if (!row) return { date, picks: [], generated_at: null };

  const ids = safeJsonArray<number>(row.bookmark_ids).filter((n) => typeof n === 'number');
  const reasons = safeJsonObject(row.reasons);
  const picks = ids.map((id) => ({ id, reason: reasons[String(id)] ?? '' }));
  return { date, picks, generated_at: row.created_at };
}

function toCandidate(row: CandidateRow): PickCandidate {
  return {
    id: row.id,
    title: row.title,
    summary: row.ai_summary,
    tags: safeJsonArray<string>(row.ai_tags).filter((t) => typeof t === 'string'),
    importance: row.importance,
    age_days: Math.max(0, Math.floor((Date.now() - row.created_at) / DAY_MS)),
    days_since_viewed: row.last_viewed_at === null
      ? null
      : Math.max(0, Math.floor((Date.now() - row.last_viewed_at) / DAY_MS)),
  };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeJsonArray<T>(raw: string): T[] {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p as T[]) : [];
  } catch { return []; }
}

function safeJsonObject(raw: string): Record<string, string> {
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      return Object.fromEntries(
        Object.entries(p as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string') as [string, string][],
      );
    }
  } catch { /* fall through */ }
  return {};
}
