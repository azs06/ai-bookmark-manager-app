export interface SummaryResult {
  summary: string;
  tags: string[];
}

export type ContentKind = 'article' | 'video';

export interface SummarizeInput {
  title?: string;
  excerpt: string;
  kind?: ContentKind;
  channel?: string;    // videos: author/creator name
  durationSec?: number; // videos: duration in seconds
}

export const SUMMARIZE_TAG_SYSTEM_PROMPT = `You catalogue web pages into a personal bookmark library. For each page you receive, return a neutral summary and topical tags as STRICT JSON.

Output format (no code fences, no commentary, no leading text):
{"summary": "...", "tags": ["tag1", "tag2"]}

Rules:
- summary: 1-2 sentences. Describe what the page is about and why it might be worth revisiting. Neutral, concrete voice — no marketing language, no "this article…".
- tags: 3-5 items, lowercase, kebab-case for multi-word (e.g. "llm-evals"). Mix topical tags ("rust", "database-internals") with resource-type tags ("tutorial", "benchmark", "essay", "docs"). Avoid generic tags like "article", "web", "technology".
- If the excerpt is clearly junk (paywall, error page, navigation only), return {"summary": "", "tags": []}.`;

// Voice differs from the article prompt: videos are watched, not read, and
// the excerpt here is usually a transcript — very chatty, lots of filler.
// We want the summary to describe what the *video* covers (not the
// transcript's surface content) and the tags to include a video-kind tag.
export const SUMMARIZE_VIDEO_SYSTEM_PROMPT = `You catalogue YouTube videos into a personal bookmark library. You receive a video's title, channel, duration, and a (possibly auto-generated) transcript excerpt. Return a neutral summary and topical tags as STRICT JSON.

Output format (no code fences, no commentary, no leading text):
{"summary": "...", "tags": ["tag1", "tag2"]}

Rules:
- summary: 1-2 sentences. Describe what the video *covers* — the topics, techniques, or arguments presented — not the channel's style. Neutral, concrete voice — no "in this video…" or "the speaker…". Lead with the subject matter.
- tags: 3-5 items, lowercase, kebab-case for multi-word. Mix topical tags with a video-kind tag from: "tutorial", "talk", "explainer", "interview", "review", "walkthrough", "demo", "vlog". Always include one kind tag. Avoid "video", "youtube".
- Transcripts from auto-captions may have typos, filler words, and missing punctuation — infer the actual topic rather than echoing exact phrases.
- If the transcript is empty, junk, or non-informative, return {"summary": "", "tags": []}.`;

export function pickSystemPrompt(kind: ContentKind | undefined): string {
  return kind === 'video' ? SUMMARIZE_VIDEO_SYSTEM_PROMPT : SUMMARIZE_TAG_SYSTEM_PROMPT;
}

export function buildSummarizeUserMessage(input: SummarizeInput): string {
  const parts: string[] = [];
  if (input.title) parts.push(`Title: ${input.title}`);
  if (input.channel) parts.push(`Channel: ${input.channel}`);
  if (input.durationSec) parts.push(`Duration: ${formatDuration(input.durationSec)}`);
  parts.push(input.kind === 'video' ? 'Transcript:' : 'Excerpt:', input.excerpt);
  return parts.join('\n');
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

// Tolerates: bare JSON, ```json fences, and leading/trailing prose around the
// JSON object. Smaller open-weight models sometimes prepend "Sure! Here's…"
// even when instructed not to — grabbing the first balanced {…} is resilient
// without being lenient enough to accept truly malformed output.
export function parseSummarizeTagJson(text: string): SummaryResult {
  const candidate = extractJsonObject(text);
  if (!candidate) return { summary: '', tags: [] };

  try {
    const parsed = JSON.parse(candidate) as { summary?: unknown; tags?: unknown };
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

function extractJsonObject(text: string): string | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  if (stripped.startsWith('{')) return stripped;

  // Scan for first balanced object, respecting string literals + escapes so
  // a `}` inside a string doesn't close the object prematurely.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) return stripped.slice(start, i + 1);
    }
  }
  return null;
}
