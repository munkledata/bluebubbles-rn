/**
 * Echo and attachment matching by content (moved from outgoing.ts): linking a server echo or a sent
 * attachment to its optimistic row when the server returned no identity for it.
 */

import { eq, sql } from 'drizzle-orm';
import { messages, outgoingQueue } from '../schema';
import {
  type DbCommitGuard,
  type DbTransactionContext,
  runInTransactionContext,
  withDbTransaction,
} from '../transaction';
import type { ReadDb } from '../types';
import { messageVisibleInChatSql } from './chatVisibility';
import { type ExactOutgoingAttemptSuccessDisposition } from './outgoingTypes';
import { reconcileExactOutgoingAttemptSuccessWithinTransaction } from './outgoingReconcile';
import {
  handoverOutgoingIdentityWithinTransaction,
  hasOutgoingIdentityHandoverConflictWithinTransaction,
} from './outgoingIdentity';

/** The minimal echo fields reconcileEchoByContent needs to correlate to an optimistic row. */
export interface EchoMatchFields {
  guid: string;
  tempGuid?: string | null;
  attemptGuid?: string | null;
  clientAttemptGeneration?: number | null;
  /** True when the wire contained a partial or malformed modern correlation tuple. */
  sendAttemptCorrelationInvalid?: true;
  isFromMe?: boolean | null;
  text?: string | null;
  dateCreated?: number | null;
  dateDelivered?: number | null;
  associatedMessageGuid?: string | null;
  associatedMessagePart?: number | null;
  associatedMessageType?: string | null;
  associatedMessageEmoji?: string | null;
  threadOriginatorGuid?: string | null;
  threadOriginatorPart?: number | null;
  /** The copy's files as the server lists them; absent when the event did not say. */
  attachments?: readonly { readonly totalBytes?: number | null }[] | null;
}
/** Only match a temp row sent within this window of the echo's own timestamp, so a
 *  coincidentally-identical message from ANOTHER device can't hijack an unrelated stale row. */
const ECHO_MATCH_WINDOW_MS = 5 * 60_000;
/** A modern optimistic send whose current attempt the server acknowledged, with its own ids. */
interface AcknowledgedModernOwner {
  readonly id: number;
  readonly guid: string;
  readonly attemptGuid: string;
  readonly generation: number;
}
/** Most look-alike unsent rows the fallback compares; with more than this it does nothing. */
const UNMARKED_COPY_CANDIDATE_LIMIT = 100;
/** Most files it reads for those rows; with more than this it does nothing. */
const UNMARKED_COPY_FILE_LIMIT = 400;
/** Phone and Google clocks may disagree this much; a copy is never older than its send beyond it. */
const UNMARKED_COPY_CLOCK_SKEW_MS = 60_000;
const sizeSignature = (sizes: readonly number[]): string =>
  [...sizes].sort((a, b) => a - b).join(',');
/**
 * Owner phone session 2026-10-21. The server's copy of a MODERN RCS send can arrive with no attempt
 * ids at all (Google did not echo the server's temp id), and modern rows never content-match, so the
 * copy was stored as a second bubble. Find the one optimistic row it belongs to, so the caller
 * reconciles it exactly with that row's own ids. When in doubt return null and the copy is stored
 * on its own as before: an extra bubble can be deleted, a message merged into the wrong one is lost.
 *
 * Only a plain copy that lists files, all with known sizes, is matched: file sizes tell sends apart,
 * while identical short texts are common. Among ALL unsent rows in this chat (any state, deleted or
 * not) with the same text, created within ECHO_MATCH_WINDOW_MS of the copy's date, none may have a
 * file of unknown size, and exactly one may have files of the same sizes. That one must be a visible
 * modern send whose current attempt the server already acknowledged, created no later than the copy
 * (allowing for clock skew), and the copy must not be dated inside its chat's deleted history or the
 * window right after it. A same-text send without files counts as unknown and blocks the merge. The
 * copy's guid may have no history (no stored row, so an existing duplicate is left alone; no
 * deletion record, server state or alias) and the send no deletion record, which a merge would carry
 * over.
 */
async function findAcknowledgedModernOwnerWithinTransaction(
  context: DbTransactionContext,
  m: EchoMatchFields,
  chatId: number,
): Promise<AcknowledgedModernOwner | null> {
  return runInTransactionContext(context, async (db) => {
    const copyDate = m.dateCreated;
    if (copyDate == null || !Array.isArray(m.attachments) || m.attachments.length === 0) {
      return null;
    }
    if (m.associatedMessageType != null || m.threadOriginatorGuid != null) return null;
    // An unknown copy size (0) can only equal an unknown send size, which blocks the merge below.
    const sizes = m.attachments.map((file) => file.totalBytes ?? 0);
    const rows: {
      id: number;
      guid: string;
      attemptGuid: string | null;
      generation: number;
      pending: number;
      sendState: string | null;
      visible: number;
      dateCreated: number | null;
      chatDeletedAt: number;
    }[] = await db.all(sql`
      SELECT mm.id, mm.guid, mm.active_send_attempt_guid AS attemptGuid,
             mm.attempt_owner_generation AS generation, mm.attempt_owner_pending AS pending,
             mm.send_state AS sendState, ${messageVisibleInChatSql('mm', 'c')} AS visible,
             mm.date_created AS dateCreated,
             MAX(COALESCE(c.history_deleted_at, 0), COALESCE(c.deleted_at, 0)) AS chatDeletedAt
        FROM messages mm
        JOIN chats c ON c.id = mm.chat_id
       WHERE mm.chat_id = ${chatId} AND mm.is_from_me = 1 AND mm.guid LIKE 'temp-%'
         AND mm.associated_message_type IS NULL AND mm.thread_originator_guid IS NULL
         AND mm.text IS ${m.text ?? null}
         AND mm.date_created >= ${copyDate - ECHO_MATCH_WINDOW_MS}
         AND mm.date_created <= ${copyDate + ECHO_MATCH_WINDOW_MS}
       LIMIT ${UNMARKED_COPY_CANDIDATE_LIMIT + 1}`);
    if (rows.length === 0 || rows.length > UNMARKED_COPY_CANDIDATE_LIMIT) return null;
    const files: { messageId: number; bytes: number | null }[] = await db.all(sql`
      SELECT message_id AS messageId, total_bytes AS bytes
        FROM attachments
       WHERE message_id IN (${sql.join(
         rows.map((row) => sql`${row.id}`),
         sql`, `,
       )})
       LIMIT ${UNMARKED_COPY_FILE_LIMIT + 1}`);
    if (files.length > UNMARKED_COPY_FILE_LIMIT) return null;
    // A file of unknown size could be this very copy's file, so nothing can be told apart. A send
    // with the same text but no files is unknown too: its files may have been purged.
    if (files.some((file) => !(file.bytes != null && file.bytes > 0))) return null;
    const filesOf = (id: number) => files.filter((file) => file.messageId === id);
    if (rows.some((row) => filesOf(row.id).length === 0)) return null;
    const wanted = sizeSignature(sizes);
    const same = rows.filter(
      (row) => sizeSignature(filesOf(row.id).map((file) => file.bytes ?? 0)) === wanted,
    );
    if (same.length !== 1) return null;
    const owner = same[0]!;
    if (
      owner.generation <= 0 ||
      owner.pending !== 0 ||
      owner.attemptGuid == null ||
      owner.sendState !== 'sent' ||
      owner.visible !== 1
    ) {
      return null;
    }
    if (owner.dateCreated == null || owner.dateCreated > copyDate + UNMARKED_COPY_CLOCK_SKEW_MS) {
      return null;
    }
    // Merging dates the send by the copy; inside a deleted chat's history it would be hidden, or
    // hidden and purged. Just after the delete, the copy may belong to a send the delete purged,
    // which can no longer block a look-alike (chatDeletedAt is 0 when it was never deleted).
    if (owner.chatDeletedAt > 0 && copyDate <= owner.chatDeletedAt + ECHO_MATCH_WINDOW_MS) {
      return null;
    }
    const history = await db.all(sql`
      SELECT 1 AS found FROM messages WHERE guid = ${m.guid}
      UNION ALL
      SELECT 1 FROM message_deletion_ledger WHERE guid IN (${m.guid}, ${owner.guid})
      UNION ALL
      SELECT 1 FROM message_server_states WHERE guid = ${m.guid}
      UNION ALL
      SELECT 1 FROM message_guid_aliases WHERE canonical_guid = ${m.guid}
      LIMIT 1`);
    if (history.length > 0) return null;
    return {
      id: owner.id,
      guid: owner.guid,
      attemptGuid: owner.attemptGuid,
      generation: owner.generation,
    };
  });
}
/**
 * Google stores a captioned RCS picture as TWO messages: the caption, then the picture with no
 * words. The server links only the picture copy to our upload (by its exact attempt ids), so our
 * bubble would keep its local caption while Google's separate caption message also arrives: the
 * caption showed twice on the sending phone. When the exact-linked copy of our own RCS upload
 * arrives with no text, drop the bubble's local caption so the chat matches Google Messages
 * (caption message, then picture). Only RCS, only an exact link, only a row that has files; a copy
 * that does carry the caption (Google kept one message) leaves the bubble alone.
 */
function dropSplitRcsCaptionWithinTransaction(
  context: DbTransactionContext,
  m: EchoMatchFields,
  chatId: number,
  disposition: ExactOutgoingAttemptSuccessDisposition,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    if (disposition !== 'reconciled' && disposition !== 'already-reconciled') return;
    // Only an explicit empty text (null or "") proves a wordless copy; an omitted field proves nothing.
    if (!m.isFromMe || !(m.text === null || m.text === '')) return;
    await db.all(sql`
      UPDATE messages
         SET text = NULL
       WHERE guid = ${m.guid}
         AND chat_id = ${chatId}
         AND is_from_me = 1
         AND text IS NOT NULL
         AND EXISTS (SELECT 1 FROM chats c WHERE c.id = ${chatId} AND substr(c.guid, 1, 6) = 'RCS;-;')
         AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = messages.id)
      RETURNING id
    `);
  });
}
/** Reconcile a modern copy through its one acknowledged owner; anything but success changes nothing. */
async function reconcileModernCopyThroughOwnerWithinTransaction(
  context: DbTransactionContext,
  m: EchoMatchFields,
  chatId: number,
  owner: AcknowledgedModernOwner,
): Promise<ExactOutgoingAttemptSuccessDisposition | null> {
  return runInTransactionContext(context, async () => {
    const disposition = await reconcileExactOutgoingAttemptSuccessWithinTransaction(context, {
      tempGuid: owner.guid,
      attemptGuid: owner.attemptGuid,
      clientAttemptGeneration: owner.generation,
      guid: m.guid,
      claimedChatId: chatId,
      dateCreated: m.dateCreated ?? null,
      dateDelivered: m.dateDelivered ?? null,
    });
    return disposition === 'reconciled' || disposition === 'already-reconciled'
      ? disposition
      : null;
  });
}
/**
 * Reconcile the LIVE echo of one of OUR sent messages against its optimistic temp row.
 *
 * Gator's `new-message` is a chat.db ROWID-watcher emission and carries NO tempGuid (unlike
 * the upstream app, which correlates it in its message manager) — so we cannot match by
 * tempGuid. Instead, an incoming is-from-me message with a REAL guid is matched by CONTENT to
 * a still-pending `temp-…` row in the same chat (same text / reaction / attachment) and that
 * row is promoted IN PLACE to the real guid. The caller's subsequent upsert then UPDATEs the
 * same row (preserving its id, attachments + local_path) instead of inserting a duplicate; the
 * queue row is dropped. No-op if the real guid already exists (already reconciled by the HTTP
 * ack) or nothing matches.
 *
 * MUST be called ONLY on the live realtime echo path (DbEventSink), never the full/incremental
 * SYNC path: sync replays historical sent messages, and content-matching a brand-new optimistic
 * send to an OLD identical message would corrupt its identity. The retry/ack path reconciles
 * sync/offline sends by guid instead.
 */
export async function reconcileEchoByContent(
  context: DbTransactionContext,
  m: EchoMatchFields,
  chatId: number,
): Promise<ExactOutgoingAttemptSuccessDisposition | null> {
  return runInTransactionContext(context, async (db) => {
    if (!m.isFromMe || m.guid.startsWith('temp-')) return null;
    if (m.sendAttemptCorrelationInvalid === true) return 'unmatched';
    const hasExactAttemptField =
      m.tempGuid != null || m.attemptGuid != null || m.clientAttemptGeneration != null;
    if (hasExactAttemptField) {
      if (!m.tempGuid || !m.attemptGuid || m.clientAttemptGeneration == null) {
        // Partial modern correlation is a protocol violation, not permission to content-match.
        return 'unmatched';
      }
      const disposition = await reconcileExactOutgoingAttemptSuccessWithinTransaction(context, {
        tempGuid: m.tempGuid,
        attemptGuid: m.attemptGuid,
        clientAttemptGeneration: m.clientAttemptGeneration,
        guid: m.guid,
        claimedChatId: chatId,
        dateCreated: m.dateCreated ?? null,
        dateDelivered: m.dateDelivered ?? null,
      });
      await dropSplitRcsCaptionWithinTransaction(context, m, chatId, disposition);
      return disposition;
    }
    // A modern send's copy that carries no attempt ids: reconcile it through its one owner.
    const modernOwner = await findAcknowledgedModernOwnerWithinTransaction(context, m, chatId);
    if (modernOwner) {
      const merged = await reconcileModernCopyThroughOwnerWithinTransaction(
        context,
        m,
        chatId,
        modernOwner,
      );
      if (merged) return merged;
    }
    // Already reconciled (the HTTP ack promoted the temp row first) → leave it to the upsert.
    const already = await db.all<{ id: number }>(
      sql`SELECT id FROM messages WHERE guid = ${m.guid} LIMIT 1`,
    );
    if (already[0]) return null;
    // Match on the fields the BARE socket echo reliably carries — serializeMessage emits NO
    // has_attachments/attachments on the live event, so we must NOT gate on them. A reaction
    // matches its target+type+known part, a reply matches its target+known part+text, and a plain
    // message cannot claim a reply row. Unknown reaction/reply parts reconcile only when the
    // candidate is unique. Other messages match exact text. This covers attachments too:
    // an outgoing attachment send and its echo both have null text. (Attachments are always sent
    // via the Private API — the AppleScript fallback is plain-text only — so on the ack-less
    // no-guid path only TEXT arrives here, and text matches reliably; an attachment that races
    // its ack falls back to reconcileOutgoingSuccess's dup-branch local_path carry-over.)
    const isReactionEcho = m.associatedMessageType != null;
    const isReplyEcho = !isReactionEcho && m.threadOriginatorGuid != null;
    const reactionHasCustomEmoji = m.associatedMessageType?.replace(/^-/, '') === 'emoji';
    const match = isReactionEcho
      ? sql`associated_message_type = ${m.associatedMessageType}
              AND associated_message_guid IS ${m.associatedMessageGuid ?? null}
              ${reactionHasCustomEmoji ? sql`AND associated_message_emoji IS ${m.associatedMessageEmoji ?? null}` : sql``}
              ${m.associatedMessagePart == null ? sql`` : sql`AND associated_message_part IS ${m.associatedMessagePart}`}`
      : isReplyEcho
        ? sql`associated_message_type IS NULL
                AND text IS ${m.text ?? null}
                AND thread_originator_guid IS ${m.threadOriginatorGuid}
                ${m.threadOriginatorPart == null ? sql`` : sql`AND thread_originator_part IS ${m.threadOriginatorPart}`}`
        : sql`associated_message_type IS NULL
                AND thread_originator_guid IS NULL
                AND text IS ${m.text ?? null}`;
    // Time-bound the match to a send near the echo's own timestamp (defeats a cross-device
    // identical-content hijack of an unrelated stale row).
    const echoDate = m.dateCreated ?? null;
    const window =
      echoDate != null
        ? sql`AND date_created >= ${echoDate - ECHO_MATCH_WINDOW_MS} AND date_created <= ${echoDate + ECHO_MATCH_WINDOW_MS}`
        : sql``;
    // A LIVE row wins over a TOMBSTONED one (`date_deleted IS NULL` first). A cancelled send keeps
    // its row so this promote can carry the tombstone onto the real guid — but if the user then
    // re-sends the same words, both rows match this echo by content, and promoting the cancelled one
    // would hide the message they actually sent while leaving the visible bubble stuck on its temp
    // identity. The tombstoned row is still reachable: it is the only candidate left once the live
    // one has been promoted, which is exactly when its own echo arrives.
    // Then prefer an actually-in-flight 'sending' row, then oldest-first (the first echo corresponds
    // to the first send) so rapid identical sends promote in order, not swapped.
    // 'error' rows are matchable too: a send that FAILED client-side (502/timeout) may still have
    // gone through server-side — its echo must promote the errored bubble in place (clearing the
    // queue row, which stops the retry ladder) instead of inserting a duplicate. The ±window +
    // exact-content + same-chat guards bound stale-row hijack.
    // A legacy/bare reaction or reply echo has unknown part identity. Preserve its old
    // single-candidate reconciliation path, but never guess between multiple otherwise-valid
    // part-specific rows. A known incoming part remains exact and rapid identical sends retain
    // their oldest-first rule.
    const requiresUniqueUnknownPartMatch =
      (isReactionEcho && m.associatedMessagePart == null) ||
      (isReplyEcho && m.threadOriginatorPart == null);
    const rows = await db.all<{ guid: string }>(sql`
      SELECT guid FROM messages
      WHERE chat_id = ${chatId} AND is_from_me = 1 AND guid LIKE 'temp-%'
        AND send_state IN ('sending', 'sent', 'error')
        AND attempt_owner_generation = 0 AND ${match} ${window}
      ORDER BY (date_deleted IS NULL) DESC, (send_state = 'sending') DESC, date_created ASC, id ASC
      LIMIT ${requiresUniqueUnknownPartMatch ? 2 : 1}`);
    if (requiresUniqueUnknownPartMatch && rows.length !== 1) return null;
    const temp = rows[0];
    if (!temp) return null;
    const owners = await db.all<{ chatGuid: string }>(sql`
      SELECT guid AS chatGuid FROM chats WHERE id = ${chatId} LIMIT 1
    `);
    const ownerChatGuid = owners[0]?.chatGuid;
    if (!ownerChatGuid) return null;
    if (
      await hasOutgoingIdentityHandoverConflictWithinTransaction(
        context,
        temp.guid,
        m.guid,
        ownerChatGuid,
      )
    ) {
      return null;
    }
    await handoverOutgoingIdentityWithinTransaction(context, temp.guid, m.guid, ownerChatGuid);
    // Drop the queue row BEFORE promoting, so a concurrent retry tick in the gap can't claim and
    // re-POST a send that's already being reconciled.
    await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, temp.guid));
    await db
      .update(messages)
      .set({ guid: m.guid, sendState: 'sent', error: 0, errorMessage: null })
      .where(eq(messages.guid, temp.guid));
    return null;
  });
}
/**
 * Reconcile the SYNC materialization of one of OUR sent ATTACHMENT messages against its optimistic
 * temp row — the sync-safe sibling of {@link reconcileEchoByContent}.
 *
 * Why a SEPARATE helper (and not just calling reconcileEchoByContent on the sync path): RCS messages
 * carry NO server rowid, so the real `rcs-<id>` row is usually first materialized by a SYNC read —
 * `syncChatMessages` (thread re-open / pull-to-refresh) or `syncAllChats`'s lastMessage upsert
 * (reconnect) — NOT the live socket echo. Those sync paths never call reconcileEchoByContent, so the
 * optimistic picture's MESSAGE row is never promoted in place; upsertAttachments (keyed by
 * message_id) then can't find the temp `-att` under the new real row and inserts the server
 * attachment with a NULL local_path — a second, image-less bubble, while the on-disk image is
 * stranded on an orphaned temp duplicate. Promoting the temp row HERE, before upsertMessages, lets
 * the existing per-message-id local_path carry-over (see upsertAttachments) preserve the image.
 *
 * reconcileEchoByContent is deliberately BANNED on the sync path because it would content-match a
 * fresh optimistic TEXT send to an OLD identical historical message. This helper is sync-safe: it
 * only ever matches a still-pending optimistic send that STILL OWNS a `-att` attachment with a
 * non-null local_path — a historical re-sync has no such pending row, so it can't be hijacked; the
 * ±window additionally rejects an old identical picture surfaced by a history backfill. It is inert
 * for iMessage/SMS (their temp row is already promoted in place by the real-guid ack, so no pending
 * `temp-…` `-att` exists at sync time) and for received messages (not is-from-me).
 */
export async function reconcileOutgoingAttachmentByContent(
  db: ReadDb,
  m: EchoMatchFields,
  chatId: number,
  commitGuard?: DbCommitGuard,
): Promise<ExactOutgoingAttemptSuccessDisposition | null> {
  if (!m.isFromMe || m.guid.startsWith('temp-')) return null;
  if (m.sendAttemptCorrelationInvalid === true) return 'unmatched';
  return withDbTransaction(
    db,
    async (db, context) => {
      const hasExactAttemptField =
        m.tempGuid != null || m.attemptGuid != null || m.clientAttemptGeneration != null;
      if (hasExactAttemptField) {
        if (!m.tempGuid || !m.attemptGuid || m.clientAttemptGeneration == null) {
          return 'unmatched';
        }
        const disposition = await reconcileExactOutgoingAttemptSuccessWithinTransaction(context, {
          tempGuid: m.tempGuid,
          attemptGuid: m.attemptGuid,
          clientAttemptGeneration: m.clientAttemptGeneration,
          guid: m.guid,
          claimedChatId: chatId,
          dateCreated: m.dateCreated ?? null,
          dateDelivered: m.dateDelivered ?? null,
        });
        await dropSplitRcsCaptionWithinTransaction(context, m, chatId, disposition);
        return disposition;
      }
      // A modern send's copy that carries no attempt ids: reconcile it through its one owner.
      const modernOwner = await findAcknowledgedModernOwnerWithinTransaction(context, m, chatId);
      if (modernOwner) {
        const merged = await reconcileModernCopyThroughOwnerWithinTransaction(
          context,
          m,
          chatId,
          modernOwner,
        );
        if (merged) return merged;
      }
      // Already materialized (a prior sync/echo created it) → leave it to the upsert.
      const already = await db.all<{ id: number }>(
        sql`SELECT id FROM messages WHERE guid = ${m.guid} LIMIT 1`,
      );
      if (already[0]) return null;
      // Time-bound to a send near the echo's own timestamp (same window as reconcileEchoByContent) so a
      // history re-sync of an OLD identical picture can't claim a fresh optimistic row.
      const echoDate = m.dateCreated ?? null;
      const window =
        echoDate != null
          ? sql`AND mm.date_created >= ${echoDate - ECHO_MATCH_WINDOW_MS} AND mm.date_created <= ${echoDate + ECHO_MATCH_WINDOW_MS}`
          : sql``;
      // A group iMessage text is sent by the Mac's AppleScript fallback, whose reply has no guid, so
      // its temp row waits for a copy. When an open chat's refresh or a reconnect reads that copy
      // before the live echo does, it must be matched here too, or the late echo finds the real guid
      // stored and the temp bubble stays beside it as a duplicate. A plain text has no pending file
      // to prove it is fresh, so it needs a known copy time and exact text, and never matches a
      // reply, a reaction, or a row that has files. Sync is the catch-up path after being offline, so
      // a copy may also be another device's identical text: the copy must not predate the bubble
      // (beyond clock skew), and a cancelled or failed bubble is never matched, so a mistake leaves a
      // double instead of marking an unsent text as sent or hiding a real message.
      const plainTextCopy =
        echoDate != null &&
        !!m.text &&
        m.associatedMessageType == null &&
        m.threadOriginatorGuid == null &&
        !(Array.isArray(m.attachments) && m.attachments.length > 0);
      // Match a pending optimistic outgoing message that STILL OWNS a local (on-disk) attachment — that
      // pending-local-`-att` gate is what makes this sync-safe. Match text too (a caption-less picture
      // and its echo both carry NULL text) so a text send can never claim a picture row. Prefer an
      // in-flight 'sending' row, then oldest-first, so rapid identical sends promote in send order.
      // 'error' included for the same reason as reconcileEchoByContent: a client-side-failed picture
      // whose upload actually landed must be promoted (and its queue row cleared), not duplicated.
      const rows = await db.all<{ guid: string }>(sql`
        SELECT mm.guid FROM messages mm
        WHERE mm.chat_id = ${chatId} AND mm.is_from_me = 1 AND mm.guid LIKE 'temp-%'
          AND mm.send_state IN ('sending', 'sent', 'error')
          -- Content matching is legacy-only. A modern row (generation > 0) must carry the exact
          -- server tuple; otherwise an old identical sync row could steal the optimistic bubble.
          AND mm.attempt_owner_generation = 0
          AND mm.associated_message_type IS NULL AND mm.text IS ${m.text ?? null}
          AND (
            EXISTS (
              SELECT 1 FROM attachments a
              WHERE a.message_id = mm.id AND a.guid LIKE '%-att' AND a.local_path IS NOT NULL
            )
            ${
              plainTextCopy
                ? sql`OR (mm.thread_originator_guid IS NULL
                        AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = mm.id)
                        AND mm.send_state IN ('sending', 'sent') AND mm.date_deleted IS NULL
                        AND mm.date_created <= ${(echoDate ?? 0) + UNMARKED_COPY_CLOCK_SKEW_MS})`
                : sql``
            }
          )
          ${window}
        ORDER BY (mm.date_deleted IS NULL) DESC, (mm.send_state = 'sending') DESC,
                 mm.date_created ASC, mm.id ASC LIMIT 1`);
      const temp = rows[0];
      if (!temp) return null;
      const owners = await db.all<{ chatGuid: string }>(sql`
        SELECT guid AS chatGuid FROM chats WHERE id = ${chatId} LIMIT 1
      `);
      const ownerChatGuid = owners[0]?.chatGuid;
      if (!ownerChatGuid) return null;
      if (
        await hasOutgoingIdentityHandoverConflictWithinTransaction(
          context,
          temp.guid,
          m.guid,
          ownerChatGuid,
        )
      ) {
        return null;
      }
      // Queue deletion and identity promotion are one commit. Otherwise a crash/rollback between
      // them can either re-send an acknowledged attachment or strand the optimistic temp row.
      await handoverOutgoingIdentityWithinTransaction(context, temp.guid, m.guid, ownerChatGuid);
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, temp.guid));
      await db
        .update(messages)
        .set({ guid: m.guid, sendState: 'sent', error: 0, errorMessage: null })
        .where(eq(messages.guid, temp.guid));
      return null;
    },
    commitGuard,
  );
}
