/**
 * One-call transaction wrappers that only tests use (Phase 6 cleanup). Production code always
 * composes the `*WithinTransaction` functions inside its own short owner, so these were removed
 * from `src/`: a wrapper that opens its own transaction is a deadlock trap if production code ever
 * calls it inside another transaction.
 */
import { type Attachment, type Chat } from '@core/models';
import { type SyncMarker } from '@core/sync';
import { upsertAttachmentsWithinTransaction } from '@db/repositories/attachments';
import {
  clearChatTombstoneWithinTransaction,
  markAllChatsReadLocalWithinTransaction,
  persistServerChatWithinTransaction,
  setChatArchiveWithinTransaction,
  setChatMuteWithinTransaction,
  setChatPinWithinTransaction,
  setChatUnreadLocalWithinTransaction,
} from '@db/repositories/chats';
import {
  linkHandlesToContacts,
  setHandleServerAvatarWithinTransaction,
} from '@db/repositories/contacts';
import {
  createCustomFolderWithinTransaction,
  deleteCustomFolderWithinTransaction,
  listCustomFolderChatGuidsWithinTransaction,
  listCustomFoldersWithinTransaction,
  renameCustomFolderWithinTransaction,
  reorderCustomFoldersWithinTransaction,
  replaceCustomFolderMembershipWithinTransaction,
  setCustomFolderShowUnreadBadgeWithinTransaction,
  type CustomFolderListRow,
  type CustomFolderRow,
} from '@db/repositories/customFolders';
import { kvSetWithinTransaction } from '@db/repositories/kv';
import {
  applyLocalEditWithinTransaction,
  applyLocalUnsendWithinTransaction,
  deleteMessageLocalWithinTransaction,
  type DeleteMessageLocalResult,
  type LocalEditSnapshot,
  type LocalUnsendSnapshot,
} from '@db/repositories/messages';
import {
  insertOutgoingContactWithinTransaction,
  markOutgoingSentNoGuidWithinTransaction,
  reconcileExactOutgoingAttemptSuccessWithinTransaction,
  retireOutgoingWithinTransaction,
  type ExactOutgoingAttemptSuccess,
  type ExactOutgoingAttemptSuccessDisposition,
  type InsertOutgoingContactArgs,
  type OutgoingAckDisposition,
  type OutgoingAttemptSettlement,
  type OutgoingInsertResult,
} from '@db/repositories/outgoing';
import {
  claimOutgoingForSendWithinTransaction,
  markMessageSendErrorWithinTransaction,
} from '@db/repositories/outgoingRetry';
import {
  createReminderWithinTransaction,
  deleteReminderWithinTransaction,
  type CreateReminderArgs,
} from '@db/repositories/reminders';
import {
  deleteScheduledHistoryWithinTransaction,
  deleteScheduledWithinTransaction,
  insertScheduledWithinTransaction,
  updateScheduledWithinTransaction,
  type InsertScheduledArgs,
  type ScheduledEditResult,
  type ScheduledOccurrence,
  type UpdateScheduledPatch,
} from '@db/repositories/scheduled';
import {
  prepareShareIntakeNewChatPlanWithinTransaction,
  type ShareIntakeManifestIdentity,
  type ShareIntakeNewChatPlan,
} from '@db/repositories/shareIntakeReceipts';
import { setSyncMarkerWithinTransaction } from '@db/repositories/sync';
import {
  createCustomThemeWithinTransaction,
  deleteCustomThemeWithinTransaction,
  updateCustomThemeWithinTransaction,
} from '@db/repositories/themes';
import { withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase, Queryable, ReadDb } from '@db/types';
import { and, eq, sql } from 'drizzle-orm';
import { toFtsQuery } from '@db/repositories/_shared';
import { type AttachmentCacheState } from '@db/repositories/attachmentCache';
import {
  setChatAppearanceWithinTransaction,
  setChatCustomizationWithinTransaction,
  setSyncedBackgroundLuminanceIfCurrentWithinTransaction,
  setSyncedBackgroundUriIfCurrentWithinTransaction,
  type ChatAppearancePatch,
} from '@db/repositories/chatAppearance';
import { chatVisible, messageHasVisibleContentSql } from '@db/repositories/chatVisibility';
import {
  claimErrorReportsWithinTransaction as claimErrorReportsInTx,
  clearErrorReportsWithinTransaction as clearErrorReportsInTx,
  deleteErrorReportsWithinTransaction,
  insertErrorReports,
  listRetryableErrorReportsWithinTransaction,
  markErrorReportsFailedWithinTransaction as markErrorReportsFailedInTx,
  trimErrorReportsWithinTransaction as trimErrorReportsInTx,
  ERROR_REPORT_CAPACITY as REPORT_CAPACITY,
  ERROR_REPORT_QUEUE_BYTE_BUDGET as REPORT_BYTE_BUDGET,
  ERROR_REPORT_UPLOAD_BATCH_SIZE,
  type ErrorReportClock as ReportClock,
  type NewErrorReport,
} from '@db/repositories/errorReports';
import { notAnOverlayMessage } from '@db/repositories/messageQueries';
import { revertLocalUnsendWithinTransaction } from '@db/repositories/messages';
import {
  applyServerSendErrorWithinTransaction,
  type ServerSendAttemptIdentity,
} from '@db/repositories/outgoingRetry';
import { updateReminderTimeWithinTransaction } from '@db/repositories/reminders';
import { setUrlPreviewWithinTransaction } from '@db/repositories/urlPreviews';
import {
  insertOutgoingAttachmentWithinTransaction,
  type InsertOutgoingAttachmentArgs,
} from '@db/repositories/attachments';
import { chats, messages, scheduledMessages } from '@db/schema';
import { runInTransactionContext, type DbTransactionContext } from '@db/transaction';

/** Public standalone attachment ingestion. Never wrap this helper in another transaction. */
export async function upsertAttachments(
  db: ReadDb,
  items: Array<{ att: Attachment; messageId: number }>,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (db, context) => upsertAttachmentsWithinTransaction(context, items),
    commitGuard,
  );
}

/** Persist a server-returned chat atomically, then apply presentation-only device-contact names. */
export async function persistServerChat(db: ReadDb, chat: Chat): Promise<void> {
  await withDbTransaction(db, (db, context) => persistServerChatWithinTransaction(context, chat));
  await linkHandlesToContacts(
    db,
    (chat.participants ?? []).map((participant) => participant.address),
  );
}

/** Set a chat's local mute preference ('mute' to mute, null to clear). */
export async function setChatMute(
  db: ReadDb,
  guid: string,
  muteType: string | null,
): Promise<void> {
  await withDbTransaction(db, (db, context) =>
    setChatMuteWithinTransaction(context, guid, muteType),
  );
}

/**
 * Pin / unpin a chat. Client-local — Gator pin is a device state, not a server
 * concept; kept out of `upsertChats`' conflict set so a re-sync can't clobber it.
 * The inbox sorts pinned chats first (see `listChatsForInbox`).
 */
export async function setChatPin(db: ReadDb, guid: string, pinned: boolean): Promise<void> {
  await withDbTransaction(db, (db, context) => setChatPinWithinTransaction(context, guid, pinned));
}

/** Archive / unarchive a chat (client-local). Archived chats drop out of the main inbox. */
export async function setChatArchive(db: ReadDb, guid: string, archived: boolean): Promise<void> {
  await withDbTransaction(db, (db, context) =>
    setChatArchiveWithinTransaction(context, guid, archived),
  );
}

/** Standalone un-hide. Existing domain transactions must use the explicitly scoped form above. */
export async function clearChatTombstone(db: ReadDb, guid: string): Promise<void> {
  await withDbTransaction(db, (db, context) => clearChatTombstoneWithinTransaction(context, guid));
}

export async function setChatUnreadLocal(
  db: ReadDb,
  chatGuid: string,
  now: number = Date.now(),
): Promise<void> {
  await withDbTransaction(db, (db, context) =>
    setChatUnreadLocalWithinTransaction(context, chatGuid, now),
  );
}

export async function markAllChatsReadLocal(db: ReadDb): Promise<void> {
  await withDbTransaction(db, (db, context) => markAllChatsReadLocalWithinTransaction(context));
}

/**
 * Write a server-sourced avatar uri onto a handle (only the photo — not display_name /
 * contact_id, which stay device-contact-owned). Used by the server-avatar backfill for
 * handles a device contact didn't supply a photo for. `expectedAvatar` defaults to null for a new
 * fill; revalidation may instead replace or clear one exact app-owned path. The compare-and-swap
 * is checked again after the download, so a device-contact photo that arrived meanwhile wins.
 */
export async function setHandleServerAvatar(
  db: ReadDb,
  handleId: number,
  uri: string,
): Promise<boolean> {
  return withDbTransaction(db, (db, context) =>
    setHandleServerAvatarWithinTransaction(context, handleId, uri),
  );
}

/** Consistency-sensitive read: queue behind mutations so partial reorder/replacement is invisible. */
export function listCustomFolders(
  db: ReadDb,
  commitGuard?: DbCommitGuard,
): Promise<CustomFolderListRow[]> {
  return withDbTransaction(
    db,
    (db, context) => listCustomFoldersWithinTransaction(context),
    commitGuard,
  );
}

/** Consistency-sensitive read: queue behind add-before-prune membership replacement. */
export function listCustomFolderChatGuids(
  db: ReadDb,
  folderId: number,
  commitGuard?: DbCommitGuard,
): Promise<string[]> {
  return withDbTransaction(
    db,
    (db, context) => listCustomFolderChatGuidsWithinTransaction(context, folderId),
    commitGuard,
  );
}

export function createCustomFolder(
  db: ReadDb,
  name: string,
  commitGuard?: DbCommitGuard,
): Promise<CustomFolderRow> {
  return withDbTransaction(
    db,
    (db, context) => createCustomFolderWithinTransaction(context, name),
    commitGuard,
  );
}

export function renameCustomFolder(
  db: ReadDb,
  folderId: number,
  name: string,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (db, context) => renameCustomFolderWithinTransaction(context, folderId, name),
    commitGuard,
  );
}

export function setCustomFolderShowUnreadBadge(
  db: ReadDb,
  folderId: number,
  showUnreadBadge: boolean,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (db, context) =>
      setCustomFolderShowUnreadBadgeWithinTransaction(context, folderId, showUnreadBadge),
    commitGuard,
  );
}

export function deleteCustomFolder(
  db: ReadDb,
  folderId: number,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (db, context) => deleteCustomFolderWithinTransaction(context, folderId),
    commitGuard,
  );
}

export function reorderCustomFolders(
  db: ReadDb,
  ids: readonly number[],
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (db, context) => reorderCustomFoldersWithinTransaction(context, ids),
    commitGuard,
  );
}

export function replaceCustomFolderMembership(
  db: ReadDb,
  folderId: number,
  chatGuids: readonly string[],
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (db, context) => replaceCustomFolderMembershipWithinTransaction(context, folderId, chatGuids),
    commitGuard,
  );
}

/** Standalone key/value upsert. Callers already inside a transaction must use the scoped form. */
export async function kvSet(db: ReadDb, key: string, value: string): Promise<void> {
  await withDbTransaction(db, (db, context) => kvSetWithinTransaction(context, key, value));
}

/**
 * Record one user-requested local deletion in its own standalone transaction. Callers that already own
 * the transaction must use {@link deleteMessageLocalWithinTransaction} instead of nesting this
 * wrapper.
 */
export async function deleteMessageLocal(
  db: ReadDb,
  guid: string,
  now: number,
): Promise<DeleteMessageLocalResult> {
  return withDbTransaction(db, (db, context) =>
    deleteMessageLocalWithinTransaction(context, guid, now),
  );
}

/** Standalone optimistic-edit owner; composing services use the transaction-only body. */
export async function applyLocalEdit(
  db: ReadDb,
  guid: string,
  newText: string,
  now: number,
): Promise<LocalEditSnapshot | null> {
  return withDbTransaction(db, (db, context) =>
    applyLocalEditWithinTransaction(context, guid, newText, now),
  );
}

/** Standalone optimistic-unsend owner; composing services use the transaction-only body. */
export async function applyLocalUnsend(
  db: ReadDb,
  guid: string,
  now: number,
  partIndex: number = 0,
): Promise<LocalUnsendSnapshot | null> {
  return withDbTransaction(db, (db, context) =>
    applyLocalUnsendWithinTransaction(context, guid, now, partIndex),
  );
}

/** Standalone optimistic contact-card owner; composing services use the transaction-only body. */
export async function insertOutgoingContact(
  db: ReadDb,
  args: InsertOutgoingContactArgs,
): Promise<OutgoingInsertResult> {
  // ONE transaction — see the insert-atomicity note above insertOutgoingText.
  return withDbTransaction(db, (db, context) =>
    insertOutgoingContactWithinTransaction(context, args),
  );
}

/**
 * Reconcile a send that SUCCEEDED but returned no GUID (the AppleScript fallback path).
 * The message left the device, so: drop the queue row (no more retries) and flip the
 * still-temp optimistic bubble to 'sent'. Its identity stays the tempGuid until the socket
 * `new-message` echo (which carries the tempGuid) promotes it to the real guid. Used by the
 * send services and the retry processor for the absent-guid case.
 *
 * The promote and the queue-row delete commit in ONE transaction, for the same reason as
 * {@link reconcileOutgoingSuccess}: as two autocommits, a death in the gap leaves a 'sent' bubble
 * whose queue row survives, and the next launch's drain re-sends a message already delivered.
 *
 * A cancelled send needs no branch here either: the discard already TOMBSTONED the row, and this
 * write touches send_state/error only, so the message stays hidden while keeping the identity the
 * fanout will promote (see the cancelled-send rule at the top of this file).
 */
export async function markOutgoingSentNoGuid(
  db: ReadDb,
  tempGuid: string,
  commitGuard?: DbCommitGuard,
  settlement?: OutgoingAttemptSettlement,
): Promise<OutgoingAckDisposition> {
  return withDbTransaction(
    db,
    (db, context) => markOutgoingSentNoGuidWithinTransaction(context, tempGuid, settlement),
    commitGuard,
  );
}

/** Standalone owner for exact capable-RCS success reconciliation. */
export function reconcileExactOutgoingAttemptSuccess(
  db: ReadDb,
  success: ExactOutgoingAttemptSuccess,
  commitGuard?: DbCommitGuard,
): Promise<ExactOutgoingAttemptSuccessDisposition> {
  return withDbTransaction(
    db,
    (db, context) => reconcileExactOutgoingAttemptSuccessWithinTransaction(context, success),
    commitGuard,
  );
}

/**
 * Permanently retire a queue row (no further automatic retries): attempts jumps to the cap and
 * the bubble is forced to 'error' unless it already reconciled to 'sent'. For failures no retry
 * can ever fix — the attachment's on-disk file is gone, or the row's kind is unknown. The queue
 * row is KEPT, matching the natural attempts-cap retirement (the bubble's 'error' state is what
 * makes it cancellable, and `cancelOutgoing` removes the ladder along with it either way).
 *
 * The optional guard authorizes this standalone commit. Services composing the write use
 * {@link retireOutgoingWithinTransaction} inside their own short guarded owner.
 */
export async function retireOutgoing(
  db: ReadDb,
  tempGuid: string,
  errorCode = 1,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (db, context) => retireOutgoingWithinTransaction(context, tempGuid, errorCode),
    commitGuard,
  );
}

/** Standalone server-pushed send-error owner. */
export async function markMessageSendError(
  db: ReadDb,
  guid: string,
  errorCode = 1,
  commitGuard?: DbCommitGuard,
  errorMessage?: string | null,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (db, context) => markMessageSendErrorWithinTransaction(context, guid, errorCode, errorMessage),
    commitGuard,
  );
}

/**
 * Standalone automatic-claim owner retained for repository and DEV callers. Production services
 * that compose this write use {@link claimOutgoingForSendWithinTransaction} inside their own short
 * guarded owner instead of nesting this wrapper.
 */
export async function claimOutgoingForSend(
  db: ReadDb,
  id: number,
  clock: () => number,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  const result = await withDbTransaction(
    db,
    (db, context) => claimOutgoingForSendWithinTransaction(context, id, clock),
    commitGuard,
  );
  return result.claimed;
}

/** Standalone reminder-creation owner; composing services use the transaction-only body. */
export async function createReminder(
  db: ReadDb,
  r: CreateReminderArgs,
  commitGuard?: DbCommitGuard,
): Promise<number> {
  return withDbTransaction(
    db,
    (db, context) => createReminderWithinTransaction(context, r),
    commitGuard,
  );
}

export async function deleteReminder(
  db: ReadDb,
  id: number,
  commitGuard?: DbCommitGuard,
  expectedNotificationId?: string,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (db, context) => deleteReminderWithinTransaction(context, id, expectedNotificationId),
    commitGuard,
  );
}

export async function insertScheduled(db: ReadDb, args: InsertScheduledArgs): Promise<number> {
  return withDbTransaction(db, (db, context) => insertScheduledWithinTransaction(context, args));
}

export function updateScheduled(
  db: ReadDb,
  id: number,
  patch: UpdateScheduledPatch,
  expected?: Omit<ScheduledOccurrence, 'id'>,
): Promise<ScheduledEditResult> {
  return withDbTransaction(db, (db, context) =>
    updateScheduledWithinTransaction(context, id, patch, expected),
  );
}

/** Delete a COMPLETED (sent/error/uncertain) row from the local history list. */
export async function deleteScheduledHistory(db: ReadDb, id: number): Promise<void> {
  await withDbTransaction(db, (db, context) =>
    deleteScheduledHistoryWithinTransaction(context, id),
  );
}

export async function deleteScheduled(db: ReadDb, id: number): Promise<void> {
  await withDbTransaction(db, (db, context) => deleteScheduledWithinTransaction(context, id));
}

export async function prepareShareIntakeNewChatPlan(
  db: ReadDb,
  identity: ShareIntakeManifestIdentity,
  plan: ShareIntakeNewChatPlan,
): Promise<ShareIntakeNewChatPlan> {
  return withDbTransaction(db, (db, context) =>
    prepareShareIntakeNewChatPlanWithinTransaction(context, identity, plan),
  );
}

/** Standalone sync-marker owner. Existing transaction owners use the context-only form above. */
export async function setSyncMarker(
  db: ReadDb,
  marker: SyncMarker,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  return withDbTransaction(
    db,
    (db, context) => setSyncMarkerWithinTransaction(context, marker),
    commitGuard,
  );
}

/** Public standalone create. Never wrap this helper in another transaction. */
export async function createCustomTheme(
  db: ReadDb,
  theme: { name: string; mode: string; tokens: string },
): Promise<number> {
  return withDbTransaction(db, (db, context) => createCustomThemeWithinTransaction(context, theme));
}

/** Public standalone update. Never wrap this helper in another transaction. */
export async function updateCustomTheme(
  db: ReadDb,
  id: number,
  patch: { name: string; mode: string; tokens: string },
): Promise<void> {
  await withDbTransaction(db, (db, context) =>
    updateCustomThemeWithinTransaction(context, id, patch),
  );
}

/** Public standalone delete. Never wrap this helper in another transaction. */
export async function deleteCustomTheme(db: ReadDb, id: number): Promise<void> {
  await withDbTransaction(db, (db, context) => deleteCustomThemeWithinTransaction(context, id));
}

// ---- Moved in Phase 6 slice 5: wrappers whose cores already validate, plus test fixtures/readers.

export async function setSyncedBackgroundUri(
  db: ReadDb,
  guid: string,
  uri: string | null,
): Promise<void> {
  await withDbTransaction(db, (db) =>
    db.update(chats).set({ syncedBackgroundUri: uri }).where(eq(chats.guid, guid)),
  );
}

export function setSyncedBackgroundUriIfCurrent(
  db: ReadDb,
  guid: string,
  expectedChannel: string | null,
  expectedUri: string | null,
  nextUri: string | null,
): Promise<boolean> {
  return withDbTransaction(db, (db, context) =>
    setSyncedBackgroundUriIfCurrentWithinTransaction(
      context,
      guid,
      expectedChannel,
      expectedUri,
      nextUri,
    ),
  );
}

export function setSyncedBackgroundLuminanceIfCurrent(
  db: ReadDb,
  guid: string,
  expectedChannel: string,
  expectedUri: string,
  isLight: boolean,
): Promise<boolean> {
  return withDbTransaction(db, (db, context) =>
    setSyncedBackgroundLuminanceIfCurrentWithinTransaction(
      context,
      guid,
      expectedChannel,
      expectedUri,
      isLight,
    ),
  );
}

export async function insertErrorReport(
  db: ReadDb,
  report: NewErrorReport,
  now = Date.now(),
): Promise<void> {
  await insertErrorReports(db, [report], now);
}

export async function trimErrorReports(
  db: ReadDb,
  capacity = REPORT_CAPACITY,
  now?: number,
  byteBudget = REPORT_BYTE_BUDGET,
): Promise<void> {
  await withDbTransaction(db, (db, context) =>
    trimErrorReportsInTx(context, capacity, now, byteBudget),
  );
}

export async function clearErrorReports(db: ReadDb, commitGuard?: DbCommitGuard): Promise<void> {
  await withDbTransaction(db, (db, context) => clearErrorReportsInTx(context), commitGuard);
}

export function listRetryableErrorReports(
  db: ReadDb,
  clock: ReportClock = Date.now,
  limit = ERROR_REPORT_UPLOAD_BATCH_SIZE,
  commitGuard?: DbCommitGuard,
) {
  return withDbTransaction(
    db,
    (db, context) => listRetryableErrorReportsWithinTransaction(context, clock, limit),
    commitGuard,
  );
}

export function claimErrorReports(
  db: ReadDb,
  ids: number[],
  clock: ReportClock = Date.now,
  commitGuard?: DbCommitGuard,
): Promise<number[]> {
  return withDbTransaction(
    db,
    (db, context) => claimErrorReportsInTx(context, ids, clock),
    commitGuard,
  );
}

export async function markErrorReportsFailed(
  db: ReadDb,
  ids: number[],
  clock: ReportClock = Date.now,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (db, context) => markErrorReportsFailedInTx(context, ids, clock),
    commitGuard,
  );
}

export async function deleteErrorReports(
  db: ReadDb,
  ids: number[],
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (db, context) => deleteErrorReportsWithinTransaction(context, ids),
    commitGuard,
  );
}

/** Seed one active ledger row (production records entries when a download commits). */
export function recordAttachmentCacheEntry(
  context: DbTransactionContext,
  input: { path: string; bytes: number; lastUsedAt: number },
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db.all<{ state: AttachmentCacheState }>(sql`
      INSERT INTO attachment_cache_entries (path, bytes, last_used_at, state, attempts, next_retry_at)
      VALUES (${input.path}, ${input.bytes}, ${input.lastUsedAt}, 'active', 0, 0)
      ON CONFLICT(path) DO UPDATE SET
        bytes = CASE
          WHEN excluded.last_used_at >= attachment_cache_entries.last_used_at THEN excluded.bytes
          ELSE attachment_cache_entries.bytes
        END,
        last_used_at = MAX(attachment_cache_entries.last_used_at, excluded.last_used_at)
      WHERE attachment_cache_entries.state = 'active'
      RETURNING state
    `);
    return rows[0]?.state === 'active';
  });
}

export function listChats(db: Queryable, opts: { includeArchived?: boolean } = {}) {
  const visible = chatVisible('chats');
  return db
    .select()
    .from(chats)
    .where(opts.includeArchived ? visible : and(eq(chats.isArchived, false), visible))
    .orderBy(sql`${chats.latestMessageDate} DESC NULLS LAST`);
}

export function listMessages(db: Queryable, chatId: number, limit = 100) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(sql`${messages.dateCreated} DESC`)
    .limit(limit);
}

/** Local full-text search over visible, non-deleted messages (the FTS index keeps tombstones). */
export async function searchMessages(
  db: Queryable,
  queryText: string,
  limit = 50,
): Promise<Array<Record<string, unknown>>> {
  const match = toFtsQuery(queryText);
  if (!match) return [];
  return db.all<Record<string, unknown>>(
    sql`SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
        WHERE messages_fts MATCH ${match}
          AND ${notAnOverlayMessage()}
          AND ${messageHasVisibleContentSql('m')}
          AND m.date_deleted IS NULL
        ORDER BY rank LIMIT ${limit}`,
  );
}

export async function listOrphanedAttachmentGuids(
  db: Queryable,
  guids: string[],
): Promise<string[]> {
  if (guids.length === 0) return [];
  const surviving = new Set<string>();
  for (let i = 0; i < guids.length; i += 400) {
    const inList = sql.join(
      guids.slice(i, i + 400).map((g) => sql`${g}`),
      sql`, `,
    );
    const rows: Array<{ guid: string }> = await db.all(
      sql`SELECT guid FROM attachments WHERE guid IN (${inList})`,
    );
    for (const r of rows) surviving.add(r.guid);
  }
  return guids.filter((g) => !surviving.has(g));
}

/** Move one pending scheduled row to `sending` (production claims due rows with claimDueScheduled). */
export function claimScheduled(
  db: ReadDb,
  id: number,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    async (db) => {
      const rows = await db
        .update(scheduledMessages)
        .set({ status: 'sending' })
        .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'pending')))
        .returning({ id: scheduledMessages.id });
      return rows.length > 0;
    },
    commitGuard,
  );
}

export function revertLocalUnsend(
  db: ReadDb,
  guid: string,
  appliedAt: number,
  previousDateRetracted?: number | null,
  previousRetractionState?: string | null,
  previousPendingRetractionPartIndex?: number | null,
  expectedAppliedPartIndex?: number,
): Promise<boolean> {
  return withDbTransaction(db, (db, context) =>
    revertLocalUnsendWithinTransaction(
      context,
      guid,
      appliedAt,
      previousDateRetracted,
      previousRetractionState,
      previousPendingRetractionPartIndex,
      expectedAppliedPartIndex,
    ),
  );
}

export async function applyServerSendError(
  db: ReadDb,
  guid: string,
  errorCode = 1,
  now: number = Date.now(),
  retryable = false,
  requeueScope: string | number = 'process',
  errorMessage?: string | null,
  attemptIdentity?: ServerSendAttemptIdentity,
): Promise<boolean> {
  const result = await withDbTransaction(db, (db, context) =>
    applyServerSendErrorWithinTransaction(
      context,
      guid,
      errorCode,
      now,
      retryable,
      requeueScope,
      errorMessage,
      attemptIdentity,
    ),
  );
  result.onCommitted?.();
  return result.matched;
}

export function updateReminderTime(
  db: ReadDb,
  id: number,
  scheduledFor: number,
  notificationId: string,
  commitGuard?: DbCommitGuard,
  expectedNotificationId?: string,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (db, context) =>
      updateReminderTimeWithinTransaction(
        context,
        id,
        scheduledFor,
        notificationId,
        expectedNotificationId,
      ),
    commitGuard,
  );
}

export async function setUrlPreview(
  db: ReadDb,
  url: string,
  data: Parameters<typeof setUrlPreviewWithinTransaction>[2],
  now: number,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (db, context) => setUrlPreviewWithinTransaction(context, url, data, now),
    commitGuard,
  );
}

export async function setChatCustomization(
  db: ReadDb,
  guid: string,
  patch: Parameters<typeof setChatCustomizationWithinTransaction>[2],
): Promise<void> {
  await withDbTransaction(db, (db, context) =>
    setChatCustomizationWithinTransaction(context, guid, patch),
  );
}

export async function setChatTheme(
  db: ReadDb,
  guid: string,
  patch: Pick<ChatAppearancePatch, 'themeTokens' | 'backgroundUri'>,
): Promise<void> {
  await withDbTransaction(db, (db, context) =>
    setChatAppearanceWithinTransaction(context, guid, patch),
  );
}

export async function setBackgroundIsLight(
  db: ReadDb,
  guid: string,
  isLight: boolean | null,
): Promise<void> {
  await withDbTransaction(db, (db, context) =>
    setChatAppearanceWithinTransaction(context, guid, { backgroundIsLight: isLight }),
  );
}

/** Insert one optimistic outgoing attachment in its own transaction (services compose the body). */
export function insertOutgoingAttachment(db: ReadDb, args: InsertOutgoingAttachmentArgs) {
  return withDbTransaction(db, (db, context) =>
    insertOutgoingAttachmentWithinTransaction(context, args),
  );
}
