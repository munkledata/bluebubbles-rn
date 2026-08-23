# Remediation Plan — BB App 2.0 Gaps & Bugs

_Created 2026-07-30. Companion to [`BB_APP_2.0_COMPARISON_2026-07-30.md`](BB_APP_2.0_COMPARISON_2026-07-30.md)._

> **Superseded 2026-08-04:** [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md) is authoritative.
> Every `0030`–`0035` assignment below is retired planning history, not a migration reservation.
> Future migrations receive the next number only during merge preparation under `MIG-01`.

**73 work items, ~43–58 dev days, in 12 shippable batches + 1 decision-gated batch.** Each item was
planned against the actual current code (not the comparison report alone), then a cross-cluster review
checked all 73 for file conflicts, migration collisions and contradictions.

That review **found a design contradiction between two batches, five under-scoped items, and a
migration collision affecting six items** — all corrected below. §3 lists them, because they're the
part of this plan most likely to bite.

> **How to use this.** Work batches in order; each ships and verifies on its own. Item ids
> (`STICKER-1`) are stable — use them in branches/commits. **Do not read the tier column as a
> priority queue** — see §3.4.

---

## 1. Totals

| Tier | Items | Effort |
|---|---|---|
| 1 — defects & near-free wins | 20 | ~9 d |
| 2 — reliability | 24 | ~17 d |
| 3 — features | 17 | ~19 d |
| 4 — docs & infra | 12 | ~7 d |
| **Total** | **73** | **~43–58 d** (excludes `PUSH-3`) |

Confidence: **50 high, 22 medium, 1 low**. The one low-confidence item (`PUSH-3`) is deliberately
scoped-but-not-scheduled.

---

## 2. Planning changed the report — read this first

### Three corrections to the comparison report

**① Report item (8) "pause the three foreground timers" is largely a NON-PROBLEM.** `LIFE-1` found
that **RN on Android already suspends JS timers when the app backgrounds**. The report inferred a
battery win from upstream having only one `Timer.periodic`; that inference doesn't transfer to our
runtime. What survives is one genuinely screen-scoped network poll worth gating
(`app/(app)/findmy.tsx:48`), plus writing the finding down so nobody "fixes" it again.

**② The report's suggested sticker fix would have introduced two new bugs.** `STICKER-2` rejected
both halves of it:
- *"Teach `parseReactionType` about 'sticker'"* — **don't.** `listReactionsByMessageGuids` selects
  every `associated_message_type IS NOT NULL` row and filters through `parseReactionType`; teaching it
  `'sticker'` puts a glyph-less, un-renderable badge into `ReactionCluster` and the reaction-details
  sheet. `parseReactionType('sticker') === null` is the *correct* boundary and two tests assert it.
- *"Narrow the filter to the reaction types"* — **insufficient.** That lets the sticker row through
  `queryMessageRows`, so it renders **both** as a standalone image bubble **and** as the overlay. The
  predicate must be "types the UI renders as an overlay on the target" — the six tapbacks + `emoji` +
  `sticker` + their `-` forms + the raw numeric Apple codes. Genuinely *unknown* types then fall
  through and render as ordinary messages, which is the actual safety property wanted.

**③ "Save original" in the fullscreen viewer is a non-problem on our server** — dropped from `VIEWER-1`.

### Two new defects the report missed

**④ `LIFE-2` — locally-scheduled messages only fire while the app is in the foreground.** The local
recurring-schedule ticker runs from home mount and each open chat's 20 s interval, but is **not**
drained by the 15-minute background task. A recurring message silently doesn't send unless the app
happens to be open. ~2-3 h.

**⑤ A received sticker is silently saved to the user's photo gallery.** `shouldAutoDownload`
(`src/utils/attachment.ts:107-116`) ignores `isSticker` and `autoDownloadDestination` defaults to
`'album'`, so today the *only* trace of a received sticker is a stray picture in Photos plus a
"Downloaded 1 image to Gator album" toast — while the thread shows nothing. One-line skip, folded into
`STICKER-1`.

### One finding that changes the sticker design

A sticker arriving on the **live** path carries **no attachment row** — the server's live fanout
serializes with `extra = {chats, handle}` only, and `serializeMessage` emits `attachments` only when
`"attachments" in extra`. Our own `src/db/repositories/outgoing.ts:544-546` already documents this. The
attachment lands on the next `ensureChatSynced` (chat open). So the overlay **must tolerate "sticker
exists, image not yet known"** — a LEFT-joined null attachment plus a pending tile in `STICKER-1`,
with fill-in-while-open as a separate conditional item (`STICKER-4`).

**Outgoing stickers are confirmed not implementable** — the server's reaction path rejects a
`"sticker"` tapback outright. Don't scope sending.

---

## 3. Plan defects the review caught

### 3.1 The serious one: `FILTER-1` and `INBOX-2` contradict each other

`FILTER-1` filters **client-side over the already-loaded `InboxRow` array**. `INBOX-1`/`INBOX-2` exist
specifically to make that array a **40-row page**. Both cannot be right.

Post-pagination, filtering for "unread" would search only the first page and confidently show "no
results" for a chat three pages down — **a silent wrong answer, not a visible bug.**

**Resolution: `FILTER-1` moves to Batch 10, strictly after `INBOX-2`, and is re-planned to filter in
SQL against the paged query** rather than over the loaded array. This reverses the comparison report's
advice ("follow upstream, filter client-side"), which was sound only while the inbox was unbounded.
The trade-off the report warned about is real — pushing filters into `listChatsForInbox` touches the
`deleted_at` / `last_read_message_guid` invariants — so `FILTER-1` must add its predicates as
*optional appended fragments* with the tombstone/unread-floor clauses untouched, and extend the
existing inbox tests rather than replacing them.

### 3.2 Migration collision — six items all claimed `0030`

HEAD is at `0029_chats_deleted_at`, so five were wrong. Migrations are never edited once applied, so
discovering this after two branches ran on a dev device means hand-repairing the applied-names table.

**Historical assignment (retired; do not implement these numbers):**

| # | Name | Item | Batch | Note |
|---|---|---|---|---|
| 0030 | `message_part_columns` | `PART-1` | 5 | ALTER `messages`; first because four Tier-1 items block on it |
| 0031 | `message_error_message` | `SEND-2` | 6 | ALTER `messages` — **same table as 0030**, so re-run the full six-site mirror checklist |
| 0032 | `push_retry_queue` | `PUSH-2` | 7 | New table; also add to `clearLocalCache` **and** its test |
| 0033 | `inbox_page_indexes` | `INBOX-1` | 9 | **Must come after `STICKER-2`** — indexes chosen against the pre-`STICKER-2` WHERE clause won't be used by the post-`STICKER-2` query |
| 0034 | `chats_pin_index` | `PIN-1` | 10 | ALTER `chats`; changes the inbox ORDER BY, so either fold into 0033 or accept a follow-up index |
| 0035 | `custom_groups` | `GROUPS-1` | 10 | New tables + links; add to `clearLocalCache` |

Also: `PART-1` and `INBOX-1` both declared the same new test file `test/db/migrations0030.test.ts`,
whose name encodes an ordinal that was about to change. **Rename to
`test/db/migrations/<migration_name>.test.ts`** — one file per migration, named for the migration, not
its number.

### 3.3 Five under-scoped or double-booked items

| Item | Problem | Fix |
|---|---|---|
| `SEND-3` | Creates `src/services/notifications/activeChat.ts`, which `ACTIVE-1` also creates, with **no declared dependency**. Also creates `src/services/send/sendFailureNotice.ts` **and** `src/utils/sendFailureNotice.ts` — same basename, and AGENTS.md already records tsc rejecting case-colliding siblings on macOS | `ACTIVE-1` **owns** `activeChat.ts`; add `SEND-3 → ACTIVE-1` as a hard dependency; collapse the two same-named files into one |
| `CA-2` | File list omits the actual module `src/native/certPinning.ts` **and** its only caller `src/services/certPins.ts` — the plan as written orphans two files | Add both; estimate stays ~1.5-2 h |
| `REDACT-1`, `REDACT-2`, `DOC-1` | All budget substantial test time in their estimates but **declare no test files** (`REDACT-1` costs "≈1-1.5 h the components sweep block including getting the four new mocks right" with an empty file list) | Name the test files before starting; they're the deliverable that proves the defect is fixed |
| `LIFE-1` | Over-scoped against its own conclusion — it's titled "FINDING: the problem isn't real", then creates four files and edits the 882-line chat screen to gate one 60 s poll | Shrink to the one-line gate on `findmy.tsx:48` + the AGENTS.md note |
| `INBOX-5` | Its main justification is admitted-unverified ("I inferred it from the code"). AGENTS.md records **two** previously-shipped wrong device-bug diagnoses on exactly this kind of inference | **Get a screen recording first.** No flash → drop to the size collapse, or drop the item |

### 3.4 Tier is not a schedule

Three chains put Tier-1 items behind lower-tier foundations. Anyone treating the tier column as a
priority queue will try to start four items that cannot be started:

- `PART-2/3/4/5` (tier 1) all sit behind `PART-1` (tier 2)
- `NOTIF-3` (tier 1) sits behind `NOTIF-2` (tier 3, 1-1.5 d)
- `INBOX-1` (tier 2) sits behind `INBOX-0` (tier 4)

**Batch order in §4 is the schedule. Tier is only severity.**

### 3.5 Hot-file serial orders — never parallelise these

| File | Lines | Required order |
|---|---|---|
| `src/db/repositories/chats.ts` | 1109 | `STICKER-2` → `INBOX-1` → `PIN-1` → `HANDLECOLOR-1` → `GROUPS-1` |
| `app/(app)/chat/[guid].tsx` | 882 | `ACTIVE-1` → `LIFE-1` → `PART-4` → `PART-5` → `VIEWER-2`. **Defer `THEME-1`'s optional chat-level StatusBar and `SEND-4` entirely** |
| `src/db/repositories/outgoing.ts` | 965 | `PART-3` → `PART-5` → `SEND-2` |
| `src/services/notifications/notifeeService.ts` | — | `NOTIF-1` → `NOTIF-2` → `NOTIF-3`; `SEND-3` wholly before or after, adding a **separate exported function** |
| `src/services/notifications/intents.ts` | — | `STICKER-2` → `STICKER-3` → `ACTIVE-1` → `NOTIF-3` |
| `src/ui/conversations/ConversationListScreen.tsx` | 476 | `CONN-3` → `CONN-4` → `INBOX-2` → `FILTER-1` → `GROUPS-2` |
| `src/core/reactions/reactionType.ts` | — | `STICKER-1` → `STICKER-2` → `PART-1` |
| `src/ui/conversations/MessageBubble.tsx` | 466 | `STICKER-1` → `PART-1` → `ENTITY-1` |
| `src/services/backup/backupSchema.ts` | — | `BACKUP-IDENT-1` → `GROUPS-3` → `HANDLECOLOR-1` → `THEME-2`. **One author owns the schema version bump** — two independent "version 2"s are incompatible |
| `AGENTS.md` | 907 | Seven items append bullets; `DOCS-2` dissolves the file. **`DOCS-2` goes strictly last** |

`chats.ts` is a **structural** risk, not just a merge risk: a mis-merge in that SQL is a silent wrong
answer (stale preview, phantom unread badge, permanently hidden chat), and AGENTS.md documents that
these exact predicates already produced three device-only bugs.

### 3.6 Smaller corrections

- **`BACKUP-1` id collision** — two different items shared it. Renamed **`BACKUP-IDENT-1`**
  (participant identity) and **`BACKUP-SLOTS-1`** (server slots). `GROUPS-3` depends on
  `BACKUP-IDENT-1`.
- **`GROUPS-1`'s `forget()` decision has an unowned consequence.** It wipes `custom_groups` on
  Disconnect, so the Disconnect copy must name them — but `GROUPS-1` doesn't touch `settings.tsx`.
  **`GROUPS-2` owns that copy edit**, so it ships with the visible feature; if `GROUPS-1` lands alone
  the wipe is live and the dialog lies.
- **`SEND-1`'s 20 s FIFO cap vs `OUTGOING_GRACE_MS`.** `runOutgoingQueue` skips fresh rows because "a
  just-inserted row is assumed owned by the live UI send". A FIFO holding a send un-POSTed for up to
  20 s stretches that ownership window — **if the grace window is shorter than the FIFO cap, a
  background drain can steal a row the FIFO still owns.** Verify the two constants against each other.
- **`INBOX-2`'s progressive first paint may false-trigger the inbox re-land loop.** The screen arms a
  scroll-to-top window on a rise in `newestDate` over *visible* rows, and `useReactiveQuery`
  deliberately keeps the previous deps' data across a deps change. Growing the limit changes deps.
  `INBOX-2` must state explicitly how first paint interacts with the re-land loop *before* `FILTER-1`
  layers on top.
- **Three PRIVACY toggles are being designed independently** (`SEC-1` block-screenshots, `DIAG-1`
  error-reporting, `REDACT-1` Find My row). Individually defensible; collectively you get three
  orthogonal switches with unresolved interactions. Decide the section's shape once.
- **~19 items add a barrel export line.** Noisy git conflicts, zero semantic risk — a mis-merge is a
  compile error. Resolve mechanically, run `typecheck` after each merge.

---

## 4. The batches

### Batch 1 — The three defects + cheapest wins · 4.5-6 d
`STICKER-1` `STICKER-2` `STICKER-3` `DOC-1` `DOC-2` `DOC-3` `REDACT-1` `REDACT-2` `REDACT-3` `CAM-1` `THEME-3` `THEME-1`

All three defects ship first, plus wins that touch almost nothing. `DOC-2` (remove `file` from the
`safeOpenUrl` allowlist) is the real guard — it makes the class of bug impossible rather than fixing
one instance. `THEME-3` ships here so `THEME-2` won't have to rework it.

**Device verification is mandatory**: a real received sticker, a real received PDF, a Find My
screenshot under redacted mode. Two of these three bugs shipped *because* a mocked test passed.

### Batch 2 — The one native-rebuild batch · 1.5-2 d + one rebuild ⚙
`SEC-1` `CA-1` `CA-2`

Clustered so the ~30-45 min build cycle is paid once (EAS cloud builds are exhausted until Aug 1 —
build locally, ~4 GB free RAM needed). `CA-1` adopts **only** the user-CA half of upstream's TLS
behaviour; their blanket self-signed acceptance is a real MITM hole and is **not** being copied.

### Batch 3 — Connection visibility + active-chat suppression · 2-2.5 d
`CONN-1` `CONN-2` `CONN-3` `ACTIVE-1` `CONN-4`

Immediately demoable (kill the server, watch the bar change). `ACTIVE-1` lands here because it
establishes `activeChat.ts`, which `SEND-3` needs in Batch 6.

**`ACTIVE-1` must be a plain module, not a hook or React store read** — the notify path also runs
headless (killed-app FCM wake, no React tree), and the headless default must be safe.

### Batch 4 — Notification stack + per-message withdrawal · 2.5-3 d
`NOTIF-1` `NOTIF-2` `NOTIF-3`

A strict chain shipping as one batch: `NOTIF-2` restructures `displayNotification` into read-back-and-
merge, and `NOTIF-3` depends on the history it introduces. `NOTIF-2` is what lets us withdraw a single
unsent message instead of cancelling the whole chat's notification.

Put the value in a **pure merge function** with a table-driven test; the notify-kit calls are thin.
Watch: read-back-then-post races if two pushes land together, and `hidePreview` must be honoured on
**every appended line**.

### Batch 5 — Part index end to end · 2-2.5 d · migration 0030
`PART-1` `PART-2` `PART-3` `PART-4` `PART-5` `PART-6`

Best ratio of Tier-1 fixes to foundation work: `PART-1` is tier 2 but unlocks four tier-1 correctness
fixes. This is the **cheap 80%** — thread a real index through the four call sites; do **not** build a
full `MessagePart` model.

The resolver is deliberately **strict** (returns `0` when `partCount` is unknown), so a chat not
opened since the upgrade behaves exactly as today until its next sync. `PART-4` deliberately does
**not** loop-retract every part on a multi-part unsend — a mid-loop failure would leave a
partially-retracted message while the compare-and-set revert clears the local tombstone: worse than
the current mislabel.

### Batch 6 — Send reliability + lifecycle honesty · 3.5-4.5 d · migration 0031
`SEND-1` `SEND-2` `SEND-3` `LIFE-2` `DIAG-1` `LIFE-1`

`SEND-1` follows Batch 5 so `partIndex` is already threaded through `outgoingQueueService` before a
FIFO wraps it. **The hazard: if the FIFO holds a send while the 20 s ticker drains the same row, you
have two senders for one message.** Any new caller of `resendOutgoingRow` must claim first, and the
claim + `markOutgoingSending` must flip in **one transaction**. The FIFO sits *in front of* the durable
queue — it does not replace the leases or reconcilers.

### Batch 7 — Durable push retry · 1.5-2 d · migration 0032
`PUSH-1` `PUSH-2`

Cloned from the proven `outgoing_queue` / `error_reports` lease-backoff-attempt-cap template.

**Be honest about the ceiling.** `PUSH-2` can only act if our JS ran *and threw*. Two failure modes
stay uncovered and neither is reachable from JS: the headless task being killed mid-delivery (no throw
happens), and **Android never starting our process at all** — which is the symptom actually recorded
in `docs/PUSH_DELIVERY.md` §3a. Ship it anyway: **its device receipts are the entry criterion for
deciding whether `PUSH-3` is worth anything.**

### Batch 8 — Sync recovery toolkit · 3.5-4.5 d
`SYNC-1` `SYNC-2` `SYNC-3` `SYNC-4` `SYNC-5` `SYNC-6`

Almost fully self-contained and shares no hot file with the inbox or send work, so it can slot in
wherever capacity allows. Today a bad local cache has **no recovery short of Disconnect**, which
destroys pins, wallpapers, per-chat themes, reminders and drafts our backup doesn't export.

The engine is already a superset of upstream's on correctness (session-epoch binding,
`awaitSyncIdle`, an existing `shouldAbort` hook) — **only the entry points are missing.**

`SYNC-6` **must** respect the tombstone rules: `deleted_at` does two jobs (hides the chat *and* floors
the unread count), and whoever drops the stamp must hand the floor to the read marker in the same
statement. Deliberately **no purge-then-repage** in v1.

### Batch 9 — Inbox query cost · 5-6.5 d · migration 0033
`INBOX-0` `INBOX-1` `INBOX-2` `INBOX-3` `INBOX-4` `INBOX-5`

**The least parallelisable batch in the plan** and the hardest to verify — three of the four largest
items concentrated on `chats.ts`, `useChats.ts`, `ConversationListScreen.tsx` and `useReactiveQuery.ts`.

`INBOX-0` first is not ceremony: its whole point is a baseline, and landing `INBOX-3` first destroys
the measurement `INBOX-0` exists to capture. `INBOX-4` records a deliberate **no** to a denormalized
latest-message cache — tombstones, retractions and reactions all affect our preview, and the filters
must stay consistent with `chatVisible`. Write the "no" down so it isn't re-litigated.

`INBOX-3` must not break liveness — the write→flush is what makes reactive queries fire at all.

### Batch 10 — Organisation · 7-8.5 d · migrations 0034, 0035
`PIN-1` `BACKUP-IDENT-1` `FILTER-1` `GROUPS-1` `GROUPS-2` `GROUPS-3`

**Must come after Batch 9, not before** — see §3.1. `FILTER-1` is re-planned to filter in SQL against
the paged query.

`BACKUP-IDENT-1` fixes a **live defect**: `chatCustomizations` rows are keyed by chat guid, which is
server-specific, so restoring onto a rebuilt Mac silently applies nothing — or applies to the wrong
conversation. It's also a prerequisite for `GROUPS-3` to mean anything.

`GROUPS-1` membership rewrites must follow **ADD-THEN-PRUNE** — never truncate-then-refill; each
statement commits and flushes the reactive queries, and the empty intermediate state *is* rendered and
acted on.

### Batch 11 — Theme axis, linkification, viewer, backup slots · 8-10 d
`THEME-2` `THEME-4` `ENTITY-1` `VIEWER-1` `VIEWER-2` `HANDLECOLOR-1` `BACKUP-SLOTS-1`

All independent of each other by this point. **`THEME-4` (make light mode shippable) means authoring
and auditing a real light preset** — design work, not plumbing. Be honest about that before starting
`THEME-2`.

`ENTITY-1` skips ML Kit deliberately. **Hold the address detector for v2** — highest false-positive
risk, lowest frequency; a wrong phone-number match on ordinary digits is worse than no linkification.

`BACKUP-SLOTS-1`'s server half already exists — we post ciphertext as-is, getting named multi-device
slots **without** giving the server readable settings. `HANDLECOLOR-1` also fixes a latent bug: a sync
would currently **wipe** per-handle colours.

### Batch 12 — Docs restructure + CI gates · 5-6 d · MUST BE LAST
`DOCS-1` `DOCS-5` `DOCS-6` `DOCS-3` `DOCS-4` `DOCS-7` `DOCS-2`

`DOCS-2` dissolves `AGENTS.md` into 33 per-directory files while **seven earlier items append bullets
to it** (`REDACT-3`, `SEC-1`, `LIFE-1`, `PART-6`, `INBOX-4`, `CA-2`, `DOCS-5`). Scheduling this batch
anywhere but last means every one of those bullets lands in a file that no longer exists. `DOCS-2`'s
relocation stage must also **re-grep for bullets added since it was planned**.

Measured: `AGENTS.md` is **907 lines / 88.8 KB**, and the UI-gotchas section alone is **lines 142-794
— 653 lines, 72% of the file**, covering four distinct concerns.

**The non-negotiable constraint: `DOCS-2` is a VERBATIM RELOCATION, staged.** Upstream's per-directory
files are inventories; ours are root-caused trap logs with the failure mode, the wrong diagnosis that
preceded it, and the test that locks it. **Summarising them destroys the asset.** Move bullets next to
the code they guard; don't rewrite them.

`DOCS-1` ships **first in the batch** so the link-check and context budget are enforced *while* the
split happens. It exists because a written staleness rule is provably insufficient — upstream's own
rule failed in three checkable places in shipped 2.0, and ours has the same rot.

`DOCS-5` measured our real coverage: **statements 81.55 / lines 84.22 / functions 77.35 / branches
75.79**, well above the documented 70. Proposed gate **78 / 80 / 74 / 72** — setting it at 70 would
permit an 11-point silent regression, which is most of what the gate is for.

### Batch 13 — Decision-gated: do NOT schedule ⚙
`PUSH-3` `SEND-4` `NOTIF-4` `STICKER-4`

Four items that shouldn't enter a sprint until someone answers a question. See §5.

---

## 5. Decisions that block work

**① `PUSH-3` — don't schedule it, and possibly don't do it.** Low confidence, 3-5 d, and all three
open questions are blocking: can our `FirebaseMessagingService` coexist with RNFB's, or must RNFB's
registration be suppressed (module vs fork — this alone determines the estimate)? Is the failure class
even real for us, given upstream's justification is Flutter *engine*-boot failure while our JS already
runs inside the RNFB headless task? And **would a foreground service (report item ⑧) be a better use
of the same effort**, since it addresses the "Android never started the process" class `PUSH-3` cannot
touch? **Recommendation: ship `PUSH-2`, read its receipts, then decide.**

**② `CA-2` — remove the dead pinning module, or wire a UI?** Recommend **remove**. Wiring it pins REST
only while the socket and every attachment transfer stay unpinned, and a stale pin against a rotating
Let's Encrypt cert bricks connectivity until app data is cleared. Today `setCertPins` has no caller, so
it reads as a security control that does nothing.

**③ `STICKER-4` rests on an unverified premise** — whether the deployed prod server matches the source
that was read. Everything else in the sticker cluster is locally verifiable; this one needs the Mac
mini. **Do the device check before committing it to a batch**, or it's half a day that discovers it was
unnecessary.

**④ `SEND-4` and `NOTIF-4`** — both plans recommend **deferring**. `NOTIF-4` (mirror an inline reply
into the notification thread): today's cancel is probably right. `SEND-4` (cancel everything sending in
a chat): if you do want it, don't let the button's label and behaviour disagree.

**⑤ `THEME-4` — one light preset or two?** Recommend **one** ("iOS Light"); "Bright White" differs only
in `groupedBackground` and doubles the audit for no visible gain.

**⑥ `DOCS-7` — `OLD_APP_PARITY_AUDIT.md` is 250 KB and superseded twice.** Archive (recommended — it's
provenance) or delete? And do you want `docs/archive/` in-repo at all?

Two more that change user-visible behaviour: should Redacted Mode imply Block Screenshots (`SEC-1` —
recommend **no**, keep them orthogonal), and should Custom Groups survive `forget()` (`GROUPS-1` —
recommend **wiped**, since a group name can carry contact identity, which then requires the Disconnect
copy update owned by `GROUPS-2`).

---

## 6. Sequencing

```
Wk 1     B1  defects + cheap wins        4.5-6 d  ──► ship
Wk 2     B2  native rebuild ⚙            1.5-2 d  ──► ship
         B3  connection + active-chat    2-2.5 d  ──► ship
Wk 3     B4  notifications               2.5-3 d  ──► ship
         B5  part index        (0030)    2-2.5 d  ──► ship
Wk 4     B6  send reliability  (0031)  3.5-4.5 d  ──► ship
Wk 5     B7  push retry        (0032)    1.5-2 d  ──► ship
         B8  sync recovery            3.5-4.5 d  ──► ship
Wk 6-7   B9  inbox cost        (0033)  5-6.5 d   ──► ship
Wk 8-9   B10 organisation  (0034,0035) 7-8.5 d   ──► ship
Wk 10-11 B11 themes/entities/viewer     8-10 d   ──► ship
Wk 12    B12 docs + CI  (must be last)  5-6 d    ──► ship
         B13 decision-gated — not scheduled
```

**Two deviations worth considering.** `DOCS-1` + `DOCS-5` (~5 h) are cheap CI gates that make every
later batch safer — worth pulling into Week 1, keeping only `DOCS-2` at the end. And if the priority is
de-risking agent-assisted work, `DOCS-2` could move earlier *provided* the seven AGENTS.md-appending
items are told to write into the new structure instead.

**Every batch ends with `npm run typecheck && npm test`**, plus the device pass named in each item. For
anything touching notifications, push, or file intents, jest genuinely cannot prove it — the device
steps *are* the verification, not a formality.
