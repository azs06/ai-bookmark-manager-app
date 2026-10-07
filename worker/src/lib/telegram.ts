const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<{ message_id: number }> {
  const r = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  const json = (await r.json()) as TelegramApiResponse<{ message_id: number }>;
  if (!json.ok || !json.result) {
    throw new Error(`telegram sendMessage failed: ${json.description ?? r.status}`);
  }
  return { message_id: json.result.message_id };
}

export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  const r = await fetch(`${TELEGRAM_API}/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`telegram editMessageText failed: ${r.status} ${detail}`);
  }
}

// Pull the first http(s) URL out of a free-form message. iOS/Android
// share-sheets often send "<page title>\n<url>" or "<url>\n<my note>";
// either shape works. The remainder (everything outside the matched URL,
// trimmed) becomes the bookmark note when present.
const URL_REGEX = /https?:\/\/[^\s<>"]+/i;
// Strip trailing sentence punctuation only. `)` and `]` are intentionally
// excluded because real URLs often end with them — Wikipedia disambiguation
// pages (`/wiki/Kafka_(novelist)`) being the canonical example. The cost of
// occasionally saving a URL with a trailing `)` from prose is much lower than
// the cost of silently truncating valid URLs into 404s.
const TRAILING_PUNCT_REGEX = /[.,;:!?'"]+$/;

export function extractFirstUrl(text: string): { url: string; rest: string } | null {
  const m = text.match(URL_REGEX);
  if (!m) return null;
  const matched = m[0].replace(TRAILING_PUNCT_REGEX, '');
  const start = m.index ?? 0;
  const rest = (text.slice(0, start) + text.slice(start + matched.length))
    .replace(/\s+/g, ' ')
    .trim();
  return { url: matched, rest };
}
