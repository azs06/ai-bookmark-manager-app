// URL liveness probe. Returns the HTTP status code after redirects, or 0 for
// network-level failures (DNS, TLS, timeout, abort). The caller decides what
// counts as "dead" — this module only reports.

const PROBE_TIMEOUT_MS = 5000;
// Browser-y UA: many CDNs (Cloudflare, Akamai, Sucuri) 403 anything that
// looks like a bot. We aren't trying to defeat scraping protection — just
// avoid false-positive 403s on pages that are actually fine in a browser.
const PROBE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function probeUrl(url: string): Promise<number> {
  // HEAD first — bandwidth-cheap. If the server refuses HEAD specifically
  // (405 Method Not Allowed, 501 Not Implemented), retry with GET so we
  // don't mark a perfectly-fine page as broken.
  const headStatus = await tryFetch(url, 'HEAD');
  if (headStatus !== 405 && headStatus !== 501) return headStatus;
  return await tryFetch(url, 'GET');
}

async function tryFetch(url: string, method: 'HEAD' | 'GET'): Promise<number> {
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        'User-Agent': PROBE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return resp.status;
  } catch {
    // DNS NXDOMAIN, TLS failure, timeout, abort — the URL is unreachable
    // from the Worker. Caller stores this as a sentinel, not as "dead".
    return 0;
  }
}
