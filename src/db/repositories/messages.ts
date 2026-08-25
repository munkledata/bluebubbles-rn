import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Attachment, Message } from '@core/models';
import { REACTION_BASE_TYPES, STICKER_ASSOCIATED_TYPE } from '@core/reactions/reactionType';
import { plainTextFromAttributedBody } from '@core/richtext';
import { chatHandles, chats, messageDeletionLedger, messages, outgoingQueue } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';
import { dedupeBy, toFtsQuery } from './_shared';
import { upsertAttachmentsWithinTransaction } from './attachments';
// The ONE definition of "this chat is not under a local deletion tombstone" — search is a reader of
// it like the inbox is (see the two FTS queries below). Imported from the module that owns the rule
// rather than restated here, so the two can't drift; chats.ts imports nothing from this file, so
// there is no cycle.
import { chatVisible, clearSupersededTombstonesWithinTransaction } from './chats';
import { handleMapKey } from './handles';

/**
 * Transaction-only message ingestion body. `resolveChatId` maps a message to its local chat id;
 * messages with no resolvable chat are skipped. Returns guid → row id and refreshes each touched
 * chat's denormalized latest_message_date.
 *
 * The owning caller controls the batch and must not auto-chunk this body: realtime receipts and
 * the incremental-sync cursor deliberately commit with the final message slice.
 */
export function upsertMessagesWithinTransaction(
  context: DbTransactionContext,
  items: Message[],
  resolveChatId: (m: Message) => number | undefined,
  handleIdByKey: Map<string, number>,
): Promise<Map<string, number>> {
  return runInTransactionContext(context, async (db) => {
    const map = new Map<string, number>();
    const deduped = dedupeBy(
      items.filter((m) => !!m?.guid),
      (m) => m.guid,
    );
    const withChat = deduped
      .map((m) => ({ m, chatId: resolveChatId(m) }))
      .filter((x): x is { m: Message; chatId: number } => x.chatId != null);
    if (withChat.length === 0) return map;

    // Read retained deletion knowledge BEFORE the insert so an out-of-order/backfilled message is
    // born tombstoned. Insert-then-UPDATE is observably unsafe: reactive queries flush after each
    // statement and could briefly render or notify on server-deleted content.
    const deletionRows = await db
      .select({ guid: messageDeletionLedger.guid, dateDeleted: messageDeletionLedger.dateDeleted })
      .from(messageDeletionLedger)
      .where(
        inArray(
          messageDeletionLedger.guid,
          withChat.map(({ m }) => m.guid),
        ),
      );
    const deletionByGuid = new Map(deletionRows.map((row) => [row.guid, row.dateDeleted]));

    const rows = await db
      .insert(messages)
      .values(
        withChat.map(({ m, chatId }) => {
          // Edited and SMS messages arrive with an empty `text` column — their body lives in the
          // attributedBody typedstream. Decode it into `text` so the message is full-text searchable
          // (FTS indexes only `text`) and previews/replies show the words. The server-side decode now
          // populates `m.text` directly; this is the local fallback for anything it didn't.
          const attributedBody = m.attributedBody ? JSON.stringify(m.attributedBody) : null;
          const text =
            m.text && m.text.length > 0
              ? m.text
              : plainTextFromAttributedBody(attributedBody) || null;
          return {
            guid: m.guid,
            originalRowId: m.originalROWID ?? null,
            chatId,
            handleId: m.handle?.address
              ? (handleIdByKey.get(handleMapKey(m.handle)) ?? null)
              : null,
            text,
            subject: m.subject ?? null,
            attributedBody,
            isFromMe: m.isFromMe ?? false,
            dateCreated: m.dateCreated ?? null,
            dateRead: m.dateRead ?? null,
            dateDelivered: m.dateDelivered ?? null,
            dateEdited: m.dateEdited ?? null,
            dateRetracted: m.dateRetracted ?? null,
            dateDeleted: deletionByGuid.get(m.guid) ?? null,
            // The server omits `hasAttachments`; infer it from the hydrated attachments array so the
            // flag stays accurate for reply-quote previews (the image read path no longer relies on it).
            hasAttachments: m.hasAttachments ?? (m.attachments?.length ?? 0) > 0,
            associatedMessageGuid: m.associatedMessageGuid ?? null,
            associatedMessageType: m.associatedMessageType ?? null,
            associatedMessageEmoji: m.associatedMessageEmoji ?? null,
            threadOriginatorGuid: m.threadOriginatorGuid ?? null,
            expressiveSendStyleId: m.expressiveSendStyleId ?? null,
            // Group/chat-event metadata (see utils/groupEvent.ts). NULL when the event omits them
            // so the COALESCE-preserve on conflict can't wipe a previously-stored value.
            itemType: m.itemType ?? null,
            groupActionType: m.groupActionType ?? null,
            groupTitle: m.groupTitle ?? null,
            otherHandle: m.otherHandle ?? null,
            // Insert-only seed (see the NOTE at the end of the conflict set). The wire never carries
            // an error — a v1 message DTO has no such field, and send failures travel in the separate
            // `message-send-error` envelope — so this is always the 0 a freshly-ingested server row
            // deserves. The column itself is owned by the send/outgoing layer.
            error: m.error ?? 0,
            // NULL (not false) when the event omits the flag, so the COALESCE on conflict
            // (below) can keep a previously-stored `true` instead of being handed a 0 that
            // would mask the real value. Consumers treat NULL as falsy, same as false.
            wasDeliveredQuietly: m.wasDeliveredQuietly ?? null,
            didNotifyRecipient: m.didNotifyRecipient ?? null,
            // Apple "Send Later" flag. NULL when the event omits it (not scheduled). PLAIN-overwritten
            // on conflict (see below) so it always mirrors the server's latest value.
            isScheduled: m.isScheduled ?? null,
            // Apple is_sent. NULL only when the server omits it (old server); a modern server always
            // emits it. PLAIN-overwritten on conflict so the 0→1 flip on send propagates and hides the
            // "Scheduled" badge (isScheduled && is_sent != 1).
            isSent: m.isSent ?? null,
            // Apple edit history / unsent parts, stored as a JSON TEXT blob (parsed shape). NULL when
            // the message isn't edited/retracted (the server omits the key), so the COALESCE-preserve
            // on conflict (below) can't wipe a previously-stored history.
            messageSummaryInfo: m.messageSummaryInfo ? JSON.stringify(m.messageSummaryInfo) : null,
            // Apple rich-link preview (URL balloons), stored as JSON TEXT. NULL when the server
            // omits it (non-URL message, placeholder, old server) so the COALESCE-preserve on
            // conflict (below) can't wipe previously-stored metadata.
            payloadData: m.payloadData ? JSON.stringify(m.payloadData) : null,
          };
        }),
      )
      .onConflictDoUpdate({
        target: messages.guid,
        set: {
          // An EDIT empties the text column and re-fills it (server-side decode, or our local
          // attributedBody fallback above), so `excluded.text` carries the new body on a re-sync.
          // COALESCE-preserve so a later event that legitimately omits text (e.g. a delivery/read
          // receipt) can't blank out a good body — text is never intentionally cleared to empty.
          text: sql`COALESCE(NULLIF(excluded.text, ''), ${messages.text})`,
          // MessageBubble prefers the rich body over `text`, so an incoming rich replacement always
          // wins. A newer dated plain-text edit must instead CLEAR the old rich body or that stale
          // wording keeps rendering over the new searchable text. Preserve on every other NULL:
          // lean FCM duplicates and receipt-shaped updates use attributedBody:null to mean "not
          // included", and an equal edit timestamp cannot prove that the plain projection is newer.
          attributedBody: sql`CASE
          WHEN excluded.attributed_body IS NOT NULL THEN excluded.attributed_body
          WHEN NULLIF(excluded.text, '') IS NOT NULL
            AND excluded.date_edited IS NOT NULL
            AND (${messages.dateEdited} IS NULL OR excluded.date_edited > ${messages.dateEdited})
            THEN NULL
          ELSE ${messages.attributedBody}
        END`,
          // Repair the sender on a later hydrated re-sync (a message first inserted via a
          // handle-less fetch had handle_id NULL → "?" avatar). COALESCE so a fetch that OMITS
          // the handle (excluded = NULL) can never wipe an already-resolved sender.
          handleId: sql`COALESCE(excluded.handle_id, ${messages.handleId})`,
          // Receipts, the edit marker and the unsend tombstone are MONOTONIC in the same sense as the
          // delivery tiers below: the server never un-reports one, and no payload ever means "this was
          // undone". A plain overwrite would hand a STALE page the power to erase them — ensureChatSynced
          // re-pages up to 500 messages on EVERY chat open, so a page fetched BEFORE an unsend and landing
          // AFTER it carries date_retracted = NULL, clears the tombstone, and the revoked text (which is
          // COALESCE-preserved above, and so still in the row) renders in full again — in the thread AND
          // as the inbox preview. The milder daily variants are a "Delivered"/"Read" receipt or the
          // "Edited" marker silently disappearing off your own message. COALESCE: a present value still
          // wins, only ABSENCE is preserved.
          //
          // TRADE-OFF, taken deliberately on date_retracted AND date_edited: both have an OPTIMISTIC
          // local writer (applyLocalUnsend / applyLocalEdit) whose compare-and-set revert is skipped
          // when the process dies with the POST in flight, and preserving absence means a re-sync can
          // no longer clear the marker that write left behind. For date_retracted the residue HIDES
          // content the user asked to revoke — the right direction for that column. For date_edited it
          // is a permanent, cosmetic falsehood instead: the server's original text is restored by the
          // COALESCE on `text` above, but the bubble keeps an "Edited" label (and offers "View Edit
          // History" over an empty messageSummaryInfo) that no sync can remove. Accepted as the lesser
          // of the two: the alternative — letting absence clear it — is a STALE page silently erasing
          // the edit marker on a message that really was edited, on every chat open.
          dateRead: sql`COALESCE(excluded.date_read, ${messages.dateRead})`,
          dateDelivered: sql`COALESCE(excluded.date_delivered, ${messages.dateDelivered})`,
          dateEdited: sql`COALESCE(excluded.date_edited, ${messages.dateEdited})`,
          dateRetracted: sql`COALESCE(excluded.date_retracted, ${messages.dateRetracted})`,
          // Deletion is local durable knowledge, not a MessageV1 field. `excluded.date_deleted`
          // comes only from message_deletion_ledger above; keep the later timestamp if an existing
          // tombstone and retained marker differ after an upgrade or out-of-order repeat.
          dateDeleted: sql`COALESCE(MAX(${messages.dateDeleted}, excluded.date_deleted), ${messages.dateDeleted}, excluded.date_deleted)`,
          // Reflect the LATEST server value (plain overwrite, not COALESCE-preserve like the delivery
          // tiers). The server emits is_scheduled=true for a schedule_type=2 row both while pending AND
          // after it sends, so this flag does NOT clear on send — the "Scheduled" badge is instead
          // gated on is_sent below (isScheduled && is_sent != 1).
          isScheduled: sql`excluded.is_scheduled`,
          // Plain-overwrite is_sent so the 0→1 send transition propagates on the re-upsert — that flip
          // is exactly what hides the badge. The wire always carries is_sent, so overwriting never
          // nulls a good value; never COALESCE-preserve here (we WANT the send to win).
          isSent: sql`excluded.is_sent`,
          // Delivery tiers flip on a later updated-message event (Apple may report the
          // quiet delivery after the initial echo), so refresh them on conflict too — but
          // COALESCE so a later event that OMITS the flag (excluded = NULL) can't downgrade
          // a previously-stored `true` back to false/null. A present flag still overwrites.
          wasDeliveredQuietly: sql`COALESCE(excluded.was_delivered_quietly, ${messages.wasDeliveredQuietly})`,
          didNotifyRecipient: sql`COALESCE(excluded.did_notify_recipient, ${messages.didNotifyRecipient})`,
          // A later hydrated re-sync can flip a stale 0 → 1; never downgrade 1 → 0 when a fetch
          // omits attachments (excluded = 0), so MAX with the already-stored value.
          hasAttachments: sql`MAX(excluded.has_attachments, ${messages.hasAttachments})`,
          // COALESCE-preserve the emoji-tapback glyph: a later event that omits it (delivery
          // receipt re-upsert) must not blank a stored glyph.
          associatedMessageEmoji: sql`COALESCE(excluded.associated_message_emoji, ${messages.associatedMessageEmoji})`,
          // Group-event metadata is set once at insert and never changes; COALESCE-preserve so a
          // later re-sync that omits these (a delivery/read receipt re-upsert) can't blank them.
          itemType: sql`COALESCE(excluded.item_type, ${messages.itemType})`,
          groupActionType: sql`COALESCE(excluded.group_action_type, ${messages.groupActionType})`,
          groupTitle: sql`COALESCE(excluded.group_title, ${messages.groupTitle})`,
          otherHandle: sql`COALESCE(excluded.other_handle, ${messages.otherHandle})`,
          // Edit history: COALESCE-PRESERVE, NOT plain-overwrite like isScheduled. The two differ on
          // whether ABSENCE is meaningful. isScheduled's absence means "no longer pending" → it must
          // clear (plain-overwrite to NULL). messageSummaryInfo's absence never means "history was
          // removed" — the history is monotonic (an edit only ADDS revisions, an unsend only ADDS a
          // retracted part) and permanent. A genuine new edit re-emits the FULL, fuller history, so
          // overwrite-WHEN-PRESENT (COALESCE) captures it; and a later flagless re-upsert (a
          // delivery/read receipt, or a live event whose leaner projection omits the blob) then can't
          // wipe the stored timeline. Same reasoning as the group-event metadata above.
          messageSummaryInfo: sql`COALESCE(excluded.message_summary_info, ${messages.messageSummaryInfo})`,
          // Rich-link metadata: COALESCE-preserve for the same reason as messageSummaryInfo —
          // absence never means "the preview was removed" (a delivery/read-receipt re-upsert or a
          // leaner live projection just omits the blob), so overwrite-when-present only.
          payloadData: sql`COALESCE(excluded.payload_data, ${messages.payloadData})`,
          // NOTE — `error` is DELIBERATELY absent from this conflict set (it IS in the insert values,
          // as the 0 seed for a brand-new row). It is not a wire-carried field: the v1 message DTO has
          // no `error` key at all — send failures travel in the separate `message-send-error` envelope
          // — so `excluded.error` can only ever be the hard-coded 0 above. Refreshing it on conflict
          // therefore doesn't "reflect the server", it ERASES: the next re-sync of a message that
          // failed to deliver zeroes the stored code and the bubble degrades from a specific
          // "iMessage Error (Code N)" to the generic "Message Failed to Send". The column is written
          // ONLY by the send/outgoing layer, which both sets it (markMessageSendError) and clears it
          // on every promotion/retry — so leaving it out of the set can't strand a stale code.
          //
          // NOTE — `date_deleted` is deliberately sourced ONLY from the local ledger, never the wire
          // model. MessageV1 has no deletion field: only `message-deleted` events write the ledger.
          // This keeps re-sync monotonic while also covering the harder event-before-row and
          // purge-then-backfill cases that preserving only an existing messages row cannot cover.
        },
      })
      .returning({ id: messages.id, guid: messages.guid });

    for (const r of rows) map.set(r.guid, r.id);

    // Link message SENDERS into chat_handles (additive) so a chat shows participant names even
    // when its participants were never synced via chat/query — e.g. a realtime-created group that
    // would otherwise render as "Group" / a raw chat-guid. Only received messages carry a sender
    // handle (sent/own messages have none). onConflictDoNothing keeps it idempotent and never
    // disturbs a canonical participant list that upsertChats may have set from a participants payload.
    // Keyed by chatId:ADDRESS (not handle id): the same person can have one handle row per
    // service (iMessage + SMS variants of the same number), and linking a second variant into
    // a chat that already lists the person would render them twice (duplicate collage avatar,
    // "Alice, Alice"). One key per person per chat also dedupes variants within this batch.
    const participantLinks = new Map<string, { chatId: number; handleId: number }>();
    for (const { m, chatId } of withChat) {
      const h = m.handle;
      if (!h?.address) continue;
      const handleId = handleIdByKey.get(handleMapKey(h));
      if (handleId != null) participantLinks.set(`${chatId}:${h.address}`, { chatId, handleId });
    }
    if (participantLinks.size > 0) {
      // Skip senders whose ADDRESS the chat already links (via any service-variant row) —
      // exact-row duplicates alone are not enough, that's what onConflictDoNothing covers.
      const chatIds = [...new Set([...participantLinks.values()].map((l) => l.chatId))];
      const inList = sql.join(
        chatIds.map((id) => sql`${id}`),
        sql`, `,
      );
      const existing: Array<{ chatId: number; address: string }> = await db.all(
        sql`SELECT ch.chat_id AS chatId, h.address AS address
          FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
          WHERE ch.chat_id IN (${inList})`,
      );
      const alreadyLinked = new Set(existing.map((r) => `${r.chatId}:${r.address}`));
      const fresh = [...participantLinks.entries()]
        .filter(([key]) => !alreadyLinked.has(key))
        .map(([, link]) => link);
      if (fresh.length > 0) {
        await db.insert(chatHandles).values(fresh).onConflictDoNothing();
      }
    }

    // Upsert nested attachments now that we have message ids.
    const attRows: Array<{ att: Attachment; messageId: number }> = [];
    for (const { m } of withChat) {
      const messageId = map.get(m.guid);
      if (messageId == null) continue;
      for (const att of m.attachments ?? []) {
        if (att?.guid) attRows.push({ att, messageId });
      }
    }
    await upsertAttachmentsWithinTransaction(context, attRows);

    // Refresh denormalized latest_message_date for touched chats. Exclude DELETED (tombstoned) rows
    // from the MAX so a re-sync of a still-in-Recently-Deleted row can't re-inflate the chat's inbox
    // position back to the deleted message's date — that must stay consistent with markMessageDeleted,
    // which recomputes the same way. (Retracted rows are intentionally NOT excluded: they still render
    // as tombstone bubbles in the thread, so they legitimately hold the chat's latest position.)
    // REACTION rows are excluded too, so the sort key agrees with what the inbox actually SHOWS:
    // listChatsForInbox's preview CTE and its unread count both skip `associated_message_type IS NOT
    // NULL`, so without this a "liked" on a three-day-old message yanks the chat to the top of the
    // inbox carrying an unchanged three-day-old preview and timestamp. It is also what makes
    // insertOutgoingReaction's "a tapback must not reorder the inbox" rule survive the round-trip —
    // that guarantee lasted exactly until the server echoed your own tapback back as a new-message.
    //
    // THE COALESCE IS LOAD-BEARING: MAX() over ZERO rows is NULL, and the reaction filter really can
    // empty the candidate set — the server's per-chat `lastMessage` is the newest message with NO
    // reaction filter, so `syncAllChats` upserts a lone tapback into a chat whose real messages
    // haven't been backfilled yet (the whole of fullSync phase 2, and indefinitely for any chat whose
    // page errored). Writing NULL there sorts the chat LAST under `ORDER BY … latest_message_date
    // DESC` in listChatsForInbox, i.e. exactly the "sinks to the bottom of the inbox" outcome that
    // upsert exists to prevent. So fall back to the unfiltered MAX: a reaction may not OUTRANK a real
    // message, but it may hold a position nothing else is holding.
    const touched = [...new Set(withChat.map((x) => x.chatId))];
    if (touched.length > 0) {
      await db
        .update(chats)
        .set({
          latestMessageDate: sql`COALESCE(
          (SELECT MAX(date_created) FROM messages WHERE messages.chat_id = chats.id AND date_deleted IS NULL AND associated_message_type IS NULL),
          (SELECT MAX(date_created) FROM messages WHERE messages.chat_id = chats.id AND date_deleted IS NULL))`,
        })
        .where(inArray(chats.id, touched));
      // Retire a local deletion tombstone the moment real new content lands, rather than leaving the
      // chat's visibility to be re-derived on every read. Deriving it is not enough on its own: a chat
      // brought back by one message would silently vanish AGAIN if that single message were later
      // deleted or unsent. This is the MESSAGE-ingestion chokepoint; upsertChats covers the
      // chat-ingestion one, and a chat can be revived by either. The CAS applies the same predicate
      // `chatVisible` reads with, so re-synced history, a tapback and an unsent row still cannot
      // resurrect a conversation the user deleted.
      await clearSupersededTombstonesWithinTransaction(context, touched);
    }
    return map;
  });
}

/**
 * Public message ingestion owner. Never call this from another transaction; composed ingestion
 * paths must use {@link upsertMessagesWithinTransaction} so their handles/chats/cursor can share
 * the same bounded commit.
 */
export async function upsertMessages(
  db: AppDatabase,
  items: Message[],
  resolveChatId: (m: Message) => number | undefined,
  handleIdByKey: Map<string, number>,
  commitGuard?: DbCommitGuard,
): Promise<Map<string, number>> {
  return withDbTransaction(
    db,
    (context) => upsertMessagesWithinTransaction(context, items, resolveChatId, handleIdByKey),
    commitGuard,
  );
}

/** Messages for a chat, newest first. */
export function listMessages(db: AppDatabase, chatId: number, limit = 100) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(sql`${messages.dateCreated} DESC`)
    .limit(limit);
}

/** Full-text search over message bodies (FTS5), ranked. */
export async function searchMessages(
  db: AppDatabase,
  queryText: string,
  limit = 50,
): Promise<Array<Record<string, unknown>>> {
  const match = toFtsQuery(queryText);
  if (!match) return [];
  const rows = await db.all<Record<string, unknown>>(
    // The FTS index still holds a tombstoned message's text (setting date_deleted only re-indexes
    // the unchanged text), so a deleted message must be excluded at QUERY time — it VANISHES.
    sql`SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ${match} AND m.date_deleted IS NULL ORDER BY rank LIMIT ${limit}`,
  );
  return rows;
}

export interface SearchResultRow {
  id: number;
  guid: string;
  text: string | null;
  /**
   * An FTS5 snippet centered on the match, with the matched term(s) wrapped in U+0002…U+0003 so the
   * UI can highlight them. This is what to display — the raw `text` start may not contain the match
   * (the word can be deep in a long message), which looks like a wrong result.
   */
  snippet: string | null;
  dateCreated: number | null;
  isFromMe: number;
  chatGuid: string;
  // Enough chat fields to run `resolveTitle` so a hit's title matches the inbox (a group shows its
  // name/participants or "Group", never a raw chat-guid; a 1:1 shows the contact name).
  chatDisplayName: string | null;
  chatCustomName: string | null;
  chatIdentifier: string | null;
  chatStyle: number | null;
  chatParticipantNames: string | null;
  senderName: string | null;
}

/**
 * FTS5 search enriched with chat + sender context for a results screen.
 * Excludes reaction rows; newest-first for parity with the Flutter search.
 *
 * Hits in a locally-deleted conversation are excluded (`chatVisible`) — the search page renders
 * these rows DIRECTLY, so without it a message from a deleted thread was listed under that thread's
 * name and tapping it opened the hidden conversation, whose `ensureChatSynced` then re-paged up to
 * 500 of its messages back into the DB. The individual message rows are gone at delete time, but
 * the next `syncAllChats` re-inserts each chat's `lastMessage` — straight back into the FTS index.
 */
export async function searchMessagesEnriched(
  db: AppDatabase,
  queryText: string,
  limit = 50,
): Promise<SearchResultRow[]> {
  const match = toFtsQuery(queryText);
  if (!match) return [];
  // `snippet()` needs the FTS table referenced by name (not an alias), so this query joins on
  // `messages_fts` directly. No mark args — it just centers the text on the match; the UI bolds the
  // query terms in JS (control-char marks don't reliably survive the native bridge).
  return db.all<SearchResultRow>(sql`
    SELECT m.id, m.guid, m.text, m.date_created AS dateCreated, m.is_from_me AS isFromMe,
           snippet(messages_fts, 0, '', '', '…', 12) AS snippet,
           c.guid AS chatGuid, c.display_name AS chatDisplayName, c.custom_name AS chatCustomName,
           c.chat_identifier AS chatIdentifier, c.style AS chatStyle,
           (SELECT group_concat(COALESCE(h2.display_name, h2.address), ', ' ORDER BY h2.id)
              FROM chat_handles ch JOIN handles h2 ON h2.id = ch.handle_id
             WHERE ch.chat_id = c.id) AS chatParticipantNames,
           COALESCE(h.display_name, h.address) AS senderName
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN chats c ON c.id = m.chat_id
    LEFT JOIN handles h ON h.id = m.handle_id
    WHERE messages_fts MATCH ${match}
      AND m.associated_message_type IS NULL
      AND m.date_deleted IS NULL
      AND ${chatVisible('c')}
    ORDER BY m.date_created DESC
    LIMIT ${limit}
  `);
}

/**
 * All messages of a reply thread: the originator plus every reply targeting it, chronological.
 * Powers the "View Thread" popup (the bubble's reply quote shows only the immediate parent).
 */
export async function listThreadMessages(
  db: AppDatabase,
  originatorGuid: string,
): Promise<MessageRow[]> {
  return db.all<MessageRow>(sql`
    ${MESSAGE_ROW_SELECT}
    WHERE (m.guid = ${originatorGuid} OR m.thread_originator_guid = ${originatorGuid})
      AND m.associated_message_type IS NULL
      AND m.date_deleted IS NULL
    ORDER BY m.date_created ASC, m.id ASC
  `);
}

/**
 * The OLDEST unread received message in a chat + how many are unread — for the "jump to oldest
 * unread" chip. Unread = received (not mine) and newer than the last-read marker's message; a
 * never-read chat counts every received message. Reactions and retracted rows are excluded.
 * Call BEFORE markRead (which moves the marker to the newest message).
 */
export async function getFirstUnreadInChat(
  db: AppDatabase,
  chatId: number,
): Promise<{ guid: string; dateCreated: number; count: number } | null> {
  const marker = await db.all<{ lastReadMessageGuid: string | null; deletedAt: number | null }>(
    sql`SELECT last_read_message_guid AS lastReadMessageGuid, deleted_at AS deletedAt
        FROM chats WHERE id = ${chatId} LIMIT 1`,
  );
  const lastReadGuid = marker[0]?.lastReadMessageGuid ?? null;
  let readDate = 0;
  if (lastReadGuid) {
    const r = await db.all<{ d: number | null }>(
      sql`SELECT date_created AS d FROM messages WHERE guid = ${lastReadGuid} LIMIT 1`,
    );
    readDate = r[0]?.d ?? 0;
  }
  // Floor the scan at a tombstone: a deleted chat that came back (a message newer than the deletion
  // arrived) must count only that NEW activity as unread. Without this the inbox badge says 1 while
  // the in-chat "jump to N unread" chip offers to scroll back through the whole restored history —
  // the same floor `chatVisible`/the inbox unread count already apply.
  readDate = Math.max(readDate, marker[0]?.deletedAt ?? 0);
  const rows = await db.all<{ guid: string; dateCreated: number; count: number }>(sql`
    SELECT guid, date_created AS dateCreated,
      (SELECT COUNT(*) FROM messages mm
        WHERE mm.chat_id = ${chatId} AND mm.is_from_me = 0 AND mm.date_created > ${readDate}
          AND mm.associated_message_type IS NULL AND mm.date_retracted IS NULL
          AND mm.date_deleted IS NULL) AS count
    FROM messages
    WHERE chat_id = ${chatId} AND is_from_me = 0 AND date_created > ${readDate}
      AND associated_message_type IS NULL AND date_retracted IS NULL
      AND date_deleted IS NULL
    ORDER BY date_created ASC, id ASC LIMIT 1
  `);
  return rows[0] ?? null;
}

/** Newest received (inbound) message guid in a chat — the correct mark-read target. */
export async function getNewestReceivedGuid(
  db: AppDatabase,
  chatId: number,
): Promise<string | null> {
  const rows = await db.all<{ guid: string }>(sql`
    SELECT guid FROM messages
    WHERE chat_id = ${chatId} AND is_from_me = 0 AND date_deleted IS NULL
    ORDER BY date_created DESC, id DESC LIMIT 1
  `);
  return rows[0]?.guid ?? null;
}

/** A message row enriched with its sender handle, ready to render a bubble. */
export interface MessageRow {
  id: number;
  guid: string;
  chatId: number;
  handleId: number | null;
  text: string | null;
  attributedBody: string | null;
  subject: string | null;
  isFromMe: number;
  dateCreated: number | null;
  dateRead: number | null;
  dateDelivered: number | null;
  dateEdited: number | null;
  dateRetracted: number | null;
  hasAttachments: number;
  // Apple "Send Later" flag (1 for a scheduled row — pending OR sent; NULL/absent otherwise).
  // Optional so hand-built test literals need not set it; the SELECT above always provides it.
  isScheduled?: number | null;
  // Apple is_sent (1 = sent, 0 = not yet, NULL/undefined = unknown on a pre-migration row). Gates the
  // "Scheduled" badge with isScheduled. Optional so hand-built test literals need not set it; the
  // SELECT above always provides it at runtime.
  isSent?: number | null;
  // Apple edit history / unsent parts as the RAW JSON TEXT blob (or null). Kept as a string here —
  // like `attributedBody` — and parsed lazily by the consumer via parseMessageSummaryInfo (only the
  // long-press "View Edit History" path needs the structured form). Optional so hand-built test
  // literals need not set it; the SELECT below always provides it at runtime.
  messageSummaryInfo?: string | null;
  // Apple rich-link preview metadata as the RAW JSON TEXT blob (or null) — like
  // messageSummaryInfo, parsed lazily by the consumer via parsePayloadData (only MessageBubble's
  // preview card needs the structured form). Optional so hand-built test literals need not set
  // it; the SELECT below always provides it at runtime.
  payloadData?: string | null;
  error: number;
  /** Already-bounded/redacted server detail for the failed-message sheet. */
  errorMessage?: string | null;
  sendState: string;
  wasDeliveredQuietly: number;
  didNotifyRecipient: number;
  associatedMessageGuid: string | null;
  associatedMessageType: string | null;
  associatedMessageEmoji: string | null;
  threadOriginatorGuid: string | null;
  expressiveSendStyleId: string | null;
  senderAddress: string | null;
  senderName: string | null;
  senderAvatar: string | null;
  senderService: string | null;
  // Group/chat-event fields (utils/groupEvent.ts). Optional so hand-built test literals need not
  // set them; the SELECT below always provides them at runtime. `otherHandleName` is resolved from
  // `other_handle` (a server ROWID) to the affected participant's display name.
  itemType?: number | null;
  groupActionType?: number | null;
  groupTitle?: string | null;
  otherHandle?: number | null;
  otherHandleName?: string | null;
  // Genmoji (macOS 15.1+) natural-language description of this message's first Genmoji attachment,
  // or null. Used as the thread-row fallback text in place of the generic "📎 Attachment". Optional
  // so hand-built test literals need not set it; the SELECT below always provides it at runtime.
  attachmentDescription?: string | null;
}

// Shared SELECT (columns + sender join) for message-row reads. Kept in ONE place so the
// recent-window and anchored-window queries below can't drift apart. Nested into each query.
const MESSAGE_ROW_SELECT = sql`
  SELECT
    m.id, m.guid, m.chat_id AS chatId, m.handle_id AS handleId,
    m.text, m.attributed_body AS attributedBody,
    m.subject, m.is_from_me AS isFromMe, m.date_created AS dateCreated,
    m.date_read AS dateRead, m.date_delivered AS dateDelivered, m.date_edited AS dateEdited,
    m.date_retracted AS dateRetracted,
    m.is_scheduled AS isScheduled,
    m.is_sent AS isSent,
    m.message_summary_info AS messageSummaryInfo,
    m.payload_data AS payloadData,
    m.has_attachments AS hasAttachments, m.error, m.error_message AS errorMessage,
    m.send_state AS sendState,
    m.was_delivered_quietly AS wasDeliveredQuietly,
    m.did_notify_recipient AS didNotifyRecipient,
    m.associated_message_guid AS associatedMessageGuid,
    m.associated_message_type AS associatedMessageType,
    m.associated_message_emoji AS associatedMessageEmoji,
    m.thread_originator_guid AS threadOriginatorGuid,
    m.expressive_send_style_id AS expressiveSendStyleId,
    m.item_type AS itemType,
    m.group_action_type AS groupActionType,
    m.group_title AS groupTitle,
    m.other_handle AS otherHandle,
    (SELECT COALESCE(h2.display_name, h2.address) FROM handles h2
       WHERE h2.original_row_id = m.other_handle LIMIT 1) AS otherHandleName,
    (SELECT a.emoji_image_short_description FROM attachments a
       WHERE a.message_id = m.id AND a.emoji_image_short_description IS NOT NULL
       ORDER BY a.id ASC LIMIT 1) AS attachmentDescription,
    h.address AS senderAddress,
    COALESCE(h.display_name, h.address) AS senderName,
    h.avatar AS senderAvatar,
    NULLIF(h.service, '') AS senderService
  FROM messages m
  LEFT JOIN handles h ON h.id = m.handle_id`;

/**
 * Associated-message types the UI draws as an OVERLAY on the target bubble, so they must not also
 * appear as messages of their own. Derived from the core constants (both directions) so this can
 * never drift from `isOverlayAssociatedType`.
 */
const OVERLAY_ASSOCIATED_TYPES: string[] = [
  ...REACTION_BASE_TYPES,
  'emoji',
  STICKER_ASSOCIATED_TYPE,
].flatMap((t) => [t, `-${t}`]);

/**
 * Exclude only the types we render as an overlay — NOT every associated message.
 *
 * The old blanket `associated_message_type IS NULL` was doing two jobs with one test: it correctly
 * hid reactions, and it silently swallowed STICKERS, which is why a received sticker rendered
 * nowhere at all. It would also swallow any future associated type, including the raw numeric Apple
 * codes the server emits for anything its own map doesn't recognise. Anything not in this list now
 * falls through and renders as an ordinary message — the safe direction to fail.
 */
const notAnOverlayMessage = (): SQL => {
  const list = sql.join(
    OVERLAY_ASSOCIATED_TYPES.map((t) => sql`${t}`),
    sql`, `,
  );
  return sql`(m.associated_message_type IS NULL OR m.associated_message_type NOT IN (${list}))`;
};

/** Run the shared message SELECT with extra WHERE conditions + an ORDER BY + LIMIT. */
function queryMessageRows(
  db: AppDatabase,
  chatId: number,
  where: SQL,
  order: SQL,
  limit: number,
): Promise<MessageRow[]> {
  return db.all<MessageRow>(sql`
    ${MESSAGE_ROW_SELECT}
    WHERE m.chat_id = ${chatId} ${where}
      AND ${notAnOverlayMessage()}
      AND m.date_deleted IS NULL
    ${order}
    LIMIT ${limit}
  `);
}

/** Messages for a chat, newest-first (the inverted list wants index 0 = newest).
 *  `beforeDate` is a paginate-older cursor (strictly older than that date); `sinceDate` widens the
 *  load downward (>= that date). To open ON a search hit with context around it, use
 *  {@link listMessagesAround} instead. */
export async function listMessagesWithSenders(
  db: AppDatabase,
  chatId: number,
  limit = 100,
  beforeDate?: number,
  sinceDate?: number,
): Promise<MessageRow[]> {
  const cursor = beforeDate != null ? sql`AND m.date_created < ${beforeDate}` : sql``;
  const floor = sinceDate != null ? sql`AND m.date_created >= ${sinceDate}` : sql``;
  return queryMessageRows(
    db,
    chatId,
    sql`${cursor} ${floor}`,
    sql`ORDER BY m.date_created DESC, m.id DESC`,
    limit,
  );
}

/**
 * Messages in a WINDOW centered on `anchorDate` (a search/jump target's date_created): up to
 * `before` messages older-or-equal (including the target itself) AND up to `after` messages newer,
 * so the thread shows context on BOTH sides of the hit. Returns newest-first (the list contract),
 * with the target roughly in the middle. This is the fix for "jump to a search hit shows nothing
 * around it" — the old path loaded the target and everything NEWER only, so a hit near the tail
 * (e.g. a recent RCS code) opened to just the one message.
 */
export async function listMessagesAround(
  db: AppDatabase,
  chatId: number,
  anchorDate: number,
  before = 150,
  after = 150,
): Promise<MessageRow[]> {
  const older = await queryMessageRows(
    db,
    chatId,
    sql`AND m.date_created <= ${anchorDate}`,
    sql`ORDER BY m.date_created DESC, m.id DESC`,
    before + 1, // +1 so the anchor row itself is included alongside `before` older ones
  );
  const newer = await queryMessageRows(
    db,
    chatId,
    sql`AND m.date_created > ${anchorDate}`,
    sql`ORDER BY m.date_created ASC, m.id ASC`,
    after,
  );
  // Newest-first: the newer set (ASC) reversed to DESC, then the older set (already DESC, with
  // the anchor first). The two sides are disjoint (<= vs >), so no row appears twice.
  return [...newer.reverse(), ...older];
}

/**
 * Distinct chat GUIDs that have at least one message matching the FTS query. Powers the inbox
 * top-bar so it filters chats by message CONTENT (incl. decoded edited/SMS text), keeping it
 * consistent with the dedicated search page instead of matching only chat names + the latest preview.
 *
 * Locally-deleted chats are excluded here too. The caller intersects this with the (already
 * filtered) chat list, so today it changes nothing — but a guid list that includes hidden chats is
 * a trap for the next caller that trusts it, and the rule is one line.
 */
export async function searchChatGuidsByMessage(
  db: AppDatabase,
  queryText: string,
  limit = 300,
): Promise<string[]> {
  const match = toFtsQuery(queryText);
  if (!match) return [];
  const rows = await db.all<{ guid: string }>(sql`
    SELECT DISTINCT c.guid AS guid
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    JOIN chats c ON c.id = m.chat_id
    WHERE messages_fts MATCH ${match}
      AND m.associated_message_type IS NULL
      AND m.date_deleted IS NULL
      AND ${chatVisible('c')}
    LIMIT ${limit}
  `);
  return rows.map((r: { guid: string }) => r.guid);
}

export interface MessagePreview {
  guid: string;
  text: string | null;
  senderName: string | null;
  isFromMe: number;
  hasAttachments: number;
  // Genmoji description of the message's first Genmoji attachment (or null) — the reply-quote /
  // reply-composer fallback text in place of the generic "📎 Attachment". Optional so hand-built
  // test literals need not set it; the SELECT below always provides it at runtime.
  attachmentDescription?: string | null;
}

/** A compact preview of a message by guid (for the reply quote). */
export async function getMessagePreviewByGuid(
  db: AppDatabase,
  guid: string,
): Promise<MessagePreview | null> {
  const rows = await db.all<MessagePreview>(sql`
    SELECT m.guid, m.text, m.is_from_me AS isFromMe, m.has_attachments AS hasAttachments,
           COALESCE(h.display_name, h.address) AS senderName,
           (SELECT a.emoji_image_short_description FROM attachments a
              WHERE a.message_id = m.id AND a.emoji_image_short_description IS NOT NULL
              ORDER BY a.id ASC LIMIT 1) AS attachmentDescription
    FROM messages m LEFT JOIN handles h ON h.id = m.handle_id
    WHERE m.guid = ${guid} AND m.date_deleted IS NULL LIMIT 1
  `);
  return rows[0] ?? null;
}

/**
 * The message's dateCreated (epoch ms) by guid, or null when the message is absent or has no
 * date. Used to center the chat on a reminded message when its notification is tapped (the
 * `?focusDate` deep-link loads a window around the message so scroll-to-message works even for
 * an old message not in the recent window).
 */
export async function getMessageDateByGuid(db: AppDatabase, guid: string): Promise<number | null> {
  const rows = await db.all<{ dateCreated: number | null }>(
    sql`SELECT date_created AS dateCreated FROM messages WHERE guid = ${guid} LIMIT 1`,
  );
  return rows[0]?.dateCreated ?? null;
}

/**
 * The USER's own "Delete message" (single or bulk) — the local counterpart of the server's
 * `message-deleted` event, and it must use the same TOMBSTONE for the same reason.
 *
 * A hard delete does not stick: the deletion never leaves the device, so the server still returns
 * that guid, and `ensureChatSynced` re-pages up to 500 messages on EVERY chat open — the row is
 * re-inserted and the "deleted" message is back the next time the thread is opened (or mid-session,
 * if the delete lands while that paging is in flight). {@link markMessageDeleted} is exactly the
 * mechanism built against this: its durable ledger marker makes upsertMessages preserve/apply the
 * tombstone, while every render/count/search query filters it out — the message VANISHES from the
 * UI and stays gone. It also recomputes the chat's denormalized
 * `latest_message_date`, which the raw delete never did (deleting the newest message used to leave
 * the inbox sorting on a row nothing renders).
 *
 * There is NO hard-delete branch, deliberately. This used to restate `discardOutgoingMessage`'s
 * guard ("a `temp-` guid still 'sending' or 'error' can't have been acknowledged, so nothing can
 * re-insert it") as a second, slightly different copy of the rule — and the premise was wrong on
 * both counts. On the guid-less ack paths (RCS bridge / AppleScript) a DELIVERED message KEEPS its
 * temp guid, and an 'error' bubble can be a send that timed out client-side after the server
 * processed it. Removing such a row destroys the one thing the later echo can carry the deletion
 * onto: `upsertMessages` then inserts the message fresh under its real guid and the "deleted"
 * bubble is back for good. The single rule now lives with the write that owns it
 * (`discardOutgoingMessage`, which tombstones), and this is the plain fall-through for everything
 * that write does not own.
 *
 * The tombstone survives promotion: `reconcileEchoByContent` /
 * `reconcileOutgoingAttachmentByContent` promote IN PLACE (they rewrite guid/send_state/error and
 * nothing else), so `date_deleted` rides onto the real identity; the retained ledger also keeps the
 * message hidden through every later re-page or hard-row purge.
 */
/** Outcome of resolving and recording a user-requested local message deletion. */
export type DeleteMessageLocalResult =
  /** A currently stored message row was tombstoned. */
  | 'applied'
  /** No row exists now, but a canonical real GUID was durably recorded for future re-ingestion. */
  | 'recorded'
  /** A stale temp GUID has no retained canonical mapping; the caller must surface that uncertainty. */
  | 'unresolved-temp';

export async function deleteMessageLocal(
  db: AppDatabase,
  guid: string,
  now: number,
): Promise<DeleteMessageLocalResult> {
  // ONE short, DB-only transaction. The ladder must not outlive the deletion (a surviving queue
  // row re-POSTs the very message the user just deleted, with nothing on screen to tell them), and
  // the tombstone must not outlive the alias resolution or chat sort-key recompute inside
  // markMessageDeletedWithinTransaction — as bare autocommits each half can be swallowed by
  // whatever transaction a neighbouring writer happens to have open and lost with its rollback.
  return withDbTransaction(db, async (context) => {
    if (guid.startsWith('temp-'))
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, guid));

    // Resolve inside the SAME transaction as the tombstone. The real-guid promotion is serialized
    // on the same DB queue, so it is now wholly before or wholly after this lookup. Prefer an exact
    // current guid over an alias even if corrupted data ever makes the two namespaces overlap.
    const targets = await db.all<{ guid: string; source: 'exact' | 'alias' }>(sql`
      SELECT guid, source
        FROM (
          SELECT guid, 'exact' AS source, 0 AS priority
            FROM messages
           WHERE guid = ${guid}
          UNION ALL
          SELECT canonical_guid AS guid, 'alias' AS source, 1 AS priority
            FROM message_guid_aliases
           WHERE alias_guid = ${guid}
        )
       ORDER BY priority
       LIMIT 1
    `);
    const target = targets[0];
    const targetGuid = target?.guid ?? guid;
    const applied = await markMessageDeletedWithinTransaction(context, targetGuid, now);
    if (applied) return 'applied';
    if (target?.source === 'alias' || !guid.startsWith('temp-')) return 'recorded';
    // Keep the temp-keyed ledger marker written above: a later authoritative HTTP ack can still
    // hand it to the real GUID. A content-only echo with no surviving temp row cannot infer that
    // mapping, so the UI must not pretend the requested bubble was removed.
    return 'unresolved-temp';
  });
}

// ---- Edit / Unsend (operate on real guids; mutate in place, reactive watcher updates UI) ----

export interface LocalEditSnapshot {
  /** Exact stored text before the optimistic edit; decoded outside the global DB mutex. */
  storedText: string | null;
  /** Exact rich body to restore; MessageBubble prefers this over messages.text when present. */
  attributedBody: string | null;
  dateEdited: number | null;
  chatGuid: string | null;
}

/**
 * Snapshot the committed message state and optimistically apply one local edit in the SAME short
 * transaction. A separate read is unsafe on the shared SQLite connection: it can see another
 * owner's uncommitted text, then make that rolled-back value durable if the HTTP request fails.
 *
 * Network work deliberately stays in the service after this owner commits. The rich body is
 * cleared while the optimistic plain text is active because MessageBubble prefers attributedBody.
 * This owner returns the raw body rather than decoding it while every DB writer is blocked; the
 * service derives the searchable restore text after this short transaction commits.
 */
export async function applyLocalEdit(
  db: AppDatabase,
  guid: string,
  newText: string,
  now: number,
): Promise<LocalEditSnapshot | null> {
  return withDbTransaction(db, async () => {
    const rows = await db.all<{
      id: number;
      text: string | null;
      attributedBody: string | null;
      dateEdited: number | null;
      chatGuid: string | null;
    }>(
      sql`SELECT m.id AS id, m.text AS text, m.attributed_body AS attributedBody,
                 m.date_edited AS dateEdited, c.guid AS chatGuid
            FROM messages m
            LEFT JOIN chats c ON c.id = m.chat_id
           WHERE m.guid = ${guid}
           LIMIT 1`,
    );
    const previous = rows[0];
    if (!previous) return null;

    await db
      .update(messages)
      .set({ text: newText, attributedBody: null, dateEdited: now })
      .where(eq(messages.id, previous.id));
    return {
      storedText: previous.text,
      attributedBody: previous.attributedBody,
      dateEdited: previous.dateEdited,
      chatGuid: previous.chatGuid,
    };
  });
}

export interface LocalUnsendSnapshot {
  /** Exact stored marker to restore if the server does not accept this unsend. */
  dateRetracted: number | null;
  chatGuid: string | null;
}

/**
 * Snapshot the committed retraction marker and optimistically apply one local unsend in the SAME
 * short transaction. A separate shared-connection read can observe another owner's uncommitted
 * state or become stale before this write finally claims the DB mutex.
 *
 * Returning null means the message row does not exist and no write occurred. Network work belongs
 * in the service after this owner commits; nothing outside the database runs under the mutex.
 */
export async function applyLocalUnsend(
  db: AppDatabase,
  guid: string,
  now: number,
): Promise<LocalUnsendSnapshot | null> {
  return withDbTransaction(db, async () => {
    const rows = await db.all<{
      id: number;
      dateRetracted: number | null;
      chatGuid: string | null;
    }>(sql`
      SELECT m.id AS id, m.date_retracted AS dateRetracted, c.guid AS chatGuid
        FROM messages m
        LEFT JOIN chats c ON c.id = m.chat_id
       WHERE m.guid = ${guid}
       LIMIT 1
    `);
    const previous = rows[0];
    if (!previous) return null;

    await db.update(messages).set({ dateRetracted: now }).where(eq(messages.id, previous.id));
    return {
      dateRetracted: previous.dateRetracted,
      chatGuid: previous.chatGuid,
    };
  });
}

/**
 * Revert an optimistic edit after the POST failed — as a COMPARE-AND-SET on the marker our own
 * optimistic write left behind, not a blind UPDATE.
 *
 * The blind form is a lost-update waiting to happen: an edit the server DID apply, whose HTTP
 * response was lost (a read timeout the origin actually processed), still emits its echo over the
 * socket. That echo lands first and writes the new text + the server's own `date_edited`; the
 * revert then overwrites it, so the message reads the OLD wording to you and the new wording to
 * everyone else, permanently. Production callers guard on every optimistic field: the local
 * marker, exact new text, and the deliberately-cleared rich body. A server echo that happens to
 * share the same millisecond marker but changes either owned value therefore still wins. A writer
 * whose marker, text, and NULL body are byte-identical is inherently indistinguishable without a
 * separate durable row version; that rare residual is deliberately not overstated here.
 * Compatibility callers that omit the final arguments retain the older marker-only behavior.
 *
 * Returns whether the revert actually applied; false means someone else owns the row now, which the
 * caller must respect (there is nothing to repair — the newer value is the true one).
 */
export async function revertLocalEdit(
  db: AppDatabase,
  guid: string,
  prevText: string | null,
  prevDateEdited: number | null,
  appliedAt: number,
  prevAttributedBody?: string | null,
  expectedOptimisticText?: string,
): Promise<boolean> {
  return withDbTransaction(db, async () => {
    const restoreAttributedBody = prevAttributedBody === undefined ? 0 : 1;
    const enforceOptimisticState = expectedOptimisticText === undefined ? 0 : 1;
    const rows = await db.all<{ id: number }>(
      sql`UPDATE messages
             SET text = ${prevText},
                 attributed_body = CASE
                   WHEN ${restoreAttributedBody} = 1 THEN ${prevAttributedBody ?? null}
                   ELSE attributed_body
                 END,
                 date_edited = ${prevDateEdited}
           WHERE guid = ${guid} AND date_edited = ${appliedAt}
             AND (
               ${enforceOptimisticState} = 0
               OR (text = ${expectedOptimisticText ?? null} AND attributed_body IS NULL)
             )
           RETURNING id`,
    );
    return rows.length > 0;
  });
}

/**
 * Revert an optimistic unsend after the POST failed — the compare-and-set twin of
 * {@link revertLocalEdit}, and the privacy-relevant one: if the server DID retract the message and
 * only the response was lost, a blind clear puts content the user revoked from everyone back on
 * their own screen. Guarding on `date_retracted = appliedAt` keeps a differently stamped server
 * retraction untouched. A server echo with the exact same marker is indistinguishable without a
 * durable server revision/attempt token; callers must not claim that marker-only CAS closes that
 * protocol residual.
 *
 * The optional final argument restores the exact committed predecessor, including an existing
 * non-null retraction. Omitting it retains the legacy clear-to-null behavior.
 *
 * Returns whether the prior retraction marker was actually restored.
 */
export async function revertLocalUnsend(
  db: AppDatabase,
  guid: string,
  appliedAt: number,
  previousDateRetracted?: number | null,
): Promise<boolean> {
  return withDbTransaction(db, async () => {
    // `undefined` is the legacy three-argument call; a production snapshot is always number|null.
    const restoreDateRetracted = previousDateRetracted === undefined ? null : previousDateRetracted;
    const rows = await db.all<{ id: number }>(
      sql`UPDATE messages SET date_retracted = ${restoreDateRetracted}
          WHERE guid = ${guid} AND date_retracted = ${appliedAt}
          RETURNING id`,
    );
    return rows.length > 0;
  });
}

/**
 * Apply a server `message-deleted` event (macOS "Recently Deleted"): TOMBSTONE the message by
 * setting `date_deleted` (Unix ms), then recompute the owning chat's denormalized
 * `latest_message_date` so deleting the NEWEST message drops the chat to its previous message's
 * inbox position (the preview CTE + the sort key would otherwise disagree).
 *
 * TOMBSTONE, not hard delete: the message stays in the Mac's chat.db (~30 days) and the server's
 * query/sync paths keep returning it, so a hard delete would be UNDONE by the next sync re-inserting
 * the row (the re-sync hazard). The tombstone is filtered out of every render/count query (the
 * message VANISHES from the UI) but survives the re-sync. Deletion is monotonic in v1: a still-
 * deleted row re-synced later can't clear the retained ledger marker, and the server emits NOTHING
 * on a 30-day recovery, so v1 does not resurrect a recovered message.
 *
 * The recompute counts RETRACTED (unsent) rows — they still render as tombstone bubbles in the
 * thread, so they legitimately hold the chat's latest position — and excludes DELETED rows and
 * REACTION rows (a tapback must never OUTRANK a real message; the inbox preview + unread count skip
 * them too), falling back to the unfiltered MAX when that filter leaves no candidate at all, so a
 * chat whose only surviving row is a tapback keeps a real sort key instead of a NULL that sinks it
 * to the bottom of the inbox. The expression must stay identical to upsertMessages' own
 * MAX(date_created) recompute — the two write the same column and any drift shows up as a chat that
 * jumps position on delete and jumps back on the next sync.
 *
 * Returns true if a local row matched the guid (tombstone applied), false when no message row is
 * present YET. False is not a no-op: the durable ledger still records the deletion so a later
 * ingestion starts hidden.
 *
 * Transaction-only body for one durable message deletion.
 *
 * Call this only from a callback that already owns {@link withDbTransaction}; standalone callers
 * must use {@link markMessageDeleted} so the ledger marker, message tombstone, and chat sort-key
 * recompute cannot split across commits.
 */
export function markMessageDeletedWithinTransaction(
  context: DbTransactionContext,
  guid: string,
  dateDeleted: number,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    await db
      .insert(messageDeletionLedger)
      .values({ guid, dateDeleted })
      .onConflictDoUpdate({
        target: messageDeletionLedger.guid,
        set: {
          dateDeleted: sql`MAX(${messageDeletionLedger.dateDeleted}, excluded.date_deleted)`,
        },
      });

    // Tombstone the row AND recover its chat id in one statement. An unknown guid updates 0 rows, so
    // RETURNING yields nothing → false (the ledger above still commits). Read the retained maximum
    // rather than blindly applying an older repeated event. db.all(sql`… RETURNING`) per the
    // op-sqlite rules: we need the chat id back, which a non-returning db.run wouldn't give.
    const rows = await db.all<{ chatId: number }>(
      sql`UPDATE messages
           SET date_deleted = (SELECT date_deleted FROM message_deletion_ledger WHERE guid = ${guid})
         WHERE guid = ${guid}
         RETURNING chat_id AS chatId`,
    );
    const chatId = rows[0]?.chatId;
    if (chatId == null) return false;
    // Recompute the inbox sort key over the surviving (non-deleted, non-reaction) rows, with the same
    // COALESCE fallback upsertMessages uses so an all-reactions remainder yields a date rather than
    // the NULL that sorts a chat last. db.run — a non-returning UPDATE (db.all would throw "use
    // run()" under better-sqlite3).
    await db.run(
      sql`UPDATE chats
        SET latest_message_date = COALESCE(
          (SELECT MAX(date_created) FROM messages
            WHERE chat_id = ${chatId} AND date_deleted IS NULL AND associated_message_type IS NULL),
          (SELECT MAX(date_created) FROM messages
            WHERE chat_id = ${chatId} AND date_deleted IS NULL))
        WHERE id = ${chatId}`,
    );
    // Cache retirement is deliberately post-commit in AttachmentCacheCoordinator. This DB layer
    // cannot see mounted-viewer/forward-handoff pins; leaving the path active and accounted until
    // that safe pass is preferable to deleting a file while native UI or a new outgoing send uses it.
    return true;
  });
}

/**
 * Apply one durable message deletion in its own guarded transaction.
 *
 * Callers that already own a transaction must use {@link markMessageDeletedWithinTransaction}
 * instead; nesting this public owner would wedge the process-wide write queue.
 */
export async function markMessageDeleted(
  db: AppDatabase,
  guid: string,
  dateDeleted: number,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) => markMessageDeletedWithinTransaction(context, guid, dateDeleted),
    commitGuard,
  );
}

/** Read a message's current text + edit marker. */
export async function getMessageTextByGuid(
  db: AppDatabase,
  guid: string,
): Promise<{ text: string | null; dateEdited: number | null } | null> {
  const rows = await db.all<{ text: string | null; dateEdited: number | null }>(
    sql`SELECT text, date_edited AS dateEdited FROM messages WHERE guid = ${guid} LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * Resolve the GUID of the chat a message belongs to (via its chat_id → chats.guid). The
 * edit/unsend server routes require `chatGuid`, which the UI doesn't always have in scope.
 */
export async function getChatGuidByMessageGuid(
  db: AppDatabase,
  messageGuid: string,
): Promise<string | null> {
  const rows = await db.all<{ guid: string }>(
    sql`SELECT c.guid AS guid FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE m.guid = ${messageGuid} LIMIT 1`,
  );
  return rows[0]?.guid ?? null;
}

/**
 * Re-check whether one stored message is still unread and present before (re)presenting its
 * notification. Durable delivery may replay presentation minutes after the DB phase committed;
 * in that gap the user can read/delete the message or the sender can retract it.
 *
 * Keep this predicate byte-for-byte aligned with the inbox unread filters in
 * `listChatsForInbox`: received, ordinary, non-retracted/non-deleted content newer than both the
 * read marker and a local chat-deletion floor.
 */
export async function isMessageNotificationEligible(
  db: AppDatabase,
  messageGuid: string,
): Promise<boolean> {
  const rows = await db.all<{ eligible: number }>(sql`
    SELECT EXISTS(
      SELECT 1
        FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE m.guid = ${messageGuid}
         AND m.is_from_me = 0
         AND m.associated_message_type IS NULL
         AND m.date_retracted IS NULL
         AND m.date_deleted IS NULL
         AND m.date_created > COALESCE(
           (SELECT lm.date_created FROM messages lm WHERE lm.guid = c.last_read_message_guid), 0)
         AND (c.deleted_at IS NULL OR m.date_created > c.deleted_at)
    ) AS eligible`);
  return rows[0]?.eligible === 1;
}
