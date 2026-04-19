import type { Env } from '../types';
import { suggestTopPicks, type PickCandidate } from './haiku';

const CANDIDATE_POOL = 30;
const DAY_MS = 86_400_000;

interface CandidateRow {
  id: number;
  title: string | null;
  ai_summary: string | null;
  ai_tags: string;
  importance: number;
  created_at: number;
}

// Generate today's picks and persist them. Idempotent — re-running on the same
// UTC day overwrites the row. Returns null if the library is too thin to bother.
export async function runDailySuggestions(env: Env): Promise<{ date: string; ids: number[] } | null> {
  const rows = await env.DB
    .prepare(`
      SELECT id, title, ai_summary, ai_tags, importance, created_at
      FROM bookmarks
      WHERE status IN ('active', 'partial')
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `)
    .bind(CANDIDATE_POOL)
    .all<CandidateRow>();

  const candidates = (rows.results ?? []).map(toCandidate);
  if (candidates.length < 3) return null;  // not enough signal to be useful

  const picks = await suggestTopPicks(env, candidates);
  if (!picks.length) return null;

  const date = todayUtc();
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
