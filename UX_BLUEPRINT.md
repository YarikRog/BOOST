# UX Blueprint — Comfy Knowledge Platform (MVP)

Screens, buttons, transitions, and UI-state-per-system-state. Grounded strictly in the state machine of `PRODUCT_LOGIC.md` (Section 11). This is UX structure, not visual design.

## Surface split (what lives where)

- **Telegram Bot** = entry, identity, notifications, delayed-feedback prompts. Thin. No content browsing.
- **WebApp (Telegram Mini App)** = the product: feed, view, create, confirm, profile. Everything content-related.

Rule: anything that is a *push* (reminder, check-event, invite delivery) lives in the bot. Anything that is a *pull* (browse, read, create) lives in the WebApp.

---

## FLOW 1 — Invite entry (Telegram Bot)

Goal: from invite link to "I'm in the system" in the fewest steps. Drives no lifehack state — only creates the user + scope.

```
[B1] /start with invite token
        │  (token valid?)
        ├─ no  → [B1e] "Доступ лише за запрошенням"  (dead end, offer contact admin)
        └─ yes → [B2] Role + scope preview
                    │  "Тебе запрошено як: ПРОДАВЕЦЬ
                    │   Магазин: Comfy Lavina"
                    │  [ Підтвердити ] [ Це не я ]
                    ▼
                 [B3] Phone share (Telegram contact button)
                    ▼
                 [B4] Experience question (asked once, Section 2)
                    │  ○ До 6 міс  ○ 6 міс–2 роки  ○ 2+ роки
                    ▼
                 [B5] Done → [ Відкрити застосунок ] (opens WebApp)
```

Screen detail:

| Screen | Elements | Buttons | Result |
|---|---|---|---|
| B2 | role + store/region from token | Підтвердити / Це не я | "Це не я" → abort, notify inviter |
| B3 | why we need phone (1 line) | Поділитись номером (native) | phone stored |
| B4 | one question, 3 radios | one tap | experience stored, never asked again |
| B5 | success | Відкрити застосунок | launches WebApp at feed |

Special case — **DIRECTOR first login:** after B4, insert one extra step `[B4.5] Create store` (store name input). This is the lazy store-creation from Section 1 — only DIRECTOR sees it, only once.

---

## FLOW 2 — Add lifehack (WebApp)

Goal: published lifehack in 30–60s. Drives lifehack entity: `DRAFT → PUBLISHED`.

```
[W-FEED] Floating [ + Додати кейс ]
   ▼
[C1] Mode is implicit — fast text by default; "Детальніше" reveals PRO fields
   ▼
[C2] Category   ( IT_SERVICE | HAPPY_SERVICE )     ← required
   ▼
[C3] Product type (flat picker: ноутбуки / ТВ / смартфони / …)  ← required
   ▼
[C4] Body
     ├─ FAST: single text area "Опиши кейс своїми словами"
     └─ PRO (optional, "Детальніше"):
          • Ситуація / що сказав клієнт
          • Що ти відповів / зробив
          • Заперечення (optional)
          • Чому спрацювало / результат
   ▼
[C5] Duplicate guard (Section 3): on submit, keyword match
     ├─ matches → "Схоже, така ідея вже є"
     │             [ Переглянути схожі ] [ Все одно опублікувати ]
     └─ none → publish
   ▼
[C6] PUBLISHED → toast "Опубліковано", lands in feed as tier NEW
```

Rules baked into UI:
- PRO fields never block publish (FAST always available).
- Category + product type are the only hard-required fields (they power Section 10 search).
- On publish the entity goes straight to `PUBLISHED`; tier is `NEW` (0 confirmations, Section 6). No "pending review" screen — there is no moderation step.

---

## FLOW 3 — Use a lifehack (WebApp + Bot)

Goal: ≤10s to a decision. Drives the **work-item** machine `NONE → IN_WORK → SUCCESS/PARTIAL/FAIL/EXPIRED`. Does **not** change the lifehack entity state.

### 3a. View + immediate signals (WebApp)

```
[V1] Lifehack detail
     ┌──────────────────────────────┐
     │ <title / structured body>    │
     │ Автор: Store Kyiv 22         │
     │ Тариф: NEW / GROWING / TOP   │  ← derived tier badge, not DB state
     ├──────────────────────────────┤
     │ 👍  👎      📌 Беру в роботу  │
     └──────────────────────────────┘
```

Button behavior by work-item state (the SAME card renders differently):

| Work-item state | What the action row shows |
|---|---|
| `NONE` | `👍` `👎` + `📌 Беру в роботу` |
| `IN_WORK` | `👍` `👎` + badge "📌 В роботі" + `Закрити достроково` |
| `SUCCESS/PARTIAL/FAIL` | `👍` `👎` + small result chip (🔥/😐/❌), `📌` re-enabled (can re-take) |
| `EXPIRED` | `👍` `👎` + `📌 Беру в роботу` (slot was freed) |

- `👍/👎` are always available, never gated by work-item state. They only affect the weighted like-rate (Section 4), not the entity state.
- Tapping `📌` when at active-work limit (3–5) → interrupt sheet (see 3c).

### 3b. Delayed confirmation (Bot — the WORK_CHECK_EVENT)

```
~7 days after IN_WORK, bot pushes:
[N1] "Ти пробував кейс «<title>»? Чи спрацювало?"
        [ 🔥 Так, продав ] [ 😐 Частково ] [ ❌ Ні ]
   ▼
   tap → work-item → SUCCESS / PARTIAL / FAIL, slot freed, feeds success-rate
   no tap within 7 more days → EXPIRED (slot freed, no signal; Section 11c)
```

- Reminders are **batched**: if 2+ are pending, one message — "У тебе 2 кейси очікують результат" → opens a small list, each with the 3 result buttons.
- One notification burst, never one-per-lifehack.

### 3c. Active-work limit interrupt (WebApp)

```
User taps 📌 while at limit:
[L1] "У тебе вже 5 кейсів у роботі. Заверши один, щоб взяти новий."
     <list of active work-items, each:>
        «<title>»   [ 🔥 ] [ 😐 ] [ ❌ ]   (close early = "вже знаю результат")
```

Closing one early → that work-item resolves (counts toward success-rate), frees a slot, then the new `📌` proceeds.

---

## Cross-cutting screen A — Feed (WebApp home)

```
┌────────────────────────────────┐
│ 🏪 <store>      <role>          │
│ [ IT_SERVICE | HAPPY_SERVICE ]  │  ← category tabs
├────────────────────────────────┤
│ <lifehack cards, ranked by      │
│  staged feed algorithm, Sec 6>  │
│   • newcomer (<6m): top-leaning │
│   • experienced: full base      │
└────────────────────────────────┘
   ( + Додати кейс )  floating
```

- Empty state (cold start / Stage 1): "Ще немає кейсів — додай перший" + the `+` button.
- Loading: skeleton cards.
- Ranking and tier badges are read-only reflections of the score model; the UI never lets a user set a tier.

## Cross-cutting screen B — Profile (WebApp)

Exactly three facts (Section 9), no leaderboard:

```
<name>   <role> · <store>
─────────────────────────
Написано кейсів:        12
Підтверджено:            7
Рівень експертизи:       ← per category (non-competitive label)
   IT_SERVICE: сильний
   HAPPY_SERVICE: початковий
```

- Deactivated author's lifehacks elsewhere show "Колишній співробітник" instead of name (Section 1).

---

## State → UI traceability (the contract)

| System state | Where it surfaces in UI |
|---|---|
| Lifehack `DRAFT` | only in author's create flow, never in feed |
| Lifehack `PUBLISHED` | feed card + detail |
| Lifehack tier NEW/GROWING/TOP | derived badge on card (read-only) |
| Lifehack `ARCHIVED` | drops out of active feed; still reachable via author profile |
| Work-item `NONE` | `📌 Беру в роботу` active |
| Work-item `IN_WORK` | "В роботі" badge + close-early |
| Work-item `SUCCESS/PARTIAL/FAIL` | result chip + re-take allowed |
| Work-item `EXPIRED` | reverts card to `📌` available |

Anything not in this table is out of MVP scope.
