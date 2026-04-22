import { Hono } from 'hono';
import { cors } from 'hono/cors';
import bookmarks from './routes/bookmarks';
import categories from './routes/categories';
import search from './routes/search';
import suggestions from './routes/suggestions';
import chat from './routes/chat';
import { runDailySuggestions } from './lib/suggestions';
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
app.route('/api/search', search);
app.route('/api/suggestions', suggestions);
app.route('/api/chat', chat);

// All other paths fall through to the static assets binding (the PWA),
// configured via `assets` in wrangler.jsonc with SPA fallback.
export default {
  fetch: app.fetch,
  // Cron-triggered daily picks. Failures here are logged but don't retry —
  // tomorrow's run will regenerate. Manual refresh endpoint is the escape hatch.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runDailySuggestions(env).catch((err) => {
        console.error('daily suggestions failed', err);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
