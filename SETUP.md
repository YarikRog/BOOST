# Setup — Foundation (Telegram Bot · Supabase · Railway)

The repo already contains the backend, schema, and configs. What's left is creating
the three external accounts and pasting their secrets into Railway. ~20 minutes.

The pieces fit together like this:

```
Telegram (BotFather) ──token──┐
                              ▼
Railway  ──runs──►  backend (API + bot + workers)  ──► Supabase (Postgres)
                              │                          ▲
                              └──────────── Redis ────────┘
```

---

## 1. Telegram bot (BotFather)

1. In Telegram open **@BotFather** → `/newbot`.
2. Pick a name and a username (must end in `bot`).
3. Copy the **token** it gives you → this is `TELEGRAM_BOT_TOKEN`.
4. (Later, once the WebApp is deployed) `/setmenubutton` or `/newapp` to attach the Mini App URL.

## 2. Supabase (Postgres only)

1. Create a project at https://supabase.com → pick a region close to users, set a DB password.
2. From **Project Settings → API**:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY` (server-only, never ship to client)
3. From **Project Settings → Database → Connection string (URI)**:
   - the `postgresql://...:5432/postgres` string → `DATABASE_URL`
4. We use Supabase as **plain Postgres** — no Supabase Auth, no client-side access.
   Migrations run automatically on deploy (`npm run migrate`, idempotent), or run locally:
   ```bash
   cd backend && cp .env.example .env   # fill DATABASE_URL
   npm install && npm run migrate
   ```

## 3. Redis (Upstash — free tier)

1. Create a database at https://upstash.com (Redis).
2. Copy the connection URL (`redis://…` / `rediss://…`) → `REDIS_URL`.

## 4. Railway (deploy the backend)

1. Create a project at https://railway.app → **Deploy from GitHub repo** → pick this repo.
2. **Important:** set the service **Root Directory** to `backend` (the app lives there).
   `backend/railway.json` then drives build (`npm ci && npm run build`) and start
   (`npm run migrate && npm run start:prod`).
3. Add the environment variables (Service → Variables):
   ```
   TELEGRAM_BOT_TOKEN=...
   SUPABASE_URL=...
   SUPABASE_SERVICE_ROLE_KEY=...
   DATABASE_URL=...
   REDIS_URL=...
   PORT=3000
   NODE_ENV=production
   WEBAPP_URL=            # fill once the Mini App is deployed
   ```
4. Deploy. On boot it runs migrations, then starts API + bot (long-polling) + workers.

> Scaling note: the bot uses long-polling, so keep the backend at **one replica**
> for now (only one `getUpdates` consumer allowed). Splitting the bot into its own
> single-instance service, or moving to webhooks, is a later step.

## 5. Smoke test

- Railway logs show: `Backend listening on :3000` and `Bot @yourbot started (long-polling)`.
- Message the bot `/start` → it replies with the "доступ лише для співробітників" text
  (expected — the invite flow is the next build step).
- `npm run migrate` log shows `apply 0001_init.sql` once, `skip` thereafter.

## What's wired vs next

Wired: backend boots, migrations apply, bot connects, workers sweep, Redis/Supabase clients.
Next build step: **auth + invites** (Telegram `initData` validation, `/start <token>` consume,
onboarding) — that's what turns `/start` into a real user.
