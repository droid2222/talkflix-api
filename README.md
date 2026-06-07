# Talkflix API

Node.js backend for Talkflix. This service provides:

- REST auth and app APIs over Express
- realtime features over Socket.IO
- live audio room media session issuance for LiveKit
- MySQL-backed persistence
- local-disk uploads from the `uploads/` directory

## Runtime

- Entry point: [`server.js`](./server.js)
- Socket layer: [`socket.js`](./socket.js)
- Production start script: [`start.sh`](./start.sh)

## Admin dashboard

- Public URL: `https://talkflix.cc/admin/`
- `https://www.talkflix.cc/admin/` redirects to `https://talkflix.cc/admin/`
- Production static HTML: `/var/www/talkflix-admin/index.html`
- Production API path: `/opt/talkflix-api`
- Full operational note in the Flutter repo: `/Users/talkflix/talkflix_flutter/docs/admin-dashboard.md`

Anonymous match admin controls are implemented in:

- [`server.js`](./server.js): routes under `/admin/anonymous-match/*`
- [`socket.js`](./socket.js): in-memory anonymous match queue/history logic

The emergency/test reset button calls `POST /admin/anonymous-match/reset-history`. It clears remembered anonymous pair history and skip cooldowns only; it does not end active matches or remove users waiting in the queue.

Pro/free usage limit admin controls are implemented in:

- [`server.js`](./server.js): routes under `/admin/pro-limits`, `/me/entitlements`, and `/me/usage/content-watch`
- [`socket.js`](./socket.js): direct-call, live-room host, audience, and stage duration enforcement
- [`entitlements.js`](./entitlements.js): default limits, app setting keys, daily usage helper, and quota accounting
- [`migrations/005_pro_entitlements_usage_mysql.sql`](./migrations/005_pro_entitlements_usage_mysql.sql)

## Mobile v1 release handoff

The Flutter repository contains the current mobile release handoff:

```text
/Users/talkflix/talkflix_flutter/docs/v1-release-handoff.md
```

Read it before changing release-sensitive backend behavior. It documents the current mobile feature gates, IAP product IDs, purchase-verification environment requirements, direct-call behavior, migrations, and production launch blockers.

Production database migration verification is documented in:

```text
docs/production-db-migrations.md
```

Scripts from [`package.json`](./package.json):

```bash
npm run dev
npm start
```

- `npm run dev` uses `nodemon`
- `npm start` runs `./start.sh`
- `start.sh` refuses to start if the configured port is already in use

## Required environment

The code reads these environment variables:

### Core app / HTTP

- `HOST`
- `PORT`
- `JWT_SECRET`
- `CORS_ORIGIN`
- `APP_URL`
- `PUBLIC_API_BASE_URL`

### MySQL

- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

### Mail

- `MAIL_PROVIDER`
  - supported in code: `ethereal`, `resend`
- `MAIL_FROM`
- `RESEND_API_KEY`

### Translation

- `OPENAI_API_KEY`
- `OPENAI_TRANSLATION_MODEL`
  - optional
  - defaults in code to `gpt-5-mini`

### Geo lookup

- `GEO_PROVIDER`
  - default in code: `ipapi`

### LiveKit / live audio rooms

- `LIVEKIT_URL`
- `LIVEKIT_API_HOST`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

### Mobile in-app purchases

- `IAP_PRO_PRODUCT_IDS`
  - comma-separated product IDs
  - default in code: `talkflix_pro_monthly_v2,talkflix_pro_6_months,talkflix_pro_yearly`
- `IAP_APPLE_BUNDLE_ID`
  - default in code: `cc.talkflix.app`
- `APPLE_IAP_ISSUER_ID`
- `APPLE_IAP_KEY_ID`
- `APPLE_IAP_PRIVATE_KEY`
  - App Store Connect In-App Purchase API private key, with newlines escaped if stored inline
- `APPLE_IAP_ENVIRONMENT`
  - `auto`, `production`, or `sandbox`
  - default in code: `auto`
- `IAP_GOOGLE_PACKAGE_NAME`
  - default in code: `cc.talkflix.app`
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`
  - full service-account JSON with Android Publisher API access
- `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE`
  - alternative path to the service-account JSON file
- `GOOGLE_PLAY_CLIENT_EMAIL` and `GOOGLE_PLAY_PRIVATE_KEY`
  - alternative inline service-account credentials

Notes:

- If `LIVEKIT_URL` is omitted, the socket layer derives it from `PUBLIC_API_BASE_URL` as `wss://.../livekit`.
- If `LIVEKIT_API_HOST` is omitted, it is derived from `LIVEKIT_URL`.
- Live audio session issuance is enabled only when the full LiveKit config is present.
- Pro subscriptions are granted only after the backend verifies the App Store or Google Play purchase. The mobile app never unlocks Pro from local purchase state alone.

## Minimal local `.env`

```env
HOST=0.0.0.0
PORT=4000
JWT_SECRET=change-me
CORS_ORIGIN=http://localhost:5173
APP_URL=talkflix://app
PUBLIC_API_BASE_URL=http://127.0.0.1:4000

DB_HOST=127.0.0.1
DB_USER=talkflix_app
DB_PASSWORD=change-me
DB_NAME=talkflix

MAIL_PROVIDER=ethereal
GEO_PROVIDER=ipapi
```

For Resend:

```env
MAIL_PROVIDER=resend
MAIL_FROM=Talkflix <no-reply@send.talkflix.cc>
RESEND_API_KEY=re_xxx
```

For LiveKit:

```env
PUBLIC_API_BASE_URL=https://api.talkflix.cc
LIVEKIT_API_HOST=http://127.0.0.1:7880
LIVEKIT_API_KEY=change-me
LIVEKIT_API_SECRET=change-me
```

For OpenAI-powered translation:

```env
OPENAI_API_KEY=sk-...
OPENAI_TRANSLATION_MODEL=gpt-5-mini
```

For mobile Pro IAP:

```env
IAP_PRO_PRODUCT_IDS=talkflix_pro_monthly_v2,talkflix_pro_6_months,talkflix_pro_yearly
IAP_APPLE_BUNDLE_ID=cc.talkflix.app
APPLE_IAP_ISSUER_ID=...
APPLE_IAP_KEY_ID=...
APPLE_IAP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
APPLE_IAP_ENVIRONMENT=auto

IAP_GOOGLE_PACKAGE_NAME=cc.talkflix.app
GOOGLE_PLAY_SERVICE_ACCOUNT_FILE=/opt/talkflix-api/google-play-service-account.json
```

## Local development

1. Install dependencies:

```bash
npm install
```

2. Create `.env`
3. Make sure MySQL is available and `DB_*` points to the correct database
4. Start the API:

```bash
npm run dev
```

Health check:

```bash
curl http://127.0.0.1:4000/health
```

The health route returns DB status from `SELECT 1`.

## Database

- Main schema is MySQL
- Startup runs `ensureTables()` from [`server.js`](./server.js)
- Snapshot and migration files live in:
  - [`docs/schema-snapshots/talkflix-2026-03-13-phpmyadmin.sql`](./docs/schema-snapshots/talkflix-2026-03-13-phpmyadmin.sql)
  - [`migrations/001_creator_videos_content_mysql.sql`](./migrations/001_creator_videos_content_mysql.sql)

## Uploads

- Uploaded files are written to the local `uploads/` folder
- The API serves them from `/uploads`
- `uploads/` is intentionally ignored by Git

## Current production deployment

The current deployed shape is:

- backend path on droplet: `/opt/talkflix-api`
- process manager: `pm2`
- PM2 app name: `talkflix-api`
- reverse proxy / TLS: `nginx`
- public API domain: `https://api.talkflix.cc`
- LiveKit API host in current droplet setup: `http://127.0.0.1:7880`

Typical commands:

```bash
pm2 status
pm2 logs talkflix-api
pm2 restart talkflix-api
systemctl status nginx
curl https://api.talkflix.cc/health
```

## Git hygiene

The repository ignores:

- `.env`
- `node_modules/`
- `uploads/`

Do not commit production secrets or runtime upload assets.
