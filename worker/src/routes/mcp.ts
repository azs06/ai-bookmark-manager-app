import type { Context } from 'hono';
import { createMcpHandler } from 'agents/mcp/server';
import type { Env } from '../types';
import { createBookmarkMcpServer } from '../lib/mcp';

// Remote MCP endpoint (Streamable HTTP) at /mcp. Lets MCP clients such as
// Claude Code, Claude Desktop, or Cursor search and save bookmarks.
//
// Auth is a single bearer token (MCP_AUTH_TOKEN). With no token configured the
// endpoint rejects everything, matching how the Telegram webhook stays inert
// until its secrets are set. MCP clients can't carry a Cloudflare Access
// cookie, so production needs an Access Bypass (or Service Auth) app on /mcp.
export async function mcpRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!(await isAuthorized(c.env.MCP_AUTH_TOKEN, c.req.header('authorization')))) {
    return c.json({ error: 'unauthorized' }, 401, {
      'WWW-Authenticate': 'Bearer realm="mcp"',
    });
  }

  const ctx = c.executionCtx;
  const handler = createMcpHandler(() => createBookmarkMcpServer(c.env, ctx));
  return handler(c.req.raw, c.env, ctx as ExecutionContext);
}

async function isAuthorized(expected: string | undefined, header: string | undefined): Promise<boolean> {
  if (!expected || !header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;

  // Hash both sides so timingSafeEqual gets equal-length inputs and the
  // comparison doesn't leak the token's length.
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(match[1])),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
