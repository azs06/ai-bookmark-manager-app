import type { Context } from 'hono';
import type { Env } from '../types';

const DEV_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

export function resolveAllowedOrigin(origin: string, c: Context<{ Bindings: Env }>): string | null {
  if (!origin) return null;

  if (origin === requestOrigin(c.req.url)) {
    return origin;
  }

  if (DEV_ORIGINS.has(origin)) {
    return origin;
  }

  const configured = parseConfiguredOrigins(c.env.ALLOWED_ORIGINS);
  if (!origin.startsWith('chrome-extension://') && configured.has(origin)) {
    return origin;
  }

  const configuredExtensions = parseConfiguredOrigins(c.env.ALLOWED_EXTENSION_ORIGINS);
  if (origin.startsWith('chrome-extension://') && configuredExtensions.has(origin)) {
    return origin;
  }

  return null;
}

function parseConfiguredOrigins(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function requestOrigin(url: string): string {
  return new URL(url).origin;
}
