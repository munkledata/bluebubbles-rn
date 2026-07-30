# BlueBubbles App 2.0 vs Gator RN — Feature & Architecture Comparison

_Produced 2026-07-30. Upstream reference: **BlueBubbles app `v2.0.0+89` (stable)**, released
2026-07-24 — the "8-month full rewrite". Compared against **Gator RN** at `master` (0.1.37)._

> **Plain-English summary of what this document is.** The Flutter app we forked from just shipped a
> near-total rewrite (2.0). This report answers two questions: *what can their app do that ours
> can't*, and *what did they build structurally that's smarter than what we built*. Every claim
> about our own code was checked by reading our code, and every "we're missing this" claim was then
> re-checked by a second reviewer whose job was to prove it wrong.

---

## 1. Bottom line

**On features that matter day to day, we are much closer to 2.0 than the size difference suggests**
(their `lib/` is 122k lines across 570 Dart files; our `src/` + `app/` is 41k lines across 351 TS
files). Several 2.0 *headline* features — per-chat themes, per-chat backgrounds, a theme authoring
studio, a swipeable image gallery — we already shipped independently.

**On engineering rigour we are ahead, decisively and measurably.** Their own docs state it plainly:
*"No automated test suite. Verify changes by running the target platform."* They have no `test/`
directory, no crash reporting, no database encryption, and they put the server password in the URL
query string of every request. We have 316 test files, SQLCipher-encrypted storage, a durable send
queue, and an error-report upload pipeline.

**Three things are genuinely worth taking from them**, in priority order:

1. **Their documentation architecture** — a 2.2 KB always-loaded router that fans out to 96
   per-directory docs on demand. Ours is an 89 KB monolith loaded into *every* session. Their
   *content* is thinner than ours; their *loading strategy* is strictly better.
2. **OS-owned retry for push events** — they wrap every incoming push in an Android WorkManager job
   with exponential backoff (~5-minute retry window). This is precisely the mitigation for the
   unresolved killed-app notification miss recorded in our own `docs/PUSH_DELIVERY.md` §3a.
3. **Custom Groups + chat filtering** — the flagship 2.0 organisation feature, and we have no
   equivalent grouping axis beyond pinned/archived/unknown-sender.

**Three genuine defects in our app** surfaced that are not "missing features" but bugs, and all
three are invisible to our green test suite:

- **Received stickers render nowhere at all.** Our chat query filters `associated_message_type IS
  NULL`, which correctly hides reactions but silently swallows stickers too.
- **Received PDFs/documents cannot be opened.** We hand Android a `file:///data/user/0/...` path it
  is forbidden to pass to another app; the exception is swallowed, so the tap does nothing.
- **Redacted mode leaks Find My coordinates.** We mask the marker's *name* but still plot the real
  location — the exact scenario redacted mode exists for.

---

## 2. How this was produced

- Upstream source: `git worktree` at tag `v2.0.0+89` (detached), so your working clone on
  `development` was untouched.
- 12 agents, one per feature/architecture dimension, each read **both** codebases. Upstream ships
  96 per-directory `CLAUDE.md` files plus 7 narrative architecture docs, which made authoritative
  comparison possible rather than guesswork.
- Every `rn_missing` / `rn_partial` claim (153 of them) then went to an **adversarial verifier**
  instructed to *refute* it — searching our repo at least three ways, accounting for our different
  naming (`conversation_view`→`chat`, `chat_creator`→`new-chat`, `skin`→`preset`).
- **Result: 150 confirmed, 3 adjusted, 0 refuted.** The three corrections are applied below.
- Cost: 15 agents, ~3.0M tokens, 1,360 tool calls, 0 errors.

**Corrections the verifier forced** (already reflected in all tables):

| Claim | Was | Now | Why |
|---|---|---|---|
| Multi-dimensional chat filters | missing | **partial** | `filterUnknownSenders` is a real persisted filter, plus two dedicated filtered routes. 4 of 5 dimensions absent, but not zero. |
| Send your current location | missing | **partial** | *Sending* is absent, but *receiving* is implemented end-to-end (`text/x-vlocation` → `LocationCard` → `geo:` intent). |
| GIF / sticker picker | missing | **different** | The capability exists via Gboard's own picker, which only works because of our native `gator-paste-input` receive-content module. What's absent is an *in-app* search UI. |

### Scope rules applied

Desktop-only (Windows/Linux/macOS), web, iOS-platform, and the Material/Samsung **skins** were
**not** counted as gaps — we are deliberately Android-only and iOS-styled. Upstream's multi-platform
tax (the `io/` vs `html/` model duplication, `universal_io`, a `Platform.isLinux` bypass around its
security wrapper) is complexity we correctly do not carry.

---

## 3. Scoreboard

243 capabilities compared across 12 dimensions:

| Verdict | Count | Meaning |
|---|---|---|
| `rn_missing` | **85** | They have it, we have nothing |
| `rn_partial` | **67** | We have some of it |
| `rn_ahead` | **57** | We have it, they don't (or ours is better) |
| `rn_different` | **24** | Both solved it, different shapes — not a gap |
| `rn_equivalent` | **10** | Parity |

By severity, gaps only (`missing` + `partial`):

| Severity | Count |
|---|---|
| High | **11** |
| Medium | **73** |
| Low | **68** |

And note the other direction: **11 of our `rn_ahead` rows are high-severity** — encryption at rest,
durable send queue, app-lock key custody, credential storage, auth transport, sync-run safety,
retry idempotency, accessibility labelling, and having a test suite at all.

---

## 4. What 2.0 actually is

Worth being precise, because "2.0" is mostly an *architectural* release. The diff from `v1.15.0+70`:

```
676 files changed, 88,459 insertions(+), 40,577 deletions(-)
358 new Dart files
```

Four directories are **brand new** — they did not exist in 1.15 at all:

| Directory | 1.15 | 2.0 | What it is |
|---|---|---|---|
| `lib/services/isolates/` | 0 files | 5 | Background-thread workers |
| `lib/services/backend/interfaces/` | 0 | 15 | Thread-routing layer |
| `lib/services/backend/actions/` | 0 | 15 | Pure DB operations |
| `lib/app/state/` | 0 | 8 | Observable state mirrors |

That four-layer split **is** the rewrite, and it's the source of the "Major Performance
Improvements" and "Reduced Battery Consumption" claims. New dependencies confirm the feature
headlines: `passkit`+`passkit_ui` (Apple Wallet passes), `klipy_flutter` (replacing `giphy_get`),
`google_mlkit_entity_extraction`, `flutter_markdown_plus`, `dice_bear`, `get_it` (they moved *off*
pure GetX), `native_dio_adapter`, `flutter_user_certificates_android`.

---

## 5. Architecture, side by side

### 5.1 The core trade-off: in-memory mirror vs database-as-truth

This is the single biggest structural difference between the two apps.

| | **BlueBubbles 2.0** | **Gator RN** |
|---|---|---|
| Source of truth | ObjectBox, but read **once** at startup | Encrypted SQLite, re-read on every write |
| UI reads from | `ChatState`/`MessageState`/`HandleState`/`AttachmentState` — ~2,100 lines of per-field observables mirroring each DB row | `useReactiveQuery` re-running real SQL |
| DB watchers | Exactly **one**, on the chat *count* | Every write to a watched table |
| Write path | Services call `update*Internal()` setters only, after a confirmed DB write; equality-checked before assigning | DB write → op-sqlite reactive flush → query re-runs |
| Chat list | In-memory `_sortedChats`, repositioned by **binary search**; UI signalled by an `RxInt chatListVersion` (immediate for a new message, debounced 250ms for bulk, **not bumped at all** if the sort position didn't move) | `listChatsForInbox` — a CTE plus six correlated sub-selects per chat, no `LIMIT`, re-run 24ms after any write |
| Rebuild granularity | ~528 fine-grained `Obx()` scopes; an unread badge changing does not re-render the avatar | `React.memo` rows with stable callbacks (documented in our AGENTS.md) |
| Cost of a new message to the list | **Zero DB reads** | Full inbox query re-execution |

**Verdict: don't adopt their architecture, adopt two pieces of it.** Their in-memory mirror
reintroduces a second source of truth — the exact class of bug our DB-as-truth rule exists to
prevent, and it costs them 2,100 lines plus the discipline of hand-mirroring every displayable
field into two places (ADR-005 admits this: *"Adding a new displayable property means adding it to
both the entity and the state class"*). What is worth taking:

1. **Bound the inbox query** — a covering index plus a `LIMIT`. Our query is unbounded.
2. **Classify the debounce** — immediate for a new message, debounced with a max-wait for a sync
   burst. Ours is one flat resetting debounce, so a sync burst re-runs the query dozens of times.

Also note their honesty in ADR-010: their frame-aware `setState` deferral was **removed** as dead
code and *nothing replaced it*. They flag that jank mitigation as no longer present.

### 5.2 The isolate / interface / action pattern

Their headline structural idea. Heavy DB work runs in a persistent background Dart isolate;
`Actions` do pure DB work and return **integer IDs**; `Interfaces` hydrate those IDs back into
objects on the main thread; an `isIsolate` flag lets the same code run in both contexts without
duplication.

**This is complexity we correctly do not need.** ObjectBox is *synchronous* Dart — a bulk insert
blocks their UI thread, which is why the isolate exists. op-sqlite already executes SQL on a native
thread, so we get the same benefit for free. Their ADR-002 (return IDs, hydrate later) exists purely
because ObjectBox objects can't cross an isolate boundary. Adopting any of this would be pure cost.

### 5.3 Send pipeline

The most interesting comparison, because both apps solved *"don't lose or duplicate a message"* and
chose different mechanisms.

| | **BlueBubbles 2.0** | **Gator RN** |
|---|---|---|
| Queue | In-memory `Queue<_OutgoingEntry>` holding a `Completer` | **`outgoing_queue` SQLite table** |
| Survives backgrounding | Yes — the `dio` call runs inside the persistent isolate | Yes — queue row is on disk |
| Survives **process death** | **No.** Nothing persists the queue; no launch-time sweep for rows stuck on `temp-` guid with `error == 0`, so a hard kill freezes that bubble on "sending" forever | **Yes** — lease + backoff + attempt cap, drained from boot, AppState `active`, the chat ticker, and the 15-min background task |
| Manual retry | `retryFailedMessage` calls `generateTempGuid()` — a **new** temp guid. The tempGuid *is* the server's dedup key, so a send that failed client-side but landed server-side is **delivered twice** | Re-POSTs under the **original** tempGuid; lease + `error`→`sending` flip commit in one transaction so a tap can't race the drain |
| Dispatch order | **Strictly serial** — one at a time, racing HTTP against the socket echo | Independent immediate POST per send; only attachment *bytes* are gated (2 slots) |
| Cancel pending | Cancel one item, cancel all pending for a chat, auto-cancel the rest after a failure | None |
| Failure while backgrounded | Local "Failed to send" notification | None |
| Server's error text | Persisted on the message, shown in the failure dialog | Not persisted |

Their 2.0 claim *"you can now leave the app after sending a message without fear of it failing &
duplicating"* is achieved by moving the HTTP call into the isolate. Ours is achieved by persisting
the queue. **Ours is strictly stronger** (process death, not just backgrounding) — and their retry
actively breaks idempotency.

**What to take:** a thin FIFO in front of our existing `send*` services so multiple quick sends
arrive in the order the user made them, which is genuinely user-visible. That's also the natural
home for "cancel everything pending in this chat". Keep the durable queue, leases, and reconcilers
exactly as they are.

### 5.4 Persistence & sync

| | **BlueBubbles 2.0** | **Gator RN** |
|---|---|---|
| Store | ObjectBox, **unencrypted** (`openStore(directory:)`, no key — ObjectBox encryption is a paid feature) | **SQLCipher**, 256-bit Keystore-held key, crash-safe `PRAGMA rekey` rotation |
| Search | `Message_.text.contains()` — an O(n) scan on device | **FTS5** external-content index with `snippet()` |
| Migrations | 9 imperative Dart cases in a `switch`, no tests | 29 named, individually-transactional SQL migrations, **19 per-migration jest tests** |
| Sync cursor | rowid-vs-timestamp with 5s overlap; marker in SharedPreferences — **can commit while the ObjectBox write rolled back** | Same cursor, but the marker is written **inside the same transaction** as the rows it claims |
| Sync safety | One `isIncrementalSyncing` bool + 30s cooldown | Two in-flight slots that chain, runs bound to a **session epoch** so a doomed previous-account run can't be handed to a new `connect()`, `awaitSyncIdle()`, `shouldAbort` |
| Deletion catch-up | None | `GET /message/deleted` + kv watermark |
| Concurrency | ObjectBox gives concurrent readers free | One connection + a process-wide write mutex, so **readers block on writers**; no WAL |
| Latest-message read | Cached `dbLatestMessage` + `hasUnreadMessage` on the chat row — **O(1)** | Recomputed via CTE + six correlated subqueries on every debounced write |

Their recent *"incremental sync per-page updates"* commit is something **we get structurally free** —
our inbox reads the DB reactively, so each committed slice already hydrates the UI. They needed an
isolate event bus to push pages into their in-memory mirror.

**Where they are clearly ahead: operational recovery.** They ship a whole repair toolkit — a
cancellable full resync with a live progress log (savable to Downloads), "Manually Sync Messages"
over a chosen time range, per-chat range sync, handle resync with backup-and-rollback, chat-only
resync, "Delete All Messaging Data" then re-sync, and a **Soft-Deleted Chats panel that restores a
locally deleted conversation**. We have one "Sync Now" button that — because `sync_markers` is
already set on any existing install — can *only ever* run the incremental branch. Our only escape
hatch from a bad local cache is Disconnect, which destroys pins, wallpapers, per-chat themes,
reminders and drafts that our own backup file doesn't export.

### 5.5 Networking

| | **BlueBubbles 2.0** | **Gator RN** |
|---|---|---|
| Auth injection | Password as a **URL query param** on every request (`params['guid']`) + in the socket handshake query. Reaches proxies, access logs, intermediaries | **`Authorization` header**, one injection point; `?guid=` survives only as a logged legacy fallback, HTTPS-only |
| Response handling | Hand-indexed `res.data['data']` | **zod** envelope validation |
| Retry | A single re-attempt, and only for a 502 from a `trycloudflare` host | Jittered exponential backoff, on by default for idempotent GETs, off for writes |
| Layering | `Interface → Action → HttpService` (3 hops, exists to cross the isolate boundary) | Flat endpoint modules |
| Payload crypto | AES-256-**CBC**, single-round MD5 EVP KDF, **no auth tag** | AES-256-**GCM** (AEAD), SHA-256 key derivation |
| TLS | Trusts user-installed CAs **and** accepts any self-signed cert matching the configured host | System CA store only |
| Rate limiting | None | None |

Their `Interface → Action` indirection buys them **nothing we lack** — it exists solely to route
across the isolate boundary. Don't copy it.

Their TLS handling is where to **adopt exactly half**: the user-installed-CA half is a legitimate
self-hosting affordance (the user already made an OS-level trust decision, and without it a
private-CA server is simply unreachable on Gator). The blanket "accept any self-signed cert for the
configured host" half is a real MITM hole and must not be copied.

### 5.6 Documentation & engineering practice — the mirror image

**They are far better organised. We are far better verified.**

| | **BlueBubbles 2.0** | **Gator RN** |
|---|---|---|
| Always-loaded context | **2.2 KB** — root `CLAUDE.md` (39 lines: scope, 6 pointers, 5 conventions) + `AGENTS.md` (27 lines, pure router) | **88.8 KB / ~12,000 words** — `CLAUDE.md` is `@AGENTS.md`, so the whole monolith loads every session (~40× their footprint) |
| On-demand docs | ~5,600 lines: **96 per-directory `CLAUDE.md`**, 5 concern-split rule files, 7 narrative docs | None — no per-directory files, no routing, no rules split |
| Decision log | `DECISIONS.md` — **13 formal ADRs** (decision / context / rationale / consequences) | None |
| Flow traces | `MESSAGE_SEND_FLOW.md` (272 lines), `MESSAGE_RECEIVE_FLOW.md` (229) — step-numbered, file-per-step, with a dedup-guarantees section | None for plain iMessage send/receive |
| Recipes | `COMMON_TASKS.md` | None |
| Staleness rule | Explicit keep-in-sync mandate | None |
| **Automated tests** | **ZERO.** No `test/`, no `*_test.dart`, no `flutter_test` dep. Their docs say so outright | **316 test files / 47,601 test LOC** vs 41,236 source LOC, two jest projects |
| CI gates | Desktop builds only | tsc-strict, ESLint-9 (`exhaustive-deps` as error), prettier, 2 custom grep guards, both jest projects |
| Crash reporting | **None** — errors land in a local log file only | Durable `error_reports` upload queue |
| Release automation | None for Android | One-command Play releases |
| Log retention | 25 MB rotating files, 6 levels, per-call tags, zip-for-bug-report | 500 JSON entries, 4 levels, no tags, no rotation |

**The important nuance: their per-directory docs are *inventories*** (`chat_api.dart — chat
endpoints`). Ours are **root-caused trap logs** — the failure mode, the wrong diagnosis that
preceded it, and the test that now locks it (the width-0 preview image; the keyboard-inset double
count; `keyboardShouldPersistTaps` eating swipes; `addAssetsToAlbumAsync`'s per-photo consent
dialog). Upstream has nothing of that depth anywhere.

**So the move is additive: build their navigation layer on top of our trap log.** Relocate trap
bullets next to the code they guard; do *not* summarise them. Summarising them destroys the actual
asset.

**One caution learned from their repo:** a written staleness rule is necessary but demonstrably
insufficient. Their own rule failed in three checkable places in the shipped 2.0 tree —
`.claude/CLAUDE.md` and `rules/git.md` both still say "No CI/CD" while two workflows exist; three
files reference `docs/MODELS.md` when the file is `docs/models.md` (broken on any case-sensitive
filesystem); and `COMMON_TASKS.md:152` points at a `docs/CUSTOM_COMPONENTS.md` that doesn't exist.
Ours has the same rot (`README.md:189` links a plan file that no longer exists). **Pair the rule
with a ~10-line CI link-check** that resolves every doc path referenced from always-loaded context.

Two honest self-criticisms this surfaced about us: our stated **≥70% UI coverage floor is not
enforced in CI** (no `coverageThreshold` in `jest.config.js`, no coverage step in `ci.yml`) — it's
an honour system; and we have **no `CONTRIBUTING.md`** and no recorded commit convention, though the
git log follows one uniformly.

---

## 6. Feature gaps — high severity

The 11 items where a user would notice. Three are defects, not missing features.

### 6.1 Defects (fix these first — they're bugs)

**① Received stickers render nowhere at all** — `rn_missing`, effort: medium

- **Them:** `StickerHolder` collects sticker messages targeting a bubble, downloads them, and
  overlays them on the target (tap to fade, long-press to dismiss).
- **Us:** `queryMessageRows` filters `AND m.associated_message_type IS NULL`
  (`src/db/repositories/messages.ts:570`), so sticker rows never reach the list. `parseReactionType`
  also returns null for `'sticker'`.
- **Why it matters:** the sender sees a sticker slapped on their photo; the Gator user sees
  *nothing* and has no way to know a message arrived. That's data-loss-shaped, not cosmetic.
- **Root cause worth fixing properly:** that one predicate is doing two jobs. Narrow it to the
  *reaction* types (we already have `isReaction()` and a reaction type list) so the exclusion is
  intentional and the next unknown associated type doesn't vanish without a trace.

**② Received documents (PDF/doc/vCard) cannot be opened** — `rn_partial`, effort: small

- **Them:** tap → `OpenFilex.open()` via a FileProvider, branching on
  `noAppToOpen`/`error`/`fileNotFound`/`permissionDenied`, each with a snackbar and a share-sheet
  fallback.
- **Us:** `FileChip` tap → `safeOpenUrl(att.localPath)` where `localPath` is
  `file:///data/user/0/<pkg>/files/attachments/...` — an app-private path. Android forbids passing a
  `file://` Uri to another app (`FileUriExposedException`, API 24+), the throw is swallowed by
  `safeOpenUrl`'s catch, and the returned `false` is ignored. Same path in `ContactCard.tsx:43`.
- **Why our tests miss it:** `fileChip.test.tsx` mocks `@utils`, so it asserts `safeOpenUrl` was
  *called* — never that Android can open the uri.
- **Cheapest fix:** route to `expo-sharing` (already a dependency, already used by the media
  viewer), or add a FileProvider + `expo-intent-launcher` with a `content://` uri.

**③ Redacted mode leaks Find My coordinates** — `rn_missing`, effort: small

- **Them:** redaction is applied at the **data layer** — the coordinate resolver returns a
  deterministic decoy point, so every consumer (marker, directions button, tile) is redacted by
  construction, and the raw-payload dialog is disabled outright.
- **Us:** redaction is per-render at the presentation layer — each label calls `redactTitle`, while
  the coordinates flowing into the map and the `geo:` intent are untouched.
- **Why it matters:** redacted mode exists so a screenshot is safe. A real pin on a real street is
  more identifying than a name. This fails the mode's own purpose.
- **Fix shape:** one pure resolver in `@utils` (node-testable, like our other privacy helpers)
  applied to markers *and* the Open-in-Maps handler in the same change, so the two can't drift.

### 6.2 Missing capabilities

**④ Custom Groups (user-defined chat folders)** — `rn_missing`, effort: large — *the flagship 2.0
organisation feature*

A `CustomGroup` entity with an N:M relation to Chat, unique name, `sortOrder`, per-group
`showUnreadBadge`; CRUD + reorder; a reactive cache; a settings panel per skin (7 files); and "Add
to Custom Group" from the tile long-press. We have no model, no table, no UI. Our only grouping axis
is pinned / archived / unknown-sender.

**⑤ Multi-dimensional chat filtering** — `rn_partial`, effort: medium — *best value-per-hour in this
dimension*

Five independent dimensions (unread / known-unknown sender / group-direct / muted / service) ANDed
together, plus an OR'd custom-group set, persisted to `Settings.savedChatFilters` with
forward-compatible enum parsing, driven by a 441-line filters sheet. We have exactly one
(`filterUnknownSenders`).

**Why this is cheap for us:** every field the dimensions need is *already* in `InboxRow` —
`unreadCount`, `style`/`participantCount`, `muteType`, `handleServices`, `hasKnownSender`
(`src/db/repositories/chats.ts:846-885`). It's pure client-side filtering over an already-loaded,
memoised array: a store plus a sheet, **not a data change**.

> **Architectural note — follow upstream here, against our own instinct.** Their filtering is
> in-memory `.where()` passes over a loaded list. Ours would naturally go into SQL. **Don't.**
> Adding five optional `WHERE` fragments to `listChatsForInbox` multiplies the surface where the
> `deleted_at` / `last_read_message_guid` invariants documented in AGENTS.md can break. Only
> custom-group *membership* needs a table + join.

**⑥ Light/dark axis + system-follow theme mode** — `rn_missing`, effort: medium

They run `adaptive_theme` with light/dark/system and *separate* selected light and dark themes;
`ThemeSvc.inDarkMode(context)` is the single branch point. We resolve exactly **one** theme, never
read `useColorScheme`, and both enabled presets are dark — so there is no light mode in practice.
The declared `ThemePreference = ThemeMode | 'system'` type is never used.

**Compounding trap:** `themes.tsx` seeds the studio with `resolvePreset(presetKey)`, so authoring a
"light" theme starts from dark hexes.

*(This was deliberately deferred as gap #6 in the 2026-07-15 audit. Flagging that it's still open,
not re-litigating the decision.)*

**⑦ OS-retried delivery of push/socket events** — `rn_missing`, effort: medium — **highest-value
idea in their whole background architecture**

Every FCM message, UnifiedPush message, foreground-socket event and notification action is enqueued
as an expedited WorkManager `OneTimeWorkRequest` with `EXPONENTIAL` backoff from a 10s minimum
(~10s/20s/40s/80s/160s ≈ a 5-minute window). Their own code comment states the intent: *"long
enough to outlast a memory-pressure spike that makes cold engine boots fail repeatedly."* Because
the worker boots the Flutter engine, **engine-startup failure is itself retryable**.

Ours runs the whole pipeline inline in the RNFB headless handler; a throw rejects a promise the
native bridge swallows. `EventRouter` correctly releases the dedupe key on a sink throw — but
*nothing redelivers*.

**This maps directly onto our open bug.** `docs/PUSH_DELIVERY.md` §3a records: *"Two identical
killed-process tests a minute apart: the first never started the process and posted nothing; the
second worked… Root cause of that last hop is NOT yet established."* An OS-owned retry is the
standard mitigation for exactly that failure class — including the "Android never even started the
process" case that no JS-side fix can reach.

**Minimal port:** on a `deliver` throw, persist the raw envelope to a small table and re-drain it
from the already-registered `gator-bg-sync` task.

**⑧ Foreground service with an always-on native socket** — `rn_missing`, effort: large

`SocketIOForegroundService.kt` keeps its **own Kotlin** socket.io connection alive under an Android
foreground service, blacklisting cheap events (typing, findmy-location) for battery, reconnecting on
a 30s handler, auto-restarting after reboot, and using its persistent notification as a live
connection-state readout. Offered to the user as one of three interchangeable "Notification
Providers".

Ours is JS-only and deliberately torn down on background (`pauseRealtime()`); background delivery is
FCM plus a ~15-min catch-up sync. **We have zero recourse when FCM's last hop misbehaves** — which
is the open bug above.

**Judgement: worth adopting as an opt-in fallback, not a default.** notify-kit already exposes
`asForegroundService`, so a JS-hosted socket is reachable without new Kotlin — but it's genuinely
large, risky work. **Start with the cheap intermediate step instead:** pause our three foreground
timers on background, shorten the catch-up cadence, and give the user a visible push-health
indicator.

**⑨ Live connection status indicator** — `rn_missing`, effort: **small** — *best value-per-hour
overall*

A 4dp animated bar under the status bar in every conversation header, shown on
reconnecting/error and briefly on recovery, plus a live "Connected/Connecting/Reconnecting/
Disconnected/Error" subtitle on the Settings root tile. A 2.0 headline ("Improved connection status
bar").

We track this in `sessionStore.status` — but the only readers are `app/index.tsx` (boot routing:
spinner vs redirect) and the two setup screens. **No connected-UI surface renders it as chrome.**
Once you're past boot, connection state is only discoverable by opening Server Management, which
does a one-shot ping on mount.
**Today a dropped socket looks identical to "nobody texted me."** The store already emits the state;
the change is one themed bar plus a subtitle.

**⑩ Active-chat awareness** — `rn_partial`, effort: small

`ChatState.isActive` gates the notification *entirely* for the thread on screen
(`notifications_service.dart:248`), marking read and playing the in-chat receive sound instead.

We have no active-chat concept: `buildMessageIntents` gates only on `isFromMe`, missing guid, and
mute. The chat screen **posts** the notification and then dismisses it once the reactive query lands
— so a message you are literally watching arrive still produces a heads-up banner, a sound, and a
vibration.

`docs/STATE_AUDIT_2026-07-25.md` §4a called out both the suppression and the read marker; only the
read marker shipped. Fix: a module-level `openChatGuid` (a plain module, **not** a hook — the notify
path runs headless) read by `intents.ts`.

**⑪ Screenshot / screen-recording block + app-switcher hiding** — `rn_missing`, effort: small —
*highest-value security item they have that we don't*

`secure_application`'s `locked_and_secured` level sets `FLAG_SECURE`, documented in-app as *"hides
content in the app switcher, and disables screenshots & screen recordings."*

We have nothing equivalent — three independent searches found no `expo-screen-capture`, no
`FLAG_SECURE`, no native equivalent. **Our app-switcher thumbnail shows the last rendered frame,
including message content.**

`expo-screen-capture`'s `preventScreenCaptureAsync()` sets `FLAG_SECURE` on Android, which also
suppresses the recents thumbnail — so this is an install plus one call driven from the lock-enabled
state our overlay already reads, plus a native rebuild.

---

## 7. Feature gaps — medium severity (73)

`MISS` = nothing on our side; `PART` = partial. Effort in brackets.

### Messaging
- `PART`[large] **Multi-part messages** — they model a message as an ordered `List<MessagePart>` and thread `partIndex` through every reply/tapback/edit/unsend. We render one bubble and hardcode `partIndex: 0`, so on a multi-part iMessage a tapback/edit/unsend **hits the wrong part**, and unsending one part blanks the whole bubble. *Adopt partially: thread a real `partIndex` through the four call sites and key reactions on `(target, part)` — that fixes the correctness half for a fraction of a full `MessagePart` model.*
- `MISS`[large] **Interactive / balloon messages** — Game Pigeon, Apple Pay, iMessage Polls, handwriting, Digital Touch. They route on `balloonBundleId` to typed cards with a labelled fallback. We have no `balloonBundleId` column at all, so these render as an **empty bubble**.
- `MISS`[medium] **In-text entity linkification** — phone / address / email / date / tracking / flight numbers tappable. We linkify only `https?://`.
- `PART`[small] **Capability gating of message actions** — we offer Reply/Edit/Unsend/tapbacks on SMS and RCS chats, where they gate on `enablePrivateAPI && chat.isIMessage && supportsEditAndUnsend`.
- `PART`[medium] Invisible-ink robustness + effect-played persistence
- `MISS`[medium] Send a location
- `PART`[medium] Voice message: waveform + Apple transcript + "Kept"

### Attachments & media
- `PART`[small] **In-app camera: video capture** — `launchCameraAsync` is called with no `mediaTypes`, so it can only take a photo. The tray's own `isVideo` branch is **dead code** and there is no way to record a video to send.
- `PART`[large] Attachment explorer in conversation details — theirs is a full-page explorer with type/sender/timeframe filters and searchable document + link grids; ours is 3 capped strips, a non-tappable "Documents" count row, and no locations section
- `MISS`[small] Fullscreen viewer secondary actions — re-download, save-original (`?original=true`), EXIF/metadata dialog, reply-to-attachment
- `MISS`[small] Download-on-demand inside the fullscreen carousel
- `PART`[small] Gallery multi-select picker + permission recovery in the tray

### Chat list & search
- `MISS`[medium] Manual pinned-chat ordering (`pinIndex` + reorder panel; our `is_pinned` is a bare boolean)
- `PART`[medium] Long-press chat "peek" preview
- `MISS`[medium] Advanced search filters — scope to chat/participant, from-me, since-date
- `MISS`[medium] **Server-side ("Network") message search** — anything outside our bounded sync window is simply unfindable
- `PART`[large] Shared-media explorer in chat details

### Theming
- `PART`[small] Theme catalogue size — theirs ~100+ selectable (2 hand-built + 9 Material You × light/dark + Nord + album-art Music themes + every `flex_color_scheme` preset × light/dark) vs our 2 enabled / 5 defined
- `MISS`[medium] Material You / monet dynamic colour from the OS palette
- `PART`[medium] Studio authoring depth — they edit 12 M3 role *pairs* through a colour wheel; we have flat hex text fields
- `MISS`[medium] Typography editor (font family + 7 per-role text sizes)
- `PART`[small] Generate a palette from a seed colour / arbitrary image (global theme)
- `MISS`[small] **Per-handle avatar/bubble colours** — we *store* `handles.color` but never render it; `Avatar`'s `color` prop is passed nowhere
- `MISS`[medium] Apple Color Emoji font — matters for an app whose premise is looking like iMessage
- `PART`[small] **Status-bar icon brightness from the active theme surface** — their 2.0 status-bar fix; ours is latent because a single root `<StatusBar style="auto" />` follows the *OS* scheme, not the theme

### Notifications
- `MISS`[small] **Grouped / summary notification** — five unread chats become five un-stacked notifications
- `PART`[small] **MessagingStyle conversation history** — a chat with three unread messages shows only the newest. They read back `activeNotifications`, extract the existing style, and **append**
- `MISS`[small] Suppress notification for the chat being read *(= item ⑩)*
- `PART`[medium] Filtering granularity — snooze/temporary mute, mute specific people, text detection, notify-reactions toggle
- `PART`[medium] Battery-optimization exemption: detect and surface current state
- `PART`[medium] Native persistent log of push arrival, before any JS runs

> Notification presentation is the biggest *visible* gap here and it's cheap: notify-kit exposes
> both halves — `getDisplayedNotifications()` and `groupId`/`groupSummary`/`groupAlertBehavior`.
> Adopting it fixes threading, stacking, **and** the currently-accepted limitation that withdrawing
> an unsent message must cancel the whole chat's notification.

### Settings & onboarding
- `PART`[large] Settings breadth — 10 category dirs / 49 panels / 135 persisted fields / an item-level search index with breadcrumb deep-jump, vs our one 462-line screen with ~18 controls. *Much of theirs is desktop-only, skin-specific, or replaced by a better default (we read 12h/24h from device locale instead of shipping a toggle).*
- `MISS`[medium] **Server-hosted backup slots** — named, list/save/delete, restore. **The Gator server half already exists** (`/api/v1/backup/theme`, `/api/v1/backup/settings`, wired at `backend.ts:551`); the prior audit's "na-fork, no such routes" note is now **stale**.
- `MISS`[medium] Onboarding permissions step (Contacts + Notifications)
- `PART`[medium] Onboarding battery-optimization step + exemption readout
- `MISS`[small] Custom HTTP headers editor
- `PART`[medium] Troubleshoot / Developer Tools page (targeted data resets)
- `MISS`[small] **Error-reporting opt-out isn't exposed** — `errorReportingEnabled` defaults **ON** and uploads captured error lines to the server, but the flag exists only in `featureSettingsStore` and is never rendered. A privacy-relevant control with no UI.

### Integrations
- `MISS`[small] Find My redacted mode hides coordinates *(= item ③)*
- `PART`[small] Live Find My updates over the socket (`new-findmy-location`); we poll every 60s
- `MISS`[medium] Your own live position on the Find My map
- `PART`[small] Find My friend detail: live status, last-updated, contact identity
- `MISS`[medium] On-device entity extraction *(see the note below)*
- `MISS`[medium] Send current location (receive works)
- `MISS`[large] **Digital pass (.pkpass / Apple Wallet) rendering** — a 2.0 headline
- `PART`[medium] Recurring scheduled messages — theirs are **server-executed** with an "every N hourly/daily/weekly/monthly/yearly" grammar, so they fire with the phone off. Ours are local-only because the Gator server contract has no recurrence and no PUT. **Not a client fix — recurrence belongs on the server.**
- `PART`[small] International phone number parsing (ours handles only 10- and 11-digit US forms)

> **On ML Kit: adopt the capability, not the dependency.** Smart replies genuinely need ML and are
> low value — leave them out (we deleted our rule-based engine in `180e51c`). **Entity extraction is
> what users actually feel** — a texted phone number or address should be tappable — and the useful
> 80% (email, phone, http(s), simple dates, address-ish spans) is regex work that fits `src/core`'s
> React-free, node-testable rule and reuses our existing `safeOpenUrl` allowlist (`tel:`, `mailto:`,
> `geo:` are already permitted).

### Architecture & docs
- `MISS`[medium] Change invalidation is **table**-scoped, so a write in chat B re-runs the open chat A's queries (op-sqlite's `fireOn` only supports rowids, so chat-scoping is impossible)
- `PART`[small] Battery: teardown discipline on background — three foreground `setInterval`s (reachability 30s, chat 20s, FindMy 60s) keep firing while backgrounded. **Their entire `lib/` has exactly one `Timer.periodic`** — the most plausible mechanical source of their "Reduced Battery Consumption" claim
- `MISS`[small] Restore a locally deleted conversation
- `MISS`[medium] Handle resync with backup + rollback
- `PART`[medium] Per-chat server-preference columns
- `PART`[small] Backup coverage vs what a wipe destroys
- `MISS`[medium] Serial dispatch order for multiple sends
- `MISS`[small] "Failed to send" local notification
- `MISS`[small] Server error text persisted + shown
- `MISS`[medium] LAN / localhost origin override
- `MISS`[medium] Self-signed / user-CA TLS trust *(adopt the user-CA half only)*
- `MISS`[medium] Layered agent-context routing
- `MISS`[medium] Per-directory doc files
- `PART`[medium] Rules split by concern into loadable files
- `MISS`[small] Doc-staleness rule *(+ CI link-check)*
- `PART`[medium] ADR-style decision log
- `PART`[small] Task recipe book
- `PART`[medium] End-to-end send/receive flow docs
- `MISS`[small] Doc index + orphaned-doc hygiene (18 of our 26 `docs/` files, plus 6 root planning docs, are referenced by nothing an agent reads)
- `PART`[small] App-lock strictness levels + re-auth to change the setting — **disabling our lock requires no auth at all**
- `PART`[medium] Redacted Mode granularity — theirs is 4 sub-toggles (`hideMessageContent`, `hideAttachments`, `hideContactInfo`, `generateFakeAvatars`) with a live preview bubble and word-count-preserving fake text; ours is one boolean and three generic placeholders
- `PART`[small] **Redacted Mode coverage — surfaces that still leak:** message-search results and the new-chat contact list render names/snippets **raw** (zero `redact` references in `SearchResultsView.tsx` / `ContactSuggestionList.tsx`); Settings shows Server origin + Version; `server-management.tsx` builds a pairing QR **embedding the password**; the account screen shows the Apple ID

---

## 8. Where Gator is ahead (57 rows)

### High-severity — structural wins
| Capability | Them | Us |
|---|---|---|
| **Encryption at rest** | ObjectBox opened with **no key** — every message, handle and chat in plaintext on disk | SQLCipher, Keystore-held 256-bit key, crash-safe `PRAGMA rekey` rotation |
| **Credential storage** | Server password in plaintext `FlutterSharedPreferences.xml` | `expo-secure-store` (Keystore + EncryptedSharedPreferences) |
| **Auth transport** | Password in the **URL query** of every request | `Authorization` header, single injection point |
| **App lock** | A blur overlay over an already-open plaintext DB | Lock flag read from the vault **before the DB exists**; SQLCipher key withheld until biometric auth |
| **Durable send queue** | In-memory; a hard kill freezes a bubble on "sending" forever | SQLite table with lease/backoff/attempt cap, 4 drain triggers |
| **Retry idempotency** | Mints a **new** tempGuid — a client-failed-but-delivered send is **sent twice** | Reuses the original tempGuid |
| **Sync run safety** | One bool + 30s cooldown | Session-epoch binding, chained in-flight slots, `awaitSyncIdle`, `shouldAbort` |
| **Accessibility** | **0** `semanticLabel` in all of `lib/`; 3 `Semantics(` calls (all in a vendored Flutter dialog); 11 tooltips vs 98 `IconButton`s → ~87 controls announce as an unnamed "button" | 104 `accessibilityLabel`, 84 `accessibilityRole`, `accessibilityViewIsModal` on sheets, media labels stating the **tap outcome** |
| **Automated tests** | **None** | 316 files / 47,601 LOC, two jest projects |

### Medium-severity
Full-text search index · migration mechanics with per-migration tests · deleted-message catch-up
sync · incremental-cursor stall guard + marker/row atomicity · transport retry/backoff · upload
cancellation granularity · server-pushed `message-send-error` handling · error/crash report upload
queue · CI quality gates · Android release automation · AEAD payload encryption · log redaction
before any sink · notification content gated by app-lock · Android composer paste of
images/GIFs/stickers · push self-test + delivery breadcrumbs.

Plus, with no upstream counterpart at all: **RCS as a first-class rendered service** (they define
`ChatServiceType.rcs` with `isVisible: false`), **Android Direct Share targets**, **scroll-restore
convergence machinery**, **synced macOS 26 transcript backgrounds**, **FaceTime outgoing calls**
(they can only answer and hand the link to an external app), and **blurhash attachment
placeholders** (they ship the API but never render them).

---

## 9. Deliberate non-goals — do not chase these

| Their feature | Why we skip it |
|---|---|
| iOS / Material / Samsung **skins** + `ThemeSwitcher` | We are deliberately iOS-styled. Costs them 3 widget variants per screen. |
| **Isolate / Interface / Action** layering | Exists because ObjectBox is synchronous Dart. op-sqlite already runs SQL off the main thread — we'd pay the cost for no benefit. |
| `io/` vs `html/` model duplication | Web-support tax; their own ADR-012 deprecates web. |
| `media_kit`/libmpv, desktop window effects, tray, `bitsdojo_window` | Desktop-only. |
| UnifiedPush, Tasker broadcast, Firebase/Google OAuth pairing | Out of scope for this fork (the Gator server removed the unifiedpush provider). |
| Blanket self-signed cert acceptance | A real MITM hole. Adopt the user-CA half only. |
| Scattering raw redaction flag reads across ~35 widgets | Our pure-helper + whole-tree leak-sweep test is why we can *prove* nothing leaks. |
| ML Kit Smart Reply | Needs a native model download for low value. |

---

## 10. Recommended order of work

Sequenced by value ÷ effort, not by dimension.

### Tier 1 — defects and near-free wins
1. **Sticker rendering** — narrow the `associated_message_type` filter to reaction types, add a `listStickersForTargets` query + overlay. *Fixes silently-dropped messages.*
2. **Document open** — route `FileChip`/`ContactCard` through `expo-sharing`; **consume `safeOpenUrl`'s return value**. Device-verify with a real PDF.
3. **Find My coordinate redaction** — one pure resolver applied to markers and the maps handler together.
4. **Live connection indicator** — `sessionStore` already has the state; add a themed bar + a Settings subtitle.
5. **Active-chat notification suppression** — module-level `openChatGuid` read by `intents.ts`.
6. **Notification grouping + MessagingStyle history** — `getDisplayedNotifications()` + `groupId`/`groupSummary`.
7. **`FLAG_SECURE`** via `expo-screen-capture`, driven off the lock setting *(needs a native rebuild)*.
8. **Pause the three foreground timers on background** — a few lines in the handler that already calls `pauseRealtime()`.
9. **Expose the error-reporting toggle** — it's ON by default and uploads to the server with no UI.

### Tier 2 — reliability
10. **Push retry** — persist the raw envelope on a `deliver` throw; re-drain from `gator-bg-sync`. *Directly targets the open `PUSH_DELIVERY.md` §3a bug.*
11. **Thread a real `partIndex`** through react/edit/unsend/reply; key reactions on `(target, part)`.
12. **Sync recovery** — "Resync from scratch" (reset marker + full sync) and "Sync last N days" over the existing `fetchMessagesAfter`; give the run an abort signal and an in-memory log buffer surfaced on Server Health. *The engine already exists; only the entry points are missing.*
13. **Bound the inbox query** (covering index + `LIMIT`) and **classify the debounce** (immediate vs max-wait).
14. **Serial send FIFO** in front of the existing `send*` services.
15. **User-installed CA trust** — a config plugin writing `<certificates src="user"/>`. *Not the blanket self-signed path.*

### Tier 3 — features
16. **Chat filtering** — client-side over `InboxRow`, which already carries every field. Store + sheet.
17. **Custom Groups** — join table via `withDbTransaction` (mind the ADD-THEN-PRUNE rule), membership read fresh, zustand caching only the group list.
18. **Light/dark axis** — light/dark *pairs* per selection + an `Appearance` listener; fix the studio's dark-hex seeding.
19. **Entity linkification** — pure regex in `src/core`, reusing the `safeOpenUrl` allowlist.
20. **Server-hosted backup slots** — POST our existing ciphertext to the routes the Gator server *already* has. Named multi-device slots **without** giving the server readable settings — better than either side alone.
21. **Manual pin ordering**, **camera video capture**, **per-handle bubble colours** (we already store `handles.color`), **viewer secondary actions**.

### Tier 4 — documentation restructure
22. **Split `AGENTS.md` into a thin router + on-demand files.** Move trap bullets *next to the code they guard* — **do not summarise them**; the depth is the asset. Natural seams: core-purity, db-writes, ui (split this first — it's four concerns under one heading, lines 142–800), realtime-and-push, native-modules, release.
23. **Add an ADR log** and **two flow traces** (send + receive). Our send path has *more* moving parts than the one they documented — optimistic insert, upload progress, an HTTP/socket race, two content reconcilers, a lease whose claim and mark-sending must flip in one transaction, RCS acks returning our own tempGuid. This is also the doc that most reduces the risk of an agent re-introducing a duplicate send.
24. **Staleness rule + a CI link-check.** Their written rule failed in 3 checkable places in shipped 2.0; ours has the same rot. Automate it.
25. **Enforce the 70% UI coverage floor in CI** — currently an honour system.
26. **Add `CONTRIBUTING.md`** and record the commit convention the log already follows.

---

## 11. Relationship to prior audits

`docs/OLD_APP_PARITY_AUDIT_2026-07-15.md` compared us against the **pre-2.0** Flutter app (217 gaps;
8 of 9 high-priority closed). This report is the **2.0 delta** and supersedes it where they overlap.
Two of its conclusions are now **stale**:

- *"Server-hosted backup — na-fork, the server has no such routes."* The Gator server **does** now
  register `/api/v1/backup/theme` and `/api/v1/backup/settings`.
- Its gap #6 (light/dark) was deferred by choice and remains open — now with the added wrinkle that
  the Theme Studio seeds light authoring from dark hexes.

Still-open items from that audit that 2.0 reinforces: multi-select in the chat list, contact
nicknames, per-chat overrides, transcript export.
