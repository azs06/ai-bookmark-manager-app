// Why the last enrichment of a bookmark left it without a summary. Stored at
// metadata.enrich_error so retries can skip failures that won't change, and
// dead pages can be routed to the URL-health review.
//
//   gone         404 / 410 — the page was removed (shows up in URL health)
//   blocked      401 / 403 / 451 — needs a login or blocks bots
//   unreachable  the site itself is broken: Cloudflare 525/526/530 (bad TLS,
//                origin/DNS failure) or a redirect loop
//   unsupported  not an HTML page (PDF, script…) or another 4xx
//   temporary    429, other 5xx, timeouts, network errors, or both AI models
//                failing — worth retrying later
//   no-summary   the page loaded but had nothing to summarize (paywall stub,
//                error page, empty body)
export type EnrichFailureKind =
  | 'gone'
  | 'blocked'
  | 'unreachable'
  | 'unsupported'
  | 'temporary'
  | 'no-summary';

export interface EnrichFailure {
  kind: EnrichFailureKind;
  detail: string;
  status?: number;
  at: number;
}

// Only these are retried by the Settings "retry" pass. A bookmark with no
// recorded failure (enriched before this existed) counts as retryable once.
export const RETRYABLE_KINDS: EnrichFailureKind[] = ['temporary'];

// Fetch helpers throw `${source} ${status}` (e.g. "fetch 404", "oembed 404",
// "watch 429"), so the HTTP status is the trailing number when present.
const STATUS_MESSAGE = /^\w+ (\d{3})$/;

export function classifyEnrichError(err: unknown): Omit<EnrichFailure, 'at'> {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  const detail = message.slice(0, 160);

  const match = message.match(STATUS_MESSAGE);
  if (match) {
    const status = Number(match[1]);
    return { kind: kindForStatus(status), detail, status };
  }
  if (message.startsWith('non-html content-type')) return { kind: 'unsupported', detail };
  if (/too many redirects/i.test(message)) return { kind: 'unreachable', detail };
  if (name === 'AbortError' || name === 'TimeoutError' || /timed? ?out/i.test(message)) {
    return { kind: 'temporary', detail };
  }
  // Network-level failures and anything unrecognized: assume transient.
  return { kind: 'temporary', detail };
}

function kindForStatus(status: number): EnrichFailureKind {
  if (status === 404 || status === 410) return 'gone';
  if (status === 401 || status === 403 || status === 451) return 'blocked';
  if (status === 408 || status === 429) return 'temporary';
  if (status === 525 || status === 526 || status === 530) return 'unreachable';
  if (status >= 500) return 'temporary';
  return 'unsupported';
}
