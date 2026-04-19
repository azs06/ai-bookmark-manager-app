// Phase 1: Anthropic Haiku calls with prompt caching for chat-over-library.
// Phase 2+: daily "what matters today" suggestion generator.
//
// Stub for phase 0.

import type { Env } from '../types';

export async function embedText(env: Env, text: string): Promise<number[]> {
  if (!env.AI) {
    throw new Error('AI binding is not configured');
  }
  const resp = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
  const data = resp as { data: number[][] };
  const first = data.data[0];
  if (!first) throw new Error('embedding returned no vectors');
  return first;
}
