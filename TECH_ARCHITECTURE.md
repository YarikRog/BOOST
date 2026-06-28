# Tech Architecture — Comfy Knowledge Platform (MVP)

Production system design, reconciled with `PRODUCT_LOGIC.md` and `UX_BLUEPRINT.md`. Where this document and those disagree, those are the source of truth for *behavior*; this document is the source of truth for *structure*.

## 1. System architecture

```
Telegram Bot ───┐                ┌──→ PostgreSQL (durable state)
                ├──→ Backend API ─┤
WebApp ─────────┘   (Core Engine) ├──→ Redis (delay timers, feed cache)
                                  └──→ Worker layer (async jobs)
```

- **Telegram Bot** — thin UI. Buttons + callbacks only. No business logic. Calls API.
- **WebApp (Mini App)** — thin UI. Same API, mirror of the same state. No business logic.
- **Backend Core** — single source of truth. State machines, invites, roles, transfers, scoring, validation.
- **Worker layer** — async: delayed-feedback trigger, expiry, score/feed recompute.
- **Redis** — delay/timer bookkeeping + precomputed feed ranking cache.

Design rule (non-negotiable): **no business logic in any UI**; backend is the only source of truth; everything is event-driven; no manual moderation; two separate state machines (lifehack entity vs work-item).

## 2. Domain model (PostgreSQL)

Enums:
```
user_role      = MEGA_ADMIN | REGIONAL_IT_LEAD | DIRECTOR | DEP_DIRECTOR | SELLER
user_status    = active | inactive | archived
experience     = lt_6m | 6m_2y | gt_2y
category        = IT_SERVICE | HAPPY_SERVICE
lifehack_status = draft | published | archived        -- NOTE: NEW/GROWING/TOP are NOT here (see §4)
workitem_status = in_work | success | partial | fail | not_tried | expired
reaction_type   = like | dislike
invite_status   = active | used | revoked
```

### regions
```
id            uuid pk
name          text
```

### stores
```
id            uuid pk
region_id     uuid fk → regions
name          text
director_id   uuid fk → users  (nullable until first director login)
created_at    timestamptz
```

### users
```
id                 uuid pk
telegram_id        bigint unique
name               text
phone              text
role               user_role
region_id          uuid fk → regions  (nullable for MEGA_ADMIN)
store_id           uuid fk → stores   (nullable for MEGA_ADMIN / REGIONAL_IT_LEAD)
status             user_status default active
experience_segment experience          (set once at onboarding, never re-asked)
created_at         timestamptz
```

### invites
```
id           uuid pk
token        text unique
role         user_role          -- role this invite grants
region_id    uuid fk → regions  (nullable)
store_id     uuid fk → stores   (nullable)
created_by   uuid fk → users
used_by      uuid fk → users    (nullable)
status       invite_status default active
expires_at   timestamptz
```

### lifehacks
```
id                  uuid pk
author_id           uuid fk → users
author_store_id     uuid fk → stores   -- SNAPSHOT at publish time (for cross-store like logic)
category            category
product_type        text
title               text
content_json        jsonb              -- structured body (fast = single field; pro = full)
status              lifehack_status default draft
created_at          timestamptz
published_at        timestamptz        (nullable)
```
- Tier (NEW/GROWING/TOP) is **derived**, never stored — see §4.
- `author_store_id` is captured at publish and not updated if the author later transfers (snapshot semantics).

### work_items  (the user×lifehack engagement — CRITICAL table)
```
id            uuid pk
user_id       uuid fk → users
lifehack_id   uuid fk → lifehacks
status        workitem_status default in_work
started_at    timestamptz
check_due_at  timestamptz     -- started_at + 7d  (when WORK_CHECK_EVENT fires)
expires_at    timestamptz     -- started_at + 14d (when auto-EXPIRED)
resolved_at   timestamptz     (nullable; set on any terminal state)
```
Constraints (these prevent the silent bugs):
```
-- at most ONE active work-item per user per lifehack
CREATE UNIQUE INDEX uniq_active_workitem
  ON work_items (user_id, lifehack_id) WHERE status = 'in_work';
```
- `work_items.status` is the **single authoritative outcome**. There is intentionally **no separate `feedbacks` table** — a second copy of the outcome would drift from this one. (If an immutable event log is ever wanted, it is append-only and `status` remains the projection, never a parallel truth.)

### reactions  (likes/dislikes)
```
id                    uuid pk
user_id               uuid fk → users
lifehack_id           uuid fk → lifehacks
type                  reaction_type
author_store_id_snap  uuid     -- SNAPSHOT: lifehack.author_store_id at like time
user_store_id_snap    uuid     -- SNAPSHOT: liker's store_id at like time (null for MEGA_ADMIN / REGIONAL_IT_LEAD)
is_cross_store        boolean  -- derived & frozen at like time: user_store_id_snap != author_store_id_snap
created_at            timestamptz
```
Constraints:
```
-- one reaction per user per lifehack (no vote stacking; flipping like↔dislike updates the row)
CREATE UNIQUE INDEX uniq_reaction ON reactions (user_id, lifehack_id);
```
- Weight is derived from `is_cross_store`: `true → 1.0`, `false → 0.25` (Section 4 of product logic). MEGA_ADMIN / REGIONAL_IT_LEAD have no store → `user_store_id_snap = null` → `is_cross_store = true` → weight `1.0`.
- All three snapshot fields are frozen at like time; later transfers of either party never recompute them. Storing both raw store IDs (not just the flag) keeps the weighting auditable and recomputable.

## 3. API design

```
AUTH
  POST /auth/telegram                 -- validate initData
  POST /auth/invite/verify            -- check token → role + scope preview
  POST /auth/phone                    -- store phone
  POST /auth/onboard                  -- set experience_segment (+ create store if DIRECTOR first login)

USERS
  GET  /users/me
  POST /users/transfer                -- region/store/role change (requires confirmation)
  POST /users/deactivate

STORES / REGIONS
  POST /stores/create
  GET  /regions
  GET  /stores?region_id=

LIFEHACKS
  POST /lifehacks                     -- create (draft→published); runs duplicate guard
  GET  /lifehacks/feed?category=      -- staged ranking, per category
  GET  /lifehacks/:id
  POST /lifehacks/:id/react           -- like/dislike (upsert; sets same_store_at_time)

WORK FLOW
  POST /lifehacks/:id/take            -- create work_item (enforces active-work limit)
  POST /work-items/:id/result         -- body: success|partial|fail|not_tried
  GET  /work-items/active             -- current IN_WORK list (powers HOME "В роботі (X)")
```

## 4. Core business engine

### Lifecycle (derived tier within PUBLISHED — matches Product Logic §6)
Tier is computed on read/recompute, NOT stored:
```
confirmations = count(work_items where status in (success, partial, fail))   -- not_tried/expired excluded

NEW      → confirmations = 0           (quality_score not yet computable)
GROWING  → 1 ≤ confirmations ≤ 9
TOP      → confirmations ≥ 10 AND quality_score ≥ threshold
ARCHIVED → quality_score sustained below threshold (or long inactivity)
```

### Scoring (one function → quality_score, Product Logic §5)
```
N = count(success) + count(partial) + count(fail)          # not_tried AND expired excluded
confirmation_success_rate = (1.0*success + 0.3*partial - 0.5*fail) / N      # undefined if N = 0

weighted_like_rate  = f(reactions, weight 1.0 cross-store / 0.25 same-store)
recency_factor      = decay since last confirmation

quality_score = 0.6*confirmation_success_rate + 0.2*weighted_like_rate + 0.2*recency_factor
              = UNDEFINED while N = 0   (likes alone never promote)
```
This is the *only* definition of quality. Feed ranking and tier both read it — they do not each compute their own.

## 5. Async workers

```
Worker 1 — delayed feedback   trigger: work_item.check_due_at reached → push bot check
Worker 2 — expiry             trigger: work_item.expires_at reached & still in_work → set EXPIRED, free slot
Worker 3 — recompute          trigger: new result / new reaction → refresh quality_score + feed cache
```
- not_tried and expired both free the slot but are excluded from scoring.

## 6. Event system

```
USER_CREATED · STORE_CREATED · LIFEHACK_PUBLISHED · WORK_STARTED ·
WORK_CHECK_DUE · WORK_RESOLVED (success|partial|fail|not_tried) · WORK_EXPIRED ·
REACTION_SET · SCORE_RECOMPUTED
```
Flow: `UI action → API → domain event → worker → DB update → feed/score refresh`.

## 7. Feed engine (per category — Product Logic §7)

```
Stage 1 (<~200/category): 90% newest, 10% random
Stage 2 (~200–1000):      40% new, 40% popular (by quality_score, else recency), 20% random
Stage 3 (1000+):          quality_score ranking (recency decay already inside it)
```
Stage is evaluated per category independently. Newcomers (`lt_6m`) are biased toward higher-tier items; experienced users see the full base.

## 8. Bot & WebApp (both thin)

```
UI action → callback/request → backend API → returns state → UI renders buttons/screens
```
Neither holds logic; both render the same backend state. The bot owns *pushes* (reminders, check prompts, invite delivery); the WebApp owns *pulls* (feed, view, create, profile).

## 9. Key design rules (recap)

1. No business logic in UI (bot = UI, web = UI).
2. Backend = single source of truth.
3. Event-driven throughout.
4. No manual moderation — lifecycle is automatic.
5. Two separate state machines: lifehack entity (`draft→published→archived`) vs work-item (`in_work→success|partial|fail|not_tried|expired`).
6. One outcome store (`work_items.status`), one quality definition (`quality_score`) — no duplicates.
