# Local chat deletion: design notes

How deleting a conversation on the phone works, and the bugs behind each rule. Review M064 moved this
history out of the code comments in `src/db/repositories/chats.ts`; the code keeps a short summary.
Code: `deleteChatLocal`, `purgeChatMessages`, `resumeChatPurges`,
`clearSupersededTombstonesWithinTransaction`, `clearChatTombstoneWithinTransaction` and
`isChatHiddenByDeletion` in that file, and the `deleteChat` service wrapper in
`src/services/chatActions.ts`. How a deletion boundary combines with other message deletions is in
[MESSAGE_STATE_PROTOCOL.md](MESSAGE_STATE_PROTOCOL.md).

## What a local delete does

- It tombstones the chat row (`deleted_at` and `history_deleted_at`) instead of deleting it.
- In one transaction it sets that stamp, hands the unread floor to the read marker, and deletes the
  chat's pending outgoing-queue rows, locally owned scheduled messages and composer draft.
- After that transaction it purges the chat's messages in bounded chunks.
- It deletes nothing on the server (iMessage threads cannot be deleted there). State whose
  cancellation needs native or network work is left to `deleteChat`.

## A tombstone, not a row delete

The same reason applies as for `markMessageDeleted`: the delete is local only, so the server keeps
returning the chat. When the row was deleted, the next `syncAllChats` took `upsertChats`' INSERT
branch, which seeds only server fields. The thread came back with its pin, archive, mute, custom
name and colour, per-chat theme, wallpaper and read marker all reset to NULL, permanently, because
no re-sync can restore device-local columns. The only lasting effect of the delete was destroying
the user's own settings. Keeping the row keeps all of them.

`chat_handles` is not deleted either. The row survives, and a chat with no participant links has an
empty participant-name array, so if it ever reappeared `resolveTitle` would fall back to the raw
phone number.

## The decisions are one transaction

The tombstone stamp, the read-marker handover and the queue, scheduled-message and draft deletes are
a fixed handful of statements, and they run together. There is a single shared connection. As bare
autocommits, these statements silently joined whatever transaction a concurrent socket or FCM handler
had open, and a rollback on that side erased the tombstone: the conversation the user deleted was
simply still there, with nothing reported (the UI calls `void deleteChat(...)`). Half-states were
just as bad in the other direction. A process death between the tombstone and the queue purge left
the chat hidden while its scheduled send survived, fired into it and un-hid it again.

## The message purge is chunked, outside that transaction

The purge's row count is unbounded. A long-running thread reaches five figures, every deleted row
fires the `messages_ad` FTS trigger and cascades to `attachments`, and the transaction mutex is
process-wide. Holding it for the whole purge stalls every send, live message, sync slice and queue
claim. It also drags every unrelated autocommit issued in that window (a read marker, a download's
local path) into an atomicity it has nothing to do with.

Chunking is safe because the tombstone has already committed. A partly purged chat is invisible
either way: every surviving row is at or before `history_deleted_at`, so `chatVisible` stays false.
`purgeChatMessages` deletes only rows at or before that boundary, so a live message that lands
between two chunks survives (its own comment explains the bound).

## Interrupted purges resume

Chunking means the loop can be interrupted. Android may reclaim the process after the tile has
already vanished from the inbox, and the committed chunks do not record where the loop stopped.
Nothing re-enters the function on its own, so the leftovers (rows, their cascaded `attachments` rows
and their FTS entries) would survive and come back when the chat revives. `resumeChatPurges` finds
every chat whose stored history boundary still has purgeable rows under it and re-runs the same loop
with the stored stamp. Re-entry is safe by construction: the bound is a stored value, not a fresh
clock reading, so a second pass can only finish what the first started.

## The stamp is floored at the chat's newest message date

`now` is the device clock, while `messages.date_created` is the server's Apple-derived timestamp, and
the two are never reconciled. With the Mac even a few seconds ahead, the message the user had just
read carried a date later than the deletion stamp. The next sync's unconditional `lastMessage`
re-insert then satisfied `date_created > deleted_at`, and the conversation came back on every sync
with no user action. The stamp is therefore computed inside the statement and is at least the
chat's newest stored message date (and its existing history boundary), so no re-synced row can
out-date it.

That fixes the server being ahead. The opposite skew is not addressed. With the device clock ahead of
the Mac by Δ, the stamp lands Δ into the future of the server's timeline, so genuinely new messages
arriving within Δ are `<= deleted_at` and the chat stays hidden while their notifications arrive.
Both clocks are normally NTP-synced, so Δ is under a second. Clamping the device side instead would
need a tolerance constant that is itself a guess, and it would mis-floor a chat with no stored
messages, so the skew is documented rather than papered over.

## The unread floor moves to the read marker in the same statement

`deleted_at` does two jobs: it hides the chat, and it floors the unread count (`listChatsForInbox`
counts only `um.date_created > c.deleted_at`). Whoever un-hides the chat later drops the stamp and
would retire the second job with the first. Handing over at that point is too late, because by then
the purge has destroyed every message that could serve as the marker. So the boundary is pinned while
it still exists, into the read marker: the one mechanism built to hold a "read up to here" position
and to survive the purge. The marker is a GUID, so its message resolves again as soon as a backfill
re-inserts it.

Without this, deleting a never-opened thread (the spam or unknown-sender case people actually delete,
whose marker is NULL) and later writing to the same person again badged the entire re-synced history
as unread. The guard is strictly newer, so the marker only ever moves forward.

## Chat-scoped rows, and two deliberate exclusions

None of these tables has a foreign key to `chats`, so nothing cascades. Without the explicit deletes,
a scheduled message still fired into a deleted conversation, and the old draft was pre-filled again
if the chat ever returned. Two exclusions are deliberate:

- **Server-backed pending scheduled messages** (`server_id` set) are kept. The Mac fires those, so a
  local delete cancels nothing; it would only destroy the user's one handle for cancelling it.
  `deleteChat` cancels them on the server first and removes the rows it got confirmation for.
  Anything it could not reach stays on the Scheduled screen, still cancellable.
- **Reminders** are not touched. A reminder's trigger notification is OS state that outlives its
  row. Once the row is gone nothing can find the alarm again: not the Reminders screen and not
  `forget()`, because both enumerate through `listReminders`. So only whoever actually cancelled the
  alarm may remove the row: the `deleteChat` service wrapper, mirroring how `forget()` does it.
  `src/db` cannot do this itself, because it must stay free of React and native modules.
