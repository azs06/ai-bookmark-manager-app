import { Hono } from 'hono';
import type { Env } from '../types';
import { displayPrefix, generateToken, hashToken, type McpTokenRow } from '../lib/mcpTokens';

// Token management for the /mcp endpoint, used by Settings → MCP access.
// Lives under /api/*, so in production it sits behind Cloudflare Access like
// the rest of the dashboard API. Never put an Access bypass on this path.
const app = new Hono<{ Bindings: Env }>();

const NAME_MAX = 100;

app.get('/', async (c) => {
  const rows = await c.env.DB
    .prepare(`
      SELECT id, name, token_prefix, created_at, last_used_at
      FROM mcp_tokens
      ORDER BY created_at DESC, id DESC
    `)
    .all<McpTokenRow>();
  return c.json({
    tokens: rows.results ?? [],
    // Lets the UI say whether the legacy secret still grants access.
    env_token_configured: Boolean(c.env.MCP_AUTH_TOKEN),
  });
});

app.post('/', async (c) => {
  // Require JSON so a cross-site form post (text/plain, no preflight) can't
  // mint tokens with the user's Access cookie.
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
    return c.json({ error: 'content-type must be application/json' }, 415);
  }
  const body = await c.req.json<{ name?: unknown }>().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name required' }, 400);
  if (name.length > NAME_MAX) return c.json({ error: `name must be ${NAME_MAX} characters or fewer` }, 400);

  const token = generateToken();
  const now = Date.now();
  const result = await c.env.DB
    .prepare(`
      INSERT INTO mcp_tokens (name, token_hash, token_prefix, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .bind(name, await hashToken(token), displayPrefix(token), now)
    .run();

  const row: McpTokenRow = {
    id: result.meta.last_row_id as number,
    name,
    token_prefix: displayPrefix(token),
    created_at: now,
    last_used_at: null,
  };
  // The plaintext token is returned this once and never stored.
  return c.json({ token, ...row }, 201);
});

app.delete('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const result = await c.env.DB
    .prepare('DELETE FROM mcp_tokens WHERE id = ?')
    .bind(id)
    .run();
  if (!result.meta.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true, id });
});

export default app;
