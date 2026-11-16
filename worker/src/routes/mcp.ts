import type { Context } from 'hono';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import type { Env } from '../types';
import { createBookmarkMcpServer } from '../lib/mcp';

// Remote MCP endpoint (Streamable HTTP) at /mcp. Lets MCP clients such as
// Claude Code, Claude Desktop, or Cursor search and save bookmarks.
//
// Auth is a single bearer token (MCP_AUTH_TOKEN). With no token configured the
// endpoint rejects everything, matching how the Telegram webhook stays inert
// until its secrets are set. MCP clients can't carry a Cloudflare Access
// cookie, so production needs an Access Bypass (or Service Auth) app on /mcp.
//
// CORS preflights are answered by the cors() middleware in index.ts before
// this runs; they never carry the Authorization header.
export async function mcpRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const request = c.req.raw;

  // The SDK handler is deliberately validation-free, so do the Host/Origin
  // checks it asks for. Host: DNS-rebinding protection for localhost only;
  // deployed hostnames are pinned by Cloudflare routing. Origin: browsers may
  // only call from localhost-class origins (e.g. MCP Inspector). The Worker's
  // own hostname is deliberately not allowed: it derives from the Host header,
  // which a rebinding page controls in local dev, and the SPA never calls
  // /mcp. Non-browser clients send no Origin and pass.
  const hostname = new URL(request.url).hostname;
  const localhosts = localhostAllowedHostnames();
  const rejected =
    (localhosts.includes(hostname) ? hostHeaderValidationResponse(request, localhosts) : undefined)
    ?? originValidationResponse(request, localhostAllowedOrigins());
  if (rejected) return rejected;

  if (!(await isAuthorized(c.env.MCP_AUTH_TOKEN, c.req.header('authorization')))) {
    return c.json({ error: 'unauthorized' }, 401, {
      'WWW-Authenticate': 'Bearer realm="mcp"',
    });
  }

  // createMcpHandler is stateless and builds a server per request, so env and
  // ctx can be closed over directly.
  const handler = createMcpHandler(() => createBookmarkMcpServer(c.env, c.executionCtx), {
    onerror: (err) => console.error('mcp error', err),
  });
  return handler.fetch(request);
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
