export interface Env extends Cloudflare.Env {
  ALLOWED_ORIGINS?: string;
  ALLOWED_EXTENSION_ORIGINS?: string;
  ANTHROPIC_API_KEY?: string;
}

export type BookmarkStatus =
  | 'pending'
  | 'active'
  | 'partial'
  | 'failed'
  | 'imported'
  | 'archived';

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
