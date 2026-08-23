import { chatsApi } from '@core/api';
import type { Chat } from '@core/models';
import { logger } from '@core/secure';
import { linkHandlesToContacts, persistServerChatWithinTransaction } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { http } from '../clients';
import { deleteChat } from '../chatActions';
import { ensureDatabase } from '../databaseControl';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { removeGroupIcon, uploadGroupIcon } from './groupIcon';

/** Private signal used to turn an account transition into a quiet, expected cancellation. */
const STALE_GROUP_ACTION = Symbol('stale-group-action');

function assertCurrent(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw STALE_GROUP_ACTION;
}

/**
 * Keep a group mutation attached to the account whose screen started it.
 *
 * The tracking slot is published before the first network/native await. Disconnect therefore
 * either waits for the operation and wipes its result, or keeps the next account blocked until a
 * retry can prove cleanup completed. A callback retained by a confirmation dialog also carries the
 * screen's original lease, so pressing it after reconnect cannot start a request with new creds.
 */
async function runGroupAction(
  lease: RealtimeDeliveryLease,
  action: (lease: RealtimeDeliveryLease) => Promise<void>,
): Promise<boolean> {
  let completed = false;
  try {
    const result = await runTrackedRealtimeWork(lease, async (trackedLease) => {
      assertCurrent(trackedLease);
      await action(trackedLease);
      assertCurrent(trackedLease);
      completed = true;
    });
    return result === 'delivered' && completed && lease.isCurrent();
  } catch (error) {
    // Old-account work should disappear quietly instead of showing its error in the new account.
    if (error === STALE_GROUP_ACTION || !lease.isCurrent()) return false;
    throw error;
  }
}

/** Commit the server's updated group snapshot atomically and only for its originating account. */
async function persistReturnedChat(chat: Chat, lease: RealtimeDeliveryLease): Promise<void> {
  assertCurrent(lease);
  const db = await ensureDatabase();
  assertCurrent(lease);
  await withDbTransaction(
    db,
    async (context) => {
      assertCurrent(lease);
      await persistServerChatWithinTransaction(context, chat);
      assertCurrent(lease);
    },
    () => lease.isCurrent(),
  );
  assertCurrent(lease);
  try {
    await linkHandlesToContacts(
      db,
      (chat.participants ?? []).map((participant) => participant.address),
      undefined,
      () => lease.isCurrent(),
    );
  } catch (error) {
    if (!lease.isCurrent()) throw STALE_GROUP_ACTION;
    logger.debug('[groups] post-commit contact linking skipped', error);
  }
  assertCurrent(lease);
}

export function renameGroupChat(
  chatGuid: string,
  displayName: string,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<boolean> {
  return runGroupAction(lease, async (activeLease) => {
    const chat = await chatsApi.renameChat(http, chatGuid, displayName);
    assertCurrent(activeLease);
    await persistReturnedChat(chat, activeLease);
  });
}

export function updateGroupParticipant(
  chatGuid: string,
  operation: 'add' | 'remove',
  address: string,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<boolean> {
  return runGroupAction(lease, async (activeLease) => {
    const chat = await chatsApi.updateParticipant(http, chatGuid, operation, address);
    assertCurrent(activeLease);
    await persistReturnedChat(chat, activeLease);
  });
}

export function leaveGroupChat(
  chatGuid: string,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<boolean> {
  return runGroupAction(lease, async (activeLease) => {
    await chatsApi.leaveChat(http, chatGuid);
    assertCurrent(activeLease);
    await deleteChat(chatGuid, activeLease);
  });
}

export function setGroupPhoto(
  chatGuid: string,
  file: { uri: string; name: string; mimeType: string },
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<boolean> {
  return runGroupAction(lease, async (activeLease) => {
    await uploadGroupIcon(http, chatGuid, file);
    assertCurrent(activeLease);
  });
}

export function clearGroupPhoto(
  chatGuid: string,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<boolean> {
  return runGroupAction(lease, async (activeLease) => {
    await removeGroupIcon(http, chatGuid);
    assertCurrent(activeLease);
  });
}
