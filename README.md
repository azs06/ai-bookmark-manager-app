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
