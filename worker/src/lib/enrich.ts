import type { Env } from '../types';
import { summarizeAndTag } from './haiku';
import { summarizeAndTagGemma } from './gemma';
import { embedAndUpsert } from './vector';
import type { SummaryResult } from './prompts';

const USER_AGENT = 'Mozilla/5.0 (compatible; AIBookmarks/0.1)';
const FETCH_TIMEOUT_MS = 8000;
const MAX_EXCERPT_CHARS = 3000;

export async function enrich(env: Env, bookmarkId: number): Promise<void> {
  const row = await env.DB
    .prepare('SELECT id, url FROM bookmarks WHERE id = ?')
    .bind(bookmarkId)
    .first<{ id: number; url: string }>();
  if (!row) return;

  try {
    const page = await extractPage(row.url);

    let summary: string | null = null;
    let tags: string[] = [];
    if (page.excerpt) {
      const ai = await summarizeWithFallback(env, {
        title: page.title ?? undefined,
        excerpt: page.excerpt,
      });
      if (ai) {
        summary = ai.summary || null;
        tags = ai.tags;
      }
    }

    await env.DB.prepare(`
      UPDATE bookmarks
      SET title           = COALESCE(?, title),
          og_image_url    = ?,
          og_description  = ?,
          content_excerpt = ?,
          ai_summary      = ?,
          ai_tags         = ?,
          status          = ?,
          updated_at      = ?
      WHERE id = ?
    `).bind(
      page.title,
      page.ogImage,
      page.ogDescription,
      page.excerpt,
      summary,
      JSON.stringify(tags),
      summary ? 'active' : 'partial',
      Date.now(),
      bookmarkId,
    ).run();

    // Best-effort vector upsert. Failure here doesn't fail enrichment —
    // the bookmark stays searchable by title/tags even without semantic.
    if (summary) {
      try {
        await embedAndUpsert(env, bookmarkId, {
          title: page.title,
          summary,
          excerpt: page.excerpt,
        });
      } catch (err) {
        console.error('vector upsert failed', err);
      }
    }
  } catch (err) {
    console.error('enrich failed', err);
    await env.DB
      .prepare(`UPDATE bookmarks SET status = 'partial', updated_at = ? WHERE id = ?`)
      .bind(Date.now(), bookmarkId)
      .run();
  }
}

interface ExtractedPage {
  title: string | null;
  ogImage: string | null;
  ogDescription: string | null;
  excerpt: string | null;
}

async function extractPage(url: string): Promise<ExtractedPage> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error(`fetch ${resp.status}`);

  const contentType = resp.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    throw new Error(`non-html content-type: ${contentType}`);
  }

  let title = '';
  let ogImage = '';
  let ogDescription = '';
  const excerptParts: string[] = [];
  let excerptLen = 0;

  const rewriter = new HTMLRewriter()
    .on('title', {
      text(t) { title += t.text; },
    })
    .on('meta[property="og:image"]', {
      element(el) { ogImage = el.getAttribute('content') ?? ''; },
    })
    .on('meta[property="og:description"]', {
      element(el) { ogDescription = el.getAttribute('content') ?? ''; },
    })
    .on('p', {
      text(t) {
        if (excerptLen >= MAX_EXCERPT_CHARS) return;
        const remaining = MAX_EXCERPT_CHARS - excerptLen;
        const piece = t.text.length > remaining ? t.text.slice(0, remaining) : t.text;
        excerptParts.push(piece);
        excerptLen += piece.length;
      },
    });

  await rewriter.transform(resp).text();

  const excerpt = excerptParts.join(' ').replace(/\s+/g, ' ').trim();
  return {
    title: title.trim() || null,
    ogImage: ogImage || null,
    ogDescription: ogDescription || null,
    excerpt: excerpt || null,
  };
}

// Gemma is ~10× cheaper than Haiku and handles the vast majority of pages
// fine. When it can't parse or the AI binding errors, fall back to Haiku so
// the bookmark still gets enriched. Log each branch so fallback rate is
// observable in `wrangler tail`.
async function summarizeWithFallback(
  env: Env,
  input: { title?: string; excerpt: string },
): Promise<SummaryResult | null> {
  try {
    const gemma = await summarizeAndTagGemma(env, input);
    if (gemma) {
      console.log('enrich:gemma-hit');
      return gemma;
    }
  } catch (err) {
    console.error('gemma failed', err);
  }

  if (!env.ANTHROPIC_API_KEY) {
    console.error('enrich:both-failed (no ANTHROPIC_API_KEY for Haiku fallback)');
    return null;
  }

  try {
    const haiku = await summarizeAndTag(env, input);
    console.log('enrich:haiku-fallback');
    return haiku;
  } catch (err) {
    console.error('enrich:both-failed', err);
    return null;
  }
}
