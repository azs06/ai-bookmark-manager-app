// RSS / Atom ingestion.
//
// Three concerns live here:
//   1. Auto-discovery: given a URL, figure out the canonical feed URL.
//      If the URL already points at a feed, keep it. If it points at an HTML
//      page, scan <link rel="alternate" type="application/rss+xml"> (and atom+xml).
//   2. Parsing: RSS 2.0 and Atom, using fast-xml-parser. We extract a small
//      shape (guid, url, title, author, published_at, excerpt) — no channel-level
//      metadata beyond the feed title/site URL the caller needs.
//   3. Upsert: INSERT OR IGNORE on (feed_id, guid) so re-polling is a no-op
//      on unchanged feeds. Returns the newly-inserted item IDs so slice 4
//      can queue importance scoring against them.

import { XMLParser } from 'fast-xml-parser';
import type { Env } from '../types';

const USER_AGENT = 'Mozilla/5.0 (compatible; AIBookmarks/0.1; +RSS reader)';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_EXCERPT_CHARS = 1500;

export interface FeedMetadata {
  url: string;           // canonical feed URL
  title: string | null;
  site_url: string | null;
  favicon_url: string | null;
}

export interface ParsedItem {
  guid: string;
  url: string | null;
  title: string | null;
  author: string | null;
  published_at: number | null;   // epoch ms, null when the feed omits a date
  content_excerpt: string | null;
}

export interface ParsedFeed {
  title: string | null;
  site_url: string | null;
  items: ParsedItem[];
}

export interface FeedCandidate {
  url: string;
  title: string | null;
  type: 'rss' | 'atom' | 'unknown';
}

export interface DirectParse {
  metadata: FeedMetadata;
  items: ParsedItem[];
  etag: string | null;
  lastModified: string | null;
}

// `direct`: the URL was a feed, or the HTML page had exactly one alternate
// link (in which case it was auto-fetched and parsed). `candidates`: the HTML
// page has multiple feeds — the route returns these to the client and waits
// for a pick before committing.
export type DiscoverResult =
  | ({ kind: 'direct' } & DirectParse)
  | { kind: 'candidates'; candidates: FeedCandidate[] };

// Entry point for `POST /api/feeds`. Fetches inputUrl once. If the body is
// HTML, scans for feed links; a single hit is auto-followed, multiple hits
// return as candidates. If the body is already a feed, parses it directly.
export async function discover(inputUrl: string): Promise<DiscoverResult> {
  const firstResp = await timedFetch(inputUrl);
  const contentType = firstResp.headers.get('content-type') ?? '';
  const body = await firstResp.text();

  if (looksLikeHtml(contentType, body)) {
    const candidates = findFeedLinksInHtml(body, firstResp.url);
    if (candidates.length === 0) {
      throw new Error('No RSS/Atom feed linked from this page.');
    }
    if (candidates.length > 1) {
      return { kind: 'candidates', candidates };
    }
    // Exactly one — follow it. Refetch rather than reuse body (this URL is
    // a feed, not HTML).
    const [only] = candidates;
    return { kind: 'direct', ...(await fetchAndParseFeed(only!.url)) };
  }

  // Input URL was the feed itself — parse what we already fetched.
  const parsed = parseFeed(body);
  const siteUrl = parsed.site_url ?? deriveSiteUrl(firstResp.url);
  return {
    kind: 'direct',
    metadata: {
      url: firstResp.url,
      title: parsed.title,
      site_url: siteUrl,
      favicon_url: siteUrl ? `${new URL(siteUrl).origin}/favicon.ico` : null,
    },
    items: parsed.items,
    etag: firstResp.headers.get('etag'),
    lastModified: firstResp.headers.get('last-modified'),
  };
}

// Fetch a known feed URL (from the picker, or the single-candidate path).
// Skips the HTML discovery step entirely.
export async function fetchAndParseFeed(feedUrl: string): Promise<DirectParse> {
  const resp = await timedFetch(feedUrl);
  const body = await resp.text();
  const parsed = parseFeed(body);
  const siteUrl = parsed.site_url ?? deriveSiteUrl(feedUrl);
  return {
    metadata: {
      url: feedUrl,
      title: parsed.title,
      site_url: siteUrl,
      favicon_url: siteUrl ? `${new URL(siteUrl).origin}/favicon.ico` : null,
    },
    items: parsed.items,
    etag: resp.headers.get('etag'),
    lastModified: resp.headers.get('last-modified'),
  };
}

// ──────────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Preserve CDATA contents (common in <description> / <content:encoded>).
  parseTagValue: false,
  trimValues: true,
  // fast-xml-parser's default XXE/billion-laughs cap of 1000 expansions is
  // easy to trip on real feeds (hundreds of items × a few &amp; each). We
  // still keep a finite ceiling so a malicious feed can't balloon memory.
  processEntities: {
    enabled: true,
    maxTotalExpansions: 50_000,
    maxExpandedLength: 10_000_000,
  },
});

export function parseFeed(xml: string): ParsedFeed {
  const doc = parser.parse(xml) as Record<string, unknown>;

  // RSS 2.0: <rss><channel><item>…
  const rss = doc.rss as { channel?: RssChannel } | undefined;
  if (rss?.channel) return parseRss(rss.channel);

  // Atom: <feed><entry>…
  const atom = doc.feed as AtomFeed | undefined;
  if (atom) return parseAtom(atom);

  throw new Error('Unrecognized feed format (not RSS 2.0 or Atom).');
}

interface RssChannel {
  title?: string;
  link?: string | { '#text'?: string };
  item?: RssItem | RssItem[];
}
interface RssItem {
  title?: string;
  link?: string;
  guid?: string | { '#text'?: string; '@_isPermaLink'?: string };
  pubDate?: string;
  author?: string;
  'dc:creator'?: string;
  description?: string;
  'content:encoded'?: string;
}

function parseRss(channel: RssChannel): ParsedFeed {
  const rawItems = channel.item
    ? Array.isArray(channel.item) ? channel.item : [channel.item]
    : [];
  const items: ParsedItem[] = [];
  for (const it of rawItems) {
    const url = typeof it.link === 'string' ? it.link : null;
    const guidRaw = it.guid;
    const guid = typeof guidRaw === 'string'
      ? guidRaw
      : guidRaw && typeof guidRaw === 'object' ? guidRaw['#text'] ?? null : null;
    const resolvedGuid = guid ?? url ?? null;
    if (!resolvedGuid) continue;  // no stable identity → can't dedup, skip

    const body = it['content:encoded'] ?? it.description ?? null;
    items.push({
      guid: resolvedGuid,
      url,
      title: it.title ?? null,
      author: it['dc:creator'] ?? it.author ?? null,
      published_at: it.pubDate ? parseDate(it.pubDate) : null,
      content_excerpt: body ? stripHtmlToExcerpt(body) : null,
    });
  }
  return {
    title: channel.title ?? null,
    site_url: typeof channel.link === 'string'
      ? channel.link
      : channel.link && typeof channel.link === 'object' ? channel.link['#text'] ?? null : null,
    items,
  };
}

interface AtomFeed {
  title?: string | { '#text'?: string };
  link?: AtomLink | AtomLink[];
  entry?: AtomEntry | AtomEntry[];
}
interface AtomLink {
  '@_href'?: string;
  '@_rel'?: string;
  '@_type'?: string;
}
interface AtomEntry {
  id?: string;
  title?: string | { '#text'?: string };
  link?: AtomLink | AtomLink[];
  updated?: string;
  published?: string;
  author?: { name?: string } | { name?: string }[];
  summary?: string | { '#text'?: string };
  content?: string | { '#text'?: string };
}

function parseAtom(feed: AtomFeed): ParsedFeed {
  const rawEntries = feed.entry
    ? Array.isArray(feed.entry) ? feed.entry : [feed.entry]
    : [];
  const items: ParsedItem[] = [];
  for (const e of rawEntries) {
    const url = pickAtomHtmlLink(e.link);
    const guid = e.id ?? url ?? null;
    if (!guid) continue;

    const body = pickText(e.content) ?? pickText(e.summary);
    const author = Array.isArray(e.author)
      ? e.author[0]?.name ?? null
      : e.author?.name ?? null;

    items.push({
      guid,
      url,
      title: pickText(e.title),
      author,
      published_at: e.published ? parseDate(e.published) : e.updated ? parseDate(e.updated) : null,
      content_excerpt: body ? stripHtmlToExcerpt(body) : null,
    });
  }
  return {
    title: pickText(feed.title),
    site_url: pickAtomHtmlLink(feed.link),
    items,
  };
}

function pickText(v: string | { '#text'?: string } | undefined): string | null {
  if (typeof v === 'string') return v || null;
  if (v && typeof v === 'object') return v['#text'] ?? null;
  return null;
}

// Atom can have many <link> elements. We want the one that points at the
// article page (rel="alternate" or omitted, type="text/html" or omitted).
function pickAtomHtmlLink(link: AtomLink | AtomLink[] | undefined): string | null {
  if (!link) return null;
  const links = Array.isArray(link) ? link : [link];
  const alt = links.find(
    (l) => (!l['@_rel'] || l['@_rel'] === 'alternate')
        && (!l['@_type'] || l['@_type'].includes('html')),
  );
  return alt?.['@_href'] ?? links[0]?.['@_href'] ?? null;
}

// ──────────────────────────────────────────────────────────────────
// Auto-discovery
// ──────────────────────────────────────────────────────────────────

function looksLikeHtml(contentType: string, body: string): boolean {
  if (contentType.includes('html')) return true;
  if (contentType.includes('xml')) return false;
  // No/ambiguous content-type: sniff the first bytes.
  const head = body.slice(0, 200).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html');
}

// Scan <head> for all <link rel="alternate" type="application/(rss|atom)+xml">
// entries. Regex is acceptable here: we're only looking at head content and
// the tag shape is simple. Duplicates (same resolved URL) are collapsed.
function findFeedLinksInHtml(html: string, baseUrl: string): FeedCandidate[] {
  const head = html.slice(0, html.toLowerCase().indexOf('</head>') + 7 || 8000);
  const linkRe = /<link\b([^>]*)>/gi;
  const out: FeedCandidate[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = linkRe.exec(head)) !== null) {
    const attrs = match[1] ?? '';
    const rel = attrMatch(attrs, 'rel')?.toLowerCase();
    if (rel !== 'alternate') continue;
    const type = attrMatch(attrs, 'type')?.toLowerCase();
    let kind: FeedCandidate['type'];
    if (type === 'application/rss+xml') kind = 'rss';
    else if (type === 'application/atom+xml') kind = 'atom';
    else continue;
    const href = attrMatch(attrs, 'href');
    if (!href) continue;
    let resolved: string;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push({
      url: resolved,
      title: attrMatch(attrs, 'title') ?? null,
      type: kind,
    });
  }
  return out;
}

function attrMatch(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = attrs.match(re);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? null;
}

function deriveSiteUrl(feedUrl: string): string | null {
  try {
    return new URL(feedUrl).origin;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────

interface FetchOptions {
  headers?: Record<string, string>;
  // Treat 304 as a success (return null body) instead of throwing. Used for
  // conditional GETs during polling.
  allowNotModified?: boolean;
}

async function timedFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.5',
        ...opts.headers,
      },
      signal: controller.signal,
    });
    if (opts.allowNotModified && resp.status === 304) return resp;
    if (!resp.ok) throw new Error(`Feed fetch failed: HTTP ${resp.status}`);
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

function parseDate(raw: string): number | null {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function stripHtmlToExcerpt(html: string): string {
  const text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_EXCERPT_CHARS ? text.slice(0, MAX_EXCERPT_CHARS) : text;
}

// ──────────────────────────────────────────────────────────────────
// Polling
// ──────────────────────────────────────────────────────────────────

export interface FeedPollRow {
  id: number;
  url: string;
  etag: string | null;
  last_modified: string | null;
}

export interface PollResult {
  feed_id: number;
  not_modified: boolean;
  new_item_ids: number[];
  error: string | null;
}

// Poll one feed with a conditional GET. On 304 we only bump last_fetched_at.
// On success we parse, upsert new items, and refresh the cached validators.
// On error the message is stored in feeds.error — subsequent successful
// polls clear it.
export async function pollFeed(env: Env, feed: FeedPollRow): Promise<PollResult> {
  const now = Date.now();
  const headers: Record<string, string> = {};
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

  let resp: Response;
  try {
    resp = await timedFetch(feed.url, { headers, allowNotModified: true });
  } catch (err) {
    const message = (err as Error).message;
    await env.DB
      .prepare('UPDATE feeds SET last_fetched_at = ?, error = ? WHERE id = ?')
      .bind(now, message, feed.id)
      .run();
    return { feed_id: feed.id, not_modified: false, new_item_ids: [], error: message };
  }

  if (resp.status === 304) {
    await env.DB
      .prepare('UPDATE feeds SET last_fetched_at = ?, error = NULL WHERE id = ?')
      .bind(now, feed.id)
      .run();
    return { feed_id: feed.id, not_modified: true, new_item_ids: [], error: null };
  }

  let items: ParsedItem[];
  try {
    const body = await resp.text();
    const parsed = parseFeed(body);
    items = parsed.items;
  } catch (err) {
    const message = (err as Error).message;
    await env.DB
      .prepare('UPDATE feeds SET last_fetched_at = ?, error = ? WHERE id = ?')
      .bind(now, message, feed.id)
      .run();
    return { feed_id: feed.id, not_modified: false, new_item_ids: [], error: message };
  }

  const insertedIds = await insertNewItems(env, feed.id, items);
  const etag = resp.headers.get('etag');
  const lastModified = resp.headers.get('last-modified');

  await env.DB
    .prepare(`
      UPDATE feeds
      SET last_fetched_at = ?, etag = ?, last_modified = ?, error = NULL
      WHERE id = ?
    `)
    .bind(now, etag, lastModified, feed.id)
    .run();

  return { feed_id: feed.id, not_modified: false, new_item_ids: insertedIds, error: null };
}

// Poll every subscribed feed. Runs inside the hourly cron and the manual
// refresh endpoint. Sequential on purpose: at MVP scale (<50 feeds) the
// extra latency is immaterial, and sequencing avoids piling on open sockets
// for the worker's connection budget.
export async function pollAllFeeds(env: Env): Promise<{
  feeds: number;
  new_items: number;
  errors: number;
}> {
  const rows = await env.DB
    .prepare('SELECT id, url, etag, last_modified FROM feeds ORDER BY id ASC')
    .all<FeedPollRow>();
  const feeds = rows.results ?? [];

  let newItems = 0;
  let errors = 0;
  for (const f of feeds) {
    const r = await pollFeed(env, f);
    newItems += r.new_item_ids.length;
    if (r.error) errors += 1;
  }
  return { feeds: feeds.length, new_items: newItems, errors };
}

// Insert newly-seen items. Returns the IDs of rows actually inserted so
// downstream work (importance scoring, embedding) only runs on new content.
export async function insertNewItems(
  env: Env,
  feedId: number,
  items: ParsedItem[],
): Promise<number[]> {
  if (!items.length) return [];
  const now = Date.now();
  const insertedIds: number[] = [];

  // D1 has no RETURNING on conflict — to learn what's new, try each INSERT
  // OR IGNORE and read last_insert_rowid() when changes() reports 1.
  // For feed counts in the dozens-to-hundreds this is fine; if we ever
  // need to import thousands we'd switch to a staging table.
  for (const it of items) {
    const r = await env.DB.prepare(`
      INSERT OR IGNORE INTO feed_items (
        feed_id, guid, url, title, author, published_at, content_excerpt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      feedId,
      it.guid,
      it.url,
      it.title,
      it.author,
      it.published_at,
      it.content_excerpt,
      now,
    ).run();
    if (r.meta.changes === 1 && typeof r.meta.last_row_id === 'number') {
      insertedIds.push(r.meta.last_row_id);
    }
  }
  return insertedIds;
}
