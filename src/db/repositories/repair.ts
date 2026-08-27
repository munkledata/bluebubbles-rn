import { and, eq, sql } from 'drizzle-orm';
import { attachments, chats, kv, messages } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';
import { DRAFT_KV_PREFIX, FULL_REPAIR_RETIRED_CHAT_KV_PREFIX } from './maintenance';

const REPAIR_EXPOSURE_PAGE_SIZE = 250;
const REPAIR_RECONCILE_BATCH_SIZE = 25;
const RECENT_UNFENCED_OUTGOING_GRACE_MS = 60 * 60 * 1000;

export interface FullRepairChatExposure {
  readonly id: number;
  readonly guid: string;
}

export interface FullRepairMessageExposure {
  readonly id: number;
  readonly guid: string;
  readonly originalRowId: number | null;
  readonly chatId: number;
  readonly dateCreated: number | null;
}

export interface FullRepairAttachmentExposure {
  readonly id: number;
  readonly guid: string;
  readonly messageId: number;
  readonly messageGuid: string;
}

/**
 * Exact committed local rows that a later, independently validated server view may retire.
 * Rows created after the three high-water ids are never exposed and therefore can never be
 * removed by this repair, even if realtime delivery lands while the network crawl is running.
 */
export interface FullRepairPruneExposure {
  readonly capturedAt: number;
  readonly attachmentIdHighWater: number;
  readonly chats: readonly FullRepairChatExposure[];
  readonly messages: readonly FullRepairMessageExposure[];
  readonly attachments: readonly FullRepairAttachmentExposure[];
}

export interface FullRepairAuthoritativeView {
  readonly chatGuids: ReadonlySet<string>;
  readonly messageGuids: ReadonlySet<string>;
  /** Present only when the server explicitly hydrated that message's complete attachment list. */
  readonly attachmentGuidsByMessage: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface FullRepairReconciliationResult {
  readonly messagesRemoved: number;
  readonly attachmentsRemoved: number;
  readonly chatsRemoved: number;
  readonly chatShellsRetired: number;
  readonly chatsPreservedForLocalWork: number;
}

interface ExposureHighWater {
  chatId: number;
  messageId: number;
  attachmentId: number;
}

/**
 * Capture a bounded, committed pre-request exposure rather than treating a later server response
 * as authority over rows that appeared while it was in flight. Each read owns a short transaction
 * so it cannot observe a neighbouring writer's uncommitted rows on the shared connection.
 */
export async function captureFullRepairPruneExposure(
  db: AppDatabase,
  commitGuard?: DbCommitGuard,
): Promise<FullRepairPruneExposure> {
  const highWater = await withDbTransaction<ExposureHighWater>(
    db,
    async () => {
      const rows = await db.all<ExposureHighWater>(sql`
        SELECT COALESCE((SELECT MAX(id) FROM chats), 0) AS chatId,
               COALESCE((SELECT MAX(id) FROM messages), 0) AS messageId,
               COALESCE((SELECT MAX(id) FROM attachments), 0) AS attachmentId
      `);
      return rows[0] ?? { chatId: 0, messageId: 0, attachmentId: 0 };
    },
    commitGuard,
  );

  const capturedAt = Date.now();
  const chatsExposure: FullRepairChatExposure[] = [];
  const messagesExposure: FullRepairMessageExposure[] = [];
  const attachmentsExposure: FullRepairAttachmentExposure[] = [];

  let afterChatId = 0;
  while (afterChatId < highWater.chatId) {
    const page = await withDbTransaction<FullRepairChatExposure[]>(
      db,
      () =>
        db.all<FullRepairChatExposure>(sql`
          SELECT id, guid
            FROM chats
           WHERE id > ${afterChatId} AND id <= ${highWater.chatId}
           ORDER BY id ASC
           LIMIT ${REPAIR_EXPOSURE_PAGE_SIZE}
        `),
      commitGuard,
    );
    if (page.length === 0) break;
    chatsExposure.push(...page);
    afterChatId = page.at(-1)!.id;
  }

  let afterMessageId = 0;
  while (afterMessageId < highWater.messageId) {
    const page = await withDbTransaction<FullRepairMessageExposure[]>(
      db,
      () =>
        db.all<FullRepairMessageExposure>(sql`
          SELECT id, guid, original_row_id AS originalRowId, chat_id AS chatId,
                 date_created AS dateCreated
            FROM messages
           WHERE id > ${afterMessageId} AND id <= ${highWater.messageId}
             AND guid NOT LIKE 'temp-%'
             AND (send_state IS NULL OR send_state = 'sent')
             AND date_deleted IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM reminders r WHERE r.message_guid = messages.guid
             )
             AND NOT (
               is_from_me = 1
               AND original_row_id IS NULL
               AND date_created >= ${capturedAt - RECENT_UNFENCED_OUTGOING_GRACE_MS}
             )
           ORDER BY id ASC
           LIMIT ${REPAIR_EXPOSURE_PAGE_SIZE}
        `),
      commitGuard,
    );
    if (page.length === 0) break;
    messagesExposure.push(...page);
    afterMessageId = page.at(-1)!.id;
  }

  let afterAttachmentId = 0;
  while (afterAttachmentId < highWater.attachmentId) {
    const page = await withDbTransaction<FullRepairAttachmentExposure[]>(
      db,
      () =>
        db.all<FullRepairAttachmentExposure>(sql`
          SELECT a.id, a.guid, a.message_id AS messageId, m.guid AS messageGuid
            FROM attachments a
            JOIN messages m ON m.id = a.message_id
           WHERE a.id > ${afterAttachmentId} AND a.id <= ${highWater.attachmentId}
             AND a.guid NOT LIKE 'temp-%'
             AND m.guid NOT LIKE 'temp-%'
             AND (m.send_state IS NULL OR m.send_state = 'sent')
             AND m.date_deleted IS NULL
           ORDER BY a.id ASC
           LIMIT ${REPAIR_EXPOSURE_PAGE_SIZE}
        `),
      commitGuard,
    );
    if (page.length === 0) break;
    attachmentsExposure.push(...page);
    afterAttachmentId = page.at(-1)!.id;
  }

  return {
    capturedAt,
    attachmentIdHighWater: highWater.attachmentId,
    chats: chatsExposure,
    messages: messagesExposure,
    attachments: attachmentsExposure,
  };
}

function removeRepairMessagesWithinTransaction(
  context: DbTransactionContext,
  candidates: readonly FullRepairMessageExposure[],
  capturedAt: number,
): Promise<number> {
  return runInTransactionContext(context, async (db) => {
    let removed = 0;
    const affectedChatIds = new Set<number>();

    for (const candidate of candidates) {
      const rows = await db
        .delete(messages)
        .where(
          and(
            eq(messages.id, candidate.id),
            eq(messages.guid, candidate.guid),
            eq(messages.chatId, candidate.chatId),
            candidate.originalRowId == null
              ? sql`${messages.originalRowId} IS NULL`
              : eq(messages.originalRowId, candidate.originalRowId),
            candidate.dateCreated == null
              ? sql`${messages.dateCreated} IS NULL`
              : eq(messages.dateCreated, candidate.dateCreated),
            sql`${messages.dateDeleted} IS NULL`,
            sql`(${messages.sendState} IS NULL OR ${messages.sendState} = 'sent')`,
            sql`NOT EXISTS (
              SELECT 1 FROM message_deletion_ledger ledger
               WHERE ledger.guid = ${candidate.guid}
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM reminders reminder
               WHERE reminder.message_guid = ${candidate.guid}
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM attachments child
               WHERE child.message_id = ${candidate.id}
            )`,
            sql`NOT (
              ${messages.isFromMe} = 1
              AND ${messages.originalRowId} IS NULL
              AND ${messages.dateCreated} >= ${capturedAt - RECENT_UNFENCED_OUTGOING_GRACE_MS}
            )`,
          ),
        )
        .returning({ id: messages.id });
      if (rows.length > 0) {
        // If the removed corrupt row was the local read floor, hand that floor to the newest
        // surviving message at or before it. The delete and handoff share this transaction, so a
        // failed late eligibility check cannot mutate read state on a row that was preserved.
        await db.run(sql`
          UPDATE chats
             SET last_read_message_guid = (
               SELECT replacement.guid
                 FROM messages replacement
                WHERE replacement.chat_id = ${candidate.chatId}
                  AND replacement.is_from_me = 0
                  AND replacement.date_deleted IS NULL
                  AND ${candidate.dateCreated} IS NOT NULL
                  AND replacement.date_created IS NOT NULL
                  AND replacement.date_created <= ${candidate.dateCreated}
                ORDER BY replacement.date_created DESC, replacement.id DESC
                LIMIT 1
             )
           WHERE id = ${candidate.chatId}
             AND last_read_message_guid = ${candidate.guid}
        `);
        removed += rows.length;
        affectedChatIds.add(candidate.chatId);
      }
    }

    for (const chatId of affectedChatIds) {
      await db.run(sql`
        UPDATE chats
           SET latest_message_date = COALESCE(
             (SELECT MAX(date_created) FROM messages
               WHERE chat_id = ${chatId} AND date_deleted IS NULL
                 AND associated_message_type IS NULL),
             (SELECT MAX(date_created) FROM messages
               WHERE chat_id = ${chatId} AND date_deleted IS NULL)
           )
         WHERE id = ${chatId}
      `);
    }
    return removed;
  });
}

function removeRepairAttachmentsWithinTransaction(
  context: DbTransactionContext,
  candidates: readonly FullRepairAttachmentExposure[],
  attachmentIdHighWater: number,
  capturedAt: number,
): Promise<number> {
  return runInTransactionContext(context, async (db) => {
    let removed = 0;
    for (const candidate of candidates) {
      const rows = await db
        .delete(attachments)
        .where(
          and(
            eq(attachments.id, candidate.id),
            eq(attachments.guid, candidate.guid),
            eq(attachments.messageId, candidate.messageId),
            sql`EXISTS (
              SELECT 1 FROM messages parent
               WHERE parent.id = ${candidate.messageId}
                 AND parent.guid = ${candidate.messageGuid}
                 AND parent.date_deleted IS NULL
                 AND (parent.send_state IS NULL OR parent.send_state = 'sent')
                 AND NOT (
                   parent.is_from_me = 1
                   AND parent.original_row_id IS NULL
                   AND parent.date_created >= ${capturedAt - RECENT_UNFENCED_OUTGOING_GRACE_MS}
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM message_deletion_ledger ledger
                    WHERE ledger.guid = parent.guid
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM reminders reminder
                    WHERE reminder.message_guid = parent.guid
                 )
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM attachments newer
               WHERE newer.message_id = ${candidate.messageId}
                 AND newer.id > ${attachmentIdHighWater}
            )`,
          ),
        )
        .returning({ id: attachments.id });
      removed += rows.length;
    }
    return removed;
  });
}

interface CurrentRepairChatRow {
  id: number;
  guid: string;
  isPinned: number | null;
  isArchived: number | null;
  muteType: string | null;
  customName: string | null;
  customColor: string | null;
  themeTokens: string | null;
  backgroundUri: string | null;
  backgroundIsLight: number | null;
  lastReadMessageGuid: string | null;
  markedUnreadAt: number | null;
  deletedAt: number | null;
}

type ChatRetirement = 'removed' | 'retired' | 'local-work' | 'changed';

function retireRepairChatWithinTransaction(
  context: DbTransactionContext,
  candidate: FullRepairChatExposure,
): Promise<ChatRetirement> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db.all<CurrentRepairChatRow>(sql`
      SELECT id, guid, is_pinned AS isPinned, is_archived AS isArchived,
             mute_type AS muteType, custom_name AS customName, custom_color AS customColor,
             theme_tokens AS themeTokens, background_uri AS backgroundUri,
             background_is_light AS backgroundIsLight,
             last_read_message_guid AS lastReadMessageGuid,
             marked_unread_at AS markedUnreadAt, deleted_at AS deletedAt
        FROM chats
       WHERE id = ${candidate.id} AND guid = ${candidate.guid}
       LIMIT 1
    `);
    const row = rows[0];
    if (!row) return 'changed';

    const draftKey = `${DRAFT_KV_PREFIX}${candidate.guid}`;
    const active = await db.all<{ active: number }>(sql`
      SELECT CASE WHEN
        EXISTS (
          SELECT 1 FROM messages
           WHERE chat_id = ${candidate.id}
        )
        OR EXISTS (SELECT 1 FROM outgoing_queue WHERE chat_guid = ${candidate.guid})
        OR EXISTS (SELECT 1 FROM scheduled_messages WHERE chat_guid = ${candidate.guid})
        OR EXISTS (
          SELECT 1 FROM kv
           WHERE key = ${draftKey} AND value IS NOT NULL AND LENGTH(value) > 0
        )
      THEN 1 ELSE 0 END AS active
    `);
    if (active[0]?.active === 1) return 'local-work';

    const preservesLocalState =
      row.isPinned === 1 ||
      row.isArchived === 1 ||
      row.muteType != null ||
      row.customName != null ||
      row.customColor != null ||
      row.themeTokens != null ||
      row.backgroundUri != null ||
      row.backgroundIsLight != null ||
      row.lastReadMessageGuid != null ||
      row.markedUnreadAt != null ||
      row.deletedAt != null;

    if (!preservesLocalState) {
      const removed = await db
        .delete(chats)
        .where(and(eq(chats.id, candidate.id), eq(chats.guid, candidate.guid)))
        .returning({ id: chats.id });
      return removed.length > 0 ? 'removed' : 'changed';
    }

    // An existing user deletion remains exactly their deletion. Do not create an automatic marker
    // that could later clear it when the server returns the chat.
    if (row.deletedAt != null) return 'retired';

    // Retain the row that owns device-local choices, but hide the now-empty server projection. The
    // sibling kv marker distinguishes this automatic floor from a real user deletion: chat upsert
    // clears it only while deleted_at still equals this exact value. Both writes are one owner, so
    // a crash cannot leave an unlabelled synthetic tombstone.
    const retirementKey = `${FULL_REPAIR_RETIRED_CHAT_KV_PREFIX}${candidate.guid}`;
    await db
      .insert(kv)
      .values({ key: retirementKey, value: '0' })
      .onConflictDoUpdate({ target: kv.key, set: { value: '0' } });
    const retired = await db
      .update(chats)
      .set({ deletedAt: 0 })
      .where(
        and(
          eq(chats.id, candidate.id),
          eq(chats.guid, candidate.guid),
          sql`${chats.deletedAt} IS NULL`,
        ),
      )
      .returning({ id: chats.id });
    if (retired.length > 0) return 'retired';
    await db.delete(kv).where(eq(kv.key, retirementKey));
    return 'changed';
  });
}

/**
 * Retire only exact rows exposed before the two server crawls. The caller must first prove both
 * complete views agree; this function deliberately knows nothing about network completeness.
 */
export async function reconcileFullRepairPruneExposure(
  db: AppDatabase,
  exposure: FullRepairPruneExposure,
  view: FullRepairAuthoritativeView,
  commitGuard?: DbCommitGuard,
): Promise<FullRepairReconciliationResult> {
  const attachmentCandidates = exposure.attachments.filter((row) => {
    if (!view.messageGuids.has(row.messageGuid)) return true;
    const authoritative = view.attachmentGuidsByMessage.get(row.messageGuid);
    return authoritative != null && !authoritative.has(row.guid);
  });
  let attachmentsRemoved = 0;
  for (let i = 0; i < attachmentCandidates.length; i += REPAIR_RECONCILE_BATCH_SIZE) {
    attachmentsRemoved += await withDbTransaction(
      db,
      (context) =>
        removeRepairAttachmentsWithinTransaction(
          context,
          attachmentCandidates.slice(i, i + REPAIR_RECONCILE_BATCH_SIZE),
          exposure.attachmentIdHighWater,
          exposure.capturedAt,
        ),
      commitGuard,
    );
  }

  // Delete exposed attachments first so message deletion never cascades into an unexposed child.
  // Any attachment created after capture remains and makes the later message CAS preserve its row.
  const messageCandidates = exposure.messages.filter((row) => !view.messageGuids.has(row.guid));
  let messagesRemoved = 0;
  for (let i = 0; i < messageCandidates.length; i += REPAIR_RECONCILE_BATCH_SIZE) {
    messagesRemoved += await withDbTransaction(
      db,
      (context) =>
        removeRepairMessagesWithinTransaction(
          context,
          messageCandidates.slice(i, i + REPAIR_RECONCILE_BATCH_SIZE),
          exposure.capturedAt,
        ),
      commitGuard,
    );
  }

  let chatsRemoved = 0;
  let chatShellsRetired = 0;
  let chatsPreservedForLocalWork = 0;
  for (const row of exposure.chats) {
    if (view.chatGuids.has(row.guid)) continue;
    const outcome = await withDbTransaction(
      db,
      (context) => retireRepairChatWithinTransaction(context, row),
      commitGuard,
    );
    if (outcome === 'removed') chatsRemoved += 1;
    else if (outcome === 'retired') chatShellsRetired += 1;
    else if (outcome === 'local-work') chatsPreservedForLocalWork += 1;
  }

  return {
    messagesRemoved,
    attachmentsRemoved,
    chatsRemoved,
    chatShellsRetired,
    chatsPreservedForLocalWork,
  };
}
