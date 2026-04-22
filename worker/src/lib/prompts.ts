export interface SummaryResult {
  summary: string;
  tags: string[];
}

export const SUMMARIZE_TAG_SYSTEM_PROMPT = `You catalogue web pages into a personal bookmark library. For each page you receive, return a neutral summary and topical tags as STRICT JSON.

Output format (no code fences, no commentary, no leading text):
{"summary": "...", "tags": ["tag1", "tag2"]}

Rules:
- summary: 1-2 sentences. Describe what the page is about and why it might be worth revisiting. Neutral, concrete voice — no marketing language, no "this article…".
- tags: 3-5 items, lowercase, kebab-case for multi-word (e.g. "llm-evals"). Mix topical tags ("rust", "database-internals") with resource-type tags ("tutorial", "benchmark", "essay", "docs"). Avoid generic tags like "article", "web", "technology".
- If the excerpt is clearly junk (paywall, error page, navigation only), return {"summary": "", "tags": []}.`;

export function buildSummarizeUserMessage(input: { title?: string; excerpt: string }): string {
  const parts: string[] = [];
  if (input.title) parts.push(`Title: ${input.title}`);
  parts.push('Excerpt:', input.excerpt);
  return parts.join('\n');
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
