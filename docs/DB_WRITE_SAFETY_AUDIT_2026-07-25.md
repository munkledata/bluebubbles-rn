# Gator RN — Database Write-Safety Audit

**Scope:** every write path in `src/db/repositories/**` (128 exported functions) and their callers — sync engine, realtime (socket + FCM, including killed-app wakes), UI actions, the 20 s tickers, the outgoing/scheduled/error-report queues, contacts sync, downloads and URL previews.
**Date:** 2026-07-25 · **Method:** six independent read-only lenses (non-atomic sequences, read-modify-write, conflict clauses, queues/leases, concurrency drivers, delete paths), then a verification pass that tried to *refute* each candidate. Findings that survived are below; one was refuted outright and is listed at the end so you don't re-chase it.

A few words defined once, because they're used throughout:

| Term | Plain meaning |
|---|---|
| **commit** | The moment a write becomes permanent and visible to everyone else. |
| **autocommit** | A single statement that commits on its own, with no surrounding transaction. Almost every write in this app is one of these. |
| **transaction** | A group of statements that all commit together or all get undone together ("rolled back"). |
| **race / interleaving** | Two things running at once, where the order they happen to hit the database changes the result. |
| **read-modify-write** | Read a value into JavaScript, decide something, then write. Anything that changes in between is invisible to you. |
| **compare-and-set** | The safe alternative: put the condition in the `WHERE` clause so the database checks it *at the instant of the write*. |
| **conflict clause** | The `onConflictDoUpdate` part of an upsert — what to overwrite when the row already exists. |
| **lease / claim** | A row marked "I'm working on this" by a single atomic `UPDATE … WHERE … RETURNING`, so only one worker can own it. |
| **tombstone** | Marking a row deleted (`date_deleted`) instead of removing it, so the next sync can't resurrect it. |
| **headless** | The app woken by Android with no screen and no React — a killed-app push or a notification button. |

---

## 1. Verdict

**The write layer's building blocks are sound. Its seams are not.**

The hard parts are right: the atomic claims (`claimOutgoing`, `claimScheduled`, `claimErrorReports`) are real single-statement locks, the transaction mutex is correctly implemented, the database open is genuinely single-flight, the socket/FCM dedup claim-and-release is airtight, foreign-key delete ordering is correct in both bulk paths, and the FTS search index cannot drift out of sync with the messages table. Six auditors went looking for holes in those and found none.

**26 real problems survived verification: 16 confirmed, 10 where the mechanism is proven but reachability isn't.** They cluster in three places — (a) UI actions that reach around the queue's lock, (b) guards that read a value into JavaScript and then use the stale copy as a SQL condition, and (c) places that empty something in order to refill it.

**The worst one needs no crash, no rare timing, and no unusual setup.** Tapping **"Try Again"** on a failed message can deliver that message to the recipient **twice**, and tapping **"Delete"** on it can deliver it anyway and then re-materialise it in your thread as a normal sent bubble. It happens because the retry sheet holds a stale snapshot and deletes the queue row that the automatic 20-second retry is *currently POSTing* — then re-sends under a brand-new id, which defeats the server's duplicate protection. `src/services/send/index.ts:266`.

Second-worst, and the one I'd fix in the same sitting: an **unsent (retracted) message can come back to life with its text visible**, because four date columns are plain-overwritten from a stale sync page (`src/db/repositories/messages.ts:108-111`).

Nothing here corrupts the database. The damage is: messages delivered twice, messages the user deleted being sent anyway, read state silently reverting, and per-chat customisations being destroyed.

---

## 2. Confirmed data-loss risks

Ordered by severity. "Likelihood" means *what a person has to be doing* for it to fire.

| # | What breaks | Where | Likelihood |
|---|---|---|---|
| D1 | Message delivered twice / deleted message sent anyway | `send/index.ts:266,280` | Ordinary usage |
| D2 | Unsent message reappears with its text | `messages.ts:108-111` | Ordinary usage |
| D3 | Scheduled message sent twice or three times | `scheduleService.ts:92` | App killed mid-send |
| D4 | "Mark as Unread" silently undone | `chats.ts:180` | Ordinary usage |
| D5 | Read marker regresses; chat goes bold again | `chats.ts:195` | Sync + chat open overlap |
| D6 | Notifications lose the contact name / are dropped | `contacts.ts:24` | Every connect, brief window |
| D7 | Deleted conversation returns, customisations gone | `chats.ts:244` | Deterministic |
| D8 | Deleted messages come back on next chat open | `messages.ts:642` | Deterministic |
| D9 | Mac's read state discarded on first sync | `chats.ts:128` | Every fresh install |
| D10 | Deleted chat's reminders + scheduled sends orphaned | `chats.ts:238` | Deterministic |
| D11 | "Mark All Read" un-does itself in some chats | `chats.ts:605` | One stuck send anywhere |
| D12 | Headless "Mark as read" button does nothing | `chatActions.ts:55` | Killed app |
| D13 | Retry ladder under-schedules; duplicate uploads | `outgoingQueueService.ts:161` | Every failed retry |
| D14 | Chat wallpaper disappears when offline | `chats.ts:50` | Offline chat open |
| D15 | Shared photo stuck at wrong aspect ratio forever | `attachments.ts:66` | Deterministic |
| D16 | Restoring a backup twice duplicates every theme | `backup.ts:63` | Second restore |

---

### D1 — CRITICAL · "Try Again" / "Delete" on a failed message race the automatic retry
*(merges three separate lens findings: Q1, Q2, CONC-2)*

**What breaks.** The recipient receives the same message (or the same photo) twice, and your own thread shows two identical bubbles. On the Delete path, a message you explicitly deleted is delivered to the recipient anyway and then reappears in your thread as a normal sent message.

**The interleaving, in plain English.** A send fails, so the app stores an error bubble plus a retry row. The chat screen drains that retry queue **every 20 seconds** (`app/(app)/chat/[guid].tsx:348`, interval at `:355`), and also on every app resume (`app/(app)/_layout.tsx:58`).

1. The 20 s drain picks up the failed row, takes the lease (`claimOutgoing`, `outgoing.ts:732`), flips the bubble to "sending", and starts a network POST that runs for seconds — with **no timeout at all** for an attachment upload (`src/core/api/http.ts:186-190`, "No timeout (uploads can run for minutes)").
2. Meanwhile the user has the red bubble's sheet open. That sheet holds a **frozen copy** of the message (`MessageList.tsx:132-133`, `const [failed, setFailed] = useState(...)`), so it does *not* close or update when the bubble flips to "sending".
3. The user taps **Try Again** → `src/services/send/index.ts:266`:
   ```ts
   await deleteMessageByGuid(getDatabase(), oldTempGuid);
   ```
   `deleteMessageByGuid` (`messages.ts:641-644`) deletes both the message row **and the queue row** — silently voiding a lease someone else is holding. It checks nothing.
4. `src/services/send/index.ts:275` then sends again under a **brand-new temporary id**. The server's duplicate protection is keyed strictly on that id (`packages/bbd/src/messaging/IdempotencyCache.ts:36-38`), so two different ids = two dispatches. **Recipient gets it twice.**

**It's actually easier than that.** Two variants need no overlap at all, just a sheet left open:
- The drain's retry **succeeds** while the sheet is open. The row is promoted to its real id, so `deleteMessageByGuid('temp-…')` matches nothing and "Try Again" simply sends a second copy of an already-delivered message.
- On the RCS bridge (and the AppleScript fallback), a successful send keeps the temporary id and only flips the state (`markOutgoingSentNoGuid`, `outgoing.ts:331-332`). A stale "Try Again" then **deletes a message that was successfully sent** and re-sends it; a stale "Delete" deletes one the recipient already has, and the server echo re-inserts it as a fresh bubble.

**The Delete path has its own hole.** `discardMessage` (`index.ts:279-281`) is a bare `deleteMessageByGuid`. The codebase has machinery for exactly this — `cancelOutgoing` records the cancellation so a still-in-flight send's echo is dropped (`outgoing.ts:224-225`, `if (msg[0].sendState === 'sending') markCancelled(tempGuid);`) — and Delete bypasses it entirely.

**Fix.** Route both UI actions through `cancelOutgoing` instead of the raw delete, with a fallback for rows that have no queue row (the server-reported-error case), and refuse to re-send when the bubble is no longer in the error state:
```ts
export async function discardMessage(guid: string): Promise<void> {
  const db = getDatabase();
  if (await cancelOutgoingRepo(db, guid)) return;   // arms the echo-drop for an in-flight POST
  await deleteMessageByGuid(db, guid);
}
```
and in `retry()`, before deleting: `cancelOutgoing` first; if it returns false, only proceed when the row is *still* `send_state = 'error'`, otherwise toast "Message was already sent". Cheap extra safety: in `MessageList.tsx`, close the sheet when its snapshot stops being an error row.

⚠️ **Regression risk AGENTS.md calls out.** AGENTS.md documents "THE SWALLOW GUARD: `resend()` flips an 'error' row to 'sending' first … without it the retry's SUCCESS is swallowed". Do **not** "fix" this by dropping the `sendState === 'sending'` condition at `outgoing.ts:225` — one lens proposed that and verification refuted it. `resend` flips the row to 'sending' *before* every POST (`outgoingQueueService.ts:77`), so that guard is already correct and `test/db/cancelOutgoing.test.ts:226` is pinning the right invariant. Leave both alone.

---

### D2 — HIGH · An unsent message comes back, with its text

**What breaks.** Someone unsends a message. It becomes a tombstone in your thread. Then it reappears in full — in the thread *and* as the inbox preview — showing content that was explicitly revoked. Milder daily variants: the "Delivered"/"Read" receipt and the "Edited" marker vanish from your own messages.

**The interleaving.** `upsertMessages`' conflict clause plain-overwrites four columns (`src/db/repositories/messages.ts:108-111`):
```ts
dateRead: sql`excluded.date_read`,
dateDelivered: sql`excluded.date_delivered`,
dateEdited: sql`excluded.date_edited`,
dateRetracted: sql`excluded.date_retracted`,
```
1. The app opens a chat. `ensureChatSynced` fires on **every** chat open (`app/(app)/chat/[guid].tsx:276`) and fetches up to five pages of 100 messages (`engine.ts:171`). That snapshot says `dateRetracted: null`.
2. While those pages are in flight, the sender unsends the message. The live event writes `date_retracted = <time>`; the tombstone appears; the inbox preview drops it (`chats.ts:425` filters `m2.date_retracted IS NULL`).
3. Page 3 lands and re-upserts the **older** snapshot. `excluded.date_retracted` is NULL, plain overwrite, tombstone cleared. The original text is still in the row (it's COALESCE-preserved at `messages.ts:103`), so the message renders in full again.

The window is a network round trip, not a millisecond — and `syncAllChats` has an even wider one (it does a full `upsertChats` including the read-marker loop between fetch and upsert).

**Why this is a bug and not a design choice:** every neighbouring monotonic column in that same clause is handled the opposite way *and says why*. `wasDeliveredQuietly`/`didNotifyRecipient` use COALESCE "so a later event that OMITS the flag can't downgrade a previously-stored value" (`messages.ts:122-127`); `hasAttachments` uses `MAX` (`:130`); `date_deleted` is excluded from the clause entirely with the reasoning "were it in the set, a re-sync would clear the tombstone and the deletion would undo itself" (`:153-162`). Unsend, edit, delivery and read are monotonic in exactly the same sense. These four are the only entries in the clause with no comment.

**Fix.**
```ts
dateRead: sql`COALESCE(excluded.date_read, ${messages.dateRead})`,
dateDelivered: sql`COALESCE(excluded.date_delivered, ${messages.dateDelivered})`,
dateEdited: sql`COALESCE(excluded.date_edited, ${messages.dateEdited})`,
dateRetracted: sql`COALESCE(excluded.date_retracted, ${messages.dateRetracted})`,
```
A present value still wins; only *absence* is preserved. The local revert paths are unaffected (`clearLocalUnsend`/`applyLocalEdit` are direct UPDATEs that never route through the clause).

⚠️ **Trade-off worth writing into the comment:** with COALESCE on `dateRetracted`, an optimistic unsend stranded by an app kill (so `clearLocalUnsend` never ran) can no longer be cleared by a re-sync. That errs toward *hiding* content rather than revealing it — the right direction for this column, but be deliberate about it.

---

### D3 — HIGH · A scheduled message sends twice (or three times) after an app kill

**What breaks.** A scheduled message — a birthday text, a recurring reminder — is delivered two or three times.

**The interleaving.** `runDueScheduled` claims the row correctly, then sends, then marks it sent — but the terminal write happens **after the whole network round trip** (`scheduleService.ts:83-92`), while delivery becomes durably owned by the outgoing queue the moment `insertOutgoingText` commits (`sendService.ts:54-69`, well before the POST).

1. Ticker claims row S (pending → sending). `sendTextMessage` commits the optimistic message row + a queue row under temp id **T1**, then POSTs.
2. Android reclaims the process. Durable state: S = 'sending', queue row T1 exists.
3. Next launch, home mounts and runs three things **in this exact order** (`app/(app)/home.tsx:38-50`):
   - `recoverStuckScheduled()` → `UPDATE scheduled_messages SET status='pending' WHERE status='sending'` (`scheduled.ts:302-309`) — unconditional, no age check, no link to the send it already issued. S is armed again.
   - `recoverOutgoing()` → re-POSTs T1. **Copy 1.**
   - `fireDueScheduled()` → re-claims S, mints a fresh temp id T2. **Copy 2.**

If the original POST reached the server before the kill, you get a third. Relaunching more than 10 minutes later also escapes the server's duplicate cache.

**Scope:** only *local-only* scheduled rows (`scheduleService.ts:81` skips server-backed ones) — but recurring rows are permanently local-only, so this is a real long-lived population.

**Fix.** Treat the scheduled row as done the moment the outgoing queue durably owns the send, not when the network resolves: have the `Sender` return the temp id and call `markScheduledSent`/`rearmScheduled` immediately after `sendTextMessage` resolves (it already swallows its own send failures, so the queue owns retries from there). Stronger version: persist the issued temp id on `scheduled_messages` and make `resetStuckScheduled` skip a row whose temp id still has a live message/queue row.

---

### D4 — HIGH · "Mark as Unread" is silently undone by the next sync

**What breaks.** You flag a conversation to come back to. The blue dot and bold title vanish on the next reconnect, pull-to-refresh, or app restart. The reminder is gone and nothing told you.

**The interleaving.** `setChatUnreadLocal` clears the marker to NULL (`chats.ts:593-595`). But the reconcile that pulls in the Mac's read watermark can't tell "never read" from "deliberately marked unread":
- `chats.ts:169-173` computes the current marker date as `COALESCE(lm.date_created, 0)` via a LEFT JOIN. With the marker NULLed, the join misses → `current = 0`.
- `chats.ts:180` `if (timestampMs <= current) continue;` — with `current = 0` this can never skip.
- `chats.ts:195` `… > ${current}` — `> 0`, also trivially true.
- So the UPDATE re-points the marker at the newest received message at or before the Mac's watermark, and the badge clears.

**Who has to be doing what:** the canonical flow *guarantees* it. Opening the chat pushes a read receipt to the Mac (`privateApiEnabled` and `sendReadReceipts` both default true), so the Mac watermark is already ahead. Back out, swipe "Mark as Unread", and either the server call is skipped (Private API off, `chatActions.ts:80`) or it fails offline and is swallowed at debug level (`:81-85`) — the comment there literally says "local flip kept", which is false. Next sync, gone. Not applicable to `RCS;-;` chats (the server never sends a watermark for those).

**Fix.** Add a device-local `marked_unread_at INTEGER` column (additive migration, appended by name, mirrored into `schema.ts`) and keep it **out** of `upsertChats`' conflict set — exactly the mechanism that already protects `custom_name`/`is_pinned`. `setChatUnreadLocal` stamps it; `setLastReadMessageGuid`/`markAllChatsReadLocal` clear it; the pair collection at `chats.ts:122-127` skips any chat whose `marked_unread_at >= timestampMs`, so a genuinely *later* read on the Mac still wins.

---

### D5 — HIGH · The read-marker guard compares against a stale value, so a chat you just read goes bold again

**What breaks.** A conversation you just opened and read pops back to bold with an unread badge counting everything since the Mac's watermark.

**The interleaving.** `reconcileReadMarkersFromTimestamps` loads every chat's current marker into a JavaScript map **once**, then loops. Inside the loop it uses that captured value as a SQL literal:

```ts
const current = markerDate.get(chatId) ?? 0;                     // chats.ts:177
…
AND (SELECT MAX(m.date_created) FROM messages m … ) > ${current}  // chats.ts:195
```

Each iteration is `await db.run(...)` (`chats.ts:185`) — a full round trip that **yields the JavaScript event loop**. With up to 200 chats in a sync page that loop runs for hundreds of milliseconds. If the user opens a chat mid-loop, `markRead` writes a *newer* marker (`chatActions.ts:59` → `setLastReadMessageGuid`, an unconditional UPDATE). When the loop reaches that chat it still sees `current = 0`, the guard `2000 > 0` passes, and the marker is dragged **backwards** to the Mac's older watermark.

A third writer makes it worse: `chat-read-status-changed` (`dbEventSink.ts:144-152`) also writes the marker, isn't in a transaction, and is triggered by exactly the action (reading on the Mac) that moves the watermark this loop is reconciling.

The function's own docstring claims each UPDATE "re-applies the monotonic guard atomically" (`chats.ts:150-151`). Only the *candidate lookup* is atomic; the *baseline* is a stale JavaScript constant.

**Fix (one line).** Read the live marker inside the same statement, reusing the expression the inbox query already uses (`chats.ts:454-455`):
```sql
        > COALESCE((SELECT lm.date_created FROM messages lm
                     WHERE lm.guid = chats.last_read_message_guid), 0)
```
Keep the JavaScript map purely as the cheap pre-filter at `:180` — a stale *skip* is harmless. Update the docstring.

---

### D6 — HIGH · The contacts table is emptied and refilled one row at a time on every connect

**What breaks.** During the refill window: notifications show a **raw phone number** instead of the contact's name and photo; with "Filter Unknown Senders" on, a first message from a newly-added contact produces **no notification at all**, permanently; and the new-chat / FaceTime recipient picker shows an empty contact list that doesn't refresh on its own.

**The code** (`src/db/repositories/contacts.ts:23-38`):
```ts
export async function upsertContacts(db: AppDatabase, items: DeviceContact[]): Promise<number> {
  await db.delete(contacts);                       // ← line 24: table is now EMPTY, and committed
  if (items.length === 0) return 0;
  for (const c of items) {
    await db.insert(contacts).values({ … });       // ← N separate commits, one per contact
  }
  return items.length;
}
```
This is the only unqualified whole-table delete left outside the logout path. For a 1–2k-entry address book that's thousands of sequential round trips on the one shared connection — **a window measured in seconds**, and it re-runs on every boot, reconnect and pull-to-refresh (`syncControl.ts:129` fires `void syncContacts()` at the tail of every sync).

**The damage, concretely.** The most reachable victim is the picker: `searchContactAddresses` is read by `useContactSearch` (`src/features/contacts/useContactSearch.ts:17`), whose effect depends only on `[query, limit]` — it is **not** reactive and never re-runs when the table changes. Open the compose screen during the window and you get a permanently empty list until you type something. (Especially likely on a share-into-Gator cold start, which routes to `/new-chat` at the same moment boot's contacts sync begins.)

For notifications: a brand-new handle created inside the window gets `contact_id = NULL`, so the notification title is the raw address (`getHandleProfile`'s `COALESCE(display_name, address)`, `handles.ts:35`). With `filterUnknownSenders` on (defaults off), `chatHasKnownSender` returns false and `postNotificationSafely` is never called — a one-shot decision with no retry. The database self-heals seconds later; the missed notification doesn't.

The recent hardening was **reader-side only** (`linkHandlesToContacts` and `matchContactsToHandles` both bail on an empty index, and `syncContacts` is coalesced). Correct as far as it goes — but the writer still commits the empty state.

**Fix — add-then-prune, like the `upsertChats` fix.** Note the obvious version **will throw**: `contacts.source_id` has no unique index, so `onConflictDoUpdate({ target: contacts.sourceId })` raises "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint". Two shippable shapes:
- **(A) No migration.** `SELECT MAX(id) AS cutoff` first → insert the new generation in multi-row batches (`chunk(items, 100)`, helper already exists in `_shared`) → `db.delete(contacts).where(lte(contacts.id, cutoff))`. Never empty, and N+1 commits become ~N/100+2. Have `searchContactAddresses` de-dupe on name+address for the brief both-generations window.
- **(B) With a migration.** Add `CREATE UNIQUE INDEX contacts_source_id_idx ON contacts (source_id)` (after de-duping the input), then a real `onConflictDoUpdate` + `notInArray` prune — byte-for-byte the `upsertChats` shape.

Keep the reader guards either way, and consider making `useContactSearch` a `useReactiveQuery` on `['contacts']` so the picker self-heals.

---

### D7 — HIGH · Deleting a conversation destroys your customisations and the conversation comes back anyway

**What breaks.** You delete one conversation. On the next sync the whole thread returns — but **unpinned, unmuted, un-archived, with a NULL read marker** (so its entire restored history counts as unread and the inbox shows a big badge), and your **custom chat name, accent colour, per-chat theme and wallpaper are gone permanently**. The only thing the delete durably accomplished was destroying your own settings.

**No race required — it's deterministic.** `deleteChatLocal` (`chats.ts:238-245`) ends with:
```ts
await db.delete(chats).where(eq(chats.id, chatId));
```
That row carries `isPinned`, `isArchived`, `muteType`, `customName`, `customColor`, `themeTokens`, `backgroundUri`, `backgroundIsLight`, `syncedBackgroundUri` and `lastReadMessageGuid`. The delete is local-only, so the server still returns the chat; `syncAllChats` runs on every non-first sync (`syncControl.ts:102`) and `upsertChats` takes the **INSERT** branch, whose values list contains only server fields — every device-local column is re-seeded to NULL.

The codebase knows these columns are unrecoverable — `maintenance.ts` spells it out for the wipe path ("worth stating plainly because no re-sync can bring it back … pin/archive/mute, custom name and colour, per-chat theme tokens and wallpaper") and `settings.tsx:111` names all of it in the Disconnect dialog. The per-chat Delete dialog says only *"This removes it from this device (not from the server)."*

**Fix.** Make it a tombstone so the delete sticks and the local columns survive:
```
{ name: '00NN_chats_is_deleted', statements: ['ALTER TABLE chats ADD COLUMN is_deleted INTEGER'] }
```
Replace the final `db.delete(chats)` with `db.update(chats).set({ isDeleted: true, latestMessageDate: null })`; filter `c.is_deleted IS NULL` in `listChatsForInbox`, `listChats` and `getChatHeader`; keep `is_deleted` **out** of `upsertChats`' conflict set (that's the same mechanism that already protects `is_pinned`); clear the flag when the user sends into the chat.
If you'd rather keep a hard delete, at minimum make the dialog truthful, mirroring the Disconnect wording.

---

### D8 — HIGH · Deleted messages come back on the next chat open

**What breaks.** You select messages and delete them. They disappear. Then they're back — often within the same screen session, and deterministically the next time you open that thread.

**Why.** `deleteMessageByGuid` (`messages.ts:641-644`) is a **hard** delete. `ensureChatSynced` fires unconditionally on every chat open (`chat/[guid].tsx:276`) and re-pages up to 500 messages; the server still has those guids (the delete never left the device), so `upsertMessages` inserts them straight back. If the delete lands *during* that paging, they reappear while you're still looking at the thread.

This is precisely the hazard the schema was designed against, and the design is only half-wired. `markMessageDeleted` (`messages.ts:669-686`) documents itself as "TOMBSTONE, not hard delete: … a hard delete would be UNDONE by the next sync re-inserting the row (the re-sync hazard)", and `date_deleted` is deliberately omitted from `upsertMessages` so the tombstone survives. But the tombstone is only used by the **server's** `message-deleted` event — the user's own Delete bypasses it. Every render and count query already filters `date_deleted IS NULL`, so the tombstone is a drop-in.

**Fix.**
```ts
export async function deleteMessageLocal(db, guid, now) {
  if (guid.startsWith('temp-')) return deleteMessageByGuid(db, guid);  // no server side
  await markMessageDeleted(db, guid, now);
}
```
Point `useMessageActions.ts:169` and `:290` at it. Bonus: `markMessageDeleted` also recomputes the chat's `latest_message_date`, which the raw delete never did. Keep the hard delete for `temp-…` rows — that's its documented purpose. Drop the now-stale comment at `useMessageActions.ts:279-281` (it says "a later full re-sync can bring it back"; it's actually the very next open).

---

### D9 — MEDIUM · The Mac's read state is thrown away on the first sync of every fresh install

**What breaks.** A brand-new install (and every reconnect after Disconnect) opens with a full unread badge on **every** conversation you've already read on your Mac. The correct data was fetched and discarded.

**A self-ordering bug, no concurrency needed.** `syncAllChats` calls `upsertChats` at `engine.ts:55` — which reconciles the read watermarks at `chats.ts:128` — but doesn't write the page's **messages** until `engine.ts:86`. On a first sync the `messages` table is empty for those chats, so the guard at `chats.ts:193-195`:
```sql
AND (SELECT MAX(m.date_created) FROM messages m WHERE … ) > ${current}
```
evaluates `NULL > 0` → falsy → every UPDATE matches zero rows. Nothing re-runs it: phase 2 only calls `upsertHandles`/`upsertMessages`.

The existing test suite misses this because `test/db/readReconcile.test.ts:57-68` seeds messages *first* — the exact reverse of production order.

Self-heals on the next sync run (reconnect / refresh / next launch), so it's "wrong for the whole first session" rather than permanent.

**Fix.** Export `reconcileReadMarkersFromTimestamps` and re-run it after the messages land: in `syncAllChats` right after `upsertMessages(lastMsgs, …)` at `engine.ts:86`, and — the one that matters — in `fullSync` after the phase-2 backfill completes. It's idempotent and monotonic, so running it two or three times costs one batched SELECT. Leave the existing call inside `upsertChats` so the live path keeps working.

---

### D10 — MEDIUM · Deleting a chat orphans its reminders (and their live OS alarms), scheduled messages and draft

**What breaks.** A reminder for a deleted conversation still buzzes the phone **with the deleted message's preview text on the lock screen** and opens an empty chat. A scheduled message to that person may be silently retired to "error". The old composer draft is still pre-filled when the chat re-syncs.

**Why.** `deleteChatLocal` (`chats.ts:238-245`) deletes exactly four things: messages, participant links, outgoing-queue rows, the chat. `scheduled_messages` (keyed by `chat_guid`), `reminders` (`chat_guid` + `message_guid`) and the `draft.<guid>` kv row have **no foreign key** to `chats`, so nothing cascades.

The wipe path proves the author knows this is chat-scoped state that must go: `clearLocalCache` deletes all three together, and `bootstrap.ts:196-210` cancels every reminder's OS alarm **first** because "a trigger notification is system state that outlives the row, so an uncancelled one still fires later and deep-links into a chat that no longer exists." None of that exists on the per-chat path.

*(The "scheduled message retired to error" half is narrower than it first looks — only local-only rows are exposed, and boot's sync usually re-creates the chat before the 5-attempt cap is burned.)*

**Fix.** Give the per-chat delete the same cleanup, split across layers so `src/db` never imports `src/services`: add the three row deletes to `deleteChatLocal`, and add a thin `deleteChat(guid)` service wrapper that cancels the reminders' OS alarms first (lazy notifee import, own try/catch, mirroring `bootstrap.ts:196-210`). Point the three call sites at it. Pairs naturally with D7.

---

### D11 — MEDIUM · "Mark All Read" can pin a chat's read marker to a message id that's about to be rewritten

**What breaks.** You tap Mark All Read; badges clear; then some chats spontaneously go bold again with an unread count equal to their **entire history**, and open with a "jump to N unread" chip pointing at the start of the thread.

**Why.** `markAllChatsReadLocal` (`chats.ts:602-608`) is the one writer of this column that doesn't filter to *received* messages:
```sql
UPDATE chats SET last_read_message_guid = (
  SELECT m.guid FROM messages m WHERE m.chat_id = chats.id ORDER BY m.date_created DESC LIMIT 1
) WHERE id IN (SELECT DISTINCT chat_id FROM messages)
```
Every other writer picks a received message, whose id is server-issued and never rewritten (`getNewestReceivedGuid`, `messages.ts:390-400`, documented as "the correct mark-read target"). Here, a still-pending outgoing message — which is the newest row in its chat and carries a **temporary** id — becomes the marker. When the send reconciles, that id is rewritten (`outgoing.ts:294-304`, `:413-416`, `:483-486`) or deleted. The marker now points at nothing, `COALESCE(…, 0)` → 0, and every received message counts as unread.

**Most likely path — no sub-second timing needed:** a send that failed offline sits at `send_state='error'` with its temp id **indefinitely**. Tap Mark All Read (a routine gesture that touches *every* chat), then the queue retries successfully later and rewrites the id. One stuck send anywhere is enough.

**Fix.** Match the documented marker semantics — add `AND m.is_from_me = 0 AND m.date_deleted IS NULL` to the subquery, the same tie-break (`date_created DESC, m.id DESC`), and narrow the outer `WHERE` the same way so a chat with no received messages isn't set to NULL.

---

### D12 — MEDIUM · The headless "Mark as read" notification button throws and does nothing

**What breaks.** On a killed app — the exact case the tray button exists for — "Mark as read" does nothing at all: the badge stays, *and* the notification stays in the tray as if you never tapped it. It works when the app happens to still be alive, so it reads as flaky.

**Why.** `markRead` opens the database the unsafe way (`src/services/chatActions.ts:55`):
```ts
const db = getDatabase();   // throws: "Database not initialized — call initDatabase() first."
```
On a killed-app wake there is no React tree, so `boot()` never runs and `dbInstance` is null (`database.ts:85-88`). The rejection propagates out of `handleNotificationAction`, so `await notifee.cancelNotification(chatGuid)` (`actions.ts:46`) is never reached — and `notifee.onBackgroundEvent` has no try/catch, so nothing is logged.

Its two siblings **in the same switch** get it right and say why: `actions.ts:124` and `:136` both use `await ensureDatabase()` with the comment "a killed-app inline-reply runs headless with no prior DB open". AGENTS.md states the rule outright: *"the DB is opened with `ensureDatabase()` (lazy, headless-safe) — never `getDatabase()`… Use `ensureDatabase()` in any background/notification-action handler."* This is a documented-invariant violation, not a judgement call.

**Fix.** Three small changes: (1) `const db = await ensureDatabase();` in both `markRead` (`:55`) and `markUnread` (`:77`); (2) hydrate the feature-settings store before the read-receipt decision on this path — headlessly it's at module defaults (`privateApiEnabled`/`sendReadReceipts` both default **true**), so once the DB fix lands it would POST a receipt for someone who turned receipts off; (3) wrap the `onBackgroundEvent` body in try/catch → `logger.warn` and move `cancelNotification` into a `finally`, so a failed action still clears the tray.

---

### D13 — MEDIUM · The retry queue captures the time once, so every failure under-schedules its next attempt

**What breaks.** The retry ladder that's supposed to ride out an outage doesn't wait as long as intended, and for attachments the next retry can be scheduled **in the past** — so the row is re-eligible on the very next 20 s tick with zero backoff (hammering). A long upload can also outlive its own 120 s lease, letting a second drain re-claim the row and upload the same file concurrently.

**Why.** `runOutgoingQueue` binds `now` once (`outgoingQueueService.ts:161`) and reuses it for every claim (`:166`) and every failure reschedule (`:167` → `reconcileOutgoingError` → `nextRetryAt: now + outgoingBackoffMs(attempts)`, `outgoing.ts:561`). The lease is `loop-start + 120 s`, not `claim-time + 120 s`. Attachment uploads have **no timeout at all** (`http.ts:186-190`), so one big upload can exceed it on its own.

*Corrected from the raw finding:* the message is **not** delivered twice here — the retry reuses the same temp id, so the server's cache collapses the dispatch (`attachmentUploadRoutes.ts:272-273`). The bytes go up twice; the message goes out once. This is a reliability/bandwidth defect, not a duplicate-delivery one. Also, for plain text the ladder is only ~15 % early, not "collapsed".

**Fix.** Fresh timestamp per row and per outcome:
```ts
for (const row of rows) {
  const t = Date.now();
  if (!(await claimOutgoing(db, row.id, t))) continue;
  if (await resend(db, http, io, row, t)) sent += 1;
}
```
and inside `resend`, pass `Date.now()` (not the loop-start value) into `reconcileSendOutcome`/`handleSendFailure`. Optionally add a module-level `draining` flag mirroring `flushErrorReports`' `flushing` (`services/errors/index.ts:36`).

---

### D14 — LOW/MEDIUM · A chat's synced wallpaper vanishes when you open it offline

**Why.** `upsertChats` writes `synced_background_channel` from a presence check (`chats.ts:39-40`) and plain-overwrites it on conflict (`chats.ts:50`). But the live/incremental paths parse embedded chats as `ChatSummary` (`src/core/models/chatSummary.ts:9-19`), which **does not declare** `backgroundChannelGuid` — zod strips unknown keys, so the value the server *does* send is discarded at the schema boundary and NULL is written over a good channel id. Then `ensureSyncedBackground` (`syncedBackground.ts:52-56`) sees a null channel, reads it as "background removed on the server", and clears the local wallpaper reference — but only when the refresh GET fails, i.e. **when you're offline**, which is exactly when offline-first should hold.

*Corrected from the raw finding:* the JPEG filename is deterministic, so this is **not** a disk leak and **not** permanent — it self-heals on the next online chat open.

**Fix.** Add `backgroundChannelGuid: z.string().nullish()` to `ChatSummary`. Do **not** switch `chats.ts:50` to COALESCE — that would break genuine background removal, which is the column's whole purpose.

---

### D15 — LOW · A shared photo is stuck at the wrong aspect ratio forever

`upsertAttachments`' conflict clause (`attachments.ts:66-75`) refreshes `mimeType`, `totalBytes`, `blurhash` and the two Genmoji columns — but **not** `width`/`height`. A file shared *into* Gator has no dimensions (`SharedAttachment` is `{uri, name, mimeType, size}`), so it's inserted NULL; the server later sends real dimensions on every fetch and they're dropped every time. `ImageAttachment.tsx:63` falls back to `0.78`, so the photo renders in a portrait box regardless of its real shape, permanently — no re-sync can fix it because the row already exists. (The MediaLibrary tray path is fine; it passes real dimensions.)

**Fix.** `height: sql\`COALESCE(excluded.height, ${attachments.height})\``, same for `width` and `transferName`. COALESCE, not plain overwrite — a payload that legitimately has no dimensions must not wipe good ones.

---

### D16 — LOW · Restoring a backup twice duplicates every custom theme

`restoreThemes` (`backup.ts:58-65`) ends in `.onConflictDoNothing()`, but `themes` has **no unique index** (`schema.ts:295-302`; `migrations.ts:133-139` creates only `id INTEGER PRIMARY KEY AUTOINCREMENT`) and no `id` is supplied — so no conflict can ever arbitrate. The clause is dead code and the statement is an unconditional INSERT. Restore the same backup twice (a normal recovery action) and every custom theme appears twice, indistinguishable, with no dedupe on a later restore. The caller's docstring ("kv + themes are upserted", `backup.ts:46-47`) asserts the opposite of what the code does.

**Fix.** An explicit lookup-then-update/insert on `(name, mode, is_preset = 0)` — no migration needed — and delete the misleading `.onConflictDoNothing()`.

---

## 3. Plausible but unproven

The mechanism is real and verified in code; what I couldn't establish is that the triggering condition happens in practice. Each says what would settle it.

**P1 — A sync page can be silently erased while its "we got this far" marker still advances** (`src/services/sync/engine.ts:338`). Because there's one shared connection, the sync engine's plain writes **join** whatever transaction happens to be open (`transaction.ts:33-40` documents this). If `DbEventSink`'s transaction then rolls back, that sync page's rows — up to 250 messages — are erased. But the marker is computed from `batch` (what the *server* returned), not from what persisted, and commits anyway. `buildSyncCursor` is a strict forward cursor, so the page is never re-fetched.
*Requires:* a `withDbTransaction` callback to actually throw. The one caller resolves its chat id inside the transaction and returns rather than throws when it can't (`dbEventSink.ts:81-88`), which closes the obvious trigger.
*Settles it:* the observed rate of error-level "event handling failed" lines in the `error_reports` queue on a real device. One such rollback during an incremental sync is enough.
*Same mechanism, other victims:* the optimistic-send inserts (`insertOutgoingText`, `outgoing.ts:61-89`) can also be swallowed by a neighbour's rollback — the user's message disappears with no bubble, no queue row and no error. `transaction.ts:45-52` explicitly calls this an accepted price; if you ever want it closed, the boring fix is to run those helpers inside `withDbTransaction` themselves so they *serialize behind* rather than *join* an open transaction.
⚠️ Fixing P1 by wrapping sync pages in `withDbTransaction` is right, but keep each wrapped block short — `transaction.ts:50-52` warns against holding the write lock for a bulk pass.

**P2 — The background sync task bypasses the coalescing slot, so Disconnect can be undone mid-flight** (`src/services/background/backgroundSync.ts:27`). The task calls `incrementalSync` **directly**, never `startSync()`. `forget()` waits on `awaitSyncIdle()` (`syncControl.ts:62-68`), which awaits `syncInFlight` — set only by `startSync()`. So it's `null` and the wait resolves instantly while the task is still paging. The wipe then runs, the task's page lands, re-creates the old account's handles/chats/messages, and commits a non-null sync marker over the reset.
*Refuted premise:* the raw finding assumed the worker runs regardless of foreground state. It doesn't — expo-background-task explicitly reschedules instead of running when the app is foregrounded, and Disconnect is only reachable from a foreground screen. The residual window is: worker starts while backgrounded → user foregrounds → walks to Settings → Disconnect → all before an in-flight page resolves. Real, but only during a long catch-up.
*Settles it:* background the app with a large unsynced backlog, trigger the worker via `adb shell cmd jobscheduler run`, then Disconnect while `[sync]` pages are still logging; check whether `chats`/`messages` repopulate and `sync_markers` returns non-null.
⚠️ **Do not fix this by calling `startSync()` from the task** until D6 is fixed — `startSync` also fires the contacts sync, which would run the whole-table truncate every 15 minutes in the background. Use a small `runTrackedSync(fn)` helper that publishes into `syncInFlight` instead.

**P3 — A send-failure that lands in the same event-loop turn as the success ack is overwritten** (`src/db/repositories/outgoing.ts:331`). `markOutgoingSentNoGuid` checks "is this row already 'error'?" as a *separate SELECT* and then unconditionally writes 'sent' and deletes the queue row. The file already knows the atomic form (`retireOutgoing` at `:525-528`, `markOutgoingSending` at `:502-506` both fold the guard into the WHERE); this is the one that doesn't. If it fires, a message the server said **failed** shows as sent with no error badge and no retry row — silently never delivered.
*Requires:* one statement-ordering swap, i.e. the HTTP ack and the socket error frame arriving within roughly one event-loop turn. The guard's own comment (`:323-326`) says the authors already saw these two collide on the RCS immediate-ack path, so "close" is real; "same turn" is the residual.
*Settles it:* timestamp both paths on device and force an instant RCS bridge rejection (expired auth cookies — a recurring real condition per your notes). A delta under ~2 ms confirms it.
*Fix:* fold the guard into the write — `db.all(sql\`UPDATE messages SET … WHERE guid = … AND (send_state IS NULL OR send_state <> 'error') RETURNING id\`)`, and only delete the queue row when it matched.

**P4 — A retryable send failure loses its retry ladder** (`src/db/repositories/outgoing.ts:691`). `applyServerSendError` reads "is there still a queue row?" and then returns unconditionally down the `reconcileOutgoingError` branch — so if the ack deleted that row in between (three awaits wide), the queue UPDATE matches nothing, reports nothing, and the `retryable → reEnqueueOutgoingFromMessage` branch at `:695` is never reached. Milder than P3 (the error badge does show, manual retry works) but it silently downgrades exactly the case that machinery exists for.
*Settles it:* same on-device experiment as P3.
*Fix:* have `reconcileOutgoingError` return whether it actually owned a queue row (`… RETURNING id`) and fall through when it didn't.

**P5 — An edit/unsend that actually went through is reverted locally** (`src/services/send/sendEditService.ts:52`). `sendEdit` snapshots the old text, applies the edit optimistically, POSTs, and on failure calls `applyLocalEdit(prev.text …)` — an **unguarded** UPDATE with no check that our own optimistic write is still the latest. If the server applied the edit and emitted its echo but the HTTP response was lost, the revert clobbers the echo: the message shows the old wording to you and the new wording to everyone else. `sendUnsend` has the identical shape at `:83`/`:88`, which is the privacy-relevant one — content you revoked from everyone is resurrected locally.
*Requires:* the server to have applied it **and** the response to be lost **and** the socket to still be up. A 502 usually means the origin was never reached; the realistic trigger is a read-timeout where the origin did process it.
*Settles it:* one server-side log correlation on a slow edit.
*Fix:* make the revert a compare-and-set on the marker your own write left — `WHERE guid = ? AND date_edited = ${now}` / `AND date_retracted = ${now}`.

**P6 — Two crash windows in the optimistic-send lifecycle** (`outgoing.ts:61` and `:226`). Both are "process dies between two adjacent commits" (roughly 1–20 ms), so I can't call them reachable — but both are one-line fixes and the damage is bad:
- **Insert order.** `insertOutgoingText`/`Contact`/`Reaction`/`Attachment` all commit the visible message row **before** the queue row that owns its recovery. A gap leaves a bubble stuck on "sending" forever: nothing retries it (`listRetryableOutgoing` reads only `outgoing_queue`, and unlike scheduled messages nothing resets `send_state='sending'` at boot), and the UI offers no escape — `MessageActionsOverlay.tsx:168-176` computes `canDelete = !canCancel`, so **Delete is never offered**, while "Cancel Sending" finds no queue row and silently returns false.
- **Delete order.** `cancelOutgoing` deletes the *message* before the *queue row* (`:226` then `:227`), and the in-memory cancel record dies with the process. A gap leaves an orphan queue row that the next launch happily re-sends — a message you explicitly cancelled is delivered, with **no bubble at all**, so you can't tell.
*Settles both:* a one-line boot diagnostic — count `messages WHERE send_state='sending' AND guid LIKE 'temp-%' AND guid NOT IN (SELECT temp_guid FROM outgoing_queue)`, and the reverse (queue rows with no message). Non-zero on real devices confirms it.
*Fix:* put both deletes in `cancelOutgoing` inside one `withDbTransaction` (verified safe — it never re-enters), and swap the insert order in the four helpers so the durable row commits first. Ship the UI escape hatch regardless: offer Delete on an optimistic row.

**P7 — The Scheduled screen's server reconcile can delete a message you just edited** (`src/db/repositories/scheduled.ts:133`). The prune keeps only ids from a server list fetched *before* it re-reads the local table, so a row created during the fetch is deleted locally while the server still fires it. The raw finding's actor (the chat composer) isn't reachable — `syncScheduledFromServer` runs only on Scheduled-screen mount. But `editScheduled` **is** on that screen and creates a new server id mid-fetch.
*Settles it:* whether `GET /scheduled` can succeed while taking longer than a tap-edit-save cycle (~5 s).
*Fix:* snapshot the prunable local ids **before** the network call and prune only within that snapshot.

**P8 — Re-setting an existing reminder destroys the old one before scheduling the new** (`src/services/notifications/remindersService.ts:58`). Cancel → delete row → *then* schedule. If scheduling throws, the user sees "Couldn't set the reminder." (which reads as "nothing changed") and has **no reminder at all**. The sibling `rescheduleReminder` at `:103-115` does it the other way round and explains why in a comment.
*Refuted trigger:* the AGENTS.md past-timestamp throw can't fire here — `pickDateTime.ts:42-46` already clamps to `now + 60 s`.
*Settles it:* any real logcat line `[reminder] createTriggerNotification failed`.
*Fix:* two-line reorder to match the sibling; guard the cancel for the same-id case.

**P9 — A reminder tap mid-reschedule strands an OS alarm with no row** (`remindersService.ts:115`). `updateReminderTime` returns void, so a 0-row update is invisible; the just-armed trigger has no backing row, can't be cancelled from the Reminders screen, and survives even Disconnect (`forget()` only cancels alarms it can find via `listReminders`). The raw finding's window is sub-100 ms, but a wider one exists: `reminders.tsx:25-35` awaits the time-picker dialog **before** calling `rescheduleReminder` with a stale row — that dialog can be open for minutes.
*Fix:* have `updateReminderTime` return a boolean (`.returning({id})`) and cancel the trigger you just armed when it's false.

**P10 — A server-reported error code is erased on the next re-sync** (`src/db/repositories/messages.ts:121`, `error: sql\`excluded.error\``). The mechanism is certain: `MessageV1` has no `error` field, so `excluded.error` is always a hard-coded 0 overwriting whatever's stored. But the headline damage is **refuted** — client error codes (10009 "Attachment Unavailable" etc.) only ever live on temp-id rows the server can never return, and every promotion explicitly zeroes the column. The only reachable case is an RCS delivery failure keyed by its real id, where "iMessage Error (Code 1)" degrades to "Message Failed to Send" — arguably an improvement. The red bubble and retry affordance survive either way (`send_state` is correctly absent from the clause).
*Fix (hygiene):* drop `error` from the conflict set with the same NOTE comment style used for `date_deleted`.

**P11 — The one-time search backfill can mark itself "done" after its writes were rolled back** (`src/services/databaseControl.ts:87`). Same shared-connection mechanism as P1, in a boot-only window, and the flag is written unconditionally rather than from evidence. Impact is limited — `upsertMessages` re-derives the searchable text on any re-upsert, so it self-heals for chats the user opens.
⚠️ The raw finding's suggested fix (re-run the selecting query) is **wrong** — rows whose attributed body decodes to nothing stay in that result set forever, so the flag would never be set and every launch would repeat the full scan. Verify only the ids the pass claims to have fixed.

---

## 4. What was checked and found sound

This matters as much as the findings — these are the patterns to **preserve**, and the reason the audit only produced 26 items instead of a hundred.

**Locking and single-flight**
- **All three atomic claims are real locks**, not `useRef` guards: `claimScheduled` (`scheduled.ts:240-247`), `claimOutgoing` (`outgoing.ts:732-737`), `claimErrorReports` (`errorReports.ts:91-104`) — each a single `UPDATE … WHERE <guard> … RETURNING`. Every drain path goes through one. The home-plus-every-chat double-ticker double-send that AGENTS.md describes is genuinely fixed. `rearmScheduled` correctly re-guards on `status='sending'` so only the claim holder can re-arm.
- **`listRetryableOutgoing`'s grace window works**: `attempts >= 1 OR created_at <= now - OUTGOING_GRACE_MS` correctly keeps a live UI send out of the retry processor's hands.
- **`withDbTransaction`'s mutex is correctly implemented** — it claims the queue **synchronously before its first await** (`transaction.ts:55-62`) so two back-to-back callers can't read the same predecessor, and releases in a `finally` that also wraps BEGIN.
- **`ensureDatabase` single-flight is correct** (`databaseControl.ts:22-58`): no await before the memo assignment, and both settle handlers clear it with an identity check, so a failed open doesn't wedge and a late settle can't clear a newer attempt.
- **One JS context, so module-level guards really are process-wide.** No `android:process` anywhere; the headless FCM task and the WorkManager worker both reuse the single ReactContext. `txQueue`, `openInFlight`, `syncInFlight`, `EventRouter.seen`, `cancelledTempGuids`, and the `inFlight` maps in contacts/URL-preview/download are all effective.
- **Only one op-sqlite connection to `gator.db`.** The second `open()` in `key.ts:35-44` runs only inside the single-flight open, before the real handle exists, and closes; the rekey self-test uses a throwaway file.

**Conflict clauses (all 9 in the codebase were enumerated and classified)**
- **Device-owned chat columns are correctly excluded** from `upsertChats`' clause — `is_pinned`, `is_archived`, `mute_type`, `custom_name`, `custom_color`, `theme_tokens`, `background_uri`, `background_is_light`, `last_read_message_guid`, `latest_message_date`. Verified column by column; each has exactly one single-writer UPDATE.
- **`date_deleted` deliberately absent** from `upsertMessages` — this is what makes the deletion tombstone survive a re-sync, and it's correctly implemented.
- **`hasAttachments: MAX(...)` is load-bearing.** The live socket path and the `lastMessage` hydration both send 0, so a plain overwrite would strip the attachment flag off every message on every reconnect.
- **`originalRowId` absent from the clause is correct and important** — the server emits `null` for it on the `lastMessage` path, and it's the field the incremental cursor is derived from.
- **`upsertHandles`' `CASE WHEN handles.contact_id IS NULL` guard** correctly preserves a contact-matched name (a table-qualified reference reads the pre-update row), and `avatar`/`contact_id` are left out so the contacts matcher keeps ownership.
- **`attachments.local_path` is protected** — out of the conflict set, carried forward on the temp→real rename (`attachments.ts:40-44`), and covered on the racing-ack path by `reconcileOutgoingSuccess`' dup branch. A re-sync can't blank a downloaded file's path.
- **COALESCE-preserve on `messageSummaryInfo`/`payloadData`/`text`/`handleId`/emoji glyph** — each verified against the actual wire contract (server code read directly), and correct in each case.

**Realtime and delete paths**
- **The socket/FCM dedup claim is airtight.** One shared `EventRouter`; `recordSeen` runs *synchronously before* `await sink.onEvent`, and `unrecordSeen` releases the guid in the catch — so a transient failure can't burn the guid forever. `updated-message` is deliberately un-deduped and every column it drives is absence-preserving, so replaying one is a no-op.
- **Foreign-key delete ordering is correct in both bulk paths.** `clearLocalCache` goes attachments → messages → chat_handles → chats → handles, which is required by the no-action edge `messages.handle_id → handles`. No mid-sequence FK failure is constructible.
- **The FTS search index cannot drift.** Both bulk paths delete `messages` explicitly (never via a cascade), `messages.id` is AUTOINCREMENT so rowids are never reused, every writer of `text` goes through the update trigger, and tombstoned rows are excluded at query time in all three search queries.
- **`fullSync`'s two concurrent per-chat fetches are safe** — each owns a distinct chat id, and the only shared table (`handles`) is written by a single atomic upsert.
- **Post-`forget()` FCM resurrection is closed** by the vault check that runs *before* `ensureDatabase()` (`fcmMessaging.ts:83-90`), and the socket is disconnected before the vault keys are deleted.
- **`ensureDownloaded` dedupes per guid** with the map set synchronously before the first await — auto-download and a manual tap can't both write `local_path`.
- **The composer draft can't resurrect a sent message** — the debounce timer is cleared before the clear-draft call.
- **kv has no lost-update shape**: every store owns disjoint keys; there is no read-modify-write of a shared JSON blob anywhere.

**The six recent fixes all check out**
`upsertChats` really is add-then-prune (insert-with-do-nothing at `chats.ts:106` before any prune; `ids.length === 0` correctly treated as "no information"; the link set is only ever a superset). `matchContactsToHandles` guards the empty index and `syncContacts` is coalesced with a chain-on-force and an abandonment escape. The transaction mutex and `DbEventSink`'s single-transaction message path are correct, with the auto-download hook deliberately left *outside* the commit. `ensureDatabase` single-flight is correct. `latest_message_date`'s reaction exclusion is byte-identical between its two writers with the COALESCE fallback load-bearing in both. `forget()`'s wipe ordering (marker reset first, children before parents) is right.

---

## 5. Coverage and gaps

**Read in full:** all 18 repository files, `database.ts`/`transaction.ts`/`migrate.ts`/`migrations.ts`/`schema.ts`/`useReactiveQuery.ts`, the whole sync engine, `syncControl`, `bootstrap`, `realtimeControl`, `dbEventSink`, the send/queue/schedule services, error-report queue, downloads, contacts sync, notifications actions/background events, and the mount effects and tickers in `app/(app)/_layout.tsx`, `home.tsx` and `chat/[guid].tsx`. Every `.delete(` call site (56) and every conflict clause (9) was enumerated and triaged. The wire contract was verified **against the real server** in `~/github/BB/bluebubbles-server/packages` — that's what let claims like "the server does send this field" be facts rather than guesses.

**Not examined:**
- `src/services/backup/backupService.ts` export/import racing a sync — a restore that overlaps an active sync is unaudited.
- The themes repo, `groupIcon.ts`, `share/*`, `media.ts`, `shortcuts/*`, `lock.ts`, `connection.ts`, `reachability.ts`.
- `socketService.ts` / `realtimeControl.ts` internals beyond their sink wiring; the FaceTime / typing / RCS-alert / server-URL sinks (confirmed write-free, then skipped).
- Most of `src/ui/**` rendering, the zustand stores beyond their kv hydrate/persist pairs, and the native Kotlin module.
- Individual migration bodies (only their index/constraint/trigger declarations were read).

**Only a device can settle these:**
1. How often a `withDbTransaction` callback actually throws (drives P1 and P11). Look for error-level "event handling failed" lines in the `error_reports` queue.
2. The timing gap between the HTTP send-ack and a socket `message-send-error` for the same message under an instant RCS bridge rejection (drives P3 and P4).
3. Whether any real user has a stuck-`sending` message with no queue row, or an orphan queue row with no message (drives P6). Two boot-time `COUNT(*)` queries would answer it.
4. Whether the background task can be mid-page when Disconnect completes (drives P2) — reproducible with `adb shell cmd jobscheduler run`.
5. Whether notify-kit's `createTriggerNotification` ever throws in this app (drives P8).
6. Whether `GET /scheduled` can succeed while taking longer than an edit-save cycle (drives P7).

**A note on the shape of this audit.** Several findings are *not* races at all — D7, D8, D9, D15, D16 are deterministic bugs found while looking for races. They were kept because the damage is real data loss and the fixes are small.

---

## 6. Prioritized worklist

### Fix now

| # | Item | Files | Size | Risk | How to verify |
|---|---|---|---|---|---|
| 1 | **D1** — route retry/discard through `cancelOutgoing`; close the sheet when its snapshot stops being an error row | `services/send/index.ts`, `db/repositories/outgoing.ts` (+1 helper), `ui/conversations/MessageList.tsx` | **M** | Medium — must not disturb the swallow guard (`outgoing.ts:225`) or `test/db/cancelOutgoing.test.ts:226` | Airplane mode → send → restore signal → open the sheet while the 20 s drain retries → tap Try Again. Recipient should get exactly one. Add a jest case asserting `retry()` on a non-error row does not re-POST. |
| 2 | **D2** — COALESCE the four date columns | `db/repositories/messages.ts:108-111` | **S** | Low, but write down the stranded-optimistic-unsend trade-off in the comment | Existing suite; add a case that upserts an older snapshot over a retracted row and asserts the tombstone survives. |
| 3 | **D5** — live marker in the monotonic guard | `db/repositories/chats.ts:192-195` | **S** | Low | `readReconcile.test.ts` should still pass unchanged; add a case where the marker advances between the batch read and the per-chat UPDATE. |
| 4 | **D6** — add-then-prune contacts (option A needs no migration) | `db/repositories/contacts.ts`, maybe `features/contacts/useContactSearch.ts` | **M** | Medium — the obvious `onConflictDoUpdate({target: sourceId})` **will throw**; there is no unique index | Open the compose screen immediately after connecting on a 1–2k-contact device; the suggestion list must never be empty. |
| 5 | **D12** — `ensureDatabase()` in `markRead`/`markUnread` + hydrate settings + log background-event failures | `services/chatActions.ts:55,77`, `services/notifications/{actions,backgroundEvents}.ts` | **S** | Low | `adb shell am kill <pkg>` (**never** `am force-stop`, per AGENTS.md), then tap "Mark as read" in the tray. Badge clears and the notification dismisses. |
| 6 | **D8** — tombstone the user's own message delete | `db/repositories/messages.ts`, `features/conversations/useMessageActions.ts:169,290` | **S** | Low — uses the mechanism the schema was built for | Delete messages, back out, re-open the chat. They must stay gone. |
| 7 | **D3** — mark the scheduled row terminal once the queue owns the send | `services/send/scheduleService.ts`, `services/send/sendService.ts` (return type) | **M** | Medium — touches the scheduled contract; keep the claim/attempt-cap intact | Schedule a message, `am kill` mid-send, relaunch. Exactly one delivery. |
| 8 | **D4** — `marked_unread_at` column | migration + `schema.ts` + `db/repositories/chats.ts` | **M** | Low (additive; column stays out of the conflict set) | Mark unread with Private API off → pull to refresh → badge must survive. New `readReconcile` case. |
| 9 | **D13** — fresh timestamp per row and per outcome | `services/send/outgoingQueueService.ts:161-167` | **S** | Low | Fail a large upload; assert `next_retry_at` lands in the future, not the past. |
| 10 | **D11** — `is_from_me = 0` in `markAllChatsReadLocal` | `db/repositories/chats.ts:602-608` | **S** | Low | Leave a failed send in a chat, Mark All Read, let the queue succeed, confirm the badge stays clear. |

### Fix soon (deterministic, smaller blast radius)

| # | Item | Files | Size | Risk | How to verify |
|---|---|---|---|---|---|
| 11 | **D7 + D10** — chat tombstone + chat-scoped cleanup of reminders/scheduled/draft, and cancel the OS alarms | migration, `db/repositories/chats.ts`, new `deleteChat` wrapper in `services/chatActions.ts`, 3 call sites | **L** | Medium — must keep `is_deleted` out of the conflict set and un-hide on send | Delete a customised chat, sync, confirm it stays gone; confirm its reminder doesn't fire. |
| 12 | **D9** — re-run the read reconcile after messages land | `services/sync/engine.ts:86` + after phase 2 | **S** | Low (idempotent) | Wipe and reconnect; the inbox should open with the Mac's read state. |
| 13 | **D14** — add `backgroundChannelGuid` to `ChatSummary` | `core/models/chatSummary.ts` | **S** | Low — do **not** COALESCE `chats.ts:50` | Receive a message in a wallpapered chat, go offline, open it. Wallpaper stays. |
| 14 | **D15** — COALESCE width/height/transferName | `db/repositories/attachments.ts:66-75` | **S** | Low | Share a landscape photo in, send, re-open the chat; it should correct itself. |
| 15 | **D16** — real upsert in `restoreThemes` | `db/repositories/backup.ts:58-65` | **S** | Low | Restore the same backup twice; theme count unchanged. |
| 16 | **P6** — swap the four insert orders, wrap `cancelOutgoing` in a transaction, offer Delete on optimistic rows | `db/repositories/{outgoing,attachments}.ts`, `ui/conversations/MessageActionsOverlay.tsx:176` | **M** | Low | Add the two boot-diagnostic counts first — they're half the fix and they'll tell you whether it's happening. |

### Fix if you see the symptom

17. **P3 / P4** — fold the sticky-error guard into the write; have `reconcileOutgoingError` report whether it owned a row. **S each.** Do these together; both are in `outgoing.ts` and share the "return what the write actually matched" shape.
18. **P1** — wrap each incremental-sync page (upserts + `setSyncMarker`) in one `withDbTransaction`. **M.** ⚠️ Keep the wrapped block short; `transaction.ts:50-52` warns against long transactions.
19. **P2** — `runTrackedSync` helper so the background task publishes into the coalescing slot. **S.** ⚠️ Do D6 first.
20. **P5** — compare-and-set on the edit/unsend revert. **S.**
21. **P8 / P9** — reorder `scheduleReminder`; make `updateReminderTime` return a boolean. **S each.**
22. **P7** — snapshot prunable ids before the `GET /scheduled`. **S.**
23. **P10 / P11** — drop `error` from the conflict set; verify the backfill's own ids before setting the flag. **S each.** Hygiene.

---

## 7. The pattern to internalize

Two rules would have prevented roughly two-thirds of what's above. They're worth taping to the wall.

### Rule 1 — If a write depends on a condition, put the condition *in the write*.

Never do this:
```ts
const cur = await db.all(sql`SELECT send_state FROM messages WHERE guid = ${g}`);
if (cur[0]?.sendState === 'error') return;
await db.update(messages).set({ sendState: 'sent' }).where(eq(messages.guid, g));
```
Do this:
```ts
const promoted = await db.all(sql`
  UPDATE messages SET send_state = 'sent'
   WHERE guid = ${g} AND send_state <> 'error'
  RETURNING id`);
if (promoted.length === 0) return;   // someone else changed it — respect that
```
The database checks the condition at the instant of the write; a separate `SELECT` checks it at some earlier instant that may no longer be true. **This applies even to a value you read into a variable and then interpolate into SQL** — `${current}` in `chats.ts:195` *looks* like a SQL guard but is a JavaScript constant baked into the statement text, which is exactly why D5 exists.

Same rule, applied to actions: **a UI action that removes work someone else may be doing must take the lease first, not delete around it.** D1 is that rule broken; `claimOutgoing` is that rule kept.

This one rule covers D1, D5, D11 (marker/id mismatch), D13, P3, P4, P5, P7, P9.

### Rule 2 — Never make the world *wrong* on the way to making it *right*.

Every write in this app commits on its own and immediately wakes every reactive query. There is no such thing as a private intermediate state. So:

- **Add, then prune** — never truncate-then-refill (D6). The already-shipped `upsertChats` fix is the model.
- **Schedule, then cancel** — never cancel-then-schedule (P8). `rescheduleReminder` already does it right and says why.
- **Write the durable record first, the visible one second** — the row that owns recovery must outlive the row the user sees (P6).
- **Absence is not a value.** In a conflict clause, `COALESCE` anything the wire may legitimately omit, and leave device-owned columns out of the clause entirely. A plain `excluded.x` says "the server is authoritative and always sends this" — if that isn't true, you've written a way for a stale page to erase good data (D2, D14, D15, P10).

This covers D2, D6, D7, D14, D15, P6, P8.

### Two supporting habits

- **A local delete of something the server still has is a tombstone, not a delete.** The schema already proves this (`date_deleted`) and the reasoning is written down at `messages.ts:153-162`. D7 and D8 are the same lesson not yet applied to chats and to the user's own message delete.
- **Any code reachable from a notification button or a push must use `ensureDatabase()`, and must not trust an in-memory store's defaults.** A headless wake has no React, no boot effect, and no hydrated settings. AGENTS.md says this; D12 is one function that missed it.

---

## Appendix — refuted, don't chase

**`deleteChatLocal`'s four separate deletes leaving a briefly-empty chat row visible.** The code is exactly as it looks (four autocommit deletes, no transaction) and the FK cascades do make two of them redundant — but every claimed damage failed verification. The reactive query's 24 ms debounce coalesces the burst into a single post-delete re-query, so the "flash of a raw phone number" is at worst one frame of a tile that's disappearing anyway; a message destroyed mid-delete is the user's own delete intent and the server still has it; the dropped-notification variant needs a sub-millisecond gap **and** a non-default setting; and the crash variant is repaired by the next `syncAllChats`. Unlike the `upsertChats` bug it resembles, the bad state is not re-created on every sync and does not persist.

**Two sub-claims inside otherwise-real findings were also refuted and should not be acted on:**
- Dropping the `sendState === 'sending'` condition at `outgoing.ts:225` and inverting `test/db/cancelOutgoing.test.ts:226`. `resend` flips the row to 'sending' *before* every POST, so that guard is correct as written.
- "Re-run the selecting query" as the fix for P11 — it never returns empty, so the flag would never be set.