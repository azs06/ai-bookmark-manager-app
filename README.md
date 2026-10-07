# AI Bookmark Manager App

AI Bookmark Manager is a Cloudflare Workers app for saving, enriching, searching, and chatting over a personal bookmark library.

This repo contains:

- a Workers API backed by D1, Vectorize, and Workers AI
- a React web UI served from the same Worker

The browser extension lives in a separate companion repo and talks to this app over `/api/*`.

## Features

- Save bookmarks and enrich them in the background
- AI-generated summaries and tags with Anthropic
- Hybrid keyword + semantic search
- Daily bookmark suggestions
- Chat over your bookmark library

## Stack

- Cloudflare Workers
- D1
- Vectorize
- Workers AI embeddings
- Anthropic Messages API
- React + Vite

## Required configuration

Set these in your Worker environment before deploying:

- `ANTHROPIC_API_KEY`
- `ALLOWED_ORIGINS`
- `ALLOWED_EXTENSION_ORIGINS`

Example local `.dev.vars` values:

```dotenv
ANTHROPIC_API_KEY=your-anthropic-key
ALLOWED_ORIGINS=http://localhost:5173
ALLOWED_EXTENSION_ORIGINS=chrome-extension://YOUR_EXTENSION_ID
```

Notes:

- `ALLOWED_ORIGINS` is a comma-separated allowlist for web clients such as local Vite dev or a separate frontend origin.
- `ALLOWED_EXTENSION_ORIGINS` is a comma-separated allowlist of companion extension origins. Example: `chrome-extension://abcdef...`.
- When the extension is loaded unpacked, you can copy its ID from `chrome://extensions`.

## Cloudflare bindings

This app expects these bindings:

- `DB` for D1
- `VECTORIZE` for Vectorize
- `AI` for Workers AI

The committed `wrangler.jsonc` is intentionally safe for a public repo. Configure your real resources in Cloudflare for your deployment.

This repo expects `wrangler` 4.45 or newer so D1 bindings can be declared without committing a `database_id`.

## Local development

Install dependencies:

```bash
npm install
cd web && npm install
```

Initialize the local D1 database:

```bash
npm run db:init:local
```

Run the Worker and web UI in separate terminals:

```bash
npm run dev
```

```bash
npm run dev:web
```

The Vite dev server proxies `/api` to the local Worker on `http://localhost:8787`.

If you change `wrangler.jsonc`, regenerate the Worker runtime types with:

```bash
npm run cf-typegen
```

## Deploy

Build the web app and deploy the Worker:

```bash
npm run deploy
```

Before deploying, make sure your Cloudflare project has:

- the required bindings
- `ANTHROPIC_API_KEY` set as a secret
- `ALLOWED_ORIGINS` and `ALLOWED_EXTENSION_ORIGINS` set for your actual clients

### Cloudflare Builds

If you deploy from GitHub using Workers Builds, configure the project with:

```bash
Build command: npm run build
Deploy command: npm run deploy:prod
Non-production branch deploy command: npm run versions:upload:prod
```

The preview deploy command must target `--env production`, otherwise Wrangler will use the top-level config and warn about multiple environments. The separate build command is required because `wrangler versions upload` does not build `web/dist` for you.

## Companion extension

The companion browser extension is a separate repo. It is not standalone and expects this app to expose:

- `POST /api/bookmarks`
- `POST /api/bookmarks/import`

The extension uses the browser's authenticated session for this app, so users should log into the dashboard once before saving bookmarks from the extension.

## Telegram bot integration (optional)

Adds a way to save bookmarks from a phone by DMing a Telegram bot. The bot accepts URLs (typed, pasted, or shared via the OS share-sheet), saves them through the same ingest path as the extension, and replies with the AI-generated title and summary once enrichment finishes.

This integration is entirely optional. The webhook route is always mounted at `POST /api/telegram/webhook`, but with no Telegram secrets configured it is inert — every inbound request is rejected and nothing else in the app is affected. Skip this whole section if you don't want the bot.

### Secrets

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_ALLOWED_CHAT_ID=
```

- `TELEGRAM_BOT_TOKEN` — from BotFather. Used to send and edit replies.
- `TELEGRAM_WEBHOOK_SECRET` — random string you generate (e.g. `openssl rand -hex 32`). Verifies that incoming webhook requests came from Telegram via the `X-Telegram-Bot-Api-Secret-Token` header.
- `TELEGRAM_ALLOWED_CHAT_ID` — your own Telegram chat id. The webhook silently drops messages from any other sender, so the bot stays single-user even if its username leaks.

For local: append to `.dev.vars`. For production: `wrangler secret put` each one. Note that local `wrangler dev` is not publicly reachable, so end-to-end testing requires a deploy or a public tunnel.

### Setup steps

1. DM `@BotFather` → `/newbot` → copy the bot token.
2. Generate a webhook secret: `openssl rand -hex 32`.
3. DM `@userinfobot` to find your chat id.
4. Set the three secrets locally and/or in production.
5. Deploy the Worker.
6. If your Worker host is gated by Cloudflare Access, add an Access app scoped to `/api/telegram/webhook` with **Action = Bypass** and confirm the policy is attached. Telegram's servers can't carry an Access cookie, so without this they hit the login wall.
7. Register the webhook with Telegram:

   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<your-host>/api/telegram/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
     -d "allowed_updates=[\"message\"]"
   ```

### Verifying after deploy

1. **DM the bot a URL.** Expect `Saving…` within ~1s, then the same message edited to `✓ <title>` plus the AI summary in 5–15s. A repeated URL comes back as `✓ Already saved: <title>`. A message with no URL replies `Send me a URL…`.
2. **Check `getWebhookInfo`.** `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` should report `pending_update_count: 0` and no `last_error_message`. If you see `last_error_message: "Wrong response from the webhook: 401"`, the registered `secret_token` doesn't match the deployed `TELEGRAM_WEBHOOK_SECRET`.
3. **Confirm CF Access Bypass is in effect.** From outside Access:

   ```bash
   curl -i https://<your-host>/api/telegram/webhook
   ```

   Expect `401 Unauthorized` (the route's missing-secret response). If you get an HTML redirect to the Access login page instead, the Bypass app on `/api/telegram/webhook` isn't attached or isn't scoped correctly.
4. **DM from a different account** (or temporarily change `TELEGRAM_ALLOWED_CHAT_ID` to a non-matching value). Expect no reply, no DB write, and a `telegram: rejected chat_id` log line in `wrangler tail`.

### Testing locally

`wrangler dev --local` is not publicly reachable, so Telegram can't deliver webhooks to it. Two ways to test before deploying:

**Tunnel + a separate test bot (real end-to-end).** Create a *second* bot in BotFather — Telegram allows only one webhook URL per bot, so registering a tunnel URL on the prod bot would unhook prod. Then:

```bash
# terminal 1
npm run dev -- --local

# terminal 2
cloudflared tunnel --url http://localhost:8787
# prints e.g. https://random-words-1234.trycloudflare.com

# terminal 3 (one-shot — re-run when the tunnel URL changes)
curl -X POST "https://api.telegram.org/bot<TEST_BOT_TOKEN>/setWebhook" \
  -d "url=https://<tunnel-host>/api/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\"]"
```

Fill `.dev.vars` with the test bot's token, the same webhook secret you registered, and your chat id. The tunnel host is on Cloudflare's own zone, not yours, so no Access Bypass app is needed for it.

**Curl simulation (handler only).** Faster for iterating on parsing / auth / DB writes — skips Telegram's inbound side but still calls the real Telegram API for outbound replies, so your phone still gets real DMs. The handler must already have valid `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_CHAT_ID` in `.dev.vars`:

```bash
curl -i -X POST http://localhost:8787/api/telegram/webhook \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  -d "{
    \"update_id\": 1,
    \"message\": {
      \"message_id\": 100,
      \"chat\": { \"id\": $TELEGRAM_ALLOWED_CHAT_ID },
      \"text\": \"https://example.com/some-article worth a read\"
    }
  }"
```

Useful payload variants: drop the secret header → expect `401`; change `chat.id` to a different number → silent `200` with a rejected-chat log line; replace `text` with `caption` → covers forwarded media with a URL in the caption; re-send the same URL → expect `✓ Already saved: <title>`.

D1 writes hit the local SQLite (`npm run db:init:local` first if you haven't). Enrichment makes real network calls so the summary you see in the reply is the real one.
