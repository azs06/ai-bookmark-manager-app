// Reddit post enrichment helpers.
//
// Reddit's modern web interface gates scrapers behind a JS-driven "Please
// wait for verification" wall, which makes plain-HTML extraction useless and
// ships poor metadata into the bookmark (title becomes the wall page text).
// The fix is the long-standing public .json endpoint: append `.json` to any
// post URL and Reddit returns clean structured data — no auth, no JS, no
// bot wall. This is the same surface every Reddit client has used for years.
//
// Two entry points:
//   detectReddit     — pure URL → { postId, subreddit } (no network)
//   fetchRedditPost  — .json endpoint → post body + top comments + metadata

const USER_AGENT = 'ai-bookmark-manager:v0.1 (+personal bookmark tool)';
const FETCH_TIMEOUT_MS = 8000;

export interface RedditHit {
  postId: string;             // base36 short id, e.g. "1sshrk6"
  subreddit: string | null;   // null for /comments/<id> permalinks
}

export interface RedditPostData {
  title: string;
  author: string | null;
  subreddit: string | null;
  selftext: string | null;     // post body (markdown), null for link posts
  linkUrl: string | null;      // for link posts: the destination URL
  thumbnail: string | null;
  score: number | null;
  numComments: number | null;
  postedAt: string | null;     // ISO
  topComments: Array<{ author: string; body: string; score: number }>;
}

const REDDIT_HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
  'i.reddit.com',
]);

// detectReddit: accept post permalinks and short links.
//   https://www.reddit.com/r/<sub>/comments/<id>/<slug>?...   → { id, sub }
//   https://reddit.com/comments/<id>                          → { id, null }
//   https://redd.it/<id>                                      → { id, null }
// Rejects subreddit listings, user pages, /r/<sub>/s/<short> share links
// (those redirect-only short links — we'd need a HEAD/GET first to resolve).
export function detectReddit(url: string): RedditHit | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;

  if (u.hostname === 'redd.it') {
    const id = u.pathname.replace(/^\//, '').split('/')[0];
    if (id && /^[a-z0-9]+$/i.test(id)) {
      return { postId: id.toLowerCase(), subreddit: null };
    }
    return null;
  }

  if (!REDDIT_HOSTS.has(u.hostname.toLowerCase())) return null;

  // /r/<sub>/comments/<id>/<slug?>
  const m = u.pathname.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
  if (m && m[1] && m[2]) {
    return { postId: m[2].toLowerCase(), subreddit: m[1] };
  }
  // /comments/<id> (no subreddit in path)
  const bare = u.pathname.match(/^\/comments\/([a-z0-9]+)/i);
  if (bare && bare[1]) {
    return { postId: bare[1].toLowerCase(), subreddit: null };
  }
  return null;
}

interface RedditApiPost {
  title?: string;
  author?: string;
  subreddit?: string;
  selftext?: string;
  is_self?: boolean;
  url?: string;
  thumbnail?: string;
  preview?: { images?: Array<{ source?: { url?: string } }> };
  score?: number;
  num_comments?: number;
  created_utc?: number;
}

interface RedditApiComment {
  kind?: string;
  data?: { author?: string; body?: string; score?: number };
}

interface RedditApiListing {
  data?: { children?: Array<{ kind?: string; data?: unknown }> };
}

export async function fetchRedditPost(hit: RedditHit): Promise<RedditPostData | null> {
  // /comments/<id>.json works without the subreddit segment. raw_json=1 turns
  // off Reddit's HTML-entity escaping so &amp; etc don't appear in the data.
  const path = hit.subreddit
    ? `/r/${encodeURIComponent(hit.subreddit)}/comments/${hit.postId}.json`
    : `/comments/${hit.postId}.json`;
  const url = `https://www.reddit.com${path}?raw_json=1&limit=5`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    return null;
  }

  // Reddit returns an array: [postListing, commentListing].
  if (!Array.isArray(payload) || payload.length < 1) return null;
  const postListing = payload[0] as RedditApiListing;
  const post = postListing?.data?.children?.[0]?.data as RedditApiPost | undefined;
  if (!post || !post.title) return null;

  const commentListing = payload[1] as RedditApiListing | undefined;
  const topComments = (commentListing?.data?.children ?? [])
    .filter((c): c is RedditApiComment => c?.kind === 't1' && !!c.data)
    .slice(0, 3)
    .map((c) => ({
      author: c.data?.author ?? '[deleted]',
      body: (c.data?.body ?? '').trim(),
      score: c.data?.score ?? 0,
    }))
    .filter((c) => c.body.length > 0);

  // Reddit's `thumbnail` is sometimes a literal "self"/"default"/"nsfw" word
  // for non-image posts. Only accept actual http(s) URLs.
  const rawThumb = post.thumbnail ?? '';
  const thumbnail = /^https?:\/\//.test(rawThumb)
    ? rawThumb
    : (post.preview?.images?.[0]?.source?.url ?? null);

  return {
    title: post.title,
    author: post.author ?? null,
    subreddit: post.subreddit ?? hit.subreddit ?? null,
    selftext: post.is_self && post.selftext ? post.selftext : null,
    linkUrl: !post.is_self && post.url ? post.url : null,
    thumbnail,
    score: typeof post.score === 'number' ? post.score : null,
    numComments: typeof post.num_comments === 'number' ? post.num_comments : null,
    postedAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
    topComments,
  };
}
