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
import { type AppDatabase } from '@db/types';

/** Public standalone attachment ingestion. Never wrap this helper in another transaction. */
export async function upsertAttachments(
  db: AppDatabase,
  items: Array<{ att: Attachment; messageId: number }>,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (context) => upsertAttachmentsWithinTransaction(context, items),
    commitGuard,
  );
}

/** Persist a server-returned chat atomically, then apply presentation-only device-contact names. */
export async function persistServerChat(db: AppDatabase, chat: Chat): Promise<void> {
  await withDbTransaction(db, (context) => persistServerChatWithinTransaction(context, chat));
  await linkHandlesToContacts(
    db,
    (chat.participants ?? []).map((participant) => participant.address),
  );
}

/** Set a chat's local mute preference ('mute' to mute, null to clear). */
export async function setChatMute(
  db: AppDatabase,
  guid: string,
  muteType: string | null,
): Promise<void> {
  await withDbTransaction(db, (context) => setChatMuteWithinTransaction(context, guid, muteType));
}

/**
 * Pin / unpin a chat. Client-local — Gator pin is a device state, not a server
 * concept; kept out of `upsertChats`' conflict set so a re-sync can't clobber it.
 * The inbox sorts pinned chats first (see `listChatsForInbox`).
 */
export async function setChatPin(db: AppDatabase, guid: string, pinned: boolean): Promise<void> {
  await withDbTransaction(db, (context) => setChatPinWithinTransaction(context, guid, pinned));
}

/** Archive / unarchive a chat (client-local). Archived chats drop out of the main inbox. */
export async function setChatArchive(
  db: AppDatabase,
  guid: string,
  archived: boolean,
): Promise<void> {
  await withDbTransaction(db, (context) =>
    setChatArchiveWithinTransaction(context, guid, archived),
  );
}

/** Standalone un-hide. Existing domain transactions must use the explicitly scoped form above. */
export async function clearChatTombstone(db: AppDatabase, guid: string): Promise<void> {
  await withDbTransaction(db, (context) => clearChatTombstoneWithinTransaction(context, guid));
}

export async function setChatUnreadLocal(
  db: AppDatabase,
  chatGuid: string,
  now: number = Date.now(),
): Promise<void> {
  await withDbTransaction(db, (context) =>
    setChatUnreadLocalWithinTransaction(context, chatGuid, now),
  );
}

export async function markAllChatsReadLocal(db: AppDatabase): Promise<void> {
  await withDbTransaction(db, (context) => markAllChatsReadLocalWithinTransaction(context));
}

/**
 * Write a server-sourced avatar uri onto a handle (only the photo — not display_name /
 * contact_id, which stay device-contact-owned). Used by the server-avatar backfill for
 * handles a device contact didn't supply a photo for. `expectedAvatar` defaults to null for a new
 * fill; revalidation may instead replace or clear one exact app-owned path. The compare-and-swap
 * is checked again after the download, so a device-contact photo that arrived meanwhile wins.
 */
export async function setHandleServerAvatar(
  db: AppDatabase,
  handleId: number,
  uri: string,
): Promise<boolean> {
  return withDbTransaction(db, (context) =>
    setHandleServerAvatarWithinTransaction(context, handleId, uri),
  );
}

/** Consistency-sensitive read: queue behind mutations so partial reorder/replacement is invisible. */
export function listCustomFolders(
  db: AppDatabase,
  commitGuard?: DbCommitGuard,
): Promise<CustomFolderListRow[]> {
  return withDbTransaction(
    db,
    (context) => listCustomFoldersWithinTransaction(context),
    commitGuard,
  );
}

/** Consistency-sensitive read: queue behind add-before-prune membership replacement. */
export function listCustomFolderChatGuids(
  db: AppDatabase,
  folderId: number,
  commitGuard?: DbCommitGuard,
): Promise<string[]> {
  return withDbTransaction(
    db,
    (context) => listCustomFolderChatGuidsWithinTransaction(context, folderId),
    commitGuard,
  );
}

export function createCustomFolder(
  db: AppDatabase,
  name: string,
  commitGuard?: DbCommitGuard,
): Promise<CustomFolderRow> {
  return withDbTransaction(
    db,
    (context) => createCustomFolderWithinTransaction(context, name),
    commitGuard,
  );
}

export function renameCustomFolder(
  db: AppDatabase,
  folderId: number,
  name: string,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) => renameCustomFolderWithinTransaction(context, folderId, name),
    commitGuard,
  );
}

export function setCustomFolderShowUnreadBadge(
  db: AppDatabase,
  folderId: number,
  showUnreadBadge: boolean,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) =>
      setCustomFolderShowUnreadBadgeWithinTransaction(context, folderId, showUnreadBadge),
    commitGuard,
  );
}

export function deleteCustomFolder(
  db: AppDatabase,
  folderId: number,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) => deleteCustomFolderWithinTransaction(context, folderId),
    commitGuard,
  );
}

export function reorderCustomFolders(
  db: AppDatabase,
  ids: readonly number[],
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) => reorderCustomFoldersWithinTransaction(context, ids),
    commitGuard,
  );
}

export function replaceCustomFolderMembership(
  db: AppDatabase,
  folderId: number,
  chatGuids: readonly string[],
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) => replaceCustomFolderMembershipWithinTransaction(context, folderId, chatGuids),
    commitGuard,
  );
}

/** Standalone key/value upsert. Callers already inside a transaction must use the scoped form. */
export async function kvSet(db: AppDatabase, key: string, value: string): Promise<void> {
  await withDbTransaction(db, (context) => kvSetWithinTransaction(context, key, value));
}

/**
 * Record one user-requested local deletion in its own standalone transaction. Callers that already own
 * the transaction must use {@link deleteMessageLocalWithinTransaction} instead of nesting this
 * wrapper.
 */
export async function deleteMessageLocal(
  db: AppDatabase,
  guid: string,
  now: number,
): Promise<DeleteMessageLocalResult> {
  return withDbTransaction(db, (context) =>
    deleteMessageLocalWithinTransaction(context, guid, now),
  );
}

/** Standalone optimistic-edit owner; composing services use the transaction-only body. */
export async function applyLocalEdit(
  db: AppDatabase,
  guid: string,
  newText: string,
  now: number,
): Promise<LocalEditSnapshot | null> {
  return withDbTransaction(db, (context) =>
    applyLocalEditWithinTransaction(context, guid, newText, now),
  );
}

/** Standalone optimistic-unsend owner; composing services use the transaction-only body. */
export async function applyLocalUnsend(
  db: AppDatabase,
  guid: string,
  now: number,
  partIndex: number = 0,
): Promise<LocalUnsendSnapshot | null> {
  return withDbTransaction(db, (context) =>
    applyLocalUnsendWithinTransaction(context, guid, now, partIndex),
  );
}

/** Standalone optimistic contact-card owner; composing services use the transaction-only body. */
export async function insertOutgoingContact(
  db: AppDatabase,
  args: InsertOutgoingContactArgs,
): Promise<OutgoingInsertResult> {
  // ONE transaction — see the insert-atomicity note above insertOutgoingText.
  return withDbTransaction(db, (context) => insertOutgoingContactWithinTransaction(context, args));
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
  db: AppDatabase,
  tempGuid: string,
  commitGuard?: DbCommitGuard,
  settlement?: OutgoingAttemptSettlement,
): Promise<OutgoingAckDisposition> {
  return withDbTransaction(
    db,
    (context) => markOutgoingSentNoGuidWithinTransaction(context, tempGuid, settlement),
    commitGuard,
  );
}

/** Standalone owner for exact capable-RCS success reconciliation. */
export function reconcileExactOutgoingAttemptSuccess(
  db: AppDatabase,
  success: ExactOutgoingAttemptSuccess,
  commitGuard?: DbCommitGuard,
): Promise<ExactOutgoingAttemptSuccessDisposition> {
  return withDbTransaction(
    db,
    (context) => reconcileExactOutgoingAttemptSuccessWithinTransaction(context, success),
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
  db: AppDatabase,
  tempGuid: string,
  errorCode = 1,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (context) => retireOutgoingWithinTransaction(context, tempGuid, errorCode),
    commitGuard,
  );
}

/** Standalone server-pushed send-error owner. */
export async function markMessageSendError(
  db: AppDatabase,
  guid: string,
  errorCode = 1,
  commitGuard?: DbCommitGuard,
  errorMessage?: string | null,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) => markMessageSendErrorWithinTransaction(context, guid, errorCode, errorMessage),
    commitGuard,
  );
}

/**
 * Standalone automatic-claim owner retained for repository and DEV callers. Production services
 * that compose this write use {@link claimOutgoingForSendWithinTransaction} inside their own short
 * guarded owner instead of nesting this wrapper.
 */
export async function claimOutgoingForSend(
  db: AppDatabase,
  id: number,
  clock: () => number,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  const result = await withDbTransaction(
    db,
    (context) => claimOutgoingForSendWithinTransaction(context, id, clock),
    commitGuard,
  );
  return result.claimed;
}

/** Standalone reminder-creation owner; composing services use the transaction-only body. */
export async function createReminder(
  db: AppDatabase,
  r: CreateReminderArgs,
  commitGuard?: DbCommitGuard,
): Promise<number> {
  return withDbTransaction(
    db,
    (context) => createReminderWithinTransaction(context, r),
    commitGuard,
  );
}

export async function deleteReminder(
  db: AppDatabase,
  id: number,
  commitGuard?: DbCommitGuard,
  expectedNotificationId?: string,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) => deleteReminderWithinTransaction(context, id, expectedNotificationId),
    commitGuard,
  );
}

export async function insertScheduled(db: AppDatabase, args: InsertScheduledArgs): Promise<number> {
  return withDbTransaction(db, (context) => insertScheduledWithinTransaction(context, args));
}

export function updateScheduled(
  db: AppDatabase,
  id: number,
  patch: UpdateScheduledPatch,
  expected?: Omit<ScheduledOccurrence, 'id'>,
): Promise<ScheduledEditResult> {
  return withDbTransaction(db, (context) =>
    updateScheduledWithinTransaction(context, id, patch, expected),
  );
}

/** Delete a COMPLETED (sent/error/uncertain) row from the local history list. */
export async function deleteScheduledHistory(db: AppDatabase, id: number): Promise<void> {
  await withDbTransaction(db, (context) => deleteScheduledHistoryWithinTransaction(context, id));
}

export async function deleteScheduled(db: AppDatabase, id: number): Promise<void> {
  await withDbTransaction(db, (context) => deleteScheduledWithinTransaction(context, id));
}

export async function prepareShareIntakeNewChatPlan(
  db: AppDatabase,
  identity: ShareIntakeManifestIdentity,
  plan: ShareIntakeNewChatPlan,
): Promise<ShareIntakeNewChatPlan> {
  return withDbTransaction(db, (context) =>
    prepareShareIntakeNewChatPlanWithinTransaction(context, identity, plan),
  );
}

/** Standalone sync-marker owner. Existing transaction owners use the context-only form above. */
export async function setSyncMarker(
  db: AppDatabase,
  marker: SyncMarker,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  return withDbTransaction(
    db,
    (context) => setSyncMarkerWithinTransaction(context, marker),
    commitGuard,
  );
}

/** Public standalone create. Never wrap this helper in another transaction. */
export async function createCustomTheme(
  db: AppDatabase,
  theme: { name: string; mode: string; tokens: string },
): Promise<number> {
  return withDbTransaction(db, (context) => createCustomThemeWithinTransaction(context, theme));
}

/** Public standalone update. Never wrap this helper in another transaction. */
export async function updateCustomTheme(
  db: AppDatabase,
  id: number,
  patch: { name: string; mode: string; tokens: string },
): Promise<void> {
  await withDbTransaction(db, (context) => updateCustomThemeWithinTransaction(context, id, patch));
}

/** Public standalone delete. Never wrap this helper in another transaction. */
export async function deleteCustomTheme(db: AppDatabase, id: number): Promise<void> {
  await withDbTransaction(db, (context) => deleteCustomThemeWithinTransaction(context, id));
}
