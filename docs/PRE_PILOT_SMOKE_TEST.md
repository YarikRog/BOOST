# BOOST — Pre-Pilot Smoke Test

Manual verification before the first real pilot. Automated tests cover pure
logic (scoring, ranking, HMAC, DTOs, DI graph); **everything below crosses a
real database, Telegram, or Storage boundary and is therefore untested by CI.**

Mark each item `PASS` / `FAIL` / `BLOCKED` and fill in `Actual` when it differs
from `Expected`. Do not start the pilot with a `FAIL` in **AUTH**, **SECURITY**,
or **MIGRATION**.

Environment used: `________________`  ·  Date: `__________`  ·  Tester: `__________`

---

## 0. MIGRATION (do this first, on a restored backup — not on production)

| # | Step | Expected | Result |
|---|---|---|---|
| 0.1 | Take a full database backup | Restorable dump exists | ☐ PASS ☐ FAIL ☐ BLOCKED |
| 0.2 | `psql "$DATABASE_URL" -f backend/scripts/preflight-0004.sql` | Section 1 empty (no duplicate store names) | ☐ PASS ☐ FAIL ☐ BLOCKED |
| 0.3 | If 0.2 lists duplicates, rename/delete extras, re-run 0.2 | Section 1 now empty | ☐ PASS ☐ FAIL ☐ BLOCKED |
| 0.4 | `npm run migrate` | `apply 0004_integrity.sql`, then `migrations done` | ☐ PASS ☐ FAIL ☐ BLOCKED |
| 0.5 | Re-run preflight section 3 | All three objects now exist (`1`) | ☐ PASS ☐ FAIL ☐ BLOCKED |
| 0.6 | Deliberately re-run `npm run migrate` | `skip 0004_integrity.sql` (idempotent) | ☐ PASS ☐ FAIL ☐ BLOCKED |
| 0.7 | App starts | Logs `Backend listening` + `Bot @… started` | ☐ PASS ☐ FAIL ☐ BLOCKED |

> **0.4 aborts by design** if duplicates exist. That is correct behaviour, not a
> bug: it refuses rather than silently renaming a store admins recognise.
> `Actual:` ______________________________________________

---

## 1. AUTH

| # | Case | Expected | Result |
|---|---|---|---|
| 1.1 | Open WebApp from inside Telegram | Loads, feed renders, profile shows your name/store | ☐ PASS ☐ FAIL |
| 1.2 | Open the WebApp URL directly in a browser | Demo mode only; no real data reaches it | ☐ PASS ☐ FAIL |
| 1.3 | `curl $API/lifehacks/feed?categorySlug=it_service` (no header) | `401` | ☐ PASS ☐ FAIL |
| 1.4 | `curl $API/categories` (no header) | `401` | ☐ PASS ☐ FAIL |
| 1.5 | Same with `x-telegram-init-data: garbage` | `401` (invalid signature) | ☐ PASS ☐ FAIL |
| 1.6 | Replay yesterday's captured initData | `401` (expired, >24h) | ☐ PASS ☐ FAIL |
| 1.7 | Valid initData for a Telegram user never onboarded | `401` "User not onboarded" | ☐ PASS ☐ FAIL |

`Actual:` ______________________________________________

---

## 2. INVITES

| # | Case | Expected | Result |
|---|---|---|---|
| 2.1 | Director taps ➕ Продавець | Bot returns a `t.me/…?start=` link | ☐ PASS ☐ FAIL |
| 2.2 | New user opens that link | Onboarding starts (phone → experience) | ☐ PASS ☐ FAIL |
| 2.3 | **Second** user opens the same link | Rejected — already used | ☐ PASS ☐ FAIL |
| 2.4 | Original user re-opens the link | Greeted normally, no duplicate account | ☐ PASS ☐ FAIL |
| 2.5 | Open a link older than 7 days | Rejected — expired | ☐ PASS ☐ FAIL |
| 2.6 | Open a made-up token | Rejected — not found | ☐ PASS ☐ FAIL |
| 2.7 | Seller tries to invite anyone | No invite buttons; API returns `403` | ☐ PASS ☐ FAIL |
| 2.8 | Invited seller's store/region | Matches the inviting director's | ☐ PASS ☐ FAIL |
| 2.9 | Admin with no store opens a director's link | Attached to that store; **role stays MEGA_ADMIN**; link still usable by its real target | ☐ PASS ☐ FAIL |

**2.3 is the race guard** (`consume_invite`). To test concurrency properly, fire
two `/start` calls simultaneously — exactly one user row must be created.
`Actual:` ______________________________________________

---

## 3. USER & ROLES

| # | Case | Expected | Result |
|---|---|---|---|
| 3.1 | Full onboarding | Phone + experience saved; app button appears | ☐ PASS ☐ FAIL |
| 3.2 | Director first login | Store created/claimed, bound to director | ☐ PASS ☐ FAIL |
| 3.3 | Second director claims an owned store | Rejected — "вже має директора" | ☐ PASS ☐ FAIL |
| 3.4 | Create a store whose name already exists | Rejected cleanly (not a 500) | ☐ PASS ☐ FAIL |
| 3.5 | Seller runs `/stats`, `/users`, `/stores`, `/regions` | All refused — admin only | ☐ PASS ☐ FAIL |

`Actual:` ______________________________________________

---

## 4. CASES

| # | Case | Expected | Result |
|---|---|---|---|
| 4.1 | Create a text case in the WebApp | Appears at the top of its category | ☐ PASS ☐ FAIL |
| 4.2 | Create a voice case (mic → record in bot) | Published; audio plays back in the app | ☐ PASS ☐ FAIL |
| 4.3 | Publish with an empty title | Rejected | ☐ PASS ☐ FAIL |
| 4.4 | Open own case | Shows "Це твій кейс"; no take/react buttons | ☐ PASS ☐ FAIL |
| 4.5 | Try to react to your own case (via API) | Rejected | ☐ PASS ☐ FAIL |
| 4.6 | Delete someone else's case as a seller | Rejected — `403` | ☐ PASS ☐ FAIL |

`Actual:` ______________________________________________

---

## 5. ARCHIVE (the behaviour that changed — verify carefully)

Setup: **A** publishes case X · **B** takes X · **B** reports 🔥 success · **A** archives X.

| # | Check | Expected | Result |
|---|---|---|---|
| 5.1 | X in the feed after archiving | Gone | ☐ PASS ☐ FAIL |
| 5.2 | `select status from lifehacks where id = X` | `archived` — **row still present** | ☐ PASS ☐ FAIL |
| 5.3 | `select * from work_items where lifehack_id = X` | B's `success` row still present | ☐ PASS ☐ FAIL |
| 5.4 | `select * from reactions where lifehack_id = X` | Reactions still present | ☐ PASS ☐ FAIL |
| 5.5 | Any work item still `in_work` on X | Moved to `expired` (taker stops being polled) | ☐ PASS ☐ FAIL |
| 5.6 | `/reset` on **A** (the author) | **Refused** — confirmations exist | ☐ PASS ☐ FAIL |
| 5.7 | `/reset` on **B** (the reporter) | **Refused** — B's reported outcomes are evidence | ☐ PASS ☐ FAIL |
| 5.8 | `/reset` on a brand-new account with no activity | Succeeds; `/start` re-onboards | ☐ PASS ☐ FAIL |

`Actual:` ______________________________________________

---

## 6. WORK ITEMS

| # | Case | Expected | Result |
|---|---|---|---|
| 6.1 | Take a colleague's case | Appears in "В роботі" | ☐ PASS ☐ FAIL |
| 6.2 | Take the same case again | Rejected — already in work | ☐ PASS ☐ FAIL |
| 6.3 | Double-tap "Беру в роботу" | Exactly one work item | ☐ PASS ☐ FAIL |
| 6.4 | Two different users take the same case | Both succeed, independent timers | ☐ PASS ☐ FAIL |
| 6.5 | Take your own case | Rejected | ☐ PASS ☐ FAIL |
| 6.6 | Take a 6th case (limit is 5) | Rejected with the limit message | ☐ PASS ☐ FAIL |
| 6.7 | Report a result | Slot freed; feed percentage updates | ☐ PASS ☐ FAIL |
| 6.8 | Report the same work item twice | Second attempt refused, no 500 | ☐ PASS ☐ FAIL |
| 6.9 | Report someone else's work item (via API) | Refused | ☐ PASS ☐ FAIL |
| 6.10 | Answer via the **bot** buttons | Same result as the app — one shared code path | ☐ PASS ☐ FAIL |

**6.10 guards the de-duplication** — the bot now delegates to `WorkItemsService.resolve()`.
`Actual:` ______________________________________________

---

## 7. REACTIONS

| # | Case | Expected | Result |
|---|---|---|---|
| 7.1 | Like a case | Counter +1, button highlighted | ☐ PASS ☐ FAIL |
| 7.2 | Tap like again | Removed (toggle off) | ☐ PASS ☐ FAIL |
| 7.3 | Like then dislike | Switches; **total stays 1** | ☐ PASS ☐ FAIL |
| 7.4 | Reload the app | Highlight state persists | ☐ PASS ☐ FAIL |
| 7.5 | >20 reactions in a minute | Rate-limited with a clear message | ☐ PASS ☐ FAIL |
| 7.6 | `select is_cross_store from reactions` for a same-store like | `false` (weight 0.25) | ☐ PASS ☐ FAIL |
| 7.7 | Same for a different-store like | `true` (weight 1.0) | ☐ PASS ☐ FAIL |

`Actual:` ______________________________________________

---

## 8. FEED & RANKING

Stage is per category, by **confirmed** case count: `<5` → 1, `5–19` → 2, `20+` → 3.

| # | Case | Expected | Result |
|---|---|---|---|
| 8.1 | Pilot start (few confirmations) | Stage 1 — newest case leads | ☐ PASS ☐ FAIL |
| 8.2 | Publish a new case | Appears at/near the top immediately | ☐ PASS ☐ FAIL |
| 8.3 | Archived case | Never in the feed | ☐ PASS ☐ FAIL |
| 8.4 | `GET /lifehacks/:id/quality` | Returns `tier` + `qualityScore` | ☐ PASS ☐ FAIL |
| 8.5 | Case with 0 confirmations | `qualityScore: null`, `tier: NEW` | ☐ PASS ☐ FAIL |
| 8.6 | Tier badge in the app vs the API | Identical (backend is the only source) | ☐ PASS ☐ FAIL |
| 8.7 | Switch tabs repeatedly | Fast; order stable within a cache window (~3 min) | ☐ PASS ☐ FAIL |

`Actual:` ______________________________________________

---

## 9. VOICE (private storage — changed behaviour)

| # | Case | Expected | Result |
|---|---|---|---|
| 9.1 | Play a voice case in the app | Plays | ☐ PASS ☐ FAIL |
| 9.2 | Copy the audio URL, open in a private window | Works while signed (~1h) | ☐ PASS ☐ FAIL |
| 9.3 | Supabase dashboard → bucket `voice-cases` | Marked **Private** | ☐ PASS ☐ FAIL |
| 9.4 | Guess an object URL without a signature | Denied | ☐ PASS ☐ FAIL |
| 9.5 | Reuse a signed URL after ~1h | Expired/denied | ☐ PASS ☐ FAIL |
| 9.6 | `curl $API/lifehacks/<id>/voice` with no `initData` | `401` | ☐ PASS ☐ FAIL |
| 9.7 | Voice case published **before** this change | Still plays (legacy public URL) | ☐ PASS ☐ FAIL |

`Actual:` ______________________________________________

---

## 10. NOTIFICATIONS & WORKERS

| # | Case | Expected | Result |
|---|---|---|---|
| 10.1 | Someone takes your case | "✨ Твій кейс щойно взяли в роботу!" | ☐ PASS ☐ FAIL |
| 10.2 | Someone reports success | "🔥 Твій кейс щойно спрацював…" | ☐ PASS ☐ FAIL |
| 10.3 | Publish a case | Everyone else gets a ping with an "Відкрити BOOST" button | ☐ PASS ☐ FAIL |
| 10.4 | Author receives their own broadcast | No — author is excluded | ☐ PASS ☐ FAIL |
| 10.5 | Set `check_due_at` to the past, wait ≤1 min | Reminder arrives with 4 buttons | ☐ PASS ☐ FAIL |
| 10.6 | Answer it | Outcome recorded; feed updates | ☐ PASS ☐ FAIL |
| 10.7 | **Retry:** set a bad bot token, force a due item, wait, restore token | Prompt is re-sent on a later sweep — not lost | ☐ PASS ☐ FAIL |
| 10.8 | Redeploy while a due item exists | Reminder still fires afterwards | ☐ PASS ☐ FAIL |
| 10.9 | Run any command | Your command message disappears immediately | ☐ PASS ☐ FAIL |
| 10.10 | Wait 5 min after a command | Bot's reply disappears; reminders/alerts do **not** | ☐ PASS ☐ FAIL |
| 10.11 | Trigger a backend 500 | Admin receives a 🚨 alert | ☐ PASS ☐ FAIL |

### Delivery semantics (verify, don't assume)

Reminders are **at-least-once**. The worker claims a row (`check_sent = true`)
before sending and releases the claim on failure, so an outage retries.

A duplicate is possible in one window: Telegram accepts the message but the
response is lost in transit, so the send looks failed, the claim is released,
and the next sweep sends again. This is unavoidable without an idempotency key
Telegram does not offer — **do not describe the system as exactly-once.**
A duplicate reminder is harmless (the first answer resolves the item; the second
prompt then reports "already confirmed"), whereas a lost reminder silently costs
a data point, so the trade-off is deliberate.

`Actual:` ______________________________________________

---

## 11. ADMIN

| # | Case | Expected | Result |
|---|---|---|---|
| 11.1 | `/help` | Grouped list; admin sees the admin section | ☐ PASS ☐ FAIL |
| 11.2 | `/stats` | Counts match reality (spot-check users & cases) | ☐ PASS ☐ FAIL |
| 11.3 | `/users` | Per-user ✍️📌🔥📱 and last-seen | ☐ PASS ☐ FAIL |
| 11.4 | `/stores` | Correct user count per store | ☐ PASS ☐ FAIL |
| 11.5 | `/regions` | Correct user count per region | ☐ PASS ☐ FAIL |
| 11.6 | Tap a store/region with people | Confirmation → then refused ("є користувачі") | ☐ PASS ☐ FAIL |
| 11.7 | Tap an empty one → Скасувати | Nothing deleted | ☐ PASS ☐ FAIL |
| 11.8 | Tap an empty one → Так | Deleted; stale invites cleaned up | ☐ PASS ☐ FAIL |

`Actual:` ______________________________________________

---

## 12. SECURITY (forgery attempts — all must fail)

Capture your own valid `initData`, then try to escalate with it.

| # | Attack | Expected | Result |
|---|---|---|---|
| 12.1 | Edit the `user.id` inside initData | `401` — HMAC breaks | ☐ PASS ☐ FAIL |
| 12.2 | POST a case with `authorId` of another user | Ignored; author = authenticated user | ☐ PASS ☐ FAIL |
| 12.3 | POST `/invites` with `role: MEGA_ADMIN` as a seller | `403` | ☐ PASS ☐ FAIL |
| 12.4 | As a **regional lead**, POST `/invites` with another region's `regionId` | Ignored; scope forced to your own region | ☐ PASS ☐ FAIL |
| 12.5 | Send `audience=newcomer` on the feed request | Ignored; derived from your profile | ☐ PASS ☐ FAIL |
| 12.6 | Resolve another user's work item id | Refused | ☐ PASS ☐ FAIL |
| 12.7 | Archive another user's case as a seller | `403` | ☐ PASS ☐ FAIL |
| 12.8 | POST a result with `outcome: "expired"` | `400` — not a user-reportable outcome | ☐ PASS ☐ FAIL |
| 12.9 | POST a result with `outcome: "hacked"` | `400` | ☐ PASS ☐ FAIL |
| 12.10 | POST a case with a 5000-character title | `400` | ☐ PASS ☐ FAIL |
| 12.11 | Request `/lifehacks/not-a-uuid/quality` | `400` | ☐ PASS ☐ FAIL |

`Actual:` ______________________________________________

---

## Known limitations (accepted for the pilot — not defects to file)

1. **Small samples over-score.** A 1-success/0-fail case scores higher than a
   proven 20/25 one; there is no confidence weighting. The tier gate contains
   it — the lucky case cannot reach TOP (needs ≥10 confirmations) — but it can
   out-rank within GROWING. Revisit only with real pilot data. *(P1)*
2. **`audience` does nothing yet.** It is stored, authenticated and part of the
   cache key, but both audiences get identical ranking. Newcomer bias is a
   future experiment, not a bug. *(P1)*
3. **Reminders are at-least-once**, never exactly-once — see §10.
4. **`/reset` refuses on any real history.** Intentional. Use fresh accounts for
   testing, or archive cases manually first.
5. **No automated integration tests.** Everything in this document is the
   substitute; CI covers only pure logic.

---

## Sign-off

- [ ] Sections 0, 1, 5, 10, 12 all `PASS` (migration, auth, archive, workers, security)
- [ ] No `FAIL` left unexplained
- [ ] Backup verified restorable
- [ ] Rollback commit noted: `____________`

Tester: `______________`  Date: `__________`  Decision: ☐ GO ☐ NO-GO
