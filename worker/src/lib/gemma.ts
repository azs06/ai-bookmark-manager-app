import type { Env } from '../types';
import {
  buildSummarizeUserMessage,
  parseSummarizeTagJson,
  pickSystemPrompt,
  type SummarizeInput,
  type SummaryResult,
} from './prompts';

// Gemma 4 26B is a reasoning model — by default it burns the token budget on
// chain-of-thought in a separate `reasoning` field before emitting `content`,
// which is wasteful for summarize+tag and hits `finish_reason: "length"` at
// any reasonable max_tokens. Workers AI exposes `chat_template_kwargs:
// { enable_thinking: false }` which disables the reasoning pass at the
// tokenizer-template level, giving us the larger model's quality without
// the reasoning overhead.
const MODEL = '@cf/google/gemma-4-26b-a4b-it';

const MAX_OUTPUT_TOKENS = 400;

// Returns null when Gemma is unavailable (no AI binding) or produced
// unparseable output. Callers should fall back to Haiku on null. Each
// null-return path logs its cause so fallback-rate diagnosis doesn't
// require flipping to a debugger.
export async function summarizeAndTagGemma(
  env: Env,
  input: SummarizeInput,
): Promise<SummaryResult | null> {
  if (!env.AI) {
    console.warn('gemma: no AI binding');
    return null;
  }

  const resp = await env.AI.run(MODEL, {
    messages: [
      { role: 'system', content: pickSystemPrompt(input.kind) },
      { role: 'user', content: buildSummarizeUserMessage(input) },
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
    // Disable Gemma 4's chain-of-thought. For this task we need
    // instruction-following, not reasoning — without this flag the model
    // spends the token budget in `message.reasoning` and emits null content.
    chat_template_kwargs: { enable_thinking: false },
  } as Parameters<typeof env.AI.run>[1]);

  const text = extractResponseText(resp);
  if (!text) {
    // Dump choices[0] so we can see the exact shape — `content` might be null,
    // nested as an array of parts, under `reasoning_content`, or behind a
    // tool_call. Truncate to stay under log-line limits.
    const choice = (resp as { choices?: unknown[] })?.choices?.[0];
    const dump = JSON.stringify(choice ?? resp).slice(0, 600);
    console.warn('gemma: empty response, choice[0]:', dump);
    return null;
  }

  const parsed = parseSummarizeTagJson(text);
  // Empty summary + empty tags is a legitimate "junk page" signal from the
  // prompt. But if Gemma returned non-empty text that failed to parse into
  // either field, treat it as a miss so we fall back to Haiku.
  if (!parsed.summary && !parsed.tags.length) {
    console.warn('gemma: parse failure, output head:', text.slice(0, 200));
    return null;
  }
  return parsed;
}

// Workers AI returns two shapes depending on the model family:
//   - Simple text models: { response: "..." }
//   - Chat-tuned models (incl. Gemma 4): OpenAI-compatible { choices: [{ message: { content }}] }
// We accept both so the module keeps working if Cloudflare shifts a model
// between shapes (they've done this before for Llama variants).
function extractResponseText(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  if (!resp || typeof resp !== 'object') return '';

  const obj = resp as Record<string, unknown>;
  if (typeof obj.response === 'string') return obj.response;

  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0] as { message?: { content?: unknown }; text?: unknown };
    const content = choice.message?.content ?? choice.text;
    if (typeof content === 'string') return content;
  }
  return '';
}
