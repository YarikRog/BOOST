# Product Logic — Comfy Knowledge Platform

Status: finalized for MVP scope. This document is the single source of truth for product behavior before UX/DB/code work begins.

## Core idea

Not a "knowledge base" (static library). A living system for exchanging real sales experience, where every lifehack goes through a verification cycle before it's trusted.

Cycle: **READ → TAKE INTO WORK ("Беру в роботу") → CONFIRMATION (delayed, ~7 days) → RESULT**

Likes (👍/👎) exist as a lightweight secondary signal, but the truth signal — the one that actually decides if a lifehack is good — is the action: taking it into work, and confirming whether it actually helped. See Section 4.

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

## 4. Confirmation is the truth signal; likes are a secondary, weighted signal (Layer 1)

Both exist, but they are not equal — confirmation is what actually determines score and lifecycle stage. Likes are a lightweight signal that helps sorting (especially during cold start) but are deliberately weakened against gaming.

### Confirmation (primary signal)
- Action verbs, not opinions:
  - `📌 Беру в роботу` (take into work)
  - After delay (~7 days): `🔥 Допомогло` / `😐 Частково` / `❌ Не допомогло`
- This is the only signal that drives lifecycle status (Section 5) and the core score.

### Likes (secondary signal, store-weighted)
- `👍` / `👎` buttons exist, shown immediately under every lifehack, no friction.
- **Anti-cronyism rule:** likes are weighted, not binary-excluded, by whether the liker shares a store with the author (snapshot: author's store at publish time vs liker's store at like time — not recalculated on later transfer):
  - Cross-store like/dislike → weight `1.0`
  - Same-store like/dislike → weight `0.25`
- Rationale: full exclusion would leave small stores with almost no counted signal at all (most of their views are same-store). A reduced weight keeps a damped signal alive instead of zeroing it out, while still preventing coworkers from reflexively mass-liking each other into the top of the feed.
- The visible like counter shown to users is the raw unweighted count; the weighting only affects the internal score used for ranking.
- `REGIONAL_IT_LEAD` / `MEGA_ADMIN` have no store_id — their likes always weight `1.0` (never "same store" as any author).
- The store-weighting rule applies only to 👍/👎. Confirmation actions (📌/🔥/😐/❌) are unaffected — they reflect one person's own real experience, not a group vote, so no weighting is needed there.

### Active-work limit
- Max 3–5 lifehacks "in progress" (awaiting confirmation) per user at a time.
- `active` = user tapped `📌 Беру в роботу` and has not yet submitted a result, closed it early, or had it auto-expire.
- If limit reached and user wants to take on a new one: show currently active ones with an option to close early ("вже знаю результат").
- Delayed-feedback reminders are batched into a single message ("У тебе є 3 лайфхаки, за якими ми ще чекаємо результат"), never one notification per lifehack.
- **Auto-expiry:** if there is no response within 7 days of the delayed-feedback prompt (~14 days total from taking it into work), the slot auto-closes as `немає відповіді` — frees the slot, and is excluded from success-rate math (not counted as positive or negative). Prevents a slot from being stuck forever by an unresponsive user.

### Anti-abuse
- One `user_id` + `lifehack_id` = at most one active confirmation vote, and at most one like/dislike (DB unique constraints). Prevents single-user vote stacking.

## 5. Quality score — single source of truth (Layer 1)

One formula, referenced by both lifecycle status (below) and feed ranking (Section 6) — there is exactly one definition of "a good lifehack," not several competing ones.

```
quality_score =
    0.6 * confirmation_success_rate     (🔥/😐/❌ outcomes, "Допомогло" weighted highest)
  + 0.2 * weighted_like_rate            (👍/👎, store-weighted per Section 4)
  + 0.2 * recency_factor                (decays with age since last confirmation)
```

- Undefined until a lifehack has **at least 1 confirmation** — with zero confirmations, `confirmation_success_rate` has no sample, so `quality_score` is not computed at all (not zero, not assumed). This is intentional: likes alone never promote a lifehack's status or score, they only matter once real usage data exists.
- Weights (0.6 / 0.2 / 0.2) are a starting point for launch, expected to be tuned post-launch against real data — not a fixed law.

## 6. Lifecycle status (Layer 1 — automatic, no human moderation)

Fully automatic, no manual "На перевірці" / moderator step. Status uses **confirmation count as a sample-size gate** (don't crown something "Top" off 3 confirmations even if all positive — needs statistical mass) and `quality_score` as the **quality gate** within/below that:

```
New        → 0 confirmations (quality_score not yet computable, regardless of like count)
Growing    → 1–9 confirmations
Top        → 10+ confirmations AND quality_score above threshold
Archived   → quality_score drops and stays below threshold (sustained, not a single dip)
```

A "New" lifehack staying New for a while is expected behavior during early data collection, not a flaw — it reflects real sample size, not a defect to mask with a temporary status.

## 7. Feed ranking — staged rollout (Layer 1)

Computed **per category** (IT_SERVICE and HAPPY_SERVICE evolve independently — don't gate one category's algorithm stage on the other's volume). These stages exist specifically because `quality_score` is statistically unreliable with too few confirmations — Stage 1/2 are scaffolding that gets a category to the point where the formula is meaningful.

- **Stage 1** (until ~200 lifehacks/category): 90% newest, 10% random. Goal: fill the base. True "Top" items can't exist yet at this volume (needs 10+ confirmations) — no pinning needed, nothing to pin.
- **Stage 2** (~200–1000): 40% new / 40% popular / 20% random. "Popular" = ranked by `quality_score` where computable, else recency.
- **Stage 3** (1000+): ranked by `quality_score` directly, with recency decay already folded into the formula.

## 8. Comments (Layer 1 — controlled vocabulary, no free text)

- Fixed set of 3–5 selectable reasons, e.g.:
  - "Працює на: ноутбуках / ТВ / смартфонах"
  - "У мене не спрацювало тому що..." (from fixed list)
  - Always include an `Інше` option, explicitly excluded from analytics — a safety valve so users aren't forced to pick the nearest wrong reason just because the real one isn't listed.
- No open-ended text fields feeding analytics on MVP. Free text is a Layer 2 consideration, not default.

## 9. Profile (Layer 1 — not a social profile)

Answers exactly three questions, nothing else:
- Скільки лайфхаків написав
- Скільки підтверджено
- В яких категоріях сильний (avg success rate by category)

No personal leaderboard / point-chasing rating of people. Rating belongs to lifehacks, not to users — avoids gaming behavior. UI label for the "strong in category" line should read as a non-competitive descriptor ("рівень експертизи"), not a ranked score.

## 10. Search (Layer 1 scope)

- MVP: filter by category + product type (structured fields), not full-text/semantic.
- Situational search ("клієнт каже X" → matching lifehacks) is explicitly **Layer 2**.

## 11. State machine (Layer 1 — the "physics" of the system)

There are **two separate state machines**, not one. Conflating them is a modeling bug (a lifehack can be "in work" for one user and brand new for another at the same instant).

### 11a. Lifehack entity (one per lifehack)

```
DRAFT → PUBLISHED → ARCHIVED
```

- `DRAFT` — author filling the form; not visible to anyone else; no interactions possible.
- `PUBLISHED` — visible in feed, open to all interactions. The quality **tier** (New / Growing / Top, Section 6) is a *derived label within* PUBLISHED, not a separate stored workflow state.
- `ARCHIVED` — `quality_score` stays below threshold (sustained, not one dip), or sustained negative results, or long inactivity. Never hard-deleted (Section 1). An archived lifehack leaves the active feed but is retained.

### 11b. Work-item (one per `user × lifehack` — the engagement, not the lifehack)

```
IN_WORK → SUCCESS | PARTIAL | FAIL | EXPIRED
```

- `IN_WORK` — created when user taps `📌 Беру в роботу`. Records `user_id`, `lifehack_id`, `started_at`. Counts against that user's active-work limit (Section 4).
- After ~7 days a `WORK_CHECK_EVENT` fires → bot asks for the result.
- Terminal states:
  - `SUCCESS` 🔥 ("допомогло")
  - `PARTIAL` 😐 ("частково")
  - `FAIL` ❌ ("не спрацювало")
  - `EXPIRED` — no response within 7 days of the check prompt (~14 days total). Frees the slot; excluded from success-rate math (neither positive nor negative). See Section 4 auto-expiry.
- Guard: at most one **active** (`IN_WORK`) work-item per `(user_id, lifehack_id)`. Re-taking is allowed only after the previous one reached a terminal state.

### 11c. How work-items feed the score

Each terminal confirmation contributes a per-outcome weight, but the lifehack's quality is a **rate, not a running sum** (consistent with Section 5 — avoids volume beating quality):

```
SUCCESS  → +1.0
PARTIAL  → +0.3
FAIL     → -0.5
EXPIRED  → not counted

confirmation_success_rate = Σ(outcome_weights) / N_confirmations
```

So 10/10 successes outranks 80/100 successes, exactly as intended. These weights feed `confirmation_success_rate` in the Section 5 formula — they are **not** a separate cumulative score.

### 11d. Event-driven, not manually managed

The whole lifecycle is event/trigger driven (publish, take-into-work, check-event, confirm, decay) — there is no human "quality manager" step anywhere. The one retention dependency is the delayed check: if users don't return, confirmations stall. Mitigation is the batched bot reminder / summary ("у тебе 2 кейси очікують результат"), Section 4 — and the `EXPIRED` state ensures stalled work-items self-clear instead of blocking slots.

## 12. Explicitly deferred to Layer 2 (do not build now)

- Situational model / tagging clients' objections as first-class taxonomy
- AI-based content classification and auto-tagging
- AI-assisted lifehack generation from wizard answers
- Contextual/semantic search
- Recommendation engine beyond staged score-based feed
