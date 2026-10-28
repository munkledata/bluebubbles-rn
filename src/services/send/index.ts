import * as scheduledApi from '@core/api/endpoints/scheduled';
import { ApiError } from '@core/api/errors';
import {
  MAX_IMESSAGE_SCHEDULED_ATTACHMENT_BYTES,
  isSupportedImessageAttachmentType,
} from '@core/models/serverInfo';
import { logger } from '@core/secure';
import {
  currentRcsProviderEpoch,
  isCurrentRcsChatGuid,
  isCurrentRcsMessageGuid,
} from '@core/rcs/providerIdentity';
import { getDatabase } from '@db/database';
import {
  claimFailedOutgoingForRetryWithinTransaction,
  countOutgoingQueueHealth,
  deleteMessageLocalWithinTransaction,
  deleteScheduledHistoryWithinTransaction,
  cancelPendingScheduledWithinTransaction,
  discardOutgoingMessageWithinTransaction,
  getOutgoingRetryChatGuid,
  getScheduledById,
  imessagePlainTextQueueState,
  listServerScheduledPruneExposure,
  MessageTargetCapabilityUnknownError,
  MessageTargetUnavailableError,
  reconcileOutgoingError,
  reconcileServerScheduled,
  resolveServerSendErrorOwnersWithinTransaction,
  updateScheduledWithinTransaction,
  type UpdateScheduledPatch,
  type ShareIntakeManifestIdentity,
  type ScheduledCancellationTarget,
  type ScheduledOccurrence,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import { useSessionStore } from '@state/sessionStore';
import { isRcsChatGuid } from '@utils/chat';
import { accountHttp } from '../clients';
import { sendTextMessage, type SendTextArgs } from './sendService';
import {
  sendIMessageReactionMessage,
  sendReactionMessage,
  type SendReactionArgs,
} from './sendReactionService';
import {
  checkUnconfirmedUnsend,
  sendEdit,
  sendUnsend,
  type CheckUnsendResult,
  type SendEditResult,
  type SendUnsendResult,
} from './sendEditService';
import {
  runDueScheduled,
  scheduleTextMessage,
  scheduleAttachmentMessage,
  ScheduledSessionChangedError,
  type ScheduleArgs,
  type ScheduleAttachmentArgs,
} from './scheduleService';
import {
  RcsAttachmentTooLargeError,
  sendImageMessage,
  UnsendableAttachmentNameError,
  type AttachmentTextService,
  type PickedImage,
} from './sendAttachmentService';
import { sendContactMessage, hasContactContent, type ContactCard } from './sendContactService';
import {
  sendCurrentLocationMessage,
  type CurrentLocationCoordinates as SendLocationCoordinates,
} from './sendLocationService';
import {
  sendIMessageEffect,
  type SendEffectArgs,
  type SendEffectResult,
} from './sendEffectService';
import {
  sendIMessageMention,
  type SendMentionArgs,
  type SendMentionResult,
} from './sendMentionService';
import {
  sendIMessageFormatted,
  type SendFormattedArgs,
  type SendFormattedResult,
} from './sendFormattedService';
import { pickContact } from '../contacts/contactsService';
import { acquireCurrentLocation, type CurrentLocationOutcome } from '../location/currentLocation';
import { getExpoLocationAdapter } from '../location/expoLocationAdapter';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { runAccountOperation } from '../realtime/accountOperation';
import { expoAttachmentUploader, expoFileExists, expoFileSize } from './attachmentUpload';
import { createRcsPacedUploader, createRcsShareUploader } from './rcsUploadPacing';
import { uploadRegistry } from './uploadControl';
import { resendOutgoingRow, runOutgoingQueue, type OutgoingQueueIO } from './outgoingQueueService';
import { createAttachmentCacheAccountScope } from '../download/attachmentCacheAccountScope';
import { attachmentCacheCoordinator } from '../download/attachmentCacheCoordinator';
import { isAttachmentCacheRecoveryReady } from '../download/attachmentCacheRecovery';
import { logicalSendQueue, LogicalSendQueueCapacityError } from './logicalSendQueue';
import { clearFailedSendNotice } from './sendFailureNotice';
import { createOutgoingPasteOwnershipPreparer } from './outgoingPasteOwnership';
import {
  captureSessionRcsCapabilityLease,
  messageTargetCommitGuard,
  messageTargetServerAuthorization,
} from './rcsAttemptCapability';

export { isContactsPermissionDeniedError } from '../contacts/contactsService';
export { runOutgoingQueue, type OutgoingQueueIO } from './outgoingQueueService';

export type SendOperationIssue = 'queue-capacity';
export type SendIssueReporter = (issue: SendOperationIssue) => void;
/** UI handoff fired only after the optimistic row and outgoing queue row are durable. */
export type SendQueuedObserver = (tempGuid: string) => void;
export type ShareCurrentLocationResult =
  | CurrentLocationOutcome
  | { readonly status: 'unavailable' }
  | { readonly status: 'queued'; readonly tempGuid: string };
export interface ForegroundLocationLifecycle {
  /** Unknown/native-transition states fail closed until the app is active again. */
  isActive(): boolean;
  /** Subscribe only for the pre-fix permission/watch lifetime. */
  subscribeToInactive(listener: () => void): () => void;
}
export interface ShareCurrentLocationOptions {
  /** Required AppState owner injected by the confirming screen. */
  readonly foregroundLifecycle: ForegroundLocationLifecycle;
  readonly accountLease?: RealtimeDeliveryLease;
  readonly reportIssue?: SendIssueReporter;
  readonly onQueued?: SendQueuedObserver;
}
export interface AttachmentQueueAdmission {
  /** Stable source identity captured before the async send starts. */
  uri: string;
  /** True only after this attachment's optimistic message + queue transaction committed. */
  queued: boolean;
  tempGuid?: string;
  /**
   * Why an attachment was not queued, when the person can fix it ('file-name': rename it;
   * 'too-large': over the RCS size limit, remove it).
   */
  reason?: 'file-name' | 'too-large';
}
export type AttachmentQueueAdmissionObserver = (admission: AttachmentQueueAdmission) => void;

export type ManualRetryResult =
  | 'retried'
  | 'already-sending'
  | 'already-settled'
  | 'unretryable'
  | 'unsendable'
  | 'failed'
  | 'stale';

export type DiscardMessageResult = 'discarded' | 'message-changed' | 'stale';

/** Internal, expected refusal when a retained callback outlives its required server capability. */
class SendCapabilityUnavailableError extends Error {
  constructor() {
    super('This messaging feature is unavailable.');
    this.name = 'SendCapabilityUnavailableError';
  }
}

/** Development sender injected into the scheduled runner instead of the real HTTP send path. */
export type ScheduledDevelopmentSender = (
  chatGuid: string,
  text: string,
  selectedMessageGuid: string | undefined,
  onQueued: () => Promise<void>,
  selectedMessagePartIndex?: number,
) => Promise<void>;

function snapshotPickedImage(image: PickedImage): PickedImage {
  return { ...image };
}

function snapshotContactCard(contact: ContactCard): ContactCard {
  return {
    ...contact,
    phones: contact.phones?.map((phone) => ({ ...phone })),
    emails: contact.emails?.map((email) => ({ ...email })),
  };
}

function snapshotSendTextArgs(args: SendTextArgs): SendTextArgs {
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

function assertScheduledLease(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw new ScheduledSessionChangedError();
}

function captureScheduledChatMutationGuard(chatGuid: string): () => boolean {
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

function assertScheduledMutationCurrent(
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
async function runScheduledAccountOperation<T>(
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
async function runUiAccountOperation<T>(
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
const rcsPacedAttachmentUploader = createRcsPacedUploader(expoAttachmentUploader);

/** The production attachment I/O for the outgoing queue (paced uploader + on-disk check). */
export const outgoingQueueIO: OutgoingQueueIO = {
  upload: rcsPacedAttachmentUploader,
  fileExists: expoFileExists,
};

export { generateTempGuid, sendTextMessage, type SendTextArgs } from './sendService';
export {
  isSupportedImessageAttachmentFile,
  isSupportedImessageVoiceFile,
  sendImageMessage,
  type AttachmentTextService,
  type PickedImage,
} from './sendAttachmentService';
export {
  sendContactMessage,
  contactDisplayName,
  hasContactContent,
  type ContactCard,
} from './sendContactService';
export { sendReactionMessage, type SendReactionArgs } from './sendReactionService';
export {
  sendEdit,
  sendUnsend,
  type CheckUnsendResult,
  type SendEditArgs,
  type SendEditResult,
  type SendUnsendArgs,
  type SendUnsendResult,
} from './sendEditService';
export {
  sendIMessageEffect,
  type SendEffectArgs,
  type SendEffectResult,
} from './sendEffectService';
export { runDueScheduled, scheduleTextMessage, type ScheduleArgs } from './scheduleService';

/**
 * Some pickers report no size: gallery-tray picks in an RCS chat, RCS voice notes, and now and then
 * a camera or document pick. Measure such a file before sending. The RCS duplicate merge matches
 * the server's copy by byte size, and upload pacing and cache accounting use it too. A file that
 * cannot be read keeps size 0, as before. Pasted and shared files are sized by their own ownership
 * step, so they are left alone.
 */
async function withMeasuredSize(
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

/** UI-facing image send: bound to the composition-root DB + HttpClient. */
export function sendImage(
  args: {
    chatGuid: string;
    image: PickedImage;
    shareIntake?: ShareIntakeManifestIdentity;
  },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
  onQueued?: SendQueuedObserver,
): Promise<{
  tempGuid: string;
} | null> {
  const snapshot = {
    chatGuid: args.chatGuid,
    image: snapshotPickedImage(args.image),
    shareIntake: args.shareIntake,
  };
  const pasteOwnership = createOutgoingPasteOwnershipPreparer(
    createAttachmentCacheAccountScope(accountLease),
    () => isAttachmentCacheRecoveryReady(accountLease),
  );
  return runUiAccountOperation(
    accountLease,
    async () => {
      const image = await withMeasuredSize(snapshot.image, accountLease);
      const db = getDatabase();
      return sendImageMessage(
        db,
        accountHttp(accountLease),
        { ...snapshot, image },
        rcsPacedAttachmentUploader,
        Date.now(),
        () => accountLease.isCurrent(),
        undefined,
        pasteOwnership,
        (tempGuid) => {
          try {
            if (accountLease.isCurrent()) onQueued?.(tempGuid);
          } catch (error) {
            logger.warn('[send] optional queue observer failed', error);
          }
        },
        captureSessionRcsCapabilityLease(),
      );
    },
    { logicalSendChat: snapshot.chatGuid },
    reportIssue,
  );
}

/** One recorded voice note through the separately gated, one-shot iMessage file path. */
export function sendVoice(
  args: { chatGuid: string; audio: PickedImage },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
  onQueued?: SendQueuedObserver,
): Promise<{ tempGuid: string } | null> {
  const snapshot = {
    chatGuid: args.chatGuid,
    image: snapshotPickedImage(args.audio),
    service: 'iMessage' as const,
    voice: true as const,
  };
  return runUiAccountOperation(
    accountLease,
    () =>
      sendImageMessage(
        getDatabase(),
        accountHttp(accountLease),
        snapshot,
        expoAttachmentUploader,
        Date.now(),
        () => accountLease.isCurrent(),
        undefined,
        createOutgoingPasteOwnershipPreparer(createAttachmentCacheAccountScope(accountLease), () =>
          isAttachmentCacheRecoveryReady(accountLease),
        ),
        (tempGuid) => {
          try {
            if (accountLease.isCurrent()) onQueued?.(tempGuid);
          } catch (error) {
            logger.warn('[send] optional voice queue observer failed', error);
          }
        },
        captureSessionRcsCapabilityLease(),
      ),
    { logicalSendChat: snapshot.chatGuid },
    reportIssue,
  );
}

/**
 * UI-facing one-attachment + text send. Both authored pieces cross the DB handoff and every retry
 * under one temp guid; capability refusal happens before native ownership or optimistic mutation.
 */
export function sendTextAttachment(
  args: {
    chatGuid: string;
    image: PickedImage;
    text: string;
    service: AttachmentTextService;
    selectedMessageGuid?: string;
    partIndex?: number;
    shareIntake?: ShareIntakeManifestIdentity;
  },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
  onQueued?: SendQueuedObserver,
): Promise<{ tempGuid: string } | null> {
  const snapshot = {
    ...args,
    image: snapshotPickedImage(args.image),
  };
  const pasteOwnership = createOutgoingPasteOwnershipPreparer(
    createAttachmentCacheAccountScope(accountLease),
    () => isAttachmentCacheRecoveryReady(accountLease),
  );
  return runUiAccountOperation(
    accountLease,
    async () =>
      sendImageMessage(
        getDatabase(),
        accountHttp(accountLease),
        { ...snapshot, image: await withMeasuredSize(snapshot.image, accountLease) },
        rcsPacedAttachmentUploader,
        Date.now(),
        () => accountLease.isCurrent(),
        undefined,
        pasteOwnership,
        (tempGuid) => {
          try {
            if (accountLease.isCurrent()) onQueued?.(tempGuid);
          } catch (error) {
            logger.warn('[send] optional queue observer failed', error);
          }
        },
        captureSessionRcsCapabilityLease(),
      ),
    { logicalSendChat: snapshot.chatGuid },
    reportIssue,
  );
}

/** UI-facing multi-image send: one optimistic message + attachment per picked asset. */
export function sendImages(
  args: {
    chatGuid: string;
    images: PickedImage[];
    service?: AttachmentTextService;
    shareIntake?: ShareIntakeManifestIdentity;
  },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
  onAdmission?: AttachmentQueueAdmissionObserver,
): Promise<{ tempGuid: string }[] | null> {
  const snapshot = {
    chatGuid: args.chatGuid,
    images: args.images.map(snapshotPickedImage),
    service: args.service,
    shareIntake: args.shareIntake,
  };
  if (snapshot.service === 'iMessage' && snapshot.images.length !== 1) {
    return Promise.reject(new Error('Send one iMessage attachment at a time.'));
  }
  const pasteOwnership = createOutgoingPasteOwnershipPreparer(
    createAttachmentCacheAccountScope(accountLease),
    () => isAttachmentCacheRecoveryReady(accountLease),
  );
  // One multi-file share: its RCS files take turns instead of uploading at once.
  const shareUploader = createRcsShareUploader(expoAttachmentUploader);
  return runUiAccountOperation(
    accountLease,
    async () => {
      const images = await Promise.all(
        snapshot.images.map((image) => withMeasuredSize(image, accountLease)),
      );
      const db = getDatabase();
      const settled = await Promise.allSettled(
        images.map(async (image) => {
          let queued = false;
          try {
            return await sendImageMessage(
              db,
              accountHttp(accountLease),
              {
                chatGuid: snapshot.chatGuid,
                image,
                service: snapshot.service,
                shareIntake: image.origin === 'share' ? snapshot.shareIntake : undefined,
              },
              shareUploader,
              Date.now(),
              () => accountLease.isCurrent(),
              undefined,
              pasteOwnership,
              (tempGuid) => {
                queued = true;
                try {
                  if (accountLease.isCurrent()) {
                    onAdmission?.({ uri: image.uri, queued: true, tempGuid });
                  }
                } catch (error) {
                  logger.warn('[send] optional attachment admission observer failed', error);
                }
              },
              captureSessionRcsCapabilityLease(),
            );
          } catch (error) {
            if (!queued && accountLease.isCurrent()) {
              try {
                onAdmission?.({
                  uri: image.uri,
                  queued: false,
                  ...(error instanceof UnsendableAttachmentNameError
                    ? { reason: 'file-name' as const }
                    : error instanceof RcsAttachmentTooLargeError
                      ? { reason: 'too-large' as const }
                      : {}),
                });
              } catch (observerError) {
                logger.warn('[send] optional attachment admission observer failed', observerError);
              }
            }
            throw error;
          }
        }),
      );
      // Promise.all rejects as soon as ONE item fails and would release the account drain while the
      // other native uploads keep running. Wait for every operation we started, then preserve the
      // original current-account failure behavior.
      const sent: { tempGuid: string }[] = [];
      for (const outcome of settled) {
        if (outcome.status === 'rejected') throw outcome.reason;
        sent.push(outcome.value);
      }
      return sent;
    },
    { logicalSendChat: snapshot.chatGuid },
    reportIssue,
  );
}

/**
 * UI-facing plain-text send: bound to the composition-root DB + HttpClient. Replies, effects,
 * subjects and mentions need the retired private API, so the type admits only chat and text
 * (review M087).
 */
export function send(
  args: Pick<SendTextArgs, 'chatGuid' | 'text'>,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
  onQueued?: SendQueuedObserver,
): Promise<{ tempGuid: string } | null> {
  const snapshot = snapshotSendTextArgs(args);
  return runUiAccountOperation(
    accountLease,
    () => {
      const capability = captureSessionRcsCapabilityLease();
      return sendTextMessage(
        getDatabase(),
        accountHttp(accountLease),
        snapshot,
        Date.now(),
        (tempGuid) => {
          try {
            if (accountLease.isCurrent()) onQueued?.(tempGuid);
          } catch (error) {
            logger.warn('[send] optional queue observer failed', error);
          }
        },
        undefined,
        () => accountLease.isCurrent(),
        capability,
      );
    },
    { logicalSendChat: snapshot.chatGuid },
    reportIssue,
  );
}

/** UI-facing contact-card send: bound to the composition-root DB + HttpClient. */
export function sendContactCard(
  args: {
    chatGuid: string;
    contact: ContactCard;
    replyToGuid?: string;
    replyToPartIndex?: number;
  },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
  onQueued?: SendQueuedObserver,
): Promise<{
  tempGuid: string;
} | null> {
  const snapshot = {
    chatGuid: args.chatGuid,
    contact: snapshotContactCard(args.contact),
    replyToGuid: args.replyToGuid,
    replyToPartIndex: args.replyToPartIndex,
  };
  return runUiAccountOperation(
    accountLease,
    () =>
      sendContactMessage(
        getDatabase(),
        accountHttp(accountLease),
        {
          chatGuid: snapshot.chatGuid,
          contact: snapshot.contact,
          selectedMessageGuid: snapshot.replyToGuid,
          partIndex: snapshot.replyToPartIndex,
        },
        Date.now(),
        () => accountLease.isCurrent(),
        captureSessionRcsCapabilityLease(),
        (tempGuid) => {
          try {
            if (accountLease.isCurrent()) onQueued?.(tempGuid);
          } catch (error) {
            logger.warn('[send] optional queue observer failed', error);
          }
        },
      ),
    { logicalSendChat: snapshot.chatGuid },
    reportIssue,
  );
}

/**
 * UI-facing "share a contact" flow: open the native picker, then send the chosen contact as a
 * card. Returns null when the user cancels the picker or the contact has no usable field. A denied
 * Contacts grant rejects with `ContactsPermissionDeniedError` so the screen can explain recovery.
 * Kept here (not in the chat screen) so the screen depends only on the send barrel — and so the
 * expo-contacts native import stays out of the screen's module graph.
 */
export async function pickAndSendContact(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
  replyTarget?: Readonly<{ replyToGuid: string; replyToPartIndex: number }>,
  onQueued?: SendQueuedObserver,
): Promise<{ tempGuid: string } | null> {
  if (!accountLease.isCurrent()) return null;
  if (
    isRcsChatGuid(chatGuid) &&
    !isCurrentRcsChatGuid(useSessionStore.getState().serverInfo, chatGuid)
  ) {
    return null;
  }
  const targetSnapshot = replyTarget ? { ...replyTarget } : undefined;
  // The native picker may sit open for minutes, but has not touched account data yet. Keep it
  // outside the Disconnect drain, then validate the screen's PRE-picker lease before admitting the
  // actual DB/send operation. This avoids either failure mode: blocking account cleanup on an OS
  // sheet, or letting that old sheet return and capture B.
  let contact: Awaited<ReturnType<typeof pickContact>>;
  try {
    contact = await pickContact();
  } catch (error) {
    if (!accountLease.isCurrent()) return null;
    throw error;
  }
  if (!accountLease.isCurrent() || !contact || !hasContactContent(contact)) return null;
  return sendContactCard(
    {
      chatGuid,
      contact,
      replyToGuid: targetSnapshot?.replyToGuid,
      replyToPartIndex: targetSnapshot?.replyToPartIndex,
    },
    accountLease,
    reportIssue,
    onQueued,
  );
}

/**
 * Acquire one foreground fix and send it through the dedicated idempotent location operation.
 * Native permission/watch work stays outside the account drain and is cancelled by AppState or
 * generation invalidation. Foreground ownership ends at the first fix; only then is the short
 * durable queue + network operation admitted under its existing bounded replay contract.
 */
export async function acquireAndSendCurrentLocation(
  chatGuid: string,
  options: ShareCurrentLocationOptions,
): Promise<ShareCurrentLocationResult> {
  const accountLease = options.accountLease ?? captureRealtimeDeliveryLease();
  if (!accountLease.isCurrent() || !options.foregroundLifecycle.isActive()) {
    return { status: 'cancelled' };
  }
  const capability = captureSessionRcsCapabilityLease();
  if (isRcsChatGuid(chatGuid)) return { status: 'unavailable' };
  if (
    capability?.isCurrent() !== true ||
    capability.serverInfo?.supports_imessage_location !== true
  ) {
    return { status: 'unavailable' };
  }

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const unsubscribeForeground = options.foregroundLifecycle.subscribeToInactive(abort);
  accountLease.signal?.addEventListener('abort', abort, { once: true });
  const unsubscribeGeneration = subscribeRealtimeGenerationInvalidation(
    accountLease.generation,
    abort,
  );
  const unsubscribeCapability = useSessionStore.subscribe(() => {
    if (!capability.isCurrent()) abort();
  });
  // Close the check/listener race at every injected lifetime boundary.
  if (
    !options.foregroundLifecycle.isActive() ||
    accountLease.signal?.aborted ||
    !capability.isCurrent()
  ) {
    abort();
  }
  let acquisition: CurrentLocationOutcome;
  try {
    acquisition = await acquireCurrentLocation(getExpoLocationAdapter(), {
      signal: controller.signal,
    });
  } finally {
    // Foreground ownership deliberately ends at the first fix. A durable location admitted after
    // this point keeps the existing bounded idempotent/process-death retry contract.
    unsubscribeForeground();
    unsubscribeGeneration();
    unsubscribeCapability();
    accountLease.signal?.removeEventListener('abort', abort);
  }
  if (!accountLease.isCurrent()) return { status: 'cancelled' };
  if (!capability.isCurrent()) return { status: 'unavailable' };
  if (controller.signal.aborted) return { status: 'cancelled' };
  if (acquisition.status !== 'success') return acquisition;

  const coordinates: SendLocationCoordinates = {
    latitude: acquisition.location.coords.latitude,
    longitude: acquisition.location.coords.longitude,
  };
  const result = await runUiAccountOperation(
    accountLease,
    () =>
      sendCurrentLocationMessage(
        getDatabase(),
        accountHttp(accountLease),
        { chatGuid, coordinates },
        Date.now(),
        () => accountLease.isCurrent(),
        capability,
        (tempGuid) => {
          try {
            if (accountLease.isCurrent()) options.onQueued?.(tempGuid);
          } catch (error) {
            logger.warn('[send] optional queue observer failed', error);
          }
        },
      ),
    { logicalSendChat: chatGuid },
    options.reportIssue,
  );
  return result ? { status: 'queued', tempGuid: result.tempGuid } : { status: 'cancelled' };
}

/** UI-facing tapback send (toggle: pass '-love' to remove). */
export function react(
  args: SendReactionArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
): Promise<{ tempGuid: string } | { guid: string } | null> {
  const snapshot = { ...args };
  return runUiAccountOperation<{ tempGuid: string } | { guid: string }>(
    accountLease,
    () => {
      const capability = captureSessionRcsCapabilityLease();
      if (isRcsChatGuid(snapshot.chatGuid)) {
        if (
          !isCurrentRcsChatGuid(capability?.serverInfo, snapshot.chatGuid) ||
          !isCurrentRcsMessageGuid(capability?.serverInfo, snapshot.targetGuid)
        ) {
          throw new SendCapabilityUnavailableError();
        }
      } else {
        if (capability?.serverInfo?.supports_imessage_reactions !== true) {
          throw new SendCapabilityUnavailableError();
        }
      }
      const serverAuthorization = messageTargetServerAuthorization(
        capability?.serverInfo,
        () => accountLease.isCurrent() && capability?.isCurrent() === true,
      );
      if (isRcsChatGuid(snapshot.chatGuid)) {
        return sendReactionMessage(
          getDatabase(),
          accountHttp(accountLease),
          snapshot,
          Date.now(),
          () => accountLease.isCurrent(),
          serverAuthorization,
        );
      }
      return sendIMessageReactionMessage(
        getDatabase(),
        accountHttp(accountLease),
        snapshot,
        () => accountLease.isCurrent(),
        serverAuthorization,
        () =>
          accountLease.isCurrent() &&
          capability?.isCurrent() === true &&
          capability?.serverInfo?.supports_imessage_reactions === true,
      );
    },
    { logicalSendChat: snapshot.chatGuid },
    reportIssue,
  );
}

/** UI-facing threaded reply: a text send whose reply target is `replyToGuid`. */
export function reply(
  args: {
    chatGuid: string;
    text: string;
    replyToGuid: string;
    /** Part of the selected message that this reply targets. */
    replyToPartIndex: 0;
    /** Retained only to reject stale callers; effects are not part of the narrow reply command. */
    effectId?: string;
  },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
  onQueued?: SendQueuedObserver,
): Promise<{
  tempGuid: string;
} | null> {
  const snapshot = { ...args };
  return runUiAccountOperation(
    accountLease,
    () => {
      const capability = captureSessionRcsCapabilityLease();
      if (
        snapshot.effectId !== undefined ||
        snapshot.replyToPartIndex !== 0 ||
        isRcsChatGuid(snapshot.chatGuid) ||
        capability?.serverInfo?.supports_imessage_replies !== true ||
        !capability.isCurrent()
      ) {
        throw new SendCapabilityUnavailableError();
      }
      return sendTextMessage(
        getDatabase(),
        accountHttp(accountLease),
        {
          chatGuid: snapshot.chatGuid,
          text: snapshot.text,
          selectedMessageGuid: snapshot.replyToGuid,
          partIndex: 0,
        },
        Date.now(),
        (tempGuid) => {
          try {
            if (accountLease.isCurrent()) onQueued?.(tempGuid);
          } catch (error) {
            logger.warn('[send] optional queue observer failed', error);
          }
        },
        undefined,
        () => accountLease.isCurrent(),
        capability,
      );
    },
    { logicalSendChat: snapshot.chatGuid },
    reportIssue,
  );
}

/** UI-facing one-shot iMessage bubble/screen effect. Ordinary text sends stay on `send()`. */
export function sendEffect(
  args: SendEffectArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
): Promise<SendEffectResult | null> {
  const snapshot = { ...args };
  return runUiAccountOperation(
    accountLease,
    () => {
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        isRcsChatGuid(snapshot.chatGuid) ||
        capability.serverInfo?.supports_imessage_effects !== true ||
        !capability.isCurrent()
      ) {
        throw new SendCapabilityUnavailableError();
      }
      return sendIMessageEffect(
        getDatabase(),
        accountHttp(accountLease),
        snapshot,
        Date.now(),
        () => accountLease.isCurrent(),
        capability,
      );
    },
    { logicalSendChat: snapshot.chatGuid },
    reportIssue,
  );
}

/** UI-facing one-shot group message with exact Apple mention ranges. */
export function sendMention(
  args: SendMentionArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
): Promise<SendMentionResult | null> {
  const snapshot: SendMentionArgs = {
    ...args,
    mentions: args.mentions.map((mention) => ({ ...mention })),
  };
  return runUiAccountOperation(
    accountLease,
    () => {
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        !/^iMessage;\+;.+$/u.test(snapshot.chatGuid) ||
        capability.serverInfo?.supports_imessage_mentions !== true ||
        !capability.isCurrent()
      ) {
        throw new SendCapabilityUnavailableError();
      }
      return sendIMessageMention(
        getDatabase(),
        accountHttp(accountLease),
        snapshot,
        Date.now(),
        () => accountLease.isCurrent(),
        capability,
      );
    },
    { logicalSendChat: snapshot.chatGuid },
    reportIssue,
  );
}

/** UI-facing one-shot message with bounded Apple text-formatting ranges. */
export function sendFormatted(
  args: SendFormattedArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
): Promise<SendFormattedResult | null> {
  const snapshot: SendFormattedArgs = {
    ...args,
    textFormatting: args.textFormatting.map((range) => ({
      ...range,
      styles: [...range.styles],
    })),
  };
  return runUiAccountOperation(
    accountLease,
    () => {
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        !/^(?:iMessage|any);-;.+$/u.test(snapshot.chatGuid) ||
        capability.serverInfo?.supports_imessage_formatted_messages !== true ||
        !capability.isCurrent()
      ) {
        throw new SendCapabilityUnavailableError();
      }
      return sendIMessageFormatted(
        getDatabase(),
        accountHttp(accountLease),
        snapshot,
        Date.now(),
        () => accountLease.isCurrent(),
        capability,
      );
    },
    { logicalSendChat: snapshot.chatGuid },
    reportIssue,
  );
}

/** UI-facing edit of a sent message's text (optimistic + revert on failure). */
export function editText(
  args: {
    messageGuid: string;
    newText: string;
    chatGuid: string;
    partIndex: 0;
  },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<SendEditResult | null> {
  return runUiAccountOperation(accountLease, () => {
    const capability = captureSessionRcsCapabilityLease();
    if (
      isRcsChatGuid(args.chatGuid) ||
      args.partIndex !== 0 ||
      capability?.serverInfo?.supports_imessage_edit !== true ||
      !capability.isCurrent()
    ) {
      throw new SendCapabilityUnavailableError();
    }
    const serverAuthorization = messageTargetServerAuthorization(
      capability?.serverInfo,
      () =>
        accountLease.isCurrent() &&
        capability.isCurrent() &&
        capability.serverInfo?.supports_imessage_edit === true,
    );
    return sendEdit(
      getDatabase(),
      accountHttp(accountLease),
      args,
      Date.now(),
      () => accountLease.isCurrent(),
      serverAuthorization,
    );
  });
}

/** UI-facing unsend/retract of a sent message. */
export function unsend(
  args: { messageGuid: string; chatGuid: string; partIndex: 0 },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<SendUnsendResult | null> {
  return runUiAccountOperation(accountLease, () => {
    const capability = captureSessionRcsCapabilityLease();
    if (
      isRcsChatGuid(args.chatGuid) ||
      args.partIndex !== 0 ||
      capability?.serverInfo?.supports_imessage_unsend !== true ||
      !capability.isCurrent()
    ) {
      throw new SendCapabilityUnavailableError();
    }
    const serverAuthorization = messageTargetServerAuthorization(
      capability?.serverInfo,
      () =>
        accountLease.isCurrent() &&
        capability.isCurrent() &&
        capability.serverInfo?.supports_imessage_unsend === true,
    );
    return sendUnsend(
      getDatabase(),
      accountHttp(accountLease),
      args,
      Date.now(),
      () => accountLease.isCurrent(),
      serverAuthorization,
    );
  });
}

/** UI-facing: check again, and finish, your own unsend whose result was unknown. */
export function checkUnsend(
  args: { messageGuid: string; chatGuid: string },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<CheckUnsendResult | null> {
  return runUiAccountOperation(accountLease, () => {
    const capability = captureSessionRcsCapabilityLease();
    if (
      isRcsChatGuid(args.chatGuid) ||
      capability?.serverInfo?.supports_imessage_unsend !== true ||
      !capability.isCurrent()
    ) {
      throw new SendCapabilityUnavailableError();
    }
    const serverAuthorization = messageTargetServerAuthorization(
      capability?.serverInfo,
      () =>
        accountLease.isCurrent() &&
        capability.isCurrent() &&
        capability.serverInfo?.supports_imessage_unsend === true,
    );
    return checkUnconfirmedUnsend(
      getDatabase(),
      accountHttp(accountLease),
      args,
      Date.now(),
      () => accountLease.isCurrent(),
      serverAuthorization,
    );
  });
}

/** UI-facing: store a message to send later (server-side when possible). */
export function schedule(
  args: ScheduleArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{ id: number; serverId: string | null }> {
  return runScheduledAccountOperation(accountLease, () => {
    const capability = captureSessionRcsCapabilityLease();
    return scheduleTextMessage(
      getDatabase(),
      accountHttp(accountLease),
      args,
      accountLease,
      capability,
    );
  });
}

/** Server-owned, one-time file schedule; failure never starts the phone's text fallback. */
export function scheduleAttachment(
  args: { chatGuid: string; text: string; scheduledFor: number; attachment: PickedImage },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{ id: number; serverId: string }> {
  const snapshot = { ...args, attachment: snapshotPickedImage(args.attachment) };
  return runScheduledAccountOperation(accountLease, async () => {
    const capability = captureSessionRcsCapabilityLease();
    if (isRcsChatGuid(snapshot.chatGuid)) {
      throw new Error('Scheduled attachments are available only in iMessage conversations.');
    }
    if (
      capability?.serverInfo?.supports_imessage_scheduled_attachment !== true ||
      !capability.isCurrent()
    ) {
      throw new Error('Scheduled iMessage attachments are unavailable on this server.');
    }
    const file = snapshot.attachment;
    if (
      !file.uri.startsWith('file://') ||
      !isSupportedImessageAttachmentType(file.mimeType, file.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > MAX_IMESSAGE_SCHEDULED_ATTACHMENT_BYTES
    ) {
      throw new Error('Choose one local JPEG, PNG, or PDF no larger than 512 KiB.');
    }
    const FileSystem = await import('expo-file-system/legacy');
    assertScheduledLease(accountLease);
    const info = await FileSystem.getInfoAsync(file.uri);
    assertScheduledLease(accountLease);
    if (
      !info.exists ||
      !Number.isSafeInteger(info.size) ||
      info.size <= 0 ||
      info.size > MAX_IMESSAGE_SCHEDULED_ATTACHMENT_BYTES
    ) {
      throw new Error('The selected file is unavailable or larger than 512 KiB.');
    }
    const attachmentData = await FileSystem.readAsStringAsync(file.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    assertScheduledLease(accountLease);
    return scheduleAttachmentMessage(
      getDatabase(),
      accountHttp(accountLease),
      {
        chatGuid: snapshot.chatGuid,
        text: snapshot.text,
        scheduledFor: snapshot.scheduledFor,
        attachmentName: file.name,
        mimeType: file.mimeType,
        attachmentData,
      } satisfies ScheduleAttachmentArgs,
      accountLease,
      capability,
    );
  });
}

/** The displayed occurrence no longer belongs to pending cancellation. */
export class ScheduledCancellationChangedError extends Error {
  constructor() {
    super('Scheduled occurrence changed or already started sending');
    this.name = 'ScheduledCancellationChangedError';
  }
}

/**
 * Cancel a remaining occurrence; this does not recall a message already handed off for sending.
 * A remote delete must succeed or confirm typed absence before the exact pending row is removed.
 * All other failures retain the local handle so cancellation can be retried.
 */
export async function cancelScheduled(
  row: ScheduledCancellationTarget,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  const expected = {
    id: row.id,
    chatGuid: row.chatGuid,
    serverId: row.serverId,
    scheduledFor: row.scheduledFor,
  };
  const db = getDatabase();
  await runScheduledAccountOperation(accountLease, async () => {
    assertScheduledLease(accountLease);
    const stored = await getScheduledById(db, expected.id);
    assertScheduledLease(accountLease);
    if (!stored) return;
    // A phone-only row is removed locally and needs no live RCS identity, so a Google re-pair must
    // not strand it; only a server-backed row needs its current pairing for the remote delete.
    const identityIsCurrent =
      stored.serverId == null ? () => true : captureScheduledChatMutationGuard(stored.chatGuid);
    assertScheduledMutationCurrent(accountLease, identityIsCurrent);
    if (
      stored.status !== 'pending' ||
      stored.serverId !== expected.serverId ||
      stored.scheduledFor !== expected.scheduledFor ||
      stored.chatGuid !== expected.chatGuid
    ) {
      throw new ScheduledCancellationChangedError();
    }
    const serverId = stored.serverId;
    if (serverId != null) {
      try {
        await scheduledApi.deleteScheduled(accountHttp(accountLease), serverId);
      } catch (error) {
        // The Mac's exact typed absence is idempotent cancellation, never a generic 404.
        if (!(
          error instanceof ApiError &&
          error.status === 404 &&
          error.serverErrorType === 'scheduled_message_not_found'
        ))
          throw error;
      }
      assertScheduledMutationCurrent(accountLease, identityIsCurrent);
    }
    const result = await withDbTransaction(
      db,
      (context) => cancelPendingScheduledWithinTransaction(context, expected),
      () => accountLease.isCurrent() && identityIsCurrent(),
    );
    assertScheduledMutationCurrent(accountLease, identityIsCurrent);
    if (result === 'changed') throw new ScheduledCancellationChangedError();
  });
}

/** Remove one completed scheduled-message history row through the scheduled service boundary. */
export function clearScheduledHistoryItem(
  id: number,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runScheduledAccountOperation(accountLease, async () => {
    const db = getDatabase();
    assertScheduledLease(accountLease);
    const stored = await getScheduledById(db, id);
    assertScheduledLease(accountLease);
    if (!stored) return;
    // Clearing history deletes only the local row; a phone-only one needs no live RCS identity.
    const identityIsCurrent =
      stored.serverId == null ? () => true : captureScheduledChatMutationGuard(stored.chatGuid);
    assertScheduledMutationCurrent(accountLease, identityIsCurrent);
    await withDbTransaction(
      db,
      (context) => deleteScheduledHistoryWithinTransaction(context, id),
      () => accountLease.isCurrent() && identityIsCurrent(),
    );
    assertScheduledMutationCurrent(accountLease, identityIsCurrent);
  });
}

/** The occurrence an editor was opened on already fired, re-armed, moved, or was removed. */
export class ScheduledEditChangedError extends Error {
  constructor() {
    super('Scheduled occurrence changed or already started sending');
    this.name = 'ScheduledEditChangedError';
  }
}

/**
 * Edit a scheduled message's text/time. Gator has NO update endpoint, so for a server-backed
 * row we re-create it: DELETE the old scheduled message, POST a fresh one, then point the local
 * row at the new uuid. The server call goes FIRST — any failure rethrows so the edit screen can
 * surface it instead of silently diverging from the server. Local-only rows just update locally.
 * Adding a RECURRENCE to a server-backed row converts it to LOCAL-ONLY (delete server-side, no
 * re-create) — the server can't repeat, so the on-device ticker must own the row to re-arm it.
 *
 * Only the exact `occurrence` the editor loaded may be edited. One that fired (and re-armed) or
 * was removed while the editor was open throws {@link ScheduledEditChangedError}: saving the
 * loaded time onto a re-armed row would send that slot twice, and a sent one-time row would
 * otherwise report a save that changed nothing.
 */
export async function editScheduled(
  occurrence: ScheduledOccurrence,
  patch: { text: string; scheduledFor?: number; recurrence?: string | null },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  const id = occurrence.id;
  const expected = {
    chatGuid: occurrence.chatGuid,
    serverId: occurrence.serverId,
    scheduledFor: occurrence.scheduledFor,
  };
  await runScheduledAccountOperation(accountLease, async () => {
    const db = getDatabase();
    assertScheduledLease(accountLease);
    const row = await getScheduledById(db, id);
    assertScheduledLease(accountLease);
    if (!row) throw new ScheduledEditChangedError();
    const identityIsCurrent = captureScheduledChatMutationGuard(row.chatGuid);
    const assertMutationCurrent = (): void =>
      assertScheduledMutationCurrent(accountLease, identityIsCurrent);
    const persistPatch = async (localPatch: UpdateScheduledPatch): Promise<void> => {
      const result = await withDbTransaction(
        db,
        (context) => updateScheduledWithinTransaction(context, id, localPatch, expected),
        () => accountLease.isCurrent() && identityIsCurrent(),
      );
      if (result !== 'updated') throw new ScheduledEditChangedError();
    };
    assertMutationCurrent();
    if (row.attachmentName) {
      throw new Error('File schedules cannot be edited; cancel and create a new schedule.');
    }
    if (
      row.status !== 'pending' ||
      row.chatGuid !== expected.chatGuid ||
      row.serverId !== expected.serverId ||
      row.scheduledFor !== expected.scheduledFor
    ) {
      throw new ScheduledEditChangedError();
    }
    if (row.serverId != null) {
      // No PUT on Gator: delete the old server-side message, then create a replacement.
      await scheduledApi.deleteScheduled(accountHttp(accountLease), row.serverId); // throws → local untouched, UI alerts
      assertMutationCurrent();
      if (patch.recurrence) {
        // Now recurring → keep it local-only so the ticker (which skips server-backed rows)
        // fires and re-arms it. The server row is already gone; just drop the serverId.
        await persistPatch({ ...patch, serverId: null });
        assertMutationCurrent();
        return;
      }
      let newServerId: string | null;
      try {
        const created = await scheduledApi.createScheduled(accountHttp(accountLease), {
          chatGuid: row.chatGuid,
          message: patch.text,
          scheduledFor: patch.scheduledFor ?? row.scheduledFor,
        });
        assertMutationCurrent();
        newServerId = created?.id ?? null;
      } catch (e) {
        // A revoked A request must not turn into a B-local fallback row.
        assertMutationCurrent();
        // DELETE succeeded but the re-create failed: the old server message is gone. DROP the
        // serverId so the on-device worker fires the edited message as a fallback (rather than
        // orphaning it — a non-null serverId would make the local worker skip it forever), apply
        // the edit locally, then surface the failure.
        await persistPatch({ ...patch, serverId: null });
        assertMutationCurrent();
        throw e;
      }
      // Repoint the local row at the fresh uuid alongside the text/time change.
      await persistPatch({ ...patch, serverId: newServerId });
      assertMutationCurrent();
      return;
    }
    await persistPatch(patch);
    assertMutationCurrent();
  });
}

/** File delivery can be ambiguous after a helper timeout, so a failed file row is not a proved miss. */
function normalizeSchedStatus(s: string | null | undefined, method?: string | null): string {
  const v = (s ?? '').toLowerCase();
  if (v === 'complete' || v === 'completed' || v === 'sent') return 'sent';
  if (v === 'error' || v === 'failed') {
    return method === 'narrow-attachment' ? 'uncertain' : 'error';
  }
  return 'pending'; // pending / scheduled → keep visible + cancellable
}

/** Pull the server's scheduled list into the local DB (keeps server-backed rows accurate). */
export async function syncScheduledFromServer(
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<boolean> {
  try {
    return await runScheduledAccountOperation(accountLease, async () => {
      const db = getDatabase();
      // Snapshot which rows this reconcile is ALLOWED to prune BEFORE the round trip. The server's
      // answer describes the instant it was built, and the Scheduled screen's Edit re-creates a
      // server-side message (delete + POST) — a row created while the GET was in flight is missing
      // from that answer through no fault of its own, and pruning it deletes the local handle to a
      // message the server will still fire.
      const pruneExposure = await listServerScheduledPruneExposure(db, () =>
        accountLease.isCurrent(),
      );
      assertScheduledLease(accountLease);
      let items: Awaited<ReturnType<typeof scheduledApi.getScheduled>>;
      try {
        items = await scheduledApi.getScheduled(accountHttp(accountLease));
      } catch {
        assertScheduledLease(accountLease);
        return false; // older/offline server — keep local rows, but do not call them verified
      }
      assertScheduledLease(accountLease);
      // EVERY id the server reported (even malformed items) — the prune set, so a row dropped by
      // the well-formed filter below is kept rather than pruned.
      const serverIds = items.map((it) => it.id);
      const mapped = items
        .map((it) => {
          if (!Number.isFinite(it.scheduledFor)) return null;
          return {
            serverId: it.id,
            chatGuid: it.chatGuid,
            text: it.text,
            attachmentName: it.attachmentName ?? undefined,
            scheduledFor: it.scheduledFor,
            status: normalizeSchedStatus(it.status, it.method),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null);
      assertScheduledLease(accountLease);
      await reconcileServerScheduled(db, mapped, serverIds, {
        pruneExposure,
        commitGuard: () => accountLease.isCurrent(),
      });
      assertScheduledLease(accountLease);
      return true;
    });
  } catch (error) {
    // This is called fire-and-forget on screen mount. A deliberate Disconnect is a quiet no-op,
    // not an unhandled rejection in the newly connected UI.
    if (error instanceof ScheduledSessionChangedError) return false;
    throw error;
  }
}

/** Fire any scheduled messages now due (real send path). */
export async function fireDueScheduled(now = Date.now()): Promise<number> {
  const accountLease = captureRealtimeDeliveryLease();
  try {
    return await runScheduledAccountOperation(accountLease, () =>
      runDueScheduled(
        getDatabase(),
        accountHttp(accountLease),
        now,
        undefined,
        accountLease,
        undefined,
        captureSessionRcsCapabilityLease,
      ),
    );
  } catch (error) {
    if (error instanceof ScheduledSessionChangedError) return 0;
    throw error;
  }
}

/** Fire due rows through a local development sender without exposing DB/transport composition. */
export async function fireDueScheduledWithDevelopmentSender(
  sender: ScheduledDevelopmentSender,
  accountLease: RealtimeDeliveryLease,
  now = Date.now(),
): Promise<number> {
  try {
    return await runScheduledAccountOperation(accountLease, () =>
      runDueScheduled(getDatabase(), accountHttp(accountLease), now, sender, accountLease),
    );
  } catch (error) {
    if (error instanceof ScheduledSessionChangedError) return 0;
    throw error;
  }
}

/**
 * Once per JS context: report optimistic sends whose message row and queue row lost each other.
 * The windows that can produce either half are single-digit milliseconds wide, so the only way to
 * learn whether they happen in the wild is to count them on real devices. Best-effort and silent
 * when clean — a diagnostic must never break the drain it rides on.
 */
let queueHealthReported = false;
async function reportQueueHealthOnce(): Promise<void> {
  if (queueHealthReported) return;
  queueHealthReported = true;
  try {
    const health = await countOutgoingQueueHealth(getDatabase());
    if (health.strandedSending > 0 || health.orphanQueueRows > 0) {
      logger.warn(
        `[queue] orphaned optimistic sends: ${health.strandedSending} stuck 'sending' with no queue row, ${health.orphanQueueRows} queue rows with no message`,
      );
    }
  } catch (e) {
    logger.debug('[queue] health check failed', e);
  }
}

/**
 * Retry stranded/failed queued sends with backoff (the optimistic-send recovery).
 * Run at launch and from the background task — a crash mid-send no longer strands a
 * message; it retries automatically until it sends or retires to the error bubble.
 */
export async function recoverOutgoing(
  now = Date.now(),
): Promise<{ eligible: number; sent: number }> {
  // Capture before the health-check await. An old recovery callback must never turn into a B-account
  // drain merely because Disconnect + reconnect completed while that read was in flight.
  const accountLease = captureRealtimeDeliveryLease();
  if (!accountLease.isCurrent()) return { eligible: 0, sent: 0 };
  // Before the drain, so the counts describe what the last session left behind rather than what
  // this one just repaired. Gated to the first call, which is the boot drain.
  await reportQueueHealthOnce();
  const capability = captureSessionRcsCapabilityLease();
  const serverAuthorization = messageTargetServerAuthorization(
    capability?.serverInfo,
    () => accountLease.isCurrent() && capability?.isCurrent() === true,
  );
  const rcsAvailable = (chatGuid?: string, messageGuid?: string): boolean => {
    const info = capability?.serverInfo;
    return (
      accountLease.isCurrent() &&
      capability?.isCurrent() === true &&
      currentRcsProviderEpoch(info) !== null &&
      (chatGuid === undefined || isCurrentRcsChatGuid(info, chatGuid)) &&
      (messageGuid === undefined || isCurrentRcsMessageGuid(info, messageGuid))
    );
  };
  const locationAvailable = (): boolean =>
    accountLease.isCurrent() &&
    capability?.isCurrent() === true &&
    capability.serverInfo?.supports_imessage_location === true;
  const imessagePlainTextAvailable = (chatGuid?: string): boolean =>
    accountLease.isCurrent() &&
    capability?.isCurrent() === true &&
    capability.serverInfo?.supports_imessage_plain_text === true &&
    (chatGuid === undefined || /^(?:iMessage|any);-;.+$/u.test(chatGuid));
  return runOutgoingQueue(
    getDatabase(),
    accountHttp(accountLease),
    outgoingQueueIO,
    now,
    accountLease,
    undefined,
    undefined,
    serverAuthorization,
    rcsAvailable,
    undefined,
    locationAvailable,
    undefined,
    imessagePlainTextAvailable,
  );
}

/**
 * Retry a failed send: take the errored row over, then drive ONE re-POST of its queue payload.
 *
 * THE SEND IS REBUILT FROM THE QUEUE ROW, NOT FROM THE BUBBLE, and it keeps its ORIGINAL temp guid.
 * The old shape — delete the row, then re-send whatever the sheet could see — got both halves
 * wrong. It re-sent the bubble's TEXT whatever had actually been queued, so a failed CONTACT CARD
 * was delivered as a plain message reading the contact's display name (exactly what `kind:'contact'`
 * exists to prevent), and a failed reply/effect/subject/mention send silently lost those fields;
 * only the payload carries them, and the automatic drain has always used it. And the fresh temp id
 * is the key the server's idempotency cache is built on, so a send that failed client-side (a 30 s
 * HTTP timeout) yet landed server-side went out a SECOND time. Nothing is destroyed either, so a
 * throw in the re-send can no longer leave the user with neither a bubble nor a queue row.
 *
 * The claim is guarded because this button races the automatic retry the app runs every 20 s: that
 * drain leases the same row, flips the bubble to 'sending' and starts a POST that can run for
 * seconds (a foreground attachment upload has no timeout), while the sheet the user is tapping opened
 * before any of that. Only an 'error' row with a live ladder is ours; anything else says so and
 * re-sends nothing.
 */
export async function retry(
  tempGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<ManualRetryResult> {
  if (!accountLease.isCurrent()) return 'stale';
  // NEVER rejects. UI callers map this typed result to presentation; a rejection from a press
  // handler would bypass that mapping and become an unhandled promise. The bubble and its ladder
  // survive any failure, so there is nothing to repair — only an outcome to report.
  try {
    const result = await runUiAccountOperation(
      accountLease,
      async (): Promise<ManualRetryResult> => {
        const db = getDatabase();
        const capability = captureSessionRcsCapabilityLease();
        const serverAuthorization = messageTargetServerAuthorization(
          capability?.serverInfo,
          () => accountLease.isCurrent() && capability?.isCurrent() === true,
        );
        const rcsAvailable = (chatGuid?: string, messageGuid?: string): boolean => {
          const info = capability?.serverInfo;
          return (
            accountLease.isCurrent() &&
            capability?.isCurrent() === true &&
            currentRcsProviderEpoch(info) !== null &&
            (chatGuid === undefined || isCurrentRcsChatGuid(info, chatGuid)) &&
            (messageGuid === undefined || isCurrentRcsMessageGuid(info, messageGuid))
          );
        };
        const locationAvailable = (): boolean =>
          accountLease.isCurrent() &&
          capability?.isCurrent() === true &&
          capability.serverInfo?.supports_imessage_location === true;
        const imessagePlainTextAvailable = (chatGuid?: string): boolean =>
          accountLease.isCurrent() &&
          capability?.isCurrent() === true &&
          capability.serverInfo?.supports_imessage_plain_text === true &&
          (chatGuid === undefined || /^(?:iMessage|any);-;.+$/u.test(chatGuid));
        const retryChatGuid = await getOutgoingRetryChatGuid(db, tempGuid);
        if (!accountLease.isCurrent()) return 'stale';
        if (retryChatGuid && isRcsChatGuid(retryChatGuid) && !rcsAvailable(retryChatGuid)) {
          return 'unretryable';
        }
        const { claim, row, attemptOwnerToken } = await withDbTransaction(
          db,
          (context) =>
            claimFailedOutgoingForRetryWithinTransaction(
              context,
              tempGuid,
              Date.now,
              serverAuthorization,
              locationAvailable,
              (chatGuid) => rcsAvailable(chatGuid),
              (chatGuid) => imessagePlainTextAvailable(chatGuid),
            ),
          messageTargetCommitGuard(
            () =>
              accountLease.isCurrent() &&
              (!retryChatGuid || !isRcsChatGuid(retryChatGuid) || rcsAvailable(retryChatGuid)),
            serverAuthorization,
          ),
        );
        if (!accountLease.isCurrent()) return 'stale';
        if (claim !== 'claimed' || !row) {
          return claim === 'sending'
            ? 'already-sending'
            : claim === 'settled'
              ? 'already-settled'
              : 'unretryable';
        }
        // The same attempt the drain would make — same payload, same temp guid, same reconcile.
        const outcome = await resendOutgoingRow(
          db,
          accountHttp(accountLease),
          outgoingQueueIO,
          row,
          () => Date.now(),
          accountLease,
          undefined,
          attemptOwnerToken,
          serverAuthorization,
          rcsAvailable,
          undefined,
          locationAvailable,
          imessagePlainTextAvailable,
        );
        if (!accountLease.isCurrent()) return 'stale';
        // Retired for good: the attachment's on-disk file is gone, so no re-send can ever work. The
        // bubble keeps its error badge (Delete on the sheet still works) — say why rather than leave
        // the tap looking like it did nothing.
        switch (outcome) {
          case 'sent':
            return 'retried';
          case 'failed':
            return 'failed';
          case 'unsendable':
            return 'unsendable';
          case 'paused':
            return 'stale';
          case 'deferred': {
            const retrySafePlainText =
              imessagePlainTextQueueState(row.kind, row.payload) === 'retry-safe';
            await reconcileOutgoingError(
              db,
              row.tempGuid,
              1,
              Date.now(),
              () => accountLease.isCurrent(),
              retrySafePlainText
                ? 'Narrow iMessage delivery is temporarily unavailable.'
                : row.kind === 'location'
                  ? 'Current-location sharing is unavailable.'
                  : 'RCS is unavailable.',
              attemptOwnerToken,
              retrySafePlainText,
            );
            return 'failed';
          }
        }
      },
    );
    return result ?? 'stale';
  } catch (e) {
    // Disconnect may have revoked this retry while a DB/native await was in flight. An A-account
    // failure must not surface as a toast in B's newly connected UI (or as a misleading warning).
    if (!accountLease.isCurrent()) return 'stale';
    if (
      e instanceof MessageTargetCapabilityUnknownError ||
      e instanceof DbCommitGuardRejectedError
    ) {
      return 'failed';
    }
    // A DB/driver failure in the claim itself. The automatic ladder still owns the row.
    logger.warn('[send] manual retry failed', e);
    return 'failed';
  }
}

/**
 * Discard a message from the user's "Delete" (single or bulk), whatever state it is in.
 *
 * ONE guarded transaction with two branches covers every state exactly once:
 *  1. `discardOutgoingMessageWithinTransaction` claims ONLY an unconfirmed optimistic row (a `temp-` guid still
 *     'sending' or 'error'): it tombstones the bubble and takes its queue row with it, so the
 *     retry ladder can't re-POST what the user just removed.
 *  2. Everything else — a real server guid, and a `temp-` row already flipped to 'sent' by a
 *     guid-less ack (RCS / AppleScript) — falls through to
 *     `deleteMessageLocalWithinTransaction` before the same commit.
 * BOTH steps tombstone; the difference is only which one owns the queue row and the ownership
 * answer the caller gets. Every state here is a message the server may still have, and a hard
 * delete of any of them is undone the next time the thread syncs (`ensureChatSynced` re-pages 500
 * messages on EVERY chat open) — `date_deleted` is the only thing that survives that.
 * The step-1 helper returning "I cleaned something up" instead of "I own this message" is what
 * made a Delete silently do nothing, so it now reports ownership only.
 */
export async function discardMessage(
  guid: string,
  now: number = Date.now(),
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<DiscardMessageResult> {
  const outcome = await runUiAccountOperation(accountLease, async () => {
    const db = getDatabase();
    const ownerResolution = await withDbTransaction(
      db,
      (context) => resolveServerSendErrorOwnersWithinTransaction(context, [guid]),
      () => accountLease.isCurrent(),
    );
    if (!accountLease.isCurrent()) return 'stale';
    if (ownerResolution.hasConflict || ownerResolution.chatGuids.length > 1) {
      return 'message-changed';
    }
    const ownerChatGuid = ownerResolution.chatGuids[0] ?? null;
    const ownerIsRcs = ownerChatGuid?.startsWith('RCS;-;') === true;
    const messageIsRcs = guid.startsWith('rcs-');
    const expectedRcsEpoch =
      ownerIsRcs || messageIsRcs
        ? currentRcsProviderEpoch(useSessionStore.getState().serverInfo)
        : null;
    const rcsIdentityIsCurrent = (): boolean =>
      (!ownerIsRcs ||
        (expectedRcsEpoch != null &&
          currentRcsProviderEpoch(useSessionStore.getState().serverInfo) === expectedRcsEpoch &&
          ownerChatGuid != null &&
          isCurrentRcsChatGuid(useSessionStore.getState().serverInfo, ownerChatGuid))) &&
      (!messageIsRcs || isCurrentRcsMessageGuid(useSessionStore.getState().serverInfo, guid)) &&
      (!messageIsRcs || ownerIsRcs);
    if (!rcsIdentityIsCurrent()) return 'message-changed';
    // STOP THE BYTES FIRST, before either tombstone. "Cancel Sending" used to be a pure DB write:
    // the bubble vanished while the phone carried on streaming the entire file to the server — on a
    // large video, for minutes, over the user's data. The upload simply had no cancel handle to
    // reach for. Cancelling is safe for every other message kind too: nothing is registered under a
    // text/reaction/contact temp guid, so this is a no-op for them.
    uploadRegistry.cancel(guid);
    const attachmentCacheScope = createAttachmentCacheAccountScope(accountLease);
    const transactionResult = await withDbTransaction(
      db,
      async (context) => {
        const currentOwner = await resolveServerSendErrorOwnersWithinTransaction(context, [guid]);
        if (
          currentOwner.hasConflict ||
          currentOwner.chatGuids.length !== ownerResolution.chatGuids.length ||
          (currentOwner.chatGuids[0] ?? null) !== ownerChatGuid ||
          !rcsIdentityIsCurrent()
        ) {
          return { kind: 'identity-changed' as const };
        }
        const outgoingOwned = await discardOutgoingMessageWithinTransaction(context, guid, now);
        const result = outgoingOwned
          ? null
          : await deleteMessageLocalWithinTransaction(context, guid, now);
        return { kind: 'applied' as const, result };
      },
      () => accountLease.isCurrent() && rcsIdentityIsCurrent(),
    );
    if (transactionResult.kind === 'identity-changed') return 'message-changed';
    const result = transactionResult.result;
    if (!accountLease.isCurrent() || !rcsIdentityIsCurrent()) return 'stale';
    // The fixed-size alias ledger may have retired an extremely old mapping. Never claim the
    // destructive action succeeded against an identity we cannot prove; the reactive list now
    // carries the real GUID, so selecting the message again gives the user a safe retry.
    const disposition: DiscardMessageResult =
      result === 'unresolved-temp' ? 'message-changed' : 'discarded';
    if (!accountLease.isCurrent() || !rcsIdentityIsCurrent()) return 'stale';
    // The tombstone commits before native mutation. Failed-send notices are keyed by the retained
    // local message id, so removing the bubble must also withdraw its already-posted tray record.
    await clearFailedSendNotice(db, guid, () => accountLease.isCurrent() && rcsIdentityIsCurrent());
    if (!accountLease.isCurrent() || !rcsIdentityIsCurrent()) return 'stale';
    // Tombstone + ledger/ref changes committed above. Exact native deletion stays outside their DB
    // transaction and inside this account-scoped operation, so Disconnect drains it before wipe.
    await attachmentCacheCoordinator
      .retireInactiveEntries(db, { scope: attachmentCacheScope })
      .catch((error) => logger.debug('[send] deleted-message cache retirement deferred', error));
    await attachmentCacheCoordinator
      .drainDueRetirements(db, { scope: attachmentCacheScope })
      .catch((error) => logger.debug('[send] deleted-message cache cleanup deferred', error));
    return disposition;
  });
  return outcome ?? 'stale';
}

/*
 * There is deliberately NO `cancelOutgoing` wrapper here any more. "Cancel Sending" and "Remove"
 * are worded differently but ask for the same thing, and routing them at only
 * `discardOutgoingMessage` made the tap a SILENT NO-OP whenever the send completed while the
 * confirmation dialog was on screen (seconds — the guard then matches nothing and the boolean is
 * discarded). Every user-facing removal goes through {@link discardMessage}, whose second step
 * removes what the first does not own.
 */
