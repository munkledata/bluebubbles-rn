# Reliability hardening — historical status, 2026-07-26

> **STATUS (2026-08-27): HISTORICAL IMPLEMENTATION NARRATIVE.** This file preserves the
> July 2026 incident and remediation sequence; it is not a current work tracker or subsystem
> authority. Use `docs/WORK_PLAN_2026-08-03.md` for open status and `AGENTS.md` plus
> `docs/README.md` to locate current contracts and runbooks.

Where this work started, what shipped, and what is still only provable on a device.

Two companion documents preserve the dated supporting detail:

- `docs/STATE_AUDIT_2026-07-25.md` — the two reported UI bugs and the app-wide React/state audit.
- `docs/DB_WRITE_SAFETY_AUDIT_2026-07-25.md` — every DB write path, audited for races and lost updates.

This file is the map: what was done, in what order, and what a reader should NOT assume is settled.

---

## 1. How it started

Two symptoms, reported from daily use:

1. On the Messages screen, chat titles sometimes flicked to phone numbers and back.
2. The inbox did not reliably land on the newest conversation when a message arrived.

Both turned out to be surface symptoms of one underlying pattern, which then justified a full audit of
the write layer. That pattern is stated once, at the end of this file, because it explains most of what
follows.

## 2. What shipped

### Phase 1 — the two reported bugs, plus a state audit (15 items)

**Name flicker.** `upsertChats` rebuilt participant links by deleting them for every chat in the loop and
re-inserting only after the loop finished, so an entire 200-chat sync page was participant-less at once.
A chat with no participants has no name to render and falls through to `chat_identifier` — the raw phone
number. Now add-then-prune: resolve the links, insert, then delete only who actually left. The same shape
was fixed in `upsertContacts`, which truncated the whole contacts table before refilling it row by row.

This was never only cosmetic: with "Filter Unknown Senders" on, `chatHasKnownSender` answered "unknown"
during the window and the notification was dropped for good.

**Inbox scroll.** The trigger required the top chat to change *identity*, so the most common case in the
world — the conversation already at the top receiving another message — never scrolled. Pinned chats
could not trigger it at all. It now converges the way `MessageList` already did: a non-animated scroll,
re-issued until the user takes over, keyed on the newest timestamp across all visible rows.

The other 13 items are in the state audit doc.

### Phase 2 — DB write-safety audit (27 items, D1–D16 / P1–P11)

Every write path in `src/db/repositories/**` was audited for races, lost updates and conflict clobber.
The findings worth knowing about, all fixed:

- **"Try Again" could deliver a message twice.** The retry sheet held a frozen snapshot and deleted the
  queue row a live POST was holding, then re-sent under a new temp id — defeating the server's
  idempotency, which is keyed on exactly that id.
- **An unsent message could come back with its text.** Four monotonic date columns were plain-overwritten
  on conflict, so a sync page fetched before a retraction and landing after it cleared the tombstone.
- **`forget()` left the whole local database.** Reconnecting to a different server showed the previous
  account's conversations interleaved with the new ones.
- **Deleting a conversation destroyed your customisations** and the conversation came back anyway.
- Plus the read-marker regressions, the scheduled double-send, and the queue lease holes.

### Phase 3 — three adversarial review rounds

Each round reviewed the *previous* round's output, because the fixes themselves kept introducing defects.

| Round | Findings | HIGH | Character |
|---|---|---|---|
| 1 | 27 | 6 | Regressions from the audit fixes (a sync transaction wide enough to swallow unrelated writers; `startSync()` returning the background run so the real sync never ran) |
| 2 | 27 | 6 | Regressions from round 1's repairs (the tombstone's un-hide rule disagreeing with the render rule) |
| 3 | 15 | 4 | Mostly coverage gaps and stale docs — the rate finally fell |

Round 3 deliberately changed *how* it searched, because rounds 1 and 2 both organised by subsystem and
file and were therefore blind to the same things twice. Its five lenses were: end-to-end user journeys,
the modules the audit admitted it never examined, the real migration upgrade path, mutation-auditing the
test corpus, and regression against the invariants in `AGENTS.md`. Every HIGH it found was invisible from
a per-file angle — most clearly the same-server reconnect bug, where every individual file is correct.

## 3. Schema changes

Two additive migrations, appended by name, mirrored into `schema.ts`:

- `0028_chats_marked_unread_at` — so a deliberate "Mark as Unread" is distinguishable from "never read".
  Kept OUT of `upsertChats`' conflict set; that exclusion is what protects it from the server.
- `0029_chats_deleted_at` — the chat tombstone, so deleting a conversation survives the next sync instead
  of being undone by it, and stops destroying pins, custom names, themes and wallpapers.

`deleted_at` does two jobs — it hides the chat AND floors the unread count. When the tombstone is retired
(real new activity arrived), the floor is handed to the read marker, which is the mechanism designed to
hold a "read up to here" position. Losing sight of that dual role caused a defect in round 2; it is now
stated in `AGENTS.md`.

## 4. Verification

```
npm run typecheck   → clean
npm test            → 308 suites, 2478 tests   (baseline before this work: 288 / 2192)
npm run lint        → 0 errors
```

**Read the test numbers carefully.** A green suite was true at every point in this work, including at the
two moments when a review round was about to find six HIGH defects. Tests written alongside their own fix
encode the same blind spot as the fix. From round 3 onward every added test was mutation-checked — break
the source, confirm the test *fails*, restore — and four load-bearing behaviours turned out to have tests
that could not fail at all, including two revert branches that were "covered" by tests exercising only
the neighbouring path.

If you add to this area, mutation-check the test. It is the single highest-value habit this work produced.

## 5. What is NOT settled — device only

None of the following can be answered by the test suite. Repro steps are written into the relevant test
file headers.

1. **Inbox scroll** — scroll down, have someone send a SHORT (one-line) message to a chat below the fold.
   It must land on row 0 and stay. A one-line message is a pure reorder with no content-height change,
   which is exactly the case the jest mock cannot reproduce (it renders a plain `View`, so FlashList's
   `maintainVisibleContentPosition` correction — the thing the fix is racing — does not exist there).
2. **The name flicker** — pull to refresh repeatedly on an account with 100+ chats.
3. **`forget()`** — disconnect mid-sync, reconnect, confirm the inbox starts empty and repopulates.
4. **Same-server reconnect** — disconnect during a large first sync, reconnect to the SAME server, and
   confirm the new session actually syncs (this was the round-3 HIGH).
5. **Migration upgrade** — install over an existing 0.1.31 install rather than a fresh one, and confirm
   pre-existing chats behave correctly with the two new columns NULL.
6. **Clock skew** — the tombstone is stamped from the device clock but compared against server-supplied
   message dates. The server-ahead direction is floored; the device-ahead direction is not, and is not
   closable without server time. Measure the real skew before deciding whether it matters.
7. **Killed-app paths** — verify with `adb shell am kill <pkg>`, NEVER `am force-stop` (see `AGENTS.md`
   for why force-stop makes push bugs look unreproducible).

## 6. The pattern worth keeping

Nearly everything above is one mistake wearing different hats:

> **If a write depends on a condition, put the condition IN the write.**
> `UPDATE … WHERE id = ? AND status = 'error' RETURNING id` — not SELECT, check in JavaScript, then
> UPDATE. Anything that changes in between is invisible to you.

And its twin, which is specific to this codebase because every write commits individually and wakes every
reactive reader:

> **Never make the world wrong on the way to making it right.**
> Add first, prune second. "Delete everything then re-insert everything" is never safe here — the UI sees
> the empty middle, and a transaction does not hide it, because reads go through the same connection.

Both are now in `AGENTS.md`, along with the `withDbTransaction` contract (a process-wide mutex whose
nesting failure mode is a permanent, silent hang) which had ~16 call sites and zero documentation.
