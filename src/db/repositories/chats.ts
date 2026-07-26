import { and, eq, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { Chat, ChatSummary } from '@core/models';
import { chatHandles, chats, kv, outgoingQueue, scheduledMessages } from '../schema';
import { withDbTransaction } from '../transaction';
import type { AppDatabase } from '../types';
import { dedupeBy } from './_shared';
import { handleMapKey, upsertHandles } from './handles';
import { DRAFT_KV_PREFIX } from './maintenance';

/**
 * Upsert chats by guid and link participants; returns guid → row id.
 * `handleIdByKey` is the map `upsertHandles` returned for these chats' participants
 * (keyed by `handleMapKey`, i.e. address + service).
 */
export async function upsertChats(
  db: AppDatabase,
  items: Array<Chat | ChatSummary>,
  handleIdByKey: Map<string, number>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const deduped = dedupeBy(
    items.filter((c) => !!c?.guid),
    (c) => c.guid,
  );
  if (deduped.length === 0) return map;

  const rows = await db
    .insert(chats)
    .values(
      deduped.map((c) => ({
        guid: c.guid,
        originalRowId: c.originalROWID ?? null,
        chatIdentifier: c.chatIdentifier ?? null,
        displayName: c.displayName ?? null,
        style: c.style ?? null,
        isArchived: c.isArchived ?? false,
        isPinned: c.isPinned ?? false,
        muteType: c.muteType ?? null,
        // Server-owned (macOS 26 synced background): the current channel GUID, or null when the
        // chat has no background. Refreshed on every sync (unlike the device-local columns below).
        syncedBackgroundChannel:
          ('backgroundChannelGuid' in c ? c.backgroundChannelGuid : null) ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: chats.guid,
      set: {
        displayName: sql`excluded.display_name`,
        chatIdentifier: sql`excluded.chat_identifier`,
        style: sql`excluded.style`,
        // Server-owned → refreshed on re-sync (a changed/removed background propagates).
        syncedBackgroundChannel: sql`excluded.synced_background_channel`,
        // is_pinned, is_archived, mute_type, custom_name, custom_color are device-local:
        // SEEDED on first insert from the server, but NOT overwritten on a re-sync — the
        // user toggles them locally (pin / archive / mute / customization UI), so they
        // survive. (Pin/archive have no server round-trip in this client.)
        // marked_unread_at and deleted_at are device-local for the same reason and are load-
        // bearing: the server has no concept of either, so listing them here would let the next
        // sync page silently undo a "Mark as Unread" and RESURRECT a deleted conversation.
      },
    })
    .returning({ id: chats.id, guid: chats.guid });

  for (const r of rows) map.set(r.guid, r.id);

  // Reconcile participant links per chat. When a chat's payload INCLUDES a participants
  // list, REPLACE its links so a removed member is pruned (not just additively kept — the
  // old additive insert left removed members in chat_handles forever). A payload WITHOUT
  // participants leaves the existing links untouched (a partial/list-only sync mustn't wipe).
  //
  // ADD-THEN-PRUNE, never delete-then-add. Every write flushes the reactive queries and several
  // readers are UN-debounced (the chat header on mount, `chatHasKnownSender`'s unknown-sender
  // gate, `getChatHeader` behind the notification intents), so an intermediate state is genuinely
  // rendered — and a chat with ZERO participant rows has no `participantNames`, so `resolveTitle`
  // falls through to `chat_identifier`, i.e. the raw phone number, and the unknown-sender gate
  // answers "unknown" and drops the notification for good. Resolving the handle ids first (pure
  // JS, no writes) and inserting BEFORE pruning means the link set is only ever a superset of the
  // truth, never empty: the worst observable state is one extra, since-removed member.
  const links: { chatId: number; handleId: number }[] = [];
  const keepByChat = new Map<number, number[]>();
  for (const c of deduped) {
    const chatId = map.get(c.guid);
    if (chatId == null || c.participants == null) continue;
    const ids = [
      ...new Set(
        c.participants
          .map((p) => handleIdByKey.get(handleMapKey(p)))
          .filter((id): id is number => id != null),
      ),
    ];
    // An empty or fully-unresolvable participants list is TREATED AS "no information", not as
    // "this chat has no members" — the old `== null` check let `participants: []` through to the
    // delete, leaving a real chat nameless (it falls back to the raw phone number) until an
    // incoming message re-linked it. What makes the skip non-negotiable is the degraded server
    // read: the Mac-side participant query hands back an EMPTY map when it can't resolve the
    // handle columns, and that emits `participants: []` for every chat in the 200-chat page at
    // once — honoring it would blank the whole inbox in a single sync.
    //
    // THE TRADE-OFF, stated plainly: the server also sends `[]` for a chat that genuinely has no
    // chat_handle_join rows, so a group whose roster really empties (everyone else left) keeps its
    // departed members here until a payload with real participants arrives. Accepted deliberately —
    // one stale name on a group nobody remains in is cheaper than an inbox of phone numbers, and
    // nothing downstream distinguishes the two payloads.
    if (ids.length === 0) continue;
    keepByChat.set(chatId, ids);
    for (const handleId of ids) links.push({ chatId, handleId });
  }
  if (links.length > 0) {
    // chat_handles is PRIMARY KEY (chat_id, handle_id), so re-inserting a link that already
    // exists is a no-op and onConflictDoNothing needs no target.
    await db.insert(chatHandles).values(links).onConflictDoNothing();
    for (const [chatId, ids] of keepByChat) {
      await db
        .delete(chatHandles)
        .where(and(eq(chatHandles.chatId, chatId), notInArray(chatHandles.handleId, ids)));
    }
  }

  // Reconcile Mac-side read state (schema gap 7): a full `Chat` (chat query / sync path) may carry
  // `lastReadMessageTimestamp` (Unix ms) from the macOS `chat.last_read_message_timestamp` column.
  // Map it into our guid-based read marker — monotonically (see reconcileReadMarkersFromTimestamps).
  // Presence-driven: absent on `ChatSummary` (live message events + incremental-sync embedded
  // chats never model it) and on old-macOS rows, so guard with `in` (mirrors the
  // backgroundChannelGuid access above). This is the single chokepoint for chat ingestion, so
  // every full-Chat path is reconciled here without per-caller wiring. Collected across the batch
  // and reconciled in as few queries as possible (not a couple of SELECTs per chat) — see the fn.
  const readMarkerPairs: { chatId: number; timestampMs: number }[] = [];
  for (const c of deduped) {
    const ts = 'lastReadMessageTimestamp' in c ? c.lastReadMessageTimestamp : null;
    const chatId = map.get(c.guid);
    if (ts != null && chatId != null) readMarkerPairs.push({ chatId, timestampMs: ts });
  }
  await reconcileReadMarkersFromTimestamps(db, readMarkerPairs);
  // Retire any deletion tombstone this chat has already outlived (see the fn). Chat ingestion is
  // the one place every path — sync page, live socket/FCM event, `persistServerChat` — passes
  // through, so putting it here is what turns the un-hide from a re-derived read-time opinion into
  // a durable one-way write.
  await clearSupersededTombstones(db, [...map.values()]);
  return map;
}

/**
 * Reconcile Mac-side read watermarks into the local guid-based read marker for a BATCH of chats.
 *
 * macOS syncs `chat.last_read_message_timestamp` (Unix ms) on the chat query/sync paths. Our read
 * model is guid-based (`lastReadMessageGuid`; the unread count is received messages newer than that
 * marker's `date_created`), so map each timestamp to the newest LOCAL received message at/before that
 * instant and advance the marker to it. Marker semantics mirror `getNewestReceivedGuid` (the target
 * the existing `chat-read-status-changed` reconcile uses): received (`is_from_me = 0`), non-deleted;
 * a retracted or reaction row CAN be the marker — only its `date_created` matters as the unread
 * threshold. MONOTONIC: advance only when the resolved message is strictly newer than the current
 * marker's message date, so a marker the user has read FURTHER on this device is never regressed. A
 * null timestamp, empty chat, unresolvable timestamp (nothing received at/before it), or a target no
 * newer than the current marker → no-op. Idempotent: re-running with the same timestamp is a no-op.
 *
 * Batched to avoid the old ~2-SELECTs-PER-CHAT cost (≈2N reads on every N-chat sync page — ~800 for a
 * 400-chat account, on EVERY sync): ONE query loads every chat's current marker date; a cheap
 * pre-filter drops chats whose watermark cannot advance the marker (`ts <= markerDate` ⇒ the
 * candidate, itself `<= ts`, can never be strictly newer — the common steady-state case, so most
 * chats do zero work); and each surviving chat takes ONE combined UPDATE that finds the candidate and
 * re-applies BOTH guards against the LIVE row. Same strictly-greater advance, same
 * `date_created DESC, id DESC` tie-break, same received/non-deleted eligibility as the per-chat
 * version it replaced — the readReconcile suite pins every branch.
 *
 * THE BASELINE MUST BE READ INSIDE THE STATEMENT, not from the batch SELECT. Every iteration is an
 * `await` — a full round trip that yields the JS event loop — and a 200-chat sync page keeps this
 * loop running for hundreds of milliseconds. Two other writers move the marker in that window
 * (opening a chat → `markRead`, and a `chat-read-status-changed` event, which is triggered by the
 * very action that moves the watermark being reconciled here). A JS constant captured before the
 * loop says "never read" for a chat the user has since read, so `2000 > 0` passes and the marker is
 * dragged BACKWARDS to the Mac's older watermark — the chat you just read goes bold again. The
 * pre-filter keeps the captured copy, which is safe: a stale SKIP can only lose an advance the next
 * sync redoes, while a stale WRITE loses read state the user can see.
 */
async function reconcileReadMarkersFromTimestamps(
  db: AppDatabase,
  pairs: { chatId: number; timestampMs: number }[],
): Promise<void> {
  if (pairs.length === 0) return;

  // One query for every chat's current marker message date — 0 when never read or the marker row
  // isn't local (mirrors the inbox unread query's COALESCE(..., 0)) — plus the deliberate
  // mark-as-unread stamp, so both pre-filters cost the same single read.
  const inList = sql.join(
    pairs.map((p) => sql`${p.chatId}`),
    sql`, `,
  );
  // Annotate the variable (not the db.all generic) — the loose AppDatabase types db.all's result as
  // `any`, so `.map` below would otherwise trip noImplicitAny (mirrors upsertMessages' `existing`).
  const markerRows: Array<{ chatId: number; markerDate: number; markedUnreadAt: number | null }> =
    await db.all(sql`
    SELECT c.id AS chatId, COALESCE(lm.date_created, 0) AS markerDate,
           c.marked_unread_at AS markedUnreadAt
      FROM chats c LEFT JOIN messages lm ON lm.guid = c.last_read_message_guid
     WHERE c.id IN (${inList})
  `);
  const state = new Map(markerRows.map((r) => [r.chatId, r]));

  for (const { chatId, timestampMs } of pairs) {
    const row = state.get(chatId);
    const current = row?.markerDate ?? 0;
    // Pre-filter: the candidate (newest received at/before ts) has date_created <= ts, so if ts is
    // already <= the current marker date it can never be strictly newer — skip the per-chat write.
    if (timestampMs <= current) continue;
    // Pre-filter 2: a watermark at/before the moment the user tapped "Mark as Unread" describes a
    // read that happened BEFORE that tap, so it must not clear the flag they just set.
    const markedUnreadAt = row?.markedUnreadAt ?? null;
    if (markedUnreadAt != null && timestampMs <= markedUnreadAt) continue;
    // One combined statement (db.run — a non-returning UPDATE): point the marker at the newest
    // received, non-deleted message at/before the watermark, but only when that candidate is strictly
    // newer than the marker AS IT STANDS NOW (the monotonic guard, re-read from the row rather than
    // from the pre-loop snapshot) and the user hasn't marked the chat unread since. Advancing the
    // marker means the chat is read, so the mark-unread flag is cleared in the same write — leaving
    // it set would keep suppressing later, genuinely newer watermarks. `date_created <= ts` also
    // drops NULL-dated rows; a chat with no candidate yields NULL from MAX(...) → guard false → no-op.
    await db.run(sql`
      UPDATE chats SET last_read_message_guid = (
        SELECT m.guid FROM messages m
         WHERE m.chat_id = ${chatId} AND m.is_from_me = 0 AND m.date_deleted IS NULL
           AND m.date_created <= ${timestampMs}
         ORDER BY m.date_created DESC, m.id DESC LIMIT 1
      ), marked_unread_at = NULL
      WHERE id = ${chatId}
        AND (chats.marked_unread_at IS NULL OR chats.marked_unread_at < ${timestampMs})
        AND (SELECT MAX(m.date_created) FROM messages m
              WHERE m.chat_id = ${chatId} AND m.is_from_me = 0 AND m.date_deleted IS NULL
                AND m.date_created <= ${timestampMs})
            > COALESCE((SELECT lm.date_created FROM messages lm
                         WHERE lm.guid = chats.last_read_message_guid), 0)
    `);
  }
}

/** Persist a server-returned chat (display name + participant links) locally. */
export async function persistServerChat(db: AppDatabase, chat: Chat): Promise<void> {
  const handleIds = await upsertHandles(db, chat.participants ?? []);
  await upsertChats(db, [chat], handleIds);
}

/** Set a chat's local mute preference ('mute' to mute, null to clear). */
export async function setChatMute(
  db: AppDatabase,
  guid: string,
  muteType: string | null,
): Promise<void> {
  await db.update(chats).set({ muteType }).where(eq(chats.guid, guid));
}

/**
 * Pin / unpin a chat. Client-local — Gator pin is a device state, not a server
 * concept; kept out of `upsertChats`' conflict set so a re-sync can't clobber it.
 * The inbox sorts pinned chats first (see `listChatsForInbox`).
 */
export async function setChatPin(db: AppDatabase, guid: string, pinned: boolean): Promise<void> {
  await db.update(chats).set({ isPinned: pinned }).where(eq(chats.guid, guid));
}

/** Archive / unarchive a chat (client-local). Archived chats drop out of the main inbox. */
export async function setChatArchive(
  db: AppDatabase,
  guid: string,
  archived: boolean,
): Promise<void> {
  await db.update(chats).set({ isArchived: archived }).where(eq(chats.guid, guid));
}

/**
 * SQL predicate for "this chat belongs in a list" — i.e. it is not sitting under a local deletion
 * tombstone. `alias` is the name the surrounding query gives the chats table.
 *
 * A tombstoned chat comes BACK on its own the moment genuinely new activity arrives. The predicate
 * is a safety net that answers correctly even before `clearSupersededTombstones` has retired the
 * stamp; that write is what makes the un-hide durable.
 *
 * "GENUINELY NEW ACTIVITY" MUST MEAN THE SAME THING HERE AS IT DOES IN THE PREVIEW AND THE UNREAD
 * COUNT — hence the three extra filters, which are exactly the ones `listChatsForInbox`'s `last`
 * CTE and its `unreadCount` sub-select already apply. A reaction (`associated_message_type` set) and
 * an unsent message (`date_retracted` set) both store a row with a fresh `date_created` and NO
 * visible content: with a looser predicate here, someone tapping a heart on an old message in a
 * thread you deleted resurrected the whole conversation, rendering its ORIGINAL pre-deletion
 * preview and timestamp with a 0 badge — a chat that un-hides must have something to show.
 *
 * Re-synced HISTORY can't un-hide anything either, because `deleteChatLocal` floors the stamp at
 * the chat's newest stored message, so every re-inserted row is `<=` it by construction.
 */
export function chatVisible(alias: string) {
  const t = sql.raw(alias);
  return sql`(${t}.deleted_at IS NULL OR EXISTS (
    SELECT 1 FROM messages dm
     WHERE dm.chat_id = ${t}.id AND dm.date_deleted IS NULL
       AND dm.associated_message_type IS NULL AND dm.date_retracted IS NULL
       AND dm.date_created > ${t}.deleted_at))`;
}

/**
 * Retire the deletion tombstone of any of `chatIds` that has since received a message newer than
 * it — a compare-and-set that can only ever move one way (stamped → NULL, never back).
 *
 * WHY A WRITE AND NOT JUST THE READ PREDICATE. Derived visibility is REVOCABLE: the chat is only
 * visible for as long as a qualifying row survives, so a conversation the user deleted, got a
 * message in, and has been using for days silently VANISHES again — with all of it — the moment
 * that one message stops qualifying. Deleting a single spam message in it is enough (the user's own
 * Delete tombstones the row via `markMessageDeleted`), and so is the sender unsending it. No chat
 * was deleted, yet the whole thread disappears. Recording the un-hide makes it a one-way
 * transition, matching how `date_deleted` on a message behaves.
 *
 * The condition is IN the write, and is the same predicate `chatVisible` reads with, so this can
 * never clear a tombstone the read queries would still be honouring: re-synced history, a reaction
 * or an unsent message leave it exactly where it was.
 */
export async function clearSupersededTombstones(db: AppDatabase, chatIds: number[]): Promise<void> {
  if (chatIds.length === 0) return;
  const inList = sql.join(
    chatIds.map((id) => sql`${id}`),
    sql`, `,
  );
  // One statement for the whole batch (a 200-chat sync page must not cost 200 round trips), and
  // `deleted_at IS NOT NULL` means the EXISTS is only evaluated for the handful of chats that are
  // actually tombstoned — normally none.
  //
  // HAND THE UNREAD FLOOR OVER BEFORE DROPPING THE STAMP. `deleted_at` does two jobs: it hides the
  // chat, and it floors the unread count (`listChatsForInbox` counts only `um.date_created >
  // c.deleted_at`) so a revived conversation badges the ONE new message rather than its whole
  // re-synced history. Clearing it would silently retire the second job with the first. So the same
  // statement advances the read marker to the newest received message at or before the boundary —
  // the mechanism that is actually designed to hold a "read up to here" position, and one that
  // survives having no tombstone. The candidate is required to be strictly NEWER than whatever the
  // marker currently resolves to, so this can only ever move it forward.
  await db.run(sql`
    UPDATE chats
       SET last_read_message_guid = COALESCE(
             (SELECT fm.guid FROM messages fm
               WHERE fm.chat_id = chats.id AND fm.is_from_me = 0 AND fm.date_deleted IS NULL
                 AND fm.associated_message_type IS NULL
                 AND fm.date_created <= chats.deleted_at
                 AND fm.date_created > COALESCE(
                       (SELECT lm.date_created FROM messages lm
                         WHERE lm.guid = chats.last_read_message_guid), 0)
               ORDER BY fm.date_created DESC, fm.id DESC LIMIT 1),
             chats.last_read_message_guid),
           deleted_at = NULL
     WHERE id IN (${inList}) AND deleted_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM messages dm
                    WHERE dm.chat_id = chats.id AND dm.date_deleted IS NULL
                      AND dm.associated_message_type IS NULL AND dm.date_retracted IS NULL
                      AND dm.date_created > chats.deleted_at)
  `);
}

/**
 * Locally delete a chat: TOMBSTONE the chat row, then destroy the chat-scoped rows this layer can
 * safely destroy — messages, pending outgoing-queue rows, locally-owned scheduled messages and the
 * composer draft. Does NOT delete on the server (iMessage threads aren't server-deletable), and
 * does not touch state whose cancellation needs the native/network layer (see the exclusions
 * below) — that is the `deleteChat` service wrapper's job.
 *
 * TOMBSTONE, NOT A ROW DELETE, for the same reason `markMessageDeleted` is one: the delete is
 * local-only, so the server keeps returning the chat and the very next `syncAllChats` takes
 * `upsertChats`' INSERT branch — which seeds ONLY server fields. The thread came back with its
 * pin, archive, mute, custom name and colour, per-chat theme, wallpaper and read marker all reset
 * to NULL, permanently (no re-sync can restore device-local columns), so the only thing the delete
 * durably accomplished was destroying the user's own settings. Keeping the row keeps all of it.
 *
 * `chat_handles` is deliberately NOT deleted: the row survives now, and a chat with zero
 * participant links has no `participantNames`, so if it ever un-hides `resolveTitle` falls through
 * to the raw phone number.
 *
 * THE DECISIONS ARE ONE TRANSACTION; THE BULK PURGE IS NOT. Everything that decides what the chat
 * IS after the delete — the tombstone stamp, the read-marker handover, and the queue/scheduled/draft
 * deletes — is a fixed handful of statements and runs together, because there is a single shared
 * connection: as bare autocommits they silently JOINED whatever transaction a concurrent socket/FCM
 * handler happened to have open, and a rollback on THAT side erased the tombstone, leaving the
 * conversation the user deleted simply still there with nothing reported (the UI calls this as
 * `void deleteChat(...)`). The half-states are just as bad in the other direction: a process death
 * between the tombstone and the queue purge left the chat hidden while its scheduled send survived
 * to fire into it and un-hide it again.
 *
 * The MESSAGE purge is deliberately outside it, in bounded chunks, because its row count is
 * UNBOUNDED — a long-running thread reaches five figures, every deleted row fires the `messages_ad`
 * FTS trigger and cascades to `attachments`, and the transaction mutex is PROCESS-WIDE. Holding it
 * for that stalls every send, every live message, every sync slice and every queue claim, and drags
 * every unrelated autocommit issued in that window (a read marker, a download's local path) into an
 * atomicity it has nothing to do with. Chunking is safe here precisely because the tombstone has
 * ALREADY committed: a partially-purged chat is invisible either way (every surviving row is
 * `<= deleted_at` by the floor below, so `chatVisible` stays false).
 *
 * THE FLIP SIDE OF CHUNKING IS THAT THE LOOP CAN BE INTERRUPTED — Android reclaims the process while
 * the tile has already vanished from the inbox — and the chunks already committed do not tell anyone
 * where it stopped. Nothing re-enters this function on its own, so the leftovers (rows, their
 * cascaded `attachments` rows and their FTS entries) would sit there forever, invisible but real,
 * and reappear the day the chat revives. `resumeChatPurges` is the resume: it finds every chat whose
 * tombstone still has purgeable rows under it and re-runs exactly this loop with the STORED stamp.
 * Re-entry is safe by construction — the bound is a stored value, not a fresh clock reading, so a
 * second pass can only finish what the first started.
 *
 * THE STAMP IS FLOORED AT THE CHAT'S NEWEST MESSAGE DATE, computed inside the statement. `now` is
 * the DEVICE clock; `messages.date_created` is the SERVER's Apple-derived timestamp, and the two
 * are never reconciled. With the Mac even seconds ahead, the message the user just read carried a
 * date GREATER than the deletion stamp — so the next sync's unconditional `lastMessage` re-insert
 * satisfied `date_created > deleted_at` and the conversation came back, deterministically, every
 * sync, with no user action. Flooring makes the stamp at least as new as anything already stored,
 * so no re-synced row can ever out-date it. NOTE WHICH DIRECTION THAT COVERS: it fixes the SERVER
 * being ahead (spurious resurrection). The opposite skew — a DEVICE clock ahead of the Mac by Δ —
 * is NOT addressed: the stamp lands Δ into the future of the server's timeline, so genuinely new
 * messages arriving in the next Δ are `<= deleted_at` and the chat stays hidden while its
 * notifications arrive. Both clocks are normally NTP-synced, so Δ is sub-second; clamping the
 * device component instead would need a tolerance constant that is itself a guess, and it would
 * mis-floor a chat with no stored messages, so the skew is documented rather than papered over.
 *
 * THE UNREAD FLOOR IS HANDED TO THE READ MARKER IN THE SAME STATEMENT. `deleted_at` does two jobs:
 * it hides the chat, and it floors the unread count (`listChatsForInbox` counts only
 * `um.date_created > c.deleted_at`). Whoever un-hides the chat later drops the stamp and would
 * retire the second job with the first — and doing the handover THERE is too late, because by then
 * this purge has destroyed every message that could serve as the marker. So the boundary is pinned
 * while it still exists, into the one mechanism designed to hold a "read up to here" position and
 * to survive the row purge (the marker is a GUID: the message re-resolves the moment a backfill
 * re-inserts it). Without this, deleting a never-opened thread — the spam/unknown-sender case
 * people actually delete, whose marker is NULL — and later re-composing to the same person badged
 * the ENTIRE re-synced history. Strictly-newer guard, so it can only ever move the marker forward.
 *
 * The deletes exist because NONE of these tables has a foreign key to `chats`, so nothing cascades:
 * a scheduled message still fires into a deleted conversation and the old draft is still pre-filled
 * if the chat ever returns. Two exclusions are deliberate:
 *  - SERVER-BACKED pending scheduled messages (`server_id` set) are kept. The Mac fires those, so a
 *    local delete doesn't cancel anything — it just destroys the only handle the user had to cancel
 *    it. `deleteChat` cancels them server-side first and removes the rows it got confirmation for;
 *    whatever it couldn't reach stays listed on the Scheduled screen, still cancellable.
 *  - `reminders` are not touched here at all. A reminder's trigger notification is OS state that
 *    outlives its row, and once the row is gone NOTHING can find the alarm again — not the
 *    Reminders screen, not `forget()`, both of which enumerate via `listReminders`. So the row may
 *    only be removed by whoever actually cancelled the alarm: the `deleteChat` service wrapper
 *    (`src/services/chatActions.ts`), mirroring how `forget()` does it. `src/db` can't do it
 *    itself — it must stay free of React and native modules.
 */
export async function deleteChatLocal(
  db: AppDatabase,
  guid: string,
  now: number = Date.now(),
): Promise<void> {
  // Resolved OUTSIDE the transaction (a plain SELECT) so the chunked purge below can use it too,
  // and so an unknown guid costs no BEGIN/COMMIT at all.
  const chatId = await getChatIdByGuid(db, guid);
  if (chatId == null) return;
  const boundary = await withDbTransaction(db, async () => {
    // MAX(a, b) is SQLite's two-argument SCALAR max; the inner MAX(...) is the aggregate. Runs
    // BEFORE the messages are dropped — afterwards there is nothing left to floor against, and the
    // same is true of the marker candidate. Every SET expression reads the PRE-update row, so
    // `chats.last_read_message_guid` in the sub-selects is the marker as it stands now.
    // The candidate needs no upper date bound: every message in the chat is about to go, and the
    // stamp above is floored at the newest of them, so they are all at/before the boundary. Same
    // eligibility as `clearSupersededTombstones`' handover (received, non-deleted, non-reaction) so
    // the two can never disagree about what "read up to the deletion" means.
    // RETURNING, because the purge below needs the resolved stamp as a LITERAL upper bound and it
    // must be the value this statement computed — re-reading the column later would pick up a NULL
    // if a message arriving mid-purge has since retired the tombstone.
    const stamped: Array<{ deletedAt: number }> = await db.all(sql`
      UPDATE chats
         SET deleted_at = MAX(${now}, COALESCE(
               (SELECT MAX(m.date_created) FROM messages m WHERE m.chat_id = ${chatId}), 0)),
             latest_message_date = NULL,
             last_read_message_guid = COALESCE(
               (SELECT fm.guid FROM messages fm
                 WHERE fm.chat_id = ${chatId} AND fm.is_from_me = 0 AND fm.date_deleted IS NULL
                   AND fm.associated_message_type IS NULL
                   AND fm.date_created > COALESCE(
                         (SELECT lm.date_created FROM messages lm
                           WHERE lm.guid = chats.last_read_message_guid), 0)
                 ORDER BY fm.date_created DESC, fm.id DESC LIMIT 1),
               chats.last_read_message_guid)
       WHERE id = ${chatId}
      RETURNING deleted_at AS deletedAt
    `);
    await db.delete(outgoingQueue).where(eq(outgoingQueue.chatGuid, guid));
    await db.delete(scheduledMessages).where(
      and(
        eq(scheduledMessages.chatGuid, guid),
        // Local-only rows (the on-device ticker owns them, so dropping the row IS the cancel)
        // plus already-settled history. A PENDING server-backed row is left for `deleteChat`.
        or(isNull(scheduledMessages.serverId), ne(scheduledMessages.status, 'pending')),
      ),
    );
    await db.delete(kv).where(eq(kv.key, `${DRAFT_KV_PREFIX}${guid}`));
    // `now` is only a fallback for a row that somehow returned nothing; it is the SAFE direction
    // (it can only leave rows behind for a re-run, never destroy a newer one).
    return stamped[0]?.deletedAt ?? now;
  });
  await purgeChatMessages(db, chatId, boundary);
}

/**
 * How many messages one purge chunk destroys. Each chunk is a single statement, so the cost is one
 * round trip per chunk rather than one per row; the number only bounds how long the process-wide
 * write lock is held at a stretch, which is what makes a 50k-message thread survivable.
 */
const MESSAGE_PURGE_CHUNK = 500;

/**
 * Destroy a chat's messages in bounded chunks, each its own short transaction.
 *
 * `DELETE FROM messages WHERE chat_id = ?` is one statement but UNBOUNDED work (per-row FTS trigger
 * + attachment cascade), and the transaction mutex is process-wide — see the note on
 * `deleteChatLocal`. `WHERE id IN (SELECT … LIMIT n)` rather than `DELETE … LIMIT n` because the
 * latter needs SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which neither driver is guaranteed to have.
 * A short chunk means "fewer rows matched than we asked for", i.e. nothing is left — the loop is
 * therefore self-terminating without a second confirming query.
 *
 * IT DELETES ONLY WHAT EXISTED AT DELETION TIME (`date_created <= boundary`, the resolved stamp).
 * Yielding the lock between chunks is the whole point, and that means a live socket/FCM message can
 * land mid-purge — an unbounded `WHERE chat_id = ?` would destroy it on the next chunk, silently
 * losing a message the user was never told about and leaving the chat visible (that arrival retires
 * the tombstone) but empty. The bound is exactly the tombstone's own rule: everything at or before
 * the boundary is deleted history, anything after it is new activity that brings the chat back. A
 * NULL date can never satisfy `> deleted_at`, so it counts as history and goes.
 */
async function purgeChatMessages(db: AppDatabase, chatId: number, boundary: number): Promise<void> {
  for (;;) {
    const purged: Array<{ id: number }> = await withDbTransaction(db, () =>
      db.all(sql`
        DELETE FROM messages
         WHERE id IN (SELECT id FROM messages
                       WHERE chat_id = ${chatId}
                         AND (date_created IS NULL OR date_created <= ${boundary})
                       LIMIT ${MESSAGE_PURGE_CHUNK})
        RETURNING id
      `),
    );
    if (purged.length < MESSAGE_PURGE_CHUNK) return;
  }
}

/**
 * Finish any chat purge that was interrupted — the resume `deleteChatLocal` is written against.
 *
 * The purge yields the process-wide write lock between chunks, so a process death (or a chunk that
 * throws) leaves a tombstoned chat holding part of its history with nobody left to remove it: the
 * chat is hidden, so the user cannot even see the leftovers to delete them again, and they come back
 * in full the day the chat revives.
 *
 * IT SELECTS ONLY CHATS THAT ACTUALLY HAVE LEFTOVERS, so the normal case (nothing interrupted, but
 * possibly dozens of long-dead tombstones) costs ONE query and opens no transaction at all. Each
 * re-run uses the chat's STORED stamp, so it deletes exactly what the original pass would have and
 * nothing that arrived since — a chat whose tombstone was retired by a real message
 * (`clearSupersededTombstones`, which every ingestion path runs) is not selected here at all, so a
 * revived conversation's history is never touched. A still-stamped chat is by definition one the
 * user deleted and that has had no ingested activity since, and everything at or before the stamp is
 * what they asked to destroy.
 *
 * Driven from `deleteChat` — the one place a purge is ever started — so an interrupted purge is
 * finished by the next delete, including its own if `deleteChatLocal`'s loop is what threw. Cheap
 * and idempotent enough to run from a launch path as well.
 */
export async function resumeChatPurges(db: AppDatabase): Promise<void> {
  const pending: Array<{ id: number; deletedAt: number }> = await db.all(sql`
    SELECT c.id, c.deleted_at AS deletedAt
      FROM chats c
     WHERE c.deleted_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM messages m
                    WHERE m.chat_id = c.id
                      AND (m.date_created IS NULL OR m.date_created <= c.deleted_at))
  `);
  for (const c of pending) await purgeChatMessages(db, c.id, c.deletedAt);
}

/**
 * Is this chat sitting under a local deletion tombstone, i.e. hidden from every list?
 *
 * The same predicate the lists read with, NOT a bare `deleted_at IS NOT NULL`: a chat that has been
 * brought back by genuinely new activity is visible from that instant, and only becomes durably
 * un-deleted when the next ingestion retires its stamp (`clearSupersededTombstones`). An optimistic
 * SEND into a deleted thread is exactly that gap — it writes the message row directly and clears no
 * stamp — so the coarser check would report a conversation the user is actively using as deleted.
 *
 * Its caller is the chat screen's on-open history backfill, which must not re-page a purged
 * conversation back into the DB (and back into the FTS index) behind the user's back: the chat is in
 * no list, so they can neither see the restored history nor delete it again. Unknown guid → false,
 * so a chat that has not been stored yet still backfills normally.
 */
export async function isChatHiddenByDeletion(db: AppDatabase, guid: string): Promise<boolean> {
  const rows: Array<{ hidden: number }> = await db.all(sql`
    SELECT 1 AS hidden FROM chats c WHERE c.guid = ${guid} AND NOT ${chatVisible('c')} LIMIT 1
  `);
  return rows.length > 0;
}

/**
 * The guids of this chat's DOWNLOADED attachments — the ones with a file on disk.
 *
 * `attachments.local_path` is the ONLY record that a download ever happened, and it cascades away
 * with the messages, so this has to be read BEFORE the delete or the files become unreachable by any
 * code path (the same argument `forget()`'s `deleteCachedMedia` is built on). `guid` is what names
 * the on-disk directory, so that is what the caller needs; rows with no `local_path` were never
 * fetched and own nothing to delete.
 */
export async function listChatAttachmentGuids(
  db: AppDatabase,
  chatGuid: string,
): Promise<string[]> {
  const rows: Array<{ guid: string }> = await db.all(sql`
    SELECT DISTINCT a.guid AS guid
      FROM attachments a
      JOIN messages m ON m.id = a.message_id
      JOIN chats c ON c.id = m.chat_id
     WHERE c.guid = ${chatGuid} AND a.local_path IS NOT NULL
  `);
  return rows.map((r) => r.guid);
}

/** How many guids one `listOrphanedAttachmentGuids` probe binds (SQLite caps bound parameters). */
const ATTACHMENT_GUID_PROBE_CHUNK = 400;

/**
 * Of `guids`, the ones whose `attachments` row is GONE — i.e. nothing in the database points at
 * their file any more.
 *
 * The delete path reads the candidates before the purge and deletes files after it, and those are
 * not the same instant: the purge is bounded at the tombstone stamp and can be interrupted, so a row
 * can legitimately survive. Deleting its file anyway would leave a message rendering a permanently
 * broken image. Re-checking is what makes "the purge orphaned it" the actual condition instead of an
 * assumption. `guid` is UNIQUE in `attachments`, so a surviving row means exactly that.
 */
export async function listOrphanedAttachmentGuids(
  db: AppDatabase,
  guids: string[],
): Promise<string[]> {
  if (guids.length === 0) return [];
  const surviving = new Set<string>();
  for (let i = 0; i < guids.length; i += ATTACHMENT_GUID_PROBE_CHUNK) {
    const chunk = guids.slice(i, i + ATTACHMENT_GUID_PROBE_CHUNK);
    const inList = sql.join(
      chunk.map((g) => sql`${g}`),
      sql`, `,
    );
    const rows: Array<{ guid: string }> = await db.all(
      sql`SELECT guid FROM attachments WHERE guid IN (${inList})`,
    );
    for (const r of rows) surviving.add(r.guid);
  }
  return guids.filter((g) => !surviving.has(g));
}

/**
 * Lift a chat's deletion tombstone (no-op when it isn't tombstoned).
 *
 * Deliberately re-composing a conversation with the same people is the one un-hide that isn't
 * covered by "a newer message exists": a 1:1 guid is derived from the address, so the server hands
 * back the SAME guid the user deleted, and without this the new-chat flow would route them into a
 * thread that is still hidden from their inbox. Called from `createNewChat`.
 *
 * NO READ-MARKER HANDOVER HERE, unlike `clearSupersededTombstones` — and that is not an oversight.
 * `deleted_at` also floors the unread count, so dropping it uncovers the whole re-synced history;
 * but the handover cannot be done at THIS point, because `deleteChatLocal` has already destroyed
 * every message that could serve as the marker (routing into the chat is what re-pages them, and
 * that happens after this returns). The floor is therefore pinned at DELETE time, while the
 * boundary message still exists — see `deleteChatLocal`. Keep it that way: adding a handover here
 * would be a second copy of the same SQL that provably matches nothing.
 */
export async function clearChatTombstone(db: AppDatabase, guid: string): Promise<void> {
  await db.update(chats).set({ deletedAt: null }).where(eq(chats.guid, guid));
}

/**
 * Set a chat's local customizations. Pass a field as `undefined` to leave it
 * unchanged, or `null` to clear it (revert to default). Validates the color.
 */
export async function setChatCustomization(
  db: AppDatabase,
  guid: string,
  patch: { customName?: string | null; customColor?: string | null },
): Promise<void> {
  const set: { customName?: string | null; customColor?: string | null } = {};
  if (patch.customName !== undefined) {
    const trimmed = patch.customName?.trim();
    set.customName = trimmed ? trimmed : null;
  }
  if (patch.customColor !== undefined) {
    if (patch.customColor !== null && !/^#[0-9a-f]{6}$/i.test(patch.customColor)) {
      throw new Error(`invalid custom color: ${patch.customColor}`);
    }
    set.customColor = patch.customColor;
  }
  if (Object.keys(set).length === 0) return;
  await db.update(chats).set(set).where(eq(chats.guid, guid));
}

/**
 * Set a chat's per-chat theme override and/or chat-background image. Pass a field
 * as `undefined` to leave it unchanged, or `null` to clear it (revert to the global
 * theme / no background). Device-local — excluded from upsertChats' conflict set.
 */
export async function setChatTheme(
  db: AppDatabase,
  guid: string,
  patch: { themeTokens?: string | null; backgroundUri?: string | null },
): Promise<void> {
  const set: { themeTokens?: string | null; backgroundUri?: string | null } = {};
  if (patch.themeTokens !== undefined) set.themeTokens = patch.themeTokens;
  if (patch.backgroundUri !== undefined) set.backgroundUri = patch.backgroundUri;
  if (Object.keys(set).length === 0) return;
  await db.update(chats).set(set).where(eq(chats.guid, guid));
}

/**
 * A chat's per-chat theme override + background uris (null fields → inherit/none). Includes
 * both the device-local `backgroundUri` (the user's pick) and the macOS 26 `syncedBackgroundUri`
 * (downloaded from the server); the UI resolves the effective background as local ?? synced.
 */
export async function getChatTheme(
  db: AppDatabase,
  guid: string,
): Promise<{
  themeTokens: string | null;
  backgroundUri: string | null;
  syncedBackgroundUri: string | null;
  /** 1 = light wallpaper, 0 = dark, null = unknown/none (raw column value). */
  backgroundIsLight: number | null;
} | null> {
  const rows = await db.all<{
    themeTokens: string | null;
    backgroundUri: string | null;
    syncedBackgroundUri: string | null;
    backgroundIsLight: number | null;
  }>(
    sql`SELECT theme_tokens AS themeTokens, background_uri AS backgroundUri,
               synced_background_uri AS syncedBackgroundUri,
               background_is_light AS backgroundIsLight
          FROM chats WHERE guid = ${guid} LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Store the effective wallpaper's luminance (true = light → dark overlay text; null = unknown). */
export async function setBackgroundIsLight(
  db: AppDatabase,
  guid: string,
  isLight: boolean | null,
): Promise<void> {
  await db.update(chats).set({ backgroundIsLight: isLight }).where(eq(chats.guid, guid));
}

/**
 * The macOS 26 synced-background state for a chat: the server's current `channel` (the version)
 * and the `uri` of the local file already downloaded for it. The background-sync service compares
 * them to decide whether to (re)download.
 */
export async function getSyncedBackgroundState(
  db: AppDatabase,
  guid: string,
): Promise<{ channel: string | null; uri: string | null } | null> {
  const rows = await db.all<{ channel: string | null; uri: string | null }>(
    sql`SELECT synced_background_channel AS channel, synced_background_uri AS uri
          FROM chats WHERE guid = ${guid} LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Set (or clear, with null) the local file path of a chat's downloaded synced background. */
export async function setSyncedBackgroundUri(
  db: AppDatabase,
  guid: string,
  uri: string | null,
): Promise<void> {
  await db.update(chats).set({ syncedBackgroundUri: uri }).where(eq(chats.guid, guid));
}

// ---- Queries ---------------------------------------------------------------

/** Inbox: non-archived chats, most-recent first. Locally deleted chats are hidden (chatVisible). */
export function listChats(db: AppDatabase, opts: { includeArchived?: boolean } = {}) {
  const visible = chatVisible('chats');
  if (opts.includeArchived) {
    return db
      .select()
      .from(chats)
      .where(visible)
      .orderBy(sql`${chats.latestMessageDate} DESC NULLS LAST`);
  }
  return db
    .select()
    .from(chats)
    .where(and(eq(chats.isArchived, false), visible))
    .orderBy(sql`${chats.latestMessageDate} DESC NULLS LAST`);
}

/**
 * One row per chat, ready to render a conversation tile: chat metadata, the
 * latest message preview, participant names/count, and an unread count — in a
 * single query. Raw SQL via db.all so it runs identically on op-sqlite (device)
 * and better-sqlite3 (tests). Booleans come back as 0/1 integers.
 */
export interface InboxRow {
  id: number;
  guid: string;
  chatIdentifier: string | null;
  displayName: string | null;
  customName: string | null;
  customColor: string | null;
  style: number | null;
  isPinned: number;
  isArchived: number;
  muteType: string | null;
  latestMessageDate: number | null;
  lastReadMessageGuid: string | null;
  lastText: string | null;
  lastSubject: string | null;
  lastIsFromMe: number | null;
  lastHasAttachments: number | null;
  lastDate: number | null;
  lastGuid: string | null;
  lastAssociatedType: string | null;
  lastError: number | null;
  // Genmoji description of the latest message's first Genmoji attachment (or null) — the inbox
  // preview fallback in place of "📎 Attachment". Optional so hand-built InboxRow test literals need
  // not set it; the query below always provides it at runtime.
  lastAttachmentDescription?: string | null;
  participantCount: number;
  participantNames: string | null;
  participantAvatars: string | null;
  /** Comma-joined participant handle services ('iMessage'/'SMS'), for `resolveChatService`. */
  handleServices: string | null;
  unreadCount: number;
  /** 1 when any participant matched a device contact — the "unknown senders" filter signal. */
  hasKnownSender: number;
}

/**
 * Inbox rows for the conversation list. Ordering mirrors Flutter Chat.sort:
 * pinned first, then most-recent message first. The "last message" is resolved
 * dedupe-safely (max date, then max id) so chats never appear twice.
 */
export async function listChatsForInbox(
  db: AppDatabase,
  opts: { includeArchived?: boolean } = {},
): Promise<InboxRow[]> {
  const whereArchived = opts.includeArchived ? sql`` : sql`AND c.is_archived = 0`;
  return db.all<InboxRow>(sql`
    WITH last AS (
      SELECT m.* FROM messages m
      WHERE m.id = (
        SELECT m2.id FROM messages m2
        WHERE m2.chat_id = m.chat_id AND m2.associated_message_type IS NULL
          AND m2.date_retracted IS NULL
          AND m2.date_deleted IS NULL
        ORDER BY m2.date_created DESC, m2.id DESC LIMIT 1
      )
    )
    SELECT
      c.id, c.guid, c.chat_identifier AS chatIdentifier, c.display_name AS displayName,
      c.custom_name AS customName, c.custom_color AS customColor,
      c.style, c.is_pinned AS isPinned, c.is_archived AS isArchived, c.mute_type AS muteType,
      c.latest_message_date AS latestMessageDate, c.last_read_message_guid AS lastReadMessageGuid,
      l.text AS lastText, l.subject AS lastSubject, l.is_from_me AS lastIsFromMe,
      l.has_attachments AS lastHasAttachments, l.date_created AS lastDate, l.guid AS lastGuid,
      l.associated_message_type AS lastAssociatedType, l.error AS lastError,
      (SELECT a.emoji_image_short_description FROM attachments a
         WHERE a.message_id = l.id AND a.emoji_image_short_description IS NOT NULL
         ORDER BY a.id ASC LIMIT 1) AS lastAttachmentDescription,
      (SELECT COUNT(*) FROM chat_handles ch WHERE ch.chat_id = c.id) AS participantCount,
      (SELECT group_concat(COALESCE(h.display_name, h.address), ', ' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantNames,
      (SELECT group_concat(COALESCE(h.avatar, ''), '|||' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantAvatars,
      (SELECT group_concat(COALESCE(h.service, ''), ',' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS handleServices,
      (SELECT COUNT(*) FROM messages um
         WHERE um.chat_id = c.id AND um.is_from_me = 0 AND um.associated_message_type IS NULL
           AND um.date_retracted IS NULL
           AND um.date_deleted IS NULL
           AND um.date_created > COALESCE(
             (SELECT lm.date_created FROM messages lm WHERE lm.guid = c.last_read_message_guid), 0)
           -- A chat the user deleted and that later came back counts only what arrived AFTER the
           -- deletion. Its marker points at a message that went with the delete, so it resolves to
           -- 0 and the whole re-synced history would otherwise land as one enormous unread badge.
           -- STILL LOAD-BEARING even though clearSupersededTombstones now hands the floor to the
           -- read marker: that handover only runs from message/chat INGESTION, and the optimistic
           -- send path (insertOutgoingText/Attachment) routes through neither. Sending into a
           -- hidden thread therefore makes it visible with its stamp still set — the one state
           -- where this clause is the only thing between the user and a badge carrying their whole
           -- re-synced history.
           AND (c.deleted_at IS NULL OR um.date_created > c.deleted_at)
      ) AS unreadCount,
      EXISTS(SELECT 1 FROM chat_handles ck JOIN handles hk ON hk.id = ck.handle_id
              WHERE ck.chat_id = c.id AND hk.contact_id IS NOT NULL) AS hasKnownSender
    FROM chats c
    LEFT JOIN last l ON l.chat_id = c.id
    WHERE ${chatVisible('c')} ${whereArchived}
    ORDER BY c.is_pinned DESC, c.latest_message_date DESC
  `);
}

/**
 * True when any participant of the chat matched a device contact. The "unknown senders"
 * feature treats contact-less chats as unknown (separate list + muted notifications).
 */
export async function chatHasKnownSender(db: AppDatabase, guid: string): Promise<boolean> {
  const rows = await db.all<{ known: number }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
       WHERE ch.chat_id = (SELECT id FROM chats WHERE guid = ${guid} LIMIT 1)
         AND h.contact_id IS NOT NULL
    ) AS known
  `);
  return rows[0]?.known === 1;
}

// ---- Conversation view -----------------------------------------------------

/** Resolve a chat's local integer id from its server guid. */
export async function getChatIdByGuid(db: AppDatabase, guid: string): Promise<number | null> {
  const rows = await db.all<{ id: number }>(sql`SELECT id FROM chats WHERE guid = ${guid} LIMIT 1`);
  return rows[0]?.id ?? null;
}

/** Minimal chat row for the conversation header (title + avatar + group state). */
export interface ChatHeaderRow {
  id: number;
  guid: string;
  chatIdentifier: string | null;
  displayName: string | null;
  customName: string | null;
  customColor: string | null;
  muteType: string | null;
  style: number | null;
  participantCount: number;
  participantNames: string | null;
  participantAvatars: string | null;
  /** Comma-joined participant handle services ('iMessage'/'SMS'), for `resolveChatService`. */
  handleServices: string | null;
  /**
   * The local deletion tombstone (ms) or null — REPORTED, not filtered on (see the fn). The
   * notification-intent builder needs it to decide whether an arriving message is one that would
   * bring the chat back. Optional so hand-built `ChatHeaderRow` test literals need not set it; the
   * query below always provides it at runtime.
   */
  deletedAt?: number | null;
}

/**
 * Identity + preferences for ONE chat, by guid. Deliberately NOT filtered by `chatVisible`.
 *
 * This is a lookup, not a list: its two callers are the open conversation's own header and the
 * notification-intent builder, and neither is deciding what to enumerate. Hiding a tombstoned chat
 * here returns null, and null is indistinguishable from "no such chat" — which silently turned OFF
 * the per-chat MUTE (`header?.muteType === 'mute'`, so an absent header reads as "not muted") and
 * degraded the notification title to the sender's name. A chat can be tombstoned while messages are
 * still arriving in it, so a muted-and-deleted conversation started buzzing. Suppression decisions
 * must never treat "unknown" as "allowed"; and the chat screen is reachable for a tombstoned chat
 * (deep link, notification tap), where a null header rendered the literal fallback title.
 * Visibility belongs on the genuine LIST queries above.
 *
 * It DOES report `deleted_at`, which is a different thing from filtering on it: the caller that
 * must not be lied to about mute is also the caller that must not raise a notification for an event
 * which can never make the chat findable again (a tapback in a deleted thread). Reporting the stamp
 * lets it apply the tombstone itself; filtering on it would take mute down with it.
 */
export async function getChatHeader(db: AppDatabase, guid: string): Promise<ChatHeaderRow | null> {
  const rows = await db.all<ChatHeaderRow>(sql`
    SELECT c.id, c.guid, c.chat_identifier AS chatIdentifier, c.display_name AS displayName,
      c.custom_name AS customName, c.custom_color AS customColor, c.mute_type AS muteType, c.style,
      c.deleted_at AS deletedAt,
      (SELECT COUNT(*) FROM chat_handles ch WHERE ch.chat_id = c.id) AS participantCount,
      (SELECT group_concat(COALESCE(h.display_name, h.address), ', ' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantNames,
      (SELECT group_concat(COALESCE(h.avatar, ''), '|||' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantAvatars,
      (SELECT group_concat(COALESCE(h.service, ''), ',' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS handleServices
    FROM chats c WHERE c.guid = ${guid} LIMIT 1
  `);
  return rows[0] ?? null;
}

/** Normalize an address for participant-set comparison: emails lowercased, phones to last 10
 *  digits (so +1 (555) 123-4567 matches 5551234567). */
function normalizeAddr(a: string): string {
  return a.includes('@') ? a.trim().toLowerCase() : a.replace(/\D/g, '').slice(-10);
}

/**
 * Find an existing chat whose participant set EXACTLY equals `addresses` (order-independent,
 * phone-suffix/email-normalized) — so the new-chat screen can offer "continue existing
 * conversation" instead of spawning a duplicate thread. Returns the chat guid or null.
 */
export async function findChatByParticipantAddresses(
  db: AppDatabase,
  addresses: string[],
): Promise<string | null> {
  const want = new Set(addresses.map(normalizeAddr).filter(Boolean));
  if (want.size === 0) return null;
  const rows = await db.all<{ guid: string; address: string }>(sql`
    SELECT c.guid AS guid, h.address AS address
      FROM chats c
      JOIN chat_handles ch ON ch.chat_id = c.id
      JOIN handles h ON h.id = ch.handle_id
     WHERE ${chatVisible('c')}
  `);
  const byChat = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byChat.get(r.guid) ?? new Set<string>();
    set.add(normalizeAddr(r.address));
    byChat.set(r.guid, set);
  }
  for (const [guid, set] of byChat) {
    if (set.size === want.size && [...want].every((a) => set.has(a))) return guid;
  }
  return null;
}

/** A chat's participants with their addresses — for group add/remove (needs the address). */
export async function getChatParticipants(
  db: AppDatabase,
  guid: string,
): Promise<{ address: string; name: string }[]> {
  return db.all<{ address: string; name: string }>(sql`
    SELECT h.address AS address, COALESCE(h.display_name, h.address) AS name
      FROM chat_handles ch
      JOIN handles h ON h.id = ch.handle_id
      JOIN chats c ON c.id = ch.chat_id
     WHERE c.guid = ${guid}
     ORDER BY h.id
  `);
}

/**
 * Mark a chat read locally (clears the inbox unread badge via listChatsForInbox). Also clears the
 * deliberate mark-as-unread stamp — reading the chat is exactly what retires that flag, and leaving
 * it behind would keep suppressing the Mac's read watermark for this chat forever.
 */
export async function setLastReadMessageGuid(
  db: AppDatabase,
  chatGuid: string,
  lastMessageGuid: string,
): Promise<void> {
  await db
    .update(chats)
    .set({ lastReadMessageGuid: lastMessageGuid, markedUnreadAt: null })
    .where(eq(chats.guid, chatGuid));
}

/**
 * Mark a chat UNREAD locally: clear the read marker so `unreadCount` (messages newer than the
 * marker) counts all received messages again and the inbox badge/bold-title returns. This is the
 * LOCAL half only — the service `markUnread` (chatActions.ts) calls it, then best-effort syncs the
 * Mac via POST /chat/:guid/unread. Opening the chat re-marks it read.
 *
 * `marked_unread_at` records WHEN, which is what makes the flag survive. A NULL read marker alone
 * is indistinguishable from "never read", so the watermark reconcile read it as `current = 0`, its
 * guards were trivially true, and the next reconnect / pull-to-refresh / relaunch silently re-armed
 * the marker and cleared the badge. That is the normal flow, not an edge case: opening the chat
 * pushes a read receipt, so the Mac's watermark is already AHEAD by the time the user backs out and
 * taps Mark as Unread. With the stamp, only a watermark from AFTER the tap — a genuinely later read
 * somewhere else — can clear it.
 */
export async function setChatUnreadLocal(
  db: AppDatabase,
  chatGuid: string,
  now: number = Date.now(),
): Promise<void> {
  await db
    .update(chats)
    .set({ lastReadMessageGuid: null, markedUnreadAt: now })
    .where(eq(chats.guid, chatGuid));
}

/**
 * Mark EVERY chat read locally in one pass: point each chat's read marker at its newest RECEIVED
 * message so all inbox badges clear. Local-only (does not send per-chat read receipts). Uses
 * `db.run` for the non-returning bulk UPDATE; the adapter flushes so the reactive inbox refreshes.
 *
 * RECEIVED-ONLY (`is_from_me = 0`), matching every other writer of this column — a server-issued
 * guid is never rewritten. The newest row in a chat is often an OUTGOING one carrying a TEMPORARY
 * guid, and a send that failed offline keeps that temp guid indefinitely; when the queue finally
 * retries and succeeds, the guid is rewritten and the marker points at nothing. `COALESCE(…, 0)`
 * then makes every received message unread, so the chat springs back to bold with its ENTIRE
 * history counted. One stuck send anywhere is enough, and Mark All Read touches every chat.
 * The outer guard is narrowed the same way so a chat with no received messages isn't set to NULL
 * (which would be the same "everything unread" outcome, arrived at from the other direction).
 */
export async function markAllChatsReadLocal(db: AppDatabase): Promise<void> {
  await db.run(sql`
    UPDATE chats SET last_read_message_guid = (
      SELECT m.guid FROM messages m
       WHERE m.chat_id = chats.id AND m.is_from_me = 0 AND m.date_deleted IS NULL
       ORDER BY m.date_created DESC, m.id DESC LIMIT 1
    ), marked_unread_at = NULL
    WHERE EXISTS (
      SELECT 1 FROM messages m2
       WHERE m2.chat_id = chats.id AND m2.is_from_me = 0 AND m2.date_deleted IS NULL
    )
  `);
}
