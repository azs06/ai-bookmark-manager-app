import type { Env } from '../types';

export interface SummaryResult {
  summary: string;
  tags: string[];
}

export async function summarizeAndTag(
  env: Env,
  input: { title?: string; excerpt: string },
): Promise<SummaryResult> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(input) }],
    }),
  });

  if (!resp.ok) {
    throw new Error(`anthropic ${resp.status}: ${await resp.text()}`);
  }

  const data = (await resp.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = data.content.find((c) => c.type === 'text')?.text ?? '';
  return parseResponse(text);
}

// ──────────────────────────────────────────────────────────────────
// The two knobs below shape how your library feels. Tune them freely —
// no other code depends on the wording.
// ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You catalogue web pages into a personal bookmark library. For each page you receive, return a neutral summary and topical tags as STRICT JSON.

Output format (no code fences, no commentary, no leading text):
{"summary": "...", "tags": ["tag1", "tag2"]}

Rules:
- summary: 1-2 sentences. Describe what the page is about and why it might be worth revisiting. Neutral, concrete voice — no marketing language, no "this article…".
- tags: 3-5 items, lowercase, kebab-case for multi-word (e.g. "llm-evals"). Mix topical tags ("rust", "database-internals") with resource-type tags ("tutorial", "benchmark", "essay", "docs"). Avoid generic tags like "article", "web", "technology".
- If the excerpt is clearly junk (paywall, error page, navigation only), return {"summary": "", "tags": []}.`;

function buildUserMessage(input: { title?: string; excerpt: string }): string {
  const parts: string[] = [];
  if (input.title) parts.push(`Title: ${input.title}`);
  parts.push('Excerpt:', input.excerpt);
  return parts.join('\n');
}

// ──────────────────────────────────────────────────────────────────

function parseResponse(text: string): SummaryResult {
  const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const parsed = JSON.parse(cleaned) as { summary?: unknown; tags?: unknown };
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((t): t is string => typeof t === 'string')
        : [],
    };
  } catch {
    return { summary: '', tags: [] };
  }
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
}

export interface Pick { id: number; reason: string; }

const PICK_SYSTEM_PROMPT = `You curate a daily shortlist from a personal bookmark library. From the candidates given, pick 3-5 that the user is most likely to act on today — balance long-unopened but high-importance items with recent saves they likely want to revisit. Return STRICT JSON only:
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

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system: PICK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: formatCandidates(candidates) }],
    }),
  });

  if (!resp.ok) throw new Error(`anthropic ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content.find((c) => c.type === 'text')?.text ?? '';
  return parsePicks(text, new Set(candidates.map((c) => c.id)));
}

function formatCandidates(candidates: PickCandidate[]): string {
  const lines = candidates.map((c) => {
    const importanceLabel = c.importance === 2 ? 'pinned' : c.importance === 1 ? 'important' : 'normal';
    const tags = c.tags.length ? ` tags=[${c.tags.join(', ')}]` : '';
    const summary = c.summary ? ` — ${c.summary}` : '';
    return `#${c.id} (${importanceLabel}, ${c.age_days}d old)${tags}: ${c.title ?? '(no title)'}${summary}`;
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
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');

  const userMessage = formatChatMessage(question, context);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      system: CHAT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!resp.ok) throw new Error(`anthropic ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as { content: Array<{ type: string; text?: string }> };
  const answer = data.content.find((c) => c.type === 'text')?.text?.trim() ?? '';
  return { answer, citedIds: extractCitations(answer, context) };
}

function formatChatMessage(question: string, context: ChatContext[]): string {
  if (!context.length) {
    return `Question: ${question}\n\n(No matching bookmarks found in the library for this question.)`;
  }
  const blocks = context.map((c) => {
    const tags = c.tags.length ? `\nTags: ${c.tags.join(', ')}` : '';
    const summary = c.summary ? `\nSummary: ${c.summary}` : '';
    return `[#${c.id}] ${c.title ?? c.url}\nURL: ${c.url}${tags}${summary}`;
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
