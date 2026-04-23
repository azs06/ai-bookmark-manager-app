import type { Env } from '../types';

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const EXCERPT_CHARS_FOR_EMBEDDING = 500;

interface EmbedInput {
  title: string | null;
  summary: string;
  excerpt: string | null;
  // Video-type signals. When present, a short "video — channel — 12m" line
  // is prepended to the embed text so channel/duration become searchable
  // without polluting the summary or excerpt.
  videoContext?: {
    channel?: string | null;
    durationSec?: number | null;
  };
}

export async function embedAndUpsert(
  env: Env,
  bookmarkId: number,
  input: EmbedInput,
): Promise<void> {
  if (!env.AI || !env.VECTORIZE) return;

  const text = [
    videoSignalLine(input.videoContext),
    input.title,
    input.summary,
    input.excerpt?.slice(0, EXCERPT_CHARS_FOR_EMBEDDING),
  ]
    .filter((x): x is string => Boolean(x))
    .join(' — ');

  const vector = await embed(env, text);
  if (!vector) return;

  await env.VECTORIZE.upsert([
    { id: String(bookmarkId), values: vector },
  ]);
}

function videoSignalLine(ctx: EmbedInput['videoContext']): string | null {
  if (!ctx) return null;
  const bits: string[] = ['video'];
  if (ctx.channel) bits.push(`channel: ${ctx.channel}`);
  if (ctx.durationSec) {
    const m = Math.floor(ctx.durationSec / 60);
    bits.push(m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`);
  }
  return bits.length > 1 ? bits.join(' — ') : null;
}

export async function deleteEmbedding(env: Env, bookmarkId: number): Promise<void> {
  if (!env.VECTORIZE) return;
  await env.VECTORIZE.deleteByIds([String(bookmarkId)]);
}

export async function embedQuery(env: Env, query: string): Promise<number[] | null> {
  if (!env.AI) return null;
  return embed(env, query);
}

async function embed(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  const resp = await env.AI.run(EMBEDDING_MODEL, { text: [text] });
  const data = resp as { data?: number[][] };
  return data.data?.[0] ?? null;
}
