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

### Geo lookup

- `GEO_PROVIDER`
  - default in code: `ipapi`

### LiveKit / live audio rooms

- `LIVEKIT_URL`
- `LIVEKIT_API_HOST`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

Notes:

- If `LIVEKIT_URL` is omitted, the socket layer derives it from `PUBLIC_API_BASE_URL` as `wss://.../livekit`.
- If `LIVEKIT_API_HOST` is omitted, it is derived from `LIVEKIT_URL`.
- Live audio session issuance is enabled only when the full LiveKit config is present.

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
