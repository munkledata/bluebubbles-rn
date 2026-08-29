import {
  createCustomFolderWithinTransaction,
  deleteCustomFolderWithinTransaction,
  listCustomFolderChatGuidsWithinTransaction,
  listCustomFolderInboxPageWithinTransaction,
  listCustomFoldersWithinTransaction,
  renameCustomFolderWithinTransaction,
  reorderCustomFoldersWithinTransaction,
  replaceCustomFolderMembershipWithinTransaction,
  type CustomFolderInboxPage,
  type CustomFolderRow,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { ensureDatabase } from './databaseControl';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';

/** Private rollback/control-flow signal for a folder command whose account is being retired. */
const STALE_CUSTOM_FOLDER_COMMAND = Symbol('stale-custom-folder-command');

export type CustomFolderCommandResult<T> =
  { readonly status: 'committed'; readonly value: T } | { readonly status: 'stale' };

function assertCustomFolderCommandLease(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw STALE_CUSTOM_FOLDER_COMMAND;
}

/** Admit one short folder read/write under the Disconnect teardown barrier. */
async function runCustomFolderCommand<T>(
  lease: RealtimeDeliveryLease,
  command: (activeLease: RealtimeDeliveryLease) => Promise<T>,
): Promise<CustomFolderCommandResult<T>> {
  let value: T | undefined;
  let completed = false;
  try {
    const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
      assertCustomFolderCommandLease(activeLease);
      value = await command(activeLease);
      assertCustomFolderCommandLease(activeLease);
      completed = true;
    });
    if (status === 'paused' || !completed || !lease.isCurrent()) return { status: 'stale' };
    return { status: 'committed', value: value as T };
  } catch (error) {
    if (error === STALE_CUSTOM_FOLDER_COMMAND || !lease.isCurrent()) return { status: 'stale' };
    throw error;
  }
}

/** Read all ordered folders for the mounted account. */
export function loadCustomFolders(
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CustomFolderCommandResult<CustomFolderRow[]>> {
  return runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertCustomFolderCommandLease(activeLease);
    return withDbTransaction(
      db,
      (context) => listCustomFoldersWithinTransaction(context),
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
    assertCustomFolderCommandLease(activeLease);
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
 */
export function loadCustomFolderInboxPage(
  folderId: number,
  limit: number,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CustomFolderCommandResult<CustomFolderInboxPage | null>> {
  return runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertCustomFolderCommandLease(activeLease);
    return withDbTransaction(
      db,
      (context) => listCustomFolderInboxPageWithinTransaction(context, folderId, limit),
      () => activeLease.isCurrent(),
    );
  });
}

export function createCustomFolder(
  name: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CustomFolderCommandResult<CustomFolderRow>> {
  return runCustomFolderCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertCustomFolderCommandLease(activeLease);
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
    assertCustomFolderCommandLease(activeLease);
    return withDbTransaction(
      db,
      (context) => renameCustomFolderWithinTransaction(context, folderId, name),
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
    assertCustomFolderCommandLease(activeLease);
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
    assertCustomFolderCommandLease(activeLease);
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
    assertCustomFolderCommandLease(activeLease);
    return withDbTransaction(
      db,
      (context) => replaceCustomFolderMembershipWithinTransaction(context, folderId, snapshot),
      () => activeLease.isCurrent(),
    );
  });
}
