# Stack & Infra Decisions — Comfy Knowledge Platform (MVP)

Concrete deployment stack. Reconciled with `TECH_ARCHITECTURE.md` (which stays the source of truth for schema/engine) and `PRODUCT_LOGIC.md` (behavior).

## 1. Stack

```
Telegram Bot ─┐
              ├─→ Backend (NestJS, single deploy: API + bot + workers)
WebApp ───────┘        ├─→ Supabase (PostgreSQL only — service-role)
                       └─→ Redis (cache + queues + flow-state + rate-limit)
```

- **Backend** — NestJS. Hosts API, Telegram bot handlers, and workers in one deployable for MVP. Single source of truth for all business logic.
- **Supabase** — used as **PostgreSQL only**, accessed with the service role from the backend.
  - **We do NOT use Supabase Auth.** Identity = Telegram `initData` validation + our own `invites` table. Supabase Auth (email/password) does not fit Telegram-only onboarding.
  - **WebApp never talks to Supabase directly** — only through the backend API. Otherwise scoring/access logic would leak to the client and RLS would become load-bearing, breaking "backend = single source of truth, UI = thin".
- **Redis** — NOT a database. Cache, queues, ephemeral flow-state, rate-limiting. **Not the system clock** (see §3).

## 2. Backend structure

```
src/
├── bot/                 # Telegram handlers (thin: callback → service → response)
├── api/                 # WebApp REST controllers
├── services/
│   ├── lifehacks.service.ts
│   ├── work-items.service.ts
│   ├── scoring.service.ts      # the ONE quality_score function
│   └── invites.service.ts
├── integrations/
│   ├── supabase.client.ts      # service-role
│   └── redis.client.ts
├── workers/
│   ├── reminder.worker.ts      # fires WORK_CHECK at check_due_at
│   └── expiry.worker.ts        # sets EXPIRED at expires_at
├── utils/
└── main.ts
```

## 3. Timers — Postgres is the clock, NOT Redis TTL  (critical)

**Do not** rely on Redis key TTL + keyspace-expired notifications to drive the 7-day check or 14-day EXPIRED transition. Redis expires keys lazily and the `expired` notification is fire-and-forget — if no subscriber is connected at that instant (worker restart, deploy), the event is **lost forever**. That would silently leave work-items stuck `in_work`: slots never freed, reminders never sent, scoring never closing.

**Authoritative approach:**
- `work_items.check_due_at` (= `started_at + 7d`) and `work_items.expires_at` (= `started_at + 14d`) live in Postgres and are the source of truth.
- A periodic **sweep worker** (every ~60s) runs:
  - reminder: `WHERE status='in_work' AND check_due_at <= now() AND check_sent = false` → push bot check, mark sent.
  - expiry: `WHERE status='in_work' AND expires_at <= now()` → set `EXPIRED`, free slot.
- Sweeps are idempotent and crash-safe: a restarted/late worker simply picks up due rows on the next tick. Nothing is lost.
- Optional upgrade later: BullMQ delayed jobs (persistent, also on Redis) if polling load ever matters. Not needed for MVP.

## 4. Where Redis IS used

```
flow:user:{id}              = wizard step (TTL 10–30m)     # bot create-lifehack flow state
ratelimit:react:{user}      = sliding counter (TTL 60s)    # anti-spam reactions
feed:{category}:{audience}  = cached ranked json (TTL 2–5m) # audience ∈ {newcomer, experienced}
```
- Feed cache is keyed by **category + audience**, NOT by region. Lifehacks are company-wide knowledge (they survive store/region changes), so there is no per-region feed. `audience` exists because newcomers (`lt_6m`) get a top-leaning mix.
- Cache is invalidated on `WORK_RESOLVED` / `REACTION_SET` / `LIFEHACK_PUBLISHED` for the affected category.

## 5. Schema note

The canonical schema lives in `TECH_ARCHITECTURE.md` §2 and is not re-listed (or abbreviated) here to avoid drift. Two points to keep straight against any shorthand:
- `reactions` stores `author_store_id_snap`, `user_store_id_snap`, `is_cross_store` (snapshots). **`weight` is derived** (`is_cross_store ? 1.0 : 0.25`) at scoring time — not a stored column.
- `work_items` must retain `started_at`, `check_due_at`, `expires_at`, `resolved_at` — the sweep worker depends on them.

## 6. Deployment

```
Railway   → backend (API + bot + workers, one service or split later)
Supabase  → PostgreSQL (service-role; no Supabase Auth)
Redis     → Upstash or Railway Redis (cache, queues, flow-state, rate-limit)
GitHub    → CI/CD
```

## 7. Why this is the right MVP shape

- No microservices, no premature splitting — one backend deploy.
- Redis adds "smarts" (cache, rate-limit, ephemeral state) without becoming a fragile clock.
- Supabase removes DevOps pain but stays a plain Postgres behind the backend.
- Scalable: workers and bot can be split out of the single deploy later with zero model changes, because state lives in Postgres and logic lives in the backend, not the UI.
