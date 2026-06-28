# Comfy Knowledge Platform — Backend

NestJS skeleton: API + Telegram bot + sweep workers in one deployable (see `../STACK.md`).
Behavior and structure are defined by the design docs at the repo root —
`PRODUCT_LOGIC.md`, `UX_BLUEPRINT.md`, `TECH_ARCHITECTURE.md`, `STACK.md`.

## Layout

```
src/
├── main.ts                  app bootstrap
├── app.module.ts            wiring (config, schedule, integrations, features, workers)
├── common/enums.ts          locked domain enums (mirror migration 0001)
├── integrations/            supabase (Postgres-only, service role) + redis clients
├── services/
│   ├── scoring.service.ts   THE single quality_score function
│   ├── work-items.service.ts  work-item state machine (take / resolve / listActive)
│   └── lifehacks.service.ts   feed (staged ranking stubbed) + quality recompute
├── api/                     thin controllers (validation + delegation only)
├── workers/                 reminder + expiry sweeps (Postgres is the clock)
└── bot/                     Telegram handlers (stub)

migrations/0001_init.sql     full schema: enums, tables, FKs, unique + partial indexes
scripts/run-migrations.js    forward-only runner
```

## Run

```bash
cp .env.example .env        # fill in Supabase / Redis / Telegram
npm install
npm run migrate             # applies migrations/*.sql via DATABASE_URL
npm run start:dev
```

## What's real vs stubbed

Implemented to spec:
- Domain enums (6 work-item states incl. `not_tried`).
- `ScoringService` — `quality_score = 0.6·confirmation + 0.2·likes + 0.2·recency`;
  `not_tried`/`expired` excluded from numerator AND denominator; `null` (NEW) while N=0;
  derived tier NEW/GROWING/TOP.
- `WorkItemsService.take` — active-work limit + single-active guard (via partial-unique index).
- Sweep workers — `check_due_at`/`expires_at` driven, idempotent, crash-safe.
- Migration — all constraints from `TECH_ARCHITECTURE.md` §2.

Stubbed (next steps):
- Auth (Telegram `initData` validation), invites consume flow, roles/transfers.
- Staged feed ranking (currently "newest published").
- Reaction folding into `weightedLikes/weightedDislikes`.
- Bot handlers + batched check prompts.
```
