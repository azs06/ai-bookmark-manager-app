import type { Env } from '../types';
import {
  buildSummarizeUserMessage,
  parseSummarizeTagJson,
  pickSystemPrompt,
  type SummarizeInput,
  type SummaryResult,
} from './prompts';

export type { SummaryResult } from './prompts';

// Haiku 5.5 thinks by default (adaptive) and thinking counts toward
// max_tokens, so caps leave headroom above the expected answer length.
const HAIKU_MODEL = 'claude-haiku-5-5';

// 'low' is the cheap automatic tier; explicit user actions (the Oracle) can
// ask for more. Haiku 5.5's API default is 'medium', so always send it.
export type HaikuEffort = 'low' | 'medium' | 'high';

// Haiku 5.5 runs safety classifiers that can decline a request (HTTP 200,
// stop_reason "refusal"). There's no server-side fallback for this model, so
// callers decide how to surface it. The message is user-readable on purpose:
// routes pass err.message straight through to the UI.
export class HaikuRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`Claude declined this request${category ? ` (category: ${category})` : ''}.`);
    this.name = 'HaikuRefusalError';
  }
}

interface MessagesResponse {
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  content: Array<{ type: string; text?: string }>;
}

async function callHaiku(
  env: Env,
  req: {
    system: string;
    user: string;
    maxTokens: number;
    effort: HaikuEffort;
    // Structured outputs: the API guarantees the reply parses against this
    // schema, so JSON routes can't come back as prose or half-fenced JSON.
    schema?: Record<string, unknown>;
  },
): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: req.maxTokens,
      output_config: {
        effort: req.effort,
        ...(req.schema && { format: { type: 'json_schema', schema: req.schema } }),
      },
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    }),
  });

  if (!resp.ok) throw new Error(`anthropic ${resp.status}: ${await resp.text()}`);
  return readText((await resp.json()) as MessagesResponse);
}

// Responses can lead with thinking blocks, so pick the text block by type.
// A response that hit max_tokens is incomplete (truncated JSON, cut-off chat
// answer) — fail loudly rather than hand callers a partial string.
// These are also the two cases where structured output may not match the schema.
function readText(data: MessagesResponse): string {
  if (data.stop_reason === 'refusal') {
    throw new HaikuRefusalError(data.stop_details?.category ?? null);
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error('anthropic response hit max_tokens before finishing');
  }
  return data.content.find((c) => c.type === 'text')?.text ?? '';
}

// Structured-output schemas: every object needs additionalProperties: false,
// and length/count constraints (minItems, maxLength…) aren't supported — the
// prompts carry those rules instead.
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'tags'],
  additionalProperties: false,
};

const PICKS_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks'],
  additionalProperties: false,
};

export async function summarizeAndTag(
  env: Env,
  input: SummarizeInput,
  opts: { effort?: HaikuEffort } = {},
): Promise<SummaryResult> {
  const text = await callHaiku(env, {
    system: pickSystemPrompt(input.kind, input.detail),
    user: buildSummarizeUserMessage(input),
    // Detailed runs think more (Oracle uses 'medium') and write more.
    maxTokens: input.detail === 'detailed' ? 2048 : 1024,
    effort: opts.effort ?? 'low',
    schema: SUMMARY_SCHEMA,
  });
  return parseSummarizeTagJson(text);
}

// ──────────────────────────────────────────────────────────────────
// Phase 5: Daily picks — Haiku selects 3-5 from pre-filtered candidates.
// ──────────────────────────────────────────────────────────────────

export interface PickCandidate {
  id: number;
  title: string | null;
  summary: string | null;
  tags: string[];
  importance: number;
  age_days: number;
  days_since_viewed: number | null;  // null = no recorded open
}

export interface Pick { id: number; reason: string; }

const PICK_SYSTEM_PROMPT = `You curate a daily shortlist from a personal bookmark library. From the candidates given, pick 3-5 that the user is most likely to act on today — balance long-unopened but high-importance items with recent saves they likely want to revisit. Each candidate shows how old it is and when it was last opened. Open tracking started recently, so "never opened" on an older save is weak evidence — weigh it lightly. Return STRICT JSON only:
{"picks": [{"id": 123, "reason": "one-sentence reason, max 15 words"}]}

Rules:
- Exactly 3-5 picks, no more, no less
- reason: crisp and specific, reference the bookmark's topic — not generic ("worth revisiting")
- No markdown, no code fences, no commentary`;

export async function suggestTopPicks(
  env: Env,
  candidates: PickCandidate[],
): Promise<Pick[]> {
  if (!env.ANTHROPIC_API_KEY || !candidates.length) return [];

  const text = await callHaiku(env, {
    system: PICK_SYSTEM_PROMPT,
    user: formatCandidates(candidates),
    maxTokens: 1024,
    effort: 'low',
    schema: PICKS_SCHEMA,
  });
  return parsePicks(text, new Set(candidates.map((c) => c.id)));
}

function formatCandidates(candidates: PickCandidate[]): string {
  const lines = candidates.map((c) => {
    const importanceLabel = c.importance === 2 ? 'pinned' : c.importance === 1 ? 'important' : 'normal';
    const tags = c.tags.length ? ` tags=[${c.tags.join(', ')}]` : '';
    const summary = c.summary ? ` — ${c.summary}` : '';
    const viewed = c.days_since_viewed === null ? 'never opened' : `opened ${c.days_since_viewed}d ago`;
    return `#${c.id} (${importanceLabel}, ${c.age_days}d old, ${viewed})${tags}: ${c.title ?? '(no title)'}${summary}`;
  });
  return `Candidates:\n${lines.join('\n')}`;
}

function parsePicks(text: string, validIds: Set<number>): Pick[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const parsed = JSON.parse(cleaned) as { picks?: unknown };
    if (!Array.isArray(parsed.picks)) return [];
    return parsed.picks
      .filter((p): p is { id: number; reason: string } =>
        typeof p === 'object' && p !== null
        && typeof (p as { id?: unknown }).id === 'number'
        && typeof (p as { reason?: unknown }).reason === 'string'
      )
      .filter((p) => validIds.has(p.id))  // drop hallucinated IDs
      .slice(0, 5);
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────
// Phase 6: Chat — answer a question with RAG context.
// ──────────────────────────────────────────────────────────────────

export interface ChatContext {
  id: number;
  title: string | null;
  url: string;
  summary: string | null;
  excerpt: string | null;
  tags: string[];
}

export interface ChatAnswer {
  answer: string;
  citedIds: number[];
}

const CHAT_SYSTEM_PROMPT = `You answer questions about a user's personal bookmark library. Use ONLY the provided context bookmarks — do not invent facts or cite pages not in the context.

Cite by bracketed bookmark id like [#42] when you reference a specific source. Keep answers concise (1-3 short paragraphs). If the context doesn't contain enough information to answer, say so directly — don't pad with speculation.`;

export async function answerWithContext(
  env: Env,
  question: string,
  context: ChatContext[],
): Promise<ChatAnswer> {
  const text = await callHaiku(env, {
    system: CHAT_SYSTEM_PROMPT,
    user: formatChatMessage(question, context),
    maxTokens: 2048,
    effort: 'low',
  });
  const answer = text.trim();
  return { answer, citedIds: extractCitations(answer, context) };
}

function formatChatMessage(question: string, context: ChatContext[]): string {
  if (!context.length) {
    return `Question: ${question}\n\n(No matching bookmarks found in the library for this question.)`;
  }
  const blocks = context.map((c) => {
    const tags = c.tags.length ? `\nTags: ${c.tags.join(', ')}` : '';
    const summary = c.summary ? `\nSummary: ${c.summary}` : '';
    // The stored excerpt (≤3000 chars) lets answers go past what a 1-2
    // sentence summary says. X posts store the same text as both — skip it.
    const excerpt = c.excerpt && c.excerpt !== c.summary ? `\nExcerpt: ${c.excerpt}` : '';
    return `[#${c.id}] ${c.title ?? c.url}\nURL: ${c.url}${tags}${summary}${excerpt}`;
  });
  return `Question: ${question}\n\nContext bookmarks:\n${blocks.join('\n\n')}`;
}

// Citations are written as [#NN] in the answer text. Extract numeric ids that
// actually exist in the supplied context — drop any the model hallucinated.
function extractCitations(answer: string, context: ChatContext[]): number[] {
  const validIds = new Set(context.map((c) => c.id));
  const found = new Set<number>();
  for (const match of answer.matchAll(/\[#(\d+)\]/g)) {
    const id = Number(match[1]);
    if (validIds.has(id)) found.add(id);
  }
  return [...found];
}
