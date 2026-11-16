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
import { verifyMcpToken } from '../lib/mcpTokens';

// Remote MCP endpoint (Streamable HTTP) at /mcp. Lets MCP clients such as
// Claude Code, Claude Desktop, or Cursor search and save bookmarks.
//
// Auth is a bearer token created in Settings → MCP access (stored hashed in
// D1), or the optional MCP_AUTH_TOKEN secret. With neither, the endpoint
// rejects everything. MCP clients can't carry a Cloudflare Access
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

  const presented = bearerToken(c.req.header('authorization'));
  if (!presented || !(await verifyMcpToken(c.env, c.executionCtx, presented))) {
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

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header?.trim() ?? '');
  return match?.[1] ?? null;
}
