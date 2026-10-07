import { Hono } from 'hono';
import type { BookmarkStatus, Env } from '../types';
import { createOrRestoreBookmark } from '../lib/createBookmark';
import { editMessageText, extractFirstUrl, sendMessage } from '../lib/telegram';

const app = new Hono<{ Bindings: Env }>();

interface TelegramUpdate {
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  caption?: string;
  chat: { id: number };
}

const POLL_INTERVAL_MS = 1000;
// Workers' waitUntil budget is ~30s after the response. Cap polling at 25s
// so the final editMessageText call has ~5s of headroom — otherwise a slow
// enrichment can leave the user staring at "Saving…" forever.
const POLL_TIMEOUT_MS = 25000;
const SUMMARY_MAX = 320;
type ResultKind = 'new' | 'duplicate' | 'restored';

// Telegram webhook receiver. Two-layer auth: the request must carry the
// shared secret header (proves it came from Telegram), AND the sender's
// chat_id must match the configured allowlist (proves the sender is you).
// We return 200 for everything except a missing/wrong webhook secret —
// Telegram retries non-2xx responses, and we don't want a typo or a stray
// inbound message from a stranger to fill the retry queue.
app.post('/webhook', async (c) => {
  const expectedSecret = c.env.TELEGRAM_WEBHOOK_SECRET;
  const headerSecret = c.req.header('x-telegram-bot-api-secret-token');
  if (!expectedSecret || headerSecret !== expectedSecret) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error('telegram: TELEGRAM_BOT_TOKEN not configured');
    return c.body(null, 200);
  }

  const update = await c.req.json<TelegramUpdate>().catch(() => null);
  const message = update?.message;
  if (!message) return c.body(null, 200);

  const allowedChatId = c.env.TELEGRAM_ALLOWED_CHAT_ID
    ? Number(c.env.TELEGRAM_ALLOWED_CHAT_ID)
    : null;
  if (!allowedChatId || !Number.isFinite(allowedChatId) || message.chat.id !== allowedChatId) {
    console.log('telegram: rejected chat_id', message.chat.id);
    return c.body(null, 200);
  }

  const chatId = message.chat.id;
  const text = message.text ?? message.caption ?? '';
  const extracted = extractFirstUrl(text);
  if (!extracted) {
    c.executionCtx.waitUntil(
      sendMessage(botToken, chatId, "Send me a URL and I'll save it as a bookmark.")
        .catch((err) => console.error('telegram: prompt send failed', err)),
    );
    return c.body(null, 200);
  }

  // Send the ack synchronously: we need its message_id to edit later. If
  // this fails we still try to save the bookmark — the user just won't get
  // a confirmation in chat.
  let ackId: number | null = null;
  try {
    const ack = await sendMessage(botToken, chatId, 'Saving…');
    ackId = ack.message_id;
  } catch (err) {
    console.error('telegram: ack failed', err);
  }

  let result;
  try {
    result = await createOrRestoreBookmark(c.env, c.executionCtx, {
      url: extracted.url,
      note: extracted.rest || undefined,
    });
  } catch (err) {
    console.error('telegram: save failed', err);
    if (ackId !== null) {
      c.executionCtx.waitUntil(
        editMessageText(botToken, chatId, ackId, "⚠️ Couldn't save that URL.")
          .catch((e) => console.error('telegram: error edit failed', e)),
      );
    }
    return c.body(null, 200);
  }

  if (ackId !== null) {
    c.executionCtx.waitUntil(
      finalizeReply(c.env, botToken, chatId, ackId, result.id, result.kind).catch((err) => {
        console.error('telegram: finalize failed', err);
      }),
    );
  }

  return c.body(null, 200);
});

// Polls D1 until the bookmark transitions out of 'pending' (or we time out),
// then edits the ack message with the final title + summary. Polling instead
// of awaiting enrich() directly: createOrRestoreBookmark already kicked off
// enrich inside its own waitUntil. The DB row is the source of truth for
// "is enrichment done" — checking it covers new inserts AND restored bookmarks
// (whose repair path may or may not re-run enrich) without branching on kind.
async function finalizeReply(
  env: Env,
  botToken: string,
  chatId: number,
  messageId: number,
  bookmarkId: number,
  kind: ResultKind,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const row = await env.DB
      .prepare('SELECT title, ai_summary, status FROM bookmarks WHERE id = ?')
      .bind(bookmarkId)
      .first<{ title: string | null; ai_summary: string | null; status: BookmarkStatus }>();
    if (!row) {
      await editMessageText(botToken, chatId, messageId, '⚠️ Bookmark vanished.');
      return;
    }
    if (row.status !== 'pending') {
      await editMessageText(botToken, chatId, messageId, formatFinal(row, kind));
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  await editMessageText(
    botToken,
    chatId,
    messageId,
    '✓ Saved (still processing in background).',
  );
}

function formatFinal(
  row: { title: string | null; ai_summary: string | null; status: BookmarkStatus },
  kind: ResultKind,
): string {
  const title = row.title?.trim() || '(untitled)';
  const prefix = kind === 'duplicate' ? '✓ Already saved' : '✓ Saved';
  if (row.status === 'partial' || !row.ai_summary) {
    return `${prefix}: ${title}`;
  }
  const summary = row.ai_summary.length > SUMMARY_MAX
    ? row.ai_summary.slice(0, SUMMARY_MAX - 1).trimEnd() + '…'
    : row.ai_summary;
  return `${prefix}: ${title}\n\n${summary}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default app;
