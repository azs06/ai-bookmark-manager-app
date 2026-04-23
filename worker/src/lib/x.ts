// x.com (Twitter) post enrichment helpers.
//
// Three entry points:
//   detectX        — pure URL → { user, statusId } (no network)
//   fetchXPostData — fxtwitter primary, oEmbed fallback
//   extractHashtags — pull #tags out of the tweet body
//
// We deliberately skip AI summarization for tweets: the tweet text IS the
// summary. Embedding still uses the tweet text so semantic search works.

const USER_AGENT = 'Mozilla/5.0 (compatible; AIBookmarks/0.1)';
const FETCH_TIMEOUT_MS = 8000;
const FX_TWITTER_BASE = 'https://api.fxtwitter.com';
const TWITTER_OEMBED_BASE = 'https://publish.twitter.com/oembed';

export interface XHit {
  user: string | null;   // null for /i/web/status/{id} URLs (no handle in path)
  statusId: string;
}

export interface XPostMetadata {
  statusId: string;
  author: string | null;        // display name
  handle: string | null;        // @screen_name (without @)
  postedAt: string | null;      // ISO string
  mediaUrls: string[];          // first item used as thumbnail
  likes: number | null;
  retweets: number | null;
  replies: number | null;
  hashtags: string[];           // lowercased, no leading #
  source: 'fxtwitter' | 'oembed';
}

export interface XPostData {
  text: string;
  meta: XPostMetadata;
  thumbnailUrl: string | null;
  ogDescription: string | null;
}

// detectX: parse a URL and decide whether it points at a single tweet.
//
// Accepts (return XHit):
//   https://x.com/{user}/status/{id}
//   https://twitter.com/{user}/status/{id}
//   https://mobile.x.com/{user}/status/{id}     (mobile.* / m.* subdomains)
//   https://m.twitter.com/{user}/status/{id}
//   https://x.com/i/web/status/{id}             (anon — user is null)
//   https://fxtwitter.com / vxtwitter.com / fixupx.com  (community mirrors;
//                                                        treat as canonical)
//   trailing /photo/N or /video/N — accepted, ignored
//   query strings + hashes — ignored
//
// Rejects (return null):
//   profile pages: /{user}
//   /i/spaces/{id}, /search, /explore, /i/lists/...
//   anything where the status ID isn't a 15–20 digit numeric snowflake
//
export function detectX(url: string): XHit | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol) || !isXHost(parsed.hostname)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const hasAllowedTail = (end: number) =>
    parts.length === end ||
    (parts.length === end + 2 &&
      (parts[end] === 'photo' || parts[end] === 'video') &&
      /^\d+$/.test(parts[end + 1] ?? ''));
  if (parts[0] === 'i' && parts[1] === 'web' && parts[2] === 'status' && isStatusId(parts[3]) && hasAllowedTail(4)) {
    return { user: null, statusId: parts[3] };
  }
  if (parts[1] === 'status' && isStatusId(parts[2]) && hasAllowedTail(3)) {
    return { user: parts[0] ?? null, statusId: parts[2] };
  }
  return null;
}

// Twitter snowflake IDs are 15–20 digits. (Today they're 19, but they were
// shorter in the early years and we accept saved tweets going back that far.)
function isStatusId(id: string | undefined | null): id is string {
  return !!id && /^\d{15,20}$/.test(id);
}

// Hosts that point at a tweet (canonical + mirrors). Strip leading mobile.* /
// m.* / www. before checking.
const X_HOSTS = new Set([
  'x.com',
  'twitter.com',
  'fxtwitter.com',
  'vxtwitter.com',
  'fixupx.com',
  'fixvx.com',
]);

export function isXHost(host: string): boolean {
  const stripped = host.toLowerCase().replace(/^(?:m|mobile|www)\./, '');
  return X_HOSTS.has(stripped);
}

// Exposed for detectX() to use.
export { isStatusId };

export async function fetchXPostData(hit: XHit): Promise<XPostData> {
  try {
    const fx = await fetchFxTwitter(hit);
    if (fx) {
      console.log('x:fxtwitter-hit', hit.statusId);
      return fx;
    }
  } catch (err) {
    console.warn('x:fxtwitter-failed', hit.statusId, err);
  }

  console.log('x:oembed-fallback', hit.statusId);
  return fetchTwitterOEmbed(hit);
}

interface FxTweetResponse {
  code?: number;
  tweet?: {
    id?: string;
    text?: string;
    created_timestamp?: number;
    created_at?: string;
    author?: {
      name?: string;
      screen_name?: string;
    };
    media?: {
      photos?: { url?: string }[];
      videos?: { thumbnail_url?: string; url?: string }[];
      all?: { type?: string; url?: string; thumbnail_url?: string }[];
    };
    likes?: number;
    retweets?: number;
    replies?: number;
  };
}

async function fetchFxTwitter(hit: XHit): Promise<XPostData | null> {
  // fxtwitter accepts a placeholder username when one isn't known.
  const userPath = hit.user ?? 'i';
  const url = `${FX_TWITTER_BASE}/${encodeURIComponent(userPath)}/status/${hit.statusId}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`fxtwitter ${resp.status}`);
  const json = (await resp.json()) as FxTweetResponse;
  if (!json.tweet) return null;
  const t = json.tweet;
  const text = (t.text ?? '').trim();
  if (!text) return null;

  const mediaUrls: string[] = [];
  for (const photo of t.media?.photos ?? []) {
    if (photo.url) mediaUrls.push(photo.url);
  }
  for (const video of t.media?.videos ?? []) {
    if (video.thumbnail_url) mediaUrls.push(video.thumbnail_url);
  }

  const postedAt = t.created_timestamp
    ? new Date(t.created_timestamp * 1000).toISOString()
    : t.created_at ?? null;

  const meta: XPostMetadata = {
    statusId: hit.statusId,
    author: t.author?.name ?? null,
    handle: t.author?.screen_name ?? hit.user ?? null,
    postedAt,
    mediaUrls,
    likes: typeof t.likes === 'number' ? t.likes : null,
    retweets: typeof t.retweets === 'number' ? t.retweets : null,
    replies: typeof t.replies === 'number' ? t.replies : null,
    hashtags: extractHashtags(text),
    source: 'fxtwitter',
  };

  return {
    text,
    meta,
    thumbnailUrl: mediaUrls[0] ?? null,
    ogDescription: text,
  };
}

interface OEmbedResponse {
  html?: string;
  author_name?: string;
  author_url?: string;
}

async function fetchTwitterOEmbed(hit: XHit): Promise<XPostData> {
  const tweetUrl = canonicalTweetUrl(hit);
  const url = `${TWITTER_OEMBED_BASE}?url=${encodeURIComponent(tweetUrl)}&omit_script=1`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`oembed ${resp.status}`);
  const json = (await resp.json()) as OEmbedResponse;

  const text = extractTextFromOEmbedHtml(json.html ?? '');
  const handle = handleFromAuthorUrl(json.author_url ?? null) ?? hit.user;

  const meta: XPostMetadata = {
    statusId: hit.statusId,
    author: json.author_name ?? null,
    handle,
    postedAt: null,
    mediaUrls: [],
    likes: null,
    retweets: null,
    replies: null,
    hashtags: extractHashtags(text),
    source: 'oembed',
  };

  return {
    text,
    meta,
    thumbnailUrl: null,
    ogDescription: text || null,
  };
}

function canonicalTweetUrl(hit: XHit): string {
  const user = hit.user ?? 'i/web';
  return `https://twitter.com/${user}/status/${hit.statusId}`;
}

// oEmbed HTML is a <blockquote> wrapping a <p> with the tweet body, then
// "&mdash; Author (@handle) <a>date</a>" tail. Strip tags from the <p> only.
function extractTextFromOEmbedHtml(html: string): string {
  const pMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!pMatch) return '';
  return decodeHtmlEntities(stripTags(pMatch[1] ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html: string): string {
  // Replace <br> with space first so tweet line breaks don't fuse words.
  return html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function handleFromAuthorUrl(authorUrl: string | null): string | null {
  if (!authorUrl) return null;
  try {
    const u = new URL(authorUrl);
    const seg = u.pathname.replace(/^\/+/, '').split('/')[0];
    return seg || null;
  } catch {
    return null;
  }
}

// Hashtags: # followed by a letter (so we don't grab "#" alone or "#1").
// Lowercase, dedupe, cap at 8 to avoid spammy hashtag-stuffed tweets blowing
// up ai_tags.
export function extractHashtags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(/#([\p{L}][\p{L}\p{N}_]*)/gu)) {
    const tag = match[1]!.toLowerCase();
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}
