import {
  createCustomFolderWithinTransaction,
  collectCustomFolderMessageMatches,
  deleteCustomFolderWithinTransaction,
  listCustomFolderChatGuidsWithinTransaction,
  listCustomFolderInboxPageWithinTransaction,
  listCustomFolderSummariesWithinTransaction,
  listCustomFoldersWithinTransaction,
  readCustomFolderMessageMatchBatchWithinTransaction,
  renameCustomFolderWithinTransaction,
  reorderCustomFoldersWithinTransaction,
  replaceCustomFolderMembershipWithinTransaction,
  setCustomFolderShowUnreadBadgeWithinTransaction,
  type CustomFolderInboxPage,
  type CustomFolderListRow,
  type CustomFolderRow,
  type CustomFolderSummaryRow,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { ensureDatabase } from './databaseControl';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import { assertAccountOperationCurrent, runAccountOperation } from './realtime/accountOperation';

export {
  CustomFolderMembershipLimitError,
  MAX_CUSTOM_FOLDER_MEMBERSHIPS_TOTAL,
} from '@db/repositories';

export type CustomFolderCommandResult<T> =
  { readonly status: 'committed'; readonly value: T } | { readonly status: 'stale' };

/** Admit one short folder read/write under the Disconnect teardown barrier. */
async function runCustomFolderCommand<T>(
  lease: RealtimeDeliveryLease,
  command: (activeLease: RealtimeDeliveryLease) => Promise<T>,
): Promise<CustomFolderCommandResult<T>> {
  const result = await runAccountOperation(lease, command);
  return result.ok ? { status: 'committed', value: result.value } : { status: 'stale' };
}

/** Read all ordered folders for the mounted account. */
export function loadCustomFolders(
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CustomFolderCommandResult<CustomFolderListRow[]>> {
  return runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    return withDbTransaction(
      db,
      (context) => listCustomFoldersWithinTransaction(context),
      () => activeLease.isCurrent(),
    );
  });
}

/** Read live manager-only unread summaries for the mounted account. */
export function loadCustomFolderSummaries(
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CustomFolderCommandResult<CustomFolderSummaryRow[]>> {
  return runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    return withDbTransaction(
      db,
      (context) => listCustomFolderSummariesWithinTransaction(context),
      () => activeLease.isCurrent(),
    );
  });
}

/** Read stable chat identities for one folder, including chats temporarily absent during repair. */
export function loadCustomFolderMembership(
  folderId: number,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CustomFolderCommandResult<string[]>> {
  return runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    return withDbTransaction(
      db,
      (context) => listCustomFolderChatGuidsWithinTransaction(context, folderId),
      () => activeLease.isCurrent(),
    );
  });
}

/**
 * Read one exact folder identity/count snapshot and its growing conversation prefix. The shared
 * transaction queue keeps add-before-prune membership replacement invisible to this UI read.
 *
 * A search first reads its message matches in short batches (review M060), so a broad search never
 * holds the database for the whole message history; the page itself is then one short snapshot.
 * `isRequestCurrent` turns false once a newer search or page request replaced this one, which stops
 * the batches early and reports `stale`.
 */
export async function loadCustomFolderInboxPage(
  folderId: number,
  limit: number,
  searchText = '',
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  isRequestCurrent: () => boolean = () => true,
): Promise<CustomFolderCommandResult<CustomFolderInboxPage | null>> {
  let replaced = false;
  const result = await runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    const messageMatches =
      searchText === ''
        ? undefined
        : await collectCustomFolderMessageMatches(
            (beforeRowid) =>
              withDbTransaction(
                db,
                (context) =>
                  readCustomFolderMessageMatchBatchWithinTransaction(
                    context,
                    folderId,
                    searchText,
                    beforeRowid,
                  ),
                () => activeLease.isCurrent(),
              ),
            () => activeLease.isCurrent() && isRequestCurrent(),
          );
    if (messageMatches === null) {
      replaced = true;
      return null;
    }
    assertAccountOperationCurrent(activeLease);
    return withDbTransaction(
      db,
      (context) =>
        listCustomFolderInboxPageWithinTransaction(
          context,
          folderId,
          limit,
          searchText,
          messageMatches,
        ),
      () => activeLease.isCurrent(),
    );
  });
  return replaced ? { status: 'stale' } : result;
}

export function createCustomFolder(
  name: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CustomFolderCommandResult<CustomFolderRow>> {
  return runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    return withDbTransaction(
      db,
      (context) => createCustomFolderWithinTransaction(context, name),
      () => activeLease.isCurrent(),
    );
  });
}

export function renameCustomFolder(
  folderId: number,
  name: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CustomFolderCommandResult<boolean>> {
  return runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    return withDbTransaction(
      db,
      (context) => renameCustomFolderWithinTransaction(context, folderId, name),
      () => activeLease.isCurrent(),
    );
  });
}

/** Persist one folder's presentation-only unread badge preference. */
export function setCustomFolderShowUnreadBadge(
  folderId: number,
  showUnreadBadge: boolean,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CustomFolderCommandResult<boolean>> {
  return runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    return withDbTransaction(
      db,
      (context) =>
        setCustomFolderShowUnreadBadgeWithinTransaction(context, folderId, showUnreadBadge),
      () => activeLease.isCurrent(),
    );
  });
}

export function deleteCustomFolder(
  folderId: number,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CustomFolderCommandResult<boolean>> {
  return runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    return withDbTransaction(
      db,
      (context) => deleteCustomFolderWithinTransaction(context, folderId),
      () => activeLease.isCurrent(),
    );
  });
}

export function reorderCustomFolders(
  folderIds: readonly number[],
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CustomFolderCommandResult<boolean>> {
  const snapshot = [...folderIds];
  return runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    return withDbTransaction(
      db,
      (context) => reorderCustomFoldersWithinTransaction(context, snapshot),
      () => activeLease.isCurrent(),
    );
  });
}

export function replaceCustomFolderMembership(
  folderId: number,
  chatGuids: readonly string[],
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CustomFolderCommandResult<boolean>> {
  const snapshot = [...chatGuids];
  return runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    // Membership is local state keyed by exact chat guid, so an RCS chat from any Google pairing can
    // join or leave a folder. A false result therefore means only that the folder no longer exists.
    return withDbTransaction(
      db,
      (context) => replaceCustomFolderMembershipWithinTransaction(context, folderId, snapshot),
      () => activeLease.isCurrent(),
    );
  });
}
