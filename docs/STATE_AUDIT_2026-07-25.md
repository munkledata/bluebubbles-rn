# State audit & fix plan — 2026-07-25

Produced from a 13-agent investigation (6 investigators → adversarial verification → synthesis) into two
user-reported bugs (inbox names flickering to phone numbers; the inbox not revealing the newest thread)
plus an app-wide audit of React/zustand/reactive-query state patterns.

Every claim below cites file:line and was independently re-verified before being written down.

---


Everything below is grounded in code I re-read at the cited lines. Two things to hold in mind throughout, because they invalidate the "obvious" fix for several items:

- **Every single write flushes the reactive queries.** `src/db/database.ts:47` `const flush = (): void => void db.flushPendingReactiveQueries();` and `:51-55` `executeAsync: async (...) => { const r = await db.execute(...); flush(); return wrap(r); }`. So a loop of N `db.delete(...)` calls is N separate commits, each waking every subscriber.
- **A transaction does NOT hide intermediate state.** There is one shared op-sqlite connection, so reads inside the app see the transaction's own uncommitted rows. `src/db/transaction.ts:15-17` says this in its own caveat. Do not reach for `withDbTransaction` to fix a "the UI saw a half-finished write" bug.

---

## 1. Bug A — inbox names flicker to phone numbers

### Root cause (one sentence)

`upsertChats` rebuilds every chat's participant links by **deleting all of them in a loop and re-inserting them all only after the loop finishes**, so during a routine sync up to 200 chats are simultaneously "a chat with no participants" — and a chat with no participants renders as its raw phone number.

The code, `src/db/repositories/chats.ts:65-77`:

```ts
const links: { chatId: number; handleId: number }[] = [];
for (const c of deduped) {
  const chatId = map.get(c.guid);
  if (chatId == null || c.participants == null) continue;
  await db.delete(chatHandles).where(eq(chatHandles.chatId, chatId));   // line 69
  for (const p of c.participants) {
    const handleId = handleIdByKey.get(handleMapKey(p));
    if (handleId != null) links.push({ chatId, handleId });
  }
}
if (links.length > 0) {
  await db.insert(chatHandles).values(links).onConflictDoNothing();     // line 76 — after ALL deletes
}
```

Why that becomes a phone number: the inbox query derives the title from that table — `src/db/repositories/chats.ts:406-408` `(SELECT group_concat(COALESCE(h.display_name, h.address), ', ' ...) FROM chat_handles ch JOIN handles h ...) AS participantNames`. With the links gone it is `NULL`, so `resolveTitle` falls through to `src/utils/chat.ts:39` `const id = c.chatIdentifier?.trim(); if (id && !RAW_CHAT_GUID.test(id)) return id;` — which for a 1:1 chat is literally the phone number. `avatarSeed` degrades the same way (`src/utils/chat.ts:131`).

Why it fires so often: `queryChats` **always** asks for participants (`src/core/api/endpoints/chats.ts:22` `with: ['participants', 'lastMessage']`), so every chat in every 200-chat page takes the delete branch; and `syncAllChats` runs on every incremental sync (`src/services/syncControl.ts:79`), which fires on boot, on pull-to-refresh, and on every foreground resume (`src/services/realtimeControl.ts:243` `maybeResumeSync()`).

Why it's intermittent: the inbox hook debounces 24 ms (`src/db/useReactiveQuery.ts:88-91`) and that debounce **resets** on each flush, so it usually rides out the burst. It only paints the bad state when a gap in the delete loop exceeds 24 ms.

### This is bigger than a flicker — three readers have no debounce at all

These make the fix mandatory rather than cosmetic, because they lose data permanently instead of self-healing:

- **Dropped notifications.** With "Filter Unknown Senders" on, `src/services/realtimeControl.ts:108` does `void chatHasKnownSender(db, intent.chatGuid).then((known) => { if (known) postNotificationSafely(intent); })`. Zero links → `false` → the notification is never posted. Gone for good.
- **Wrong group notification titles.** `src/services/notifications/intents.ts:25` reads `getChatHeader` directly; `participantCount` is 0 in the window, so `isGroup` is false and the title falls back to just the sender. A posted notification is never re-rendered.
- **Wrong chat header on open.** `useChatHeader` also watches `chat_handles`, and `useReactiveQuery.ts:93` `void exec(); // initial load, immediate` reads with no debounce on mount.

### Secondary contributor: the contacts matcher can blank every name at once

Separate code path, same symptom. `matchContactsToHandles` has no guard against an empty contact index, so if the index comes back empty it walks every handle and takes the revert branch, `src/db/repositories/contacts.ts:197-204`:

```ts
} else if (h.contactId != null) {
  await db.update(handles)
    .set({ displayName: h.serverDisplayName, avatar: null, contactId: null })
    .where(eq(handles.id, h.id));
```

`serverDisplayName` is **always NULL on this server** — the wire DTO has no such field (`~/github/BB/bluebubbles-server/packages/protocol/src/v1/entities.ts:189-194` `interface HandleV1 { address; country; uncanonicalizedId; service; }`). So the revert writes `display_name = NULL` and every affected title becomes the raw address, one committed write at a time.

Its sibling function already has exactly the guard that's missing here — `src/db/repositories/contacts.ts:153` `if (index.size === 0) return 0;`. The index can go empty because `upsertContacts` starts with `await db.delete(contacts);` (`contacts.ts:24`) and then inserts one row at a time, and `syncContacts` is fired uncoalesced from two places (`src/services/syncControl.ts:106` and `app/(app)/settings.tsx:139`), so two runs can overlap.

Confidence: the mechanism is certain; whether it actually fires on this device is not. It is two cheap lines, so ship it either way.

### The fix

**A1 — `src/db/repositories/chats.ts`, replace lines 65-77 with add-then-prune.** Resolve the handle ids first (pure JS, no writes), insert them, then delete only the ones that are genuinely gone. Keep the same write count as today (one batch insert + N prunes).

```ts
// Resolve links FIRST, INSERT before pruning, so a chat is never left with ZERO participant
// rows at a commit boundary. Every write flushes the reactive queries and several readers are
// un-debounced, so an intermediate state IS observable: it renders 1:1 titles as raw phone
// numbers and silently suppresses unknown-sender notifications.
const links: { chatId: number; handleId: number }[] = [];
const keepByChat = new Map<number, number[]>();
for (const c of deduped) {
  const chatId = map.get(c.guid);
  if (chatId == null || c.participants == null) continue;
  const ids = c.participants
    .map((p) => handleIdByKey.get(handleMapKey(p)))
    .filter((id): id is number => id != null);
  // An empty / fully-unresolvable participants payload means "no information", NOT
  // "no members" — leave existing links alone.
  if (ids.length === 0) continue;
  keepByChat.set(chatId, ids);
  for (const handleId of ids) links.push({ chatId, handleId });
}
if (links.length > 0) {
  await db.insert(chatHandles).values(links).onConflictDoNothing();
  for (const [chatId, ids] of keepByChat) {
    await db
      .delete(chatHandles)
      .where(and(eq(chatHandles.chatId, chatId), notInArray(chatHandles.handleId, ids)));
  }
}
```

Add `and, notInArray` to the drizzle-orm import. `chat_handles` is keyed `PRIMARY KEY (chat_id, handle_id)` (`src/db/migrations.ts:45-49`), so `onConflictDoNothing()` needs no target and re-inserting an existing link is a no-op.

The `ids.length === 0` skip is also the fix for a third, separate bug: the server can legitimately send `participants: []` (`packages/bbd/src/api/operations/readOperations.ts` `extra.participants = participants.get(rowId) ?? []`), and today `== null` lets that through to the delete, wiping a real chat's links until a received message re-links them.

**Regression risk to respect:** the comment at `chats.ts:60-64` records a hard-won rule — a payload that *includes* participants must PRUNE removed members (the old additive-only version left ex-members in forever), and a payload *without* participants must leave links untouched. The code above preserves both. The worst intermediate state becomes "a chat briefly shows one extra, since-removed participant" instead of "every chat shows a phone number."

**A2 — `src/db/repositories/contacts.ts:182`, add the missing guard.**

```ts
const index = await buildContactIndex(db);
// An empty contacts read means "we don't know", not "every contact was deleted" — reverting
// here blanks display_name on every linked handle (the server never sends one, so
// serverDisplayName is always NULL) and shows raw phone numbers. Mirrors linkHandlesToContacts.
if (index.size === 0) return 0;
```

Trade-off to note in the comment: a user who deletes their *entire* address book keeps existing handle names until a contact exists again. That's the right side to err on.

**A3 — `src/services/contacts/contactsService.ts`, coalesce `syncContacts`** the way `startSync` does (`src/services/syncControl.ts:27-34`): rename the body to `runContactsSync`, and

```ts
let inFlight: Promise<{ contacts: number; matched: number }> | null = null;
export function syncContacts(): Promise<{ contacts: number; matched: number }> {
  if (inFlight) return inFlight;
  inFlight = runContactsSync().finally(() => { inFlight = null; });
  return inFlight;
}
```

Both existing callers keep working unchanged.

### How to verify

**Jest (node project, writable today):** add to `test/db/chatParticipants.test.ts`

1. Upsert a chat with participants A and B; re-upsert the same guid with participants A only; assert `getChatParticipants` returns exactly A (pruning still works — this is the hard-won behavior).
2. Re-upsert with `participants: []`; assert A and B are still there.
3. The real regression guard for the window: wrap `db` so each write pushes a snapshot of `SELECT COUNT(*) FROM chat_handles WHERE chat_id = ?` for chat #1, upsert a 3-chat batch, and assert the count is **never 0** at any commit boundary. That's the assertion that would have caught this.

Add to `test/db/contactsRepo.test.ts`: with contacts empty and a handle that has `contact_id` set, `matchContactsToHandles` returns 0 and leaves `display_name` intact.

**On device (mark as device-only):** open the inbox, pull to refresh repeatedly on an account with 100+ chats, watch for titles briefly flipping to numbers. Cheaper and more reliable: temporarily add a `logger.warn` at the top of `matchContactsToHandles` when `index.size === 0`, and one in the `chatHasKnownSender === false` branch, then read the in-app App Logs after a day of use.

---

## 2. Bug B — inbox doesn't scroll to the newest thread

There are **four** distinct defects stacked here, which is exactly why it feels random. Fix them as one change.

### B1 (primary) — the trigger requires the top chat to *change identity*

`src/ui/conversations/ConversationListScreen.tsx:110-119`:

```ts
const topGuid = listData[0]?.guid;
const topDate = listData[0]?.latestMessageDate ?? 0;
useEffect(() => {
  const prev = prevTopRef.current;
  prevTopRef.current = topGuid != null ? { guid: topGuid, date: topDate } : null;
  if (searching || topGuid == null || prev == null) return;
  if (prev.guid !== topGuid && topDate > prev.date) {     // line 116
    listRef.current?.scrollToTop({ animated: true });
  }
}, [topGuid, topDate, searching]);
```

When the chat already at row 0 gets another message, `prev.guid === topGuid`, so nothing scrolls. That's the most common case in the world (an active conversation).

The `prev.guid !== topGuid` clause was added to suppress "a same-chat update", but it buys nothing: `latest_message_date` is `MAX(date_created)` (`src/db/repositories/messages.ts:228`), so a delivery receipt / read marker / avatar backfill / localPath write leaves it unchanged and already fails `topDate > prev.date` on its own.

### B2 — pinned chats are invisible to the trigger *and* to the eye

`ConversationListScreen.tsx:96-97` splits `pinned` out of `listData`, and the effect only reads `listData[0]`. A message to a pinned chat therefore changes neither dep, so the effect doesn't even re-run. Meanwhile `PinnedGrid` renders only an avatar and a name — no badge, no preview, no timestamp (`src/ui/conversations/PinnedGrid.tsx:40-68`, `unreadCount` is never referenced in the file) — and it's the `ListHeaderComponent` (`ConversationListScreen.tsx:289`), i.e. off-screen when scrolled down. For a user who pins their most important chats, the Messages screen is completely inert.

### B3 — a transient empty list wipes the baseline

Line 114 writes `null` when the list is empty, and line 115 returns early on `prev == null`. `useReactiveQuery` sets `data: null` on **any** query error (`src/db/useReactiveQuery.ts:78-86`), which the screen maps to `rows = data ?? []` (line 42). One failed re-query nulls the baseline; the next successful one only re-seeds it and returns — swallowing a real bump.

### B4 — the one-shot animated scroll loses a race with FlashList

`scrollToTop({ animated: true })` at line 117 is fired once, from a **passive** effect. FlashList v2 has `maintainVisibleContentPosition` on by default (`node_modules/@shopify/flash-list/src/recyclerview/RecyclerViewManager.ts:329-334`) and defers its offset correction by one commit when the layout changed (`RecyclerView.tsx:220-229`). Our passive effect runs *between* those, and the correction then scrolls away from where we put it. On Android the correction path ends in `ReactScrollView.scrollToPreservingMomentum` → `recreateFlingAnimation`, which begins by cancelling any running fling — and an animated `scrollTo` *is* that fling. So the smooth scroll is killed mid-flight.

The nastiest case: the user is already at offset 0 and a chat lower down bumps to index 0. `scrollTo({y: 0, animated: true})` does nothing (already there), then the correction keeps the *old* row 0 stationary by scrolling **down** one row — pushing the brand-new top conversation above the fold, with no recovery.

Row heights do vary, which is what triggers the deferred branch: `src/ui/conversations/ConversationTile.tsx:180` `numberOfLines={compact ? 1 : 2}`.

### B5 — an incoming tapback reorders the inbox and fires a scroll for nothing

`src/db/repositories/messages.ts:225-231` recomputes `latest_message_date` as `MAX(date_created) ... WHERE date_deleted IS NULL` with **no** exclusion of reaction rows, while the inbox preview CTE explicitly excludes them (`src/db/repositories/chats.ts:388` `m2.associated_message_type IS NULL`) and so does the unread count (`chats.ts:415-421`). So an incoming "liked" on a three-day-old message yanks that chat to the top with an unchanged three-day-old preview and timestamp — and it is exactly the shape that *does* pass the current scroll gate.

This also silently defeats a rule the repo already documented and tested: `src/db/repositories/outgoing.ts:150-153` "Unlike a text send this does NOT bump latestMessageDate — a tapback must not reorder the inbox" (locked by `test/services/sendReactionService.test.ts:101`). That guarantee survives exactly one round-trip, until the server echoes your tapback back as a `new-message`.

### Recommended design — copy the chat screen's convergence loop

The codebase already solved this class of problem on the chat side and AGENTS.md records the lesson: **corrective scrolls are `animated: false` and are re-issued on every content-size/layout change until the user drags** (`src/ui/conversations/MessageList.tsx:274-276` and `:286-293`). `animated: true` is reserved for user-initiated scrolls. The inbox got a one-shot instead. Give it the same machine, minus the parts it doesn't need (there's no anchored/frozen mode here).

**Replace `ConversationListScreen.tsx:108-119` with:**

```ts
const listRef = useRef<FlashListRef<InboxRow>>(null);

// Newest message anywhere in the inbox — PINNED INCLUDED, so a pinned bump still scrolls to 0
// and reveals the grid. Rises only on a real message: latest_message_date is MAX(date_created).
const newestDate = useMemo(
  () => visible.reduce((m, r) => Math.max(m, r.latestMessageDate ?? 0), 0),
  [visible],
);
const prevNewestRef = useRef<number | null>(null);

// THE CONVERGENCE LOOP (mirrors MessageList): FlashList v2's offset correction runs a commit
// AFTER this effect and cancels an animated scroll, so a one-shot lands mid-list. Re-issue a
// non-animated scroll on every content-size change until the user grabs the list.
const wantTopRef = useRef(false);
const requestScrollToTop = useCallback((): void => {
  wantTopRef.current = true;
  listRef.current?.scrollToTop({ animated: false });
}, []);
const onContentSizeChange = useCallback((): void => {
  if (wantTopRef.current) listRef.current?.scrollToTop({ animated: false });
}, []);
const onScrollBeginDrag = useCallback((): void => {
  wantTopRef.current = false;   // a finger-down drag is the only unpin signal
}, []);

useEffect(() => {
  const prev = prevNewestRef.current;
  // Never reset to null: an empty/failed pass must not swallow the next genuine bump.
  if (newestDate > 0) prevNewestRef.current = newestDate;
  if (searching || newestDate === 0 || prev == null) return;
  if (newestDate > prev) requestScrollToTop();
}, [newestDate, searching, requestScrollToTop]);
```

and on the FlashList (`ConversationListScreen.tsx:281-305`, which currently has neither prop) add `onContentSizeChange={onContentSizeChange}` and `onScrollBeginDrag={onScrollBeginDrag}`.

Skip an `onScroll` + `scrollEventThrottle={16}` handler — a drag is the only way the user leaves the top, and that already clears the flag. Do **not** pass `maintainVisibleContentPosition={{ disabled: true }}`; that's what keeps the list steady while the user reads.

**Also:**
- `src/db/repositories/messages.ts:228` and the matching recompute in `markMessageDeleted` at `:686-692` — add `AND associated_message_type IS NULL` to both, so the sort key agrees with the preview CTE and with the outgoing rule. Update the doc comment at `:665-668` (which requires the two to stay identical) to mention reactions.
- `src/ui/conversations/PinnedGrid.tsx` — add an unread dot to the cell from `row.unreadCount` (the query already returns it, `chats.ts:415-421`). Presence only, no count; the cell is ~64px. Add the unread state to the existing `accessibilityLabel` at line 48.

### How to verify

**The blocker first: the test mock throws the ref away.** `test/components/conversations/conversationListScreen.test.tsx:45` is `_ref: unknown` with no `useImperativeHandle`, so `listRef.current` is permanently `null` and `scrollToTop` is unobservable. A repo-wide grep for `scrollToTop` outside `node_modules` matches exactly one line — `ConversationListScreen.tsx:117`. **Nothing in the suite tests this effect**, which is why the bug shipped.

Wire it:

```ts
const scrollToTopSpy = jest.fn();
// in the mock factory, replacing `_ref: unknown`:
  ref: unknown,
) {
  ReactLib.useImperativeHandle(ref, () => ({ scrollToTop: scrollToTopSpy }), []);
```

Then lock the corrected contract: (a) first data arrival seeds only, no scroll; (b) a newer `latestMessageDate` on the chat **already at row 0** DOES scroll; (c) a different chat bumping to row 0 with a newer date scrolls; (d) archiving the top chat so an *older* chat surfaces does NOT scroll; (e) a **pinned** chat receiving a newer message DOES scroll; (f) an error pass emptying the list, then recovery with a bump, still scrolls; (g) nothing scrolls while `searching`. Reset the spy in `beforeEach` (not `afterEach`) and `await act(async () => …)` around each re-drive of the `useChats` mock — both per AGENTS.md.

Add a config-level guard in the same style as `test/components/conversations/messageSwipeWrapper.test.tsx`: assert the FlashList receives `onContentSizeChange` and `onScrollBeginDrag`, so the convergence loop can't be silently deleted.

Node test for B5 in `test/db/messagesRepo.test.ts`: ingest a reaction for an old chat via `upsertMessages`, assert `latest_message_date` is unchanged.

**Device-only:** scroll down in a long inbox, have someone send several messages to the chat already at the top, and confirm the list lands and *stays* at row 0 (the convergence loop's whole point is surviving the late row-height change from a two-line preview).

---

## 3. State-pattern audit

Five themes, ordered by real impact.

### Theme 1 — No mutual exclusion around shared async resources (highest impact)

Four instances of the same missing discipline: an async operation with no in-flight guard on a resource that only supports one at a time.

**1a. Overlapping DB transactions silently discard writes. This is the most severe item in the whole report.**

`src/db/transaction.ts:20-32` issues a literal `BEGIN IMMEDIATE` / `COMMIT` on the single shared connection. Nothing serializes realtime event handling — `src/services/realtime/socketService.ts:169-173` is fire-and-forget:

```ts
for (const event of SERVER_EVENTS) {
  this.socket.on(event, (data: unknown) => {
    void this.router.handle(event, data, 'socket');
  });
}
```

and `DbEventSink.onEvent` awaits several things (`dbEventSink.ts:41,45,64`) before reaching its transaction at `:81`, guaranteeing an interleave window. SQLite's behavior was reproduced against better-sqlite3 (the Node-test driver): the second `BEGIN IMMEDIATE` throws *"cannot start a transaction within a transaction"*, its `catch` runs `ROLLBACK` — **which succeeds and aborts the FIRST transaction** — and the first transaction's `COMMIT` then throws.

User-visible result: two received messages vanish from the thread and the inbox, **and neither posts a notification** (`notifyingEventSink.ts:23-27` awaits the inner sink before building intents), with no retry (`eventRouter.ts:72-74` rethrows into a `void`). Dedup doesn't save you — it only covers `new-message` by guid (`eventRouter.ts:89-93`), and in the foreground both socket and FCM are live (`fcmMessaging.ts:113`), so even the *same* guid can run the transaction twice concurrently.

Fix — a promise-chain mutex in `src/db/transaction.ts`:

```ts
// One shared connection => only one transaction may be open at a time. Realtime events are
// dispatched fire-and-forget, so two handlers can reach BEGIN IMMEDIATE at once: the second
// throws and its ROLLBACK aborts the FIRST one's writes. Queue them instead.
// CAVEAT: `fn` must never itself call withDbTransaction — that would deadlock.
let chain: Promise<void> = Promise.resolve();

export async function withDbTransaction<T>(db: AppDatabase, fn: () => Promise<T>): Promise<T> {
  const prev = chain;
  let release!: () => void;
  chain = new Promise<void>((r) => (release = r));
  await prev;
  try {
    await db.run(sql`BEGIN IMMEDIATE`);
    try {
      const result = await fn();
      await db.run(sql`COMMIT`);
      return result;
    } catch (err) {
      try { await db.run(sql`ROLLBACK`); } catch { /* already aborted */ }
      throw err;
    }
  } finally {
    release();
  }
}
```

Two details that matter: `release()` must be in a `finally` wrapping the `BEGIN` too, and the chain link must be a promise that can only *resolve* — if it could reject, one failed transaction would wedge the queue forever.

Also fix the silent failure: `socketService.ts:171` → `void this.router.handle(event, data, 'socket').catch((e) => logger.warn('[socket] event handling failed', { event, error: e }));`.

**1b. `findmyStore.refresh()` has no in-flight guard, and the call site's comment claims one that doesn't exist.** `src/state/findmyStore.ts:110` is `create<FindMyState>((set) => ({` — no `get`, so `refresh` structurally cannot read its own `refreshing` flag. `app/(app)/findmy.tsx:44-50` polls it on a bare 60s interval, and its comment says "The store's `refreshing` guard coalesces overlapping refreshes." The only real guard is `disabled={refreshing}` on the header button (`findmy.tsx:82`), which neither the interval nor the pull-to-refresh goes through. Because every run ends with an unconditional `refreshing: false`, the first run to settle re-enables the button and its data write can be overwritten out of order by a later-settling run.

Fix: change the creator to `(set, get) => ({` and make `refresh` start with `if (get().refreshing) return;`. Don't add the same guard to `load` — it's called once from a mount effect and gating it adds a failure mode for nothing.

**1c. `syncContacts` is uncoalesced** — covered as A3 above.

**1d. URL previews have no in-flight dedupe, so previews fetch each other's URLs repeatedly.** `src/features/conversations/useUrlPreview.ts:6` subscribes to the whole `url_previews` table, and the network fetch happens *inside* the reactive query (`:33` `const result = await fetchOgMetadata(url);`, `:38-49` `await setUrlPreview(...)`). op-sqlite fires reactive callbacks per **table**, so when one bubble's preview resolves and writes, every other mounted hook re-runs — and the ones still waiting on their own fetch see no cache row and start a *second* fetch of the same URL. Ten links can produce ~50 outbound requests to third-party hosts.

Fix in `src/services/urlPreview.ts` — rename the current body to `fetchOgMetadataUncached` and wrap it:

```ts
// One fetch per URL at a time. Every URL bubble's lookup lives in a reactive query that re-fires
// on ANY url_previews write, so without this a resolving sibling restarts every still-unresolved
// bubble's fetch of the same URL.
const inFlight = new Map<string, Promise<OgFetchResult>>();

export function fetchOgMetadata(url: string): Promise<OgFetchResult> {
  const existing = inFlight.get(url);
  if (existing) return existing;
  const p = fetchOgMetadataUncached(url).finally(() => inFlight.delete(url));
  inFlight.set(url, p);
  return p;
}
```

It already never rejects (`urlPreview.ts:212-214`), so there's no rejection leak. Node-testable: call twice with a stubbed fetch, assert one network call. Skip the proposed "cache the last resolved row in a ref" — that's a clever caching layer to save one indexed SELECT.

### Theme 2 — Non-atomic multi-write sequences that the UI can observe

This is Bug A's theme, and A1/A2 are the fixes. The general rule worth writing down somewhere: **because every write flushes the reactive queries, "delete everything then re-insert everything" is never safe in this codebase.** Always add first, prune second, and make an empty/unresolvable payload mean "no information" rather than "empty set." A transaction is not an escape hatch here.

### Theme 3 — Unstable callbacks make "run once on mount" effects run on every navigation

**3a. The notification-tap drain re-fires forever, and can trap the user in a chat.** `src/ui/useChatNavigator.ts:36,49` — `usePathname()` is a `useSyncExternalStore` subscription, so `openChat`'s identity changes on every route change. `app/(app)/_layout.tsx:85-92` makes `consumeNotificationTap` depend on it, and the effect at `:113-115` — commented "drained here on mount" — therefore re-runs on every navigation inside `(app)`, plus on every AppState `active` (`:122-127`).

That would be harmless if `getInitialNotification()` were read-once, which is what `src/services/notifications/notificationOpen.ts:88-90` assumes. On Android it isn't: `Notifee.java:433-459` pops the sticky event and, finding none, **falls back to `activity.getIntent()`**, which still carries the `"notification"` extra that `NotificationPendingIntent.java:74` put on the launch intent. RN never calls `setIntent`, so that extra persists for the Activity's whole life.

Failure: cold-start the app by tapping a notification for chat A → land in chat A → press Back → the effect re-runs → `getInitialNotification()` returns the same notification → `resolveChatNavigation('/home', '/chat/A')` returns `'push'` → thrown straight back into chat A. The user cannot reach the inbox. Backgrounding and resuming does it too.

Fix, two parts. The essential one, in `notificationOpen.ts`: a real press event always carries a `pressAction` bundle; Android's launch-intent echo carries only `"notification"`. Use that as the discriminator.

```ts
// Android's getInitialNotification() is NOT read-once: once the sticky press event is consumed
// it falls back to the Activity's LAUNCH INTENT, which keeps its "notification" extra for the
// Activity's whole lifetime — so every later drain would re-open the launching chat. The echo
// carries no pressAction; skip it.
const raw = await getInitial();
const initial = raw?.pressAction ? raw : null;
```

Then stabilise the hook in `src/ui/useChatNavigator.ts`, using the read-a-ref-during-render pattern MessageList already uses (`focusReadyRef.current = focusReady`):

```ts
const pathnameRef = useRef(pathname);
pathnameRef.current = pathname;
return useCallback((path: string): void => {
  reportChatOpened(chatGuidFromPath(path));
  const action = resolveChatNavigation(pathnameRef.current, path);
  if (action === 'push') router.push(path);
  else if (action === 'replace') router.replace(path);
}, [router]);
```

That also stops the `notifee.onForegroundEvent` subscription and the AppState listener being torn down and re-added on every navigation. Fixing the hook covers every caller — no ref wrapper needed in `_layout.tsx`.

Tests in `test/services/notificationOpen.test.ts`: an initial *without* `pressAction` must not navigate; the same call must still navigate from the `pending` stash.

**3b. A stale index in the chat's focus-scroll.** `src/ui/conversations/MessageList.tsx:214-228` guards on `focusedRef.current === focusGuid` but its 450 ms deferred `scrollToIndex` closes over `focusIndex`, which is recomputed when the anchored window arrives (`useReactiveQuery` keeps the previous deps' rows meanwhile). Note `jump` is *not* in `screenKey` (`app/(app)/chat/[guid].tsx:109`), so a mid-session jump doesn't remount and doesn't hit the loading gate. Usually the stale index is out of range and FlashList silently ignores it (`useRecyclerViewController.js:261-263` bounds-checks) — so the centering nudge is just lost. But with >100 unread, or a ThreadSheet jump near the top of the window, the index *is* in range and it actively scrolls to the wrong message half a second after landing.

Minimal fix — read the index at fire time via a ref instead of closing over it:

```ts
const focusIndexRef = useRef(focusIndex);
focusIndexRef.current = focusIndex;
// … inside the timeout:
const index = focusIndexRef.current;
if (index < 0) return;
```

**Do not** add `focusIndex` to the FlashList `key` (`MessageList.tsx:343`) — that remounts the list and throws away scroll position every time the anchor shifts, which is worse than the bug.

### Theme 4 — Two sources of truth that disagree

**4a. Read markers only advance on chat open.** `app/(app)/chat/[guid].tsx:224-248` has deps exactly `[guid]` and calls `markRead(guid)` (`:239`) + `clearChatNotification(guid)` (`:241`) once per open. Nothing advances the marker while the screen stays mounted (`setLastReadMessageGuid` has two callers: `chatActions.markRead` and the remote `chat-read-status-changed` handler at `dbEventSink.ts:129`). And there is no active-chat notification suppression anywhere — `buildMessageIntents` (`intents.ts:18-67`) gates only on `isFromMe`, missing guid, and mute. So messages you watch arrive in an open thread both post a heads-up notification and leave a bold unread badge behind when you press Back.

Fix — add a second effect, and **don't** restructure the mount effect (it deliberately reads the *old* marker first to compute `firstUnread`; see the comment at `:215`):

```ts
// Keep the read marker current while the thread is open: a message that arrives and renders
// here has been read. Armed only after the mount effect captured firstUnread.
const readTrackingArmed = useRef(false);
const newestReceivedGuid = useMemo(
  () => messages.filter((m) => m.isFromMe === 0).at(-1)?.guid,
  [messages],
);
useEffect(() => {
  if (!guid || !newestReceivedGuid || !readTrackingArmed.current) return;
  void markRead(guid);
  clearChatNotification(guid);
}, [guid, newestReceivedGuid]);
```

Set `readTrackingArmed.current = false` as the mount effect's first statement and `true` right after its `markRead`. `messages` is oldest→newest (`chat/[guid].tsx:154`).

**4b. Reaction rows bump the inbox sort key but not the preview** — covered as B5.

**4c. `forget()` clears credentials but leaves the entire local database.** `src/services/bootstrap.ts:126-141` stops reachability, disconnects the socket, clears Direct Share chips, deletes two vault keys, resets the session store — and never touches the DB. Nothing anywhere truncates `chats`/`messages`/`handles` or resets `sync_markers`. So after Disconnect → connect to a different server, the inbox still shows the previous server's conversations and message bodies interleaved with the new ones. On a shared device that's a straight leak of someone else's threads. The stale marker also forces the incremental branch (`src/services/syncControl.ts:64-65`) with a cursor built from the old server's max ROWID.

(Correction to the raw finding: history is not entirely lost — `syncAllChats` still pages the chat list and `ensureChatSynced` backfills on open. The persistent old-data leak is the real problem.)

Fix — a `clearLocalCache(db)` helper (e.g. `src/db/repositories/maintenance.ts`) deleting from `attachments`, `messages`, `chat_handles`, `chats`, `handles`, `outgoing_queue`, `scheduled_messages`, `reminders`, `url_previews` (children first — FK enforcement is on, `database.ts:79`), then `UPDATE sync_markers SET last_synced_row_id = NULL, last_synced_timestamp = NULL` and deleting the deletions watermark from `kv`. The `messages_fts` AFTER DELETE trigger (`migrations.ts:151`) keeps search consistent. Call it from `forget()` in a try/catch just before `useSessionStore.getState().reset()`, and update the confirm dialog at `app/(app)/settings.tsx:101` so the full re-sync isn't a surprise.

**Don't** make this conditional on "did the origin change" — `applyNewServerUrl` legitimately rewrites the origin for the *same* server on a tunnel rotation, and `ServerInfo` carries no stable identity to key on.

### Theme 5 — Hydration ordering and lifecycle leftovers (lowest impact)

**5a. The root-layout `hydrateAllStores()` can never succeed on a cold launch.** `getDatabase()` throws until `initDatabase()` runs (`src/db/database.ts:85-88`), every store's `hydrate()` calls it before its first `await`, and `app/_layout.tsx:75` runs before `void boot()` on line 78 — which itself only reaches `ensureDatabase()` after `applyStoredCertPins()` + `hydrateLock()` (`bootstrap.ts:64-76`). This is documented and unit-tested (`src/state/hydrateStores.ts:7-12`, `test/state/hydrateStores.test.ts:46-58`), so it's not a surprise — but two consumers read settings in the gap before `home.tsx:37` re-hydrates:

- `runSync` reads `useSyncSettingsStore.getState().messagesPerChat` (`syncControl.ts:69`) after only two fast local ops, so a user who chose 25 or 500 messages/chat gets the unhydrated default (which resolves to 100/chat at `engine.ts:108`, *not* all history — the raw finding overstated this).
- `ThemeProvider`'s anti-flash gate (`src/ui/theme/ThemeProvider.tsx:36-44`) opens one frame later with the *default* preset, because `themeStore.hydrate()`'s catch sets `hydrated: true` (`src/state/themeStore.ts:65-67`). So a `gator`-preset or custom-theme user watches the whole boot (and the lock screen) render in `oled-dark`, then flash. Cosmetic.

Fix — one line in `src/services/bootstrap.ts`: inside `hydrateSession()`, right after `await ensureDatabase()`, add `await hydrateAllStores();`. That's the first point the DB is known open, it's still before `void startSync()` (line 43), and it covers the app-locked path because `completeUnlock()` calls `hydrateSession()`. Leave `app/_layout.tsx:75` and `home.tsx:37` alone (cheap idempotent retries), leave the per-store try/catch alone, and **leave `themeStore`'s `set({ hydrated: true })` on failure alone** — it's the correct never-hang fallback and is locked by `test/state/themeStore.test.ts:86`.

**5b. Toast backlog from headless FCM wakes.** `src/ui/toast/toastStore.ts:26-39` is a FIFO with no TTL and no host-awareness; only the mounted `AppToast` ever calls `dismiss()` (`AppToast.tsx:20-30`). A killed-app FCM wake runs auto-download → `showToast` with nothing to drain it, so if Android reuses that JS context when the user later opens the app, stale "Downloaded 2 images" pills replay. Fix: add `createdAt: Date.now()` in `enqueue`, and in `AppToast`'s effect after the `if (!current) return;` guard, `if (Date.now() - current.createdAt > 15_000) { dismiss(); return; }`. Don't add a mount-time store reset — that would also wipe a toast legitimately enqueued in the same commit. Device-only to confirm.

---

## 4. Prioritized worklist

Each item is independently verifiable. Items 1-2 are the reported bugs; 3 is the most severe defect found; the rest are grouped so related edits land together.

| # | Change | Files | Size | Risk | Verify |
|---|---|---|---|---|---|
| **1** | **Bug A core:** `upsertChats` add-then-prune; skip on empty/unresolvable participants | `src/db/repositories/chats.ts:65-77` | **S** | **Med** — touches the hard-won prune semantics at `chats.ts:60-64`. Keep both rules. | New tests in `test/db/chatParticipants.test.ts` (prune still works; `[]` leaves links; count never hits 0 mid-batch). `npm test` |
| **2** | **Bug A secondary:** empty-index guard in `matchContactsToHandles`; coalesce `syncContacts` | `src/db/repositories/contacts.ts:182`, `src/services/contacts/contactsService.ts` | **S** | Low | Test in `test/db/contactsRepo.test.ts`: empty contacts + a linked handle → returns 0, `display_name` intact |
| **3** | **Bug B:** newest-timestamp trigger over `visible` + convergence loop (`animated:false`, `onContentSizeChange`, `onScrollBeginDrag`); never null the baseline | `src/ui/conversations/ConversationListScreen.tsx:108-119` and the FlashList at `:281-305` | **M** | **Med** — copies MessageList's proven pattern; don't invent a new one | Item 4's tests; then **device-only**: confirm landing survives a two-line-preview row growth |
| **4** | **Wire the FlashList mock's ref** + 7 scroll contract tests + a props-present guard | `test/components/conversations/conversationListScreen.test.tsx:45` | **M** | Low | `npm test` — must fail before item 3, pass after |
| **5** | Reactions stop bumping the inbox sort key (both recomputes) | `src/db/repositories/messages.ts:228` and `:686-692` | **S** | Low — aligns with the preview CTE and `outgoing.ts:150-153` | Node test: reaction ingest leaves `latest_message_date` unchanged |
| **6** | Unread dot on pinned cells | `src/ui/conversations/PinnedGrid.tsx` | **S** | Low | Extend `test/components/conversations/pinnedGrid.test.tsx` |
| **7** | **Transaction mutex** (+ `.catch` on the socket dispatch) | `src/db/transaction.ts:20-32`, `src/services/realtime/socketService.ts:171` | **S** | **Med** — a broken chain would deadlock all writes; the shape above can only resolve. `fn` must never nest. | `test/db/withDbTransaction.test.ts`: start two without awaiting the first; assert both commit |
| **8** | Notification drain: ignore Android's launch-intent echo; stabilise `useChatNavigator` | `src/services/notifications/notificationOpen.ts:88-90`, `src/ui/useChatNavigator.ts:36-49` | **M** | Med — `useChatNavigator` is the single entry point for opening a chat; its push/replace/none rules must not change | Node tests in `test/services/notificationOpen.test.ts`. **Device-only:** `adb shell am kill <pkg>` (never `force-stop`), tap a notification, press Back — must land on Messages |
| **9** | Live read-marker while a thread is open | `app/(app)/chat/[guid].tsx` (new effect after `:248`) | **S** | Low — don't touch the mount effect's `firstUnread` capture | **Device-only:** stay in a thread, receive 3 messages, press Back — no badge, no tray notification |
| **10** | `forget()` wipes the local cache + sync marker | `src/db/repositories/maintenance.ts` (new), `src/services/bootstrap.ts:126-141`, `app/(app)/settings.tsx:101` | **M** | Med — destructive; must run in try/catch so logout never fails | Node test on the helper (all tables empty, marker null). **Device-only:** disconnect → reconnect to a different server → inbox is empty then repopulates |
| **11** | `hydrateAllStores()` after `ensureDatabase()` in `hydrateSession()` | `src/services/bootstrap.ts` | **S** | Low | `npm test`; **device-only:** set messages/chat to 25, kill mid-first-sync, relaunch, confirm the cap is honoured |
| **12** | `findmyStore.refresh()` in-flight guard | `src/state/findmyStore.ts:110,146` | **S** | Low | Extend `test/state/findmyStore.test.ts` |
| **13** | URL-preview in-flight dedupe | `src/services/urlPreview.ts` | **S** | Low | Node test: two concurrent calls → one fetch |
| **14** | Focus-scroll reads the index at fire time | `src/ui/conversations/MessageList.tsx:214-228` | **S** | Med — MessageList is the most behaviour-locked file in the repo; change *only* the timeout body | Existing `messageListPinned` / `messageList` tests must stay green. **Device-only:** chat with >100 unread → jump chip → no yank ~0.5s after landing |
| **15** | Toast staleness drop | `src/ui/toast/toastStore.ts`, `src/ui/toast/AppToast.tsx` | **S** | Low | **Device-only:** `am kill`, 3 image pushes, relaunch — no stale pills |

Suggested batching: **1+2** (Bug A), **3+4+5+6** (Bug B), **7** alone (it's the scariest and the most valuable), **8+9** (notification/read correctness), **10+11** (lifecycle), **12+13+14+15** (hygiene).

Run `npm run typecheck && npm test` after each batch, not at the end.

---

## 5. Explicitly NOT worth doing

- **Adding a tiebreaker to the inbox `ORDER BY`.** `chats.ts:426-427` really has no final sort key, but SQLite materializes a deterministic sorter for a fixed plan and unchanged data, so consecutive re-queries can't flip two rows. Nothing to observe. (`DESC NULLS LAST` at `chats.ts:323/329` is also a no-op in SQLite — NULLs sort lowest already — so `listChats` and `listChatsForInbox` are not actually inconsistent.) Harmless to add someday; changes nothing today.
- **Pruning `downloadStore`'s progress/status maps.** Entries do not accrue by scrolling: `ImageAttachment.tsx:49` gates on `shouldAutoDownload(att)`, which returns false the moment a file is local (`src/utils/attachment.ts:66`). And `status` is load-bearing as the session "already attempted" marker that prevents a re-download storm — **leave it alone**.
- **Adding `attachments` to `useChats`' subscribed tables.** `upsertMessages`' *last* write is always the `chats` UPDATE (`messages.ts:224-230`), and `chats` is already subscribed — so the inbox is woken after attachments have landed regardless of timing. There is also no attachment-only write that can change an inbox column (`upsertAttachments` has exactly one caller).
- **Filtering "degraded" rows inside `publishShareShortcuts`.** Fixing item 1 removes the source, including for the non-debounced `refreshShareShortcuts()` path. A per-row filter would *permanently* hide chats that legitimately have no participant links, trading a transient cosmetic issue for a silent permanent one.
- **Using `withDbTransaction` to fix Bug A.** Reads go through the same connection and see uncommitted rows, so it closes nothing — and `transaction.ts:15-17` warns that a bystander write joining the transaction would be lost on rollback.
- **Making `upsertContacts` a non-destructive sourceId upsert.** Once `syncContacts` is coalesced (item 2), the delete-then-insert window has no concurrent reader that can act on it. Churn.
- **Removing `themeStore`'s `set({ hydrated: true })` in its catch, or adding a timeout to `ThemeProvider`'s gate.** The catch is the correct never-hang fallback and is unit-tested. Item 11 fixes the ordering, which is all that's needed. The lock screen stays default-themed by design — the preset lives in the encrypted DB that app-lock deliberately keeps shut.
- **Putting `focusIndex` in `MessageList`'s FlashList `key`, or threading the queried `anchorDate` back out of `useMessages`.** The first remounts the list and destroys scroll position; the second is a large change for a best-effort centering nudge. If it ever matters, the boring version is to add `jump` to `screenKey` so the existing loading gate handles it.
- **An `onScroll` + `scrollEventThrottle={16}` handler on the inbox**, or `maintainVisibleContentPosition={{ disabled: true }}`. The first adds a JS callback per scroll frame for nothing; the second removes the thing that keeps the list steady while the user reads.
- **Serializing events at the `EventRouter` level.** The transaction mutex (item 7) is smaller and covers every current and future caller.

---

**One thing to take away:** the two reported bugs and half the audit share a single root pattern — *asynchronous work with no guard on a resource that only supports one at a time*, whether that resource is the participant-links table, the SQLite connection, an HTTP endpoint, or the contacts table. When you write `await` inside a loop or a fire-and-forget handler in this codebase, ask "what happens if a second one of these starts right here?" — because with reactive queries flushing after every write, the answer is usually "the user sees it."