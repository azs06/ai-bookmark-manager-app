export interface Env {
  DB: D1Database;
  VECTORIZE?: VectorizeIndex;
  KV?: KVNamespace;
  R2?: R2Bucket;
  AI?: Ai;
  ASSETS: Fetcher;
  ENV: string;
  ANTHROPIC_API_KEY?: string;
}

export type BookmarkStatus = 'pending' | 'active' | 'partial' | 'failed' | 'archived';

export interface BookmarkRow {
  id: number;
  url: string;
  url_hash: string;
  title: string | null;
  note: string;
  og_image_url: string | null;
  og_description: string | null;
  domain: string | null;
  ai_summary: string | null;
  ai_tags: string;
  importance: 0 | 1 | 2;
  view_count: number;
  last_viewed_at: number | null;
  content_excerpt: string | null;
  status: BookmarkStatus;
  created_at: number;
  updated_at: number;
}
