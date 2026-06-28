# Product Logic — Comfy Knowledge Platform

Status: finalized for MVP scope. This document is the single source of truth for product behavior before UX/DB/code work begins.

## Core idea

Not a "knowledge base" (static library). A living system for exchanging real sales experience, where every lifehack goes through a verification cycle before it's trusted.

Cycle: **READ → TAKE INTO WORK ("Беру в роботу") → CONFIRMATION (delayed, ~7 days) → RESULT**

There is no "like" button. The only signals that count are actions: taking a lifehack into work, and confirming whether it actually helped.

---

## Architecture: two layers

### Layer 1 — MVP (build now)
Everything below this line ships at launch.

### Layer 2 — Intelligence Layer (v1.1+, not built now)
Situational model, AI classification, auto-tagging, recommendation engine, contextual search ("client says X → here's the answer"). Explicitly deferred — do not let MVP scope creep into this.

---

## 1. Access & hierarchy (Layer 1)

- No self-registration. Access only via invite token.
- Invite token encodes: role + scope (region and/or store). User never picks their own role.
- Hierarchy: `MEGA_ADMIN → REGIONAL_IT_LEAD → DIRECTOR (= STORE_IT_LEAD) → DEP_DIRECTOR (= IT_EXPERT) → SELLER`
- A region can have **N** `REGIONAL_IT_LEAD` users with equal rights (no primary/backup distinction — just add another when needed).
- `DIRECTOR` creates the store on first login (lazy creation), not pre-provisioned by the regional lead.
- `DIRECTOR` and `DEP_DIRECTOR` have equal rights within their store.
- Transfers (region/store/role change, deactivation) require confirmation; never silent.
- No hard deletes. Only status changes (`active`/`inactive`/`archived`).
- Deactivated author: lifehack stays, author display becomes "Колишній співробітник" / "Архівний автор" (no name).

## 2. Experience segmentation (Layer 1)

- Asked once at first login: "Скільки часу ви працюєте в Comfy?" — `<6m` / `6m–2y` / `2y+`.
- Stored once, never asked again, never auto-derived from account age.
- Not an attestation — only determines which feed mix a new user sees by default (newcomers lean toward top-confirmed content). Self-reported and not security/HR-relevant; minor inaccuracy has no real cost.

## 3. Lifehack structure (Layer 1)

A lifehack is **structured data, not a free-text post**:

- Category: `IT_SERVICE` | `HAPPY_SERVICE`
- Product type: flat list (e.g. laptops, TVs, smartphones)
- Body fields (kept simple for MVP — no situational taxonomy):
  - What problem/approach
  - What you say / do
  - Objection handling (optional)
  - Why it works / result

### Creation modes
- **Default — fast text mode.** Minimal friction, optimized for volume during bootstrap.
- **PRO mode — structured wizard** (the 5-question form: situation, client said, you replied, outcome, applicable products). Optional, never blocks publishing. May be auto-formatted from answers later (AI, Layer 2).

### Duplicate detection
- On submit, keyword-based similarity search against existing lifehacks.
- If matches found: non-blocking prompt — "Схоже, така ідея вже є" with options "Переглянути схожі" / "Все одно опублікувати".
- AI-based similarity is Layer 2.

## 4. Confirmation, not rating (Layer 1)

- No 👍/👎 like buttons.
- Action verbs only:
  - `📌 Беру в роботу` (take into work)
  - After delay (~7 days): `🔥 Допомогло` / `😐 Частково` / `❌ Не допомогло`
- These actions are the only signal that affects a lifehack's score.

### Active-work limit
- Max 3–5 lifehacks "in progress" (awaiting confirmation) per user at a time.
- If limit reached and user wants to take on a new one: show currently active ones with an option to close early ("вже знаю результат").
- Delayed-feedback reminders are batched into a single message ("У тебе є 3 лайфхаки, за якими ми ще чекаємо результат"), never one notification per lifehack.

### Anti-abuse
- One `user_id` + `lifehack_id` = at most one active confirmation vote (DB unique constraint). Prevents single-user vote stacking.

## 5. Lifecycle status (Layer 1 — automatic, no human moderation)

Score-based, fully automatic. No manual "На перевірці" / moderator step.

```
New        → 0–2 confirmations
Growing    → 3–10 confirmations
Top        → 10+ confirmations, high success ratio
Archived   → score decay / sustained negative ratio
```

## 6. Feed ranking — staged rollout (Layer 1)

Computed **per category** (IT_SERVICE and HAPPY_SERVICE evolve independently — don't gate one category's algorithm stage on the other's volume).

- **Stage 1** (until ~200 lifehacks/category): 90% newest, 10% random. Goal: fill the base.
- **Stage 2** (~200–1000): 40% new / 40% popular / 20% random.
- **Stage 3** (1000+): full score — confirmations taken, success ratio, recency decay.

## 7. Comments (Layer 1 — controlled vocabulary, no free text)

- Fixed set of 3–5 selectable reasons, e.g.:
  - "Працює на: ноутбуках / ТВ / смартфонах"
  - "У мене не спрацювало тому що..." (from fixed list)
- No open-ended text fields on MVP. Free text is a Layer 2 consideration, not default.

## 8. Profile (Layer 1 — not a social profile)

Answers exactly three questions, nothing else:
- Скільки лайфхаків написав
- Скільки підтверджено
- В яких категоріях сильний (avg success rate by category)

No personal leaderboard / point-chasing rating of people. Rating belongs to lifehacks, not to users — avoids gaming behavior.

## 9. Search (Layer 1 scope)

- MVP: filter by category + product type (structured fields), not full-text/semantic.
- Situational search ("клієнт каже X" → matching lifehacks) is explicitly **Layer 2**.

## 10. Explicitly deferred to Layer 2 (do not build now)

- Situational model / tagging clients' objections as first-class taxonomy
- AI-based content classification and auto-tagging
- AI-assisted lifehack generation from wizard answers
- Contextual/semantic search
- Recommendation engine beyond staged score-based feed
