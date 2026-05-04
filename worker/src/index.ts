import { Hono } from 'hono';
import { cors } from 'hono/cors';
import bookmarks from './routes/bookmarks';
import categories from './routes/categories';
import feeds from './routes/feeds';
import search from './routes/search';
import suggestions from './routes/suggestions';
import chat from './routes/chat';
import shortlinks, { shortlinkRedirect } from './routes/shortlinks';
import { runDailySuggestions } from './lib/suggestions';
import { pollAllFeeds } from './lib/feeds';
import { resolveAllowedOrigin } from './lib/cors';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

// Extension and PWA both hit /api/*. CORS is permissive here because
// Cloudflare Access enforces identity, but we still keep read access scoped to
// first-party web origins plus Chrome extension pages.
app.use('/api/*', cors({
  origin: (origin, c) => resolveAllowedOrigin(origin, c),
  credentials: true,
  allowHeaders: ['Content-Type'],
}));

app.get('/api/health', (c) => c.json({
  ok: true,
  env: c.env.ENV,
  ts: Date.now(),
}));

app.route('/api/bookmarks', bookmarks);
app.route('/api/categories', categories);
app.route('/api/feeds', feeds);
app.route('/api/search', search);
app.route('/api/suggestions', suggestions);
app.route('/api/chat', chat);
app.route('/api/shortlinks', shortlinks);

// Public short-link redirect. Lives at the root (not under /api) so the URL
// stays short. Requires a CF Access bypass policy on /s/* in production —
// otherwise recipients hit the Access login page instead of the redirect.
app.get('/s/:code', (c) => shortlinkRedirect(c.req.raw, c.env, c.executionCtx));

// All other paths fall through to the static assets binding (the PWA),
// configured via `assets` in wrangler.jsonc with SPA fallback.
export default {
  fetch: app.fetch,
  // Cron runs hourly. Feed polling happens every tick; the daily-picks job
  // only runs at 03:00 UTC (09:00 Dhaka) so the morning triage ritual is
  // preserved. Failures in either job are logged but never retried — the
  // next hour (or day) is the retry.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      pollAllFeeds(env).catch((err) => {
        console.error('feed poll failed', err);
      }),
    );

    if (new Date(event.scheduledTime).getUTCHours() === 3) {
      ctx.waitUntil(
        runDailySuggestions(env).catch((err) => {
          console.error('daily suggestions failed', err);
        }),
      );
    }
  },
} satisfies ExportedHandler<Env>;
