/**
 * Shared pieces of the send front door (moved from index.ts): the account-operation guards every
 * send and schedule runs under, the argument snapshots, the paced attachment uploader and the
 * outgoing queue I/O, plus the types the UI composes against.
 */

import { logger } from '@core/secure';
import { currentRcsProviderEpoch, isCurrentRcsChatGuid } from '@core/rcs/providerIdentity';
import {
  MessageTargetCapabilityUnknownError,
  MessageTargetUnavailableError,
} from '@db/repositories';
import { DbCommitGuardRejectedError } from '@db/transaction';
import { useSessionStore } from '@state/sessionStore';
import { isRcsChatGuid } from '@utils/chat';
import type { SendTextArgs } from './sendService';
import { ScheduledSessionChangedError } from './scheduleService';
import type { PickedImage } from './sendAttachmentService';
import type { ContactCard } from './sendContactService';
import {
  type RealtimeDeliveryLease,
  runTrackedRealtimeWork,
} from '../realtime/deliveryCoordinator';
import { runAccountOperation } from '../realtime/accountOperation';
import { expoAttachmentUploader, expoFileExists, expoFileSize } from './attachmentUpload';
import { createRcsPacedUploader } from './rcsUploadPacing';
import type { OutgoingQueueIO } from './outgoingQueueService';
import { logicalSendQueue, LogicalSendQueueCapacityError } from './logicalSendQueue';

export type SendOperationIssue = 'queue-capacity';
export type SendIssueReporter = (issue: SendOperationIssue) => void;
/** Internal, expected refusal when a retained callback outlives its required server capability. */
export class SendCapabilityUnavailableError extends Error {
  constructor() {
    super('This messaging feature is unavailable.');
    this.name = 'SendCapabilityUnavailableError';
  }
}
export function snapshotPickedImage(image: PickedImage): PickedImage {
  return { ...image };
}
export function snapshotContactCard(contact: ContactCard): ContactCard {
  return {
    ...contact,
    phones: contact.phones?.map((phone) => ({ ...phone })),
    emails: contact.emails?.map((email) => ({ ...email })),
  };
}
export function snapshotSendTextArgs(args: SendTextArgs): SendTextArgs {
  return {
    ...args,
    mentions: args.mentions?.map((mention) => ({ ...mention })),
  };
}
/**
 * Composer preflight for one synchronous submit turn. The composer checks the whole attachment +
 * text submission before it clears the authored draft, then immediately calls the send front
 * doors, whose queue admission is synchronous.
 */
export function hasLogicalSendCapacity(logicalSendCount = 1): boolean {
  return logicalSendQueue.canRetain(logicalSendCount);
}
export function assertScheduledLease(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw new ScheduledSessionChangedError();
}
export function captureScheduledChatMutationGuard(chatGuid: string): () => boolean {
  if (!isRcsChatGuid(chatGuid)) return () => true;
  const providerEpoch = currentRcsProviderEpoch(useSessionStore.getState().serverInfo);
  if (
    providerEpoch == null ||
    !isCurrentRcsChatGuid(useSessionStore.getState().serverInfo, chatGuid)
  ) {
    throw new Error('This scheduled RCS message belongs to a previous Google pairing.');
  }
  return () =>
    currentRcsProviderEpoch(useSessionStore.getState().serverInfo) === providerEpoch &&
    isCurrentRcsChatGuid(useSessionStore.getState().serverInfo, chatGuid);
}
export function assertScheduledMutationCurrent(
  lease: RealtimeDeliveryLease,
  identityIsCurrent: () => boolean,
): void {
  assertScheduledLease(lease);
  if (!identityIsCurrent()) {
    throw new Error('This scheduled RCS message belongs to a previous Google pairing.');
  }
}
/**
 * Publish one whole scheduled-message action to Disconnect's drain while retaining its real return
 * value. The coordinator intentionally returns only delivered/paused, so this tiny adapter keeps
 * the result in the admitted callback and converts a rejected admission into the same clear error
 * used by mid-flight ownership checks.
 */
export async function runScheduledAccountOperation<T>(
  lease: RealtimeDeliveryLease,
  task: () => Promise<T>,
): Promise<T> {
  let completed = false;
  let result!: T;
  const status = await runTrackedRealtimeWork(lease, async () => {
    assertScheduledLease(lease);
    try {
      result = await task();
      assertScheduledLease(lease);
      completed = true;
    } catch (error) {
      // Prefer the ownership error when the underlying await failed because Disconnect reset its
      // HTTP/native/DB dependency. Otherwise callers would report a misleading offline failure.
      assertScheduledLease(lease);
      throw error;
    }
  });
  if (status === 'paused' || !completed || !lease.isCurrent()) {
    throw new ScheduledSessionChangedError();
  }
  return result;
}
/**
 * Keep one user-initiated send/mutation visible to Disconnect from before its first await until
 * its last DB/native/network continuation settles. A stale screen callback is deliberately a
 * quiet `null`: it belongs to the retired account, so it must neither act with the next account's
 * dependencies nor surface an old-account error in the new UI.
 *
 * Unlike scheduled actions, ordinary composer/menu callbacks are fire-and-forget and have no
 * useful error UI for an account switch. Current-account failures still reject unchanged.
 */
export async function runUiAccountOperation<T>(
  lease: RealtimeDeliveryLease,
  task: () => Promise<T>,
  mode: 'immediate' | { readonly logicalSendChat: string } = 'immediate',
  reportIssue?: SendIssueReporter,
): Promise<T | null> {
  try {
    // A logical send takes its chat's ordering turn (review M089); other work runs immediately.
    const result = await runAccountOperation(lease, () =>
      mode === 'immediate' ? task() : logicalSendQueue.run(lease, mode.logicalSendChat, task),
    );
    return result.ok ? result.value : null;
  } catch (error) {
    if (
      error instanceof MessageTargetUnavailableError ||
      error instanceof MessageTargetCapabilityUnknownError ||
      error instanceof DbCommitGuardRejectedError ||
      error instanceof SendCapabilityUnavailableError
    ) {
      return null;
    }
    if (error instanceof LogicalSendQueueCapacityError) {
      try {
        reportIssue?.('queue-capacity');
      } catch (reportError) {
        logger.warn('[send] optional issue reporter failed', reportError);
      }
      return null;
    }
    throw error;
  }
}
/**
 * The production uploader for single foreground sends and queue retries: RCS files ride out the
 * server's one-at-a-time busy refusals ({@link createRcsPacedUploader}). `sendImages` gives each
 * share its own turn order instead. `sendVoice` is iMessage-only and keeps the plain uploader.
 */
export const rcsPacedAttachmentUploader = createRcsPacedUploader(expoAttachmentUploader);
/** The production attachment I/O for the outgoing queue (paced uploader + on-disk check). */
export const outgoingQueueIO: OutgoingQueueIO = {
  upload: rcsPacedAttachmentUploader,
  fileExists: expoFileExists,
};
/**
 * Some pickers report no size: gallery-tray picks in an RCS chat, RCS voice notes, and now and then
 * a camera or document pick. Measure such a file before sending. The RCS duplicate merge matches
 * the server's copy by byte size, and upload pacing and cache accounting use it too. A file that
 * cannot be read keeps size 0, as before. Pasted and shared files are sized by their own ownership
 * step, so they are left alone.
 */
export async function withMeasuredSize(
  image: PickedImage,
  lease: RealtimeDeliveryLease,
): Promise<PickedImage> {
  if (image.origin === 'paste' || image.origin === 'share') return image;
  if (Number.isSafeInteger(image.size) && image.size > 0) return image;
  const size = await expoFileSize(image.uri);
  // The account may have changed while the file was measured; send nothing for an old account.
  if (!lease.isCurrent()) throw new DbCommitGuardRejectedError();
  return size === null ? image : { ...image, size };
}
