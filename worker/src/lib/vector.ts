import type { Env } from '../types';

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const EXCERPT_CHARS_FOR_EMBEDDING = 500;

interface EmbedInput {
  title: string | null;
  summary: string;
  excerpt: string | null;
}

export async function embedAndUpsert(
  env: Env,
  bookmarkId: number,
  input: EmbedInput,
): Promise<void> {
  if (!env.AI || !env.VECTORIZE) return;

  const text = [
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
