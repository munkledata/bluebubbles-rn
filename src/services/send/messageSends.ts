/** Message sends of the send front door (moved from index.ts): photos, voice, text with an attachment, contacts, location, reactions, replies, effects, mentions, formatting, edit and unsend. */

import {
  canSendRestoredIMessageReply,
  canSendRestoredIMessageSubject,
  canSendRestoredIMessageTapback,
  canUseRestoredIMessageGroupFeature,
  IMESSAGE_RESTORED_ATTACHMENT_MAX_FILES,
  restoredChatKind,
  restoredGroupCommandsAcceptAnyPrefix,
} from '@core/models/imessageRestoredFeatures';
import { logger } from '@core/secure';
import { isCurrentRcsChatGuid, isCurrentRcsMessageGuid } from '@core/rcs/providerIdentity';
import { getDatabase } from '@db/database';
import type { ShareIntakeManifestIdentity } from '@db/repositories';
import { useSessionStore } from '@state/sessionStore';
import { isRcsChatGuid } from '@utils/chat';
import { accountHttp } from '../clients';
import { type SendTextArgs, sendTextMessage } from './sendService';
import {
  sendIMessageReactionMessage,
  type SendReactionArgs,
  sendReactionMessage,
} from './sendReactionService';
import {
  checkUnconfirmedUnsend,
  type CheckUnsendResult,
  sendEdit,
  type SendEditResult,
  sendUnsend,
  type SendUnsendResult,
} from './sendEditService';
import {
  type AttachmentTextService,
  type AttachmentUploader,
  type PickedImage,
  RcsAttachmentTooLargeError,
  sendImageMessage,
  SeveralFilesUnavailableError,
  UnsendableAttachmentNameError,
} from './sendAttachmentService';
import { sendRestoredIMessageReactionMessage } from './sendRestoredReactionService';
import { type ContactCard, hasContactContent, sendContactMessage } from './sendContactService';
import {
  sendCurrentLocationMessage,
  type CurrentLocationCoordinates as SendLocationCoordinates,
} from './sendLocationService';
import {
  type SendEffectArgs,
  type SendEffectResult,
  sendIMessageEffect,
} from './sendEffectService';
import {
  sendIMessageSubject,
  type SendSubjectArgs,
  type SendSubjectResult,
} from './sendSubjectService';
import {
  sendIMessageMention,
  type SendMentionArgs,
  type SendMentionResult,
} from './sendMentionService';
import {
  type SendFormattedArgs,
  type SendFormattedResult,
  sendIMessageFormatted,
} from './sendFormattedService';
import { pickContact } from '../contacts/contactsService';
import { acquireCurrentLocation, type CurrentLocationOutcome } from '../location/currentLocation';
import { getExpoLocationAdapter } from '../location/expoLocationAdapter';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
} from '../realtime/deliveryCoordinator';
import { expoAttachmentUploader } from './attachmentUpload';
import { createRcsShareUploader } from './rcsUploadPacing';
import { createConcurrencyGate, runRegisteredInGate, uploadRegistry } from './uploadControl';
import { createAttachmentCacheAccountScope } from '../download/attachmentCacheAccountScope';
import { isAttachmentCacheRecoveryReady } from '../download/attachmentCacheRecovery';
import { createOutgoingPasteOwnershipPreparer } from './outgoingPasteOwnership';
import {
  captureSessionRcsCapabilityLease,
  messageTargetServerAuthorization,
} from './rcsAttemptCapability';
import {
  SendCapabilityUnavailableError,
  rcsPacedAttachmentUploader,
  runUiAccountOperation,
  snapshotContactCard,
  snapshotPickedImage,
  snapshotSendTextArgs,
  withMeasuredSize,
  type SendIssueReporter,
} from './sendShared';

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
/**
 * UI-facing multi-image send: several iMessage files go as one message when the server's restored
 * route takes them all for the chat; otherwise one optimistic message + attachment per asset.
 */
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
  // Each iMessage file is its own one-shot message; the route decides per file whether it may go.
  if (
    snapshot.service === 'iMessage' &&
    (snapshot.images.length < 1 || snapshot.images.length > IMESSAGE_RESTORED_ATTACHMENT_MAX_FILES)
  ) {
    return Promise.reject(
      new Error(
        `Send one to ${IMESSAGE_RESTORED_ATTACHMENT_MAX_FILES} iMessage attachments at a time.`,
      ),
    );
  }
  const pasteOwnership = createOutgoingPasteOwnershipPreparer(
    createAttachmentCacheAccountScope(accountLease),
    () => isAttachmentCacheRecoveryReady(accountLease),
  );
  // One multi-file share: its RCS files take turns instead of uploading at once.
  const rcsShareUploader = createRcsShareUploader(expoAttachmentUploader);
  // The iMessage files of one pick upload one at a time in pick order: each is its own message, and
  // two large videos at once only compete for the network. A file stays registered while it waits,
  // so the outgoing recovery can't retire it as "may have been delivered" mid-wait, and Cancel
  // Sending or Disconnect ends its wait before any request starts.
  const imessageLane = createConcurrencyGate(1);
  const shareUploader: AttachmentUploader = (args) =>
    args.service === 'iMessage'
      ? runRegisteredInGate(
          imessageLane,
          uploadRegistry,
          args.tempGuid,
          () => rcsShareUploader(args),
          args.signal,
        )
      : rcsShareUploader(args);
  return runUiAccountOperation(
    accountLease,
    async () => {
      const images = await Promise.all(
        snapshot.images.map((image) => withMeasuredSize(image, accountLease)),
      );
      const db = getDatabase();
      // One send: a file on its own, or several files as one iMessage. Both use this one call, so
      // every file keeps the same admission, observers and failure handling.
      const sendUnit = async (image: PickedImage, additionalImages?: PickedImage[]) => {
        const unitImages = [image, ...(additionalImages ?? [])];
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
              ...(additionalImages ? { additionalImages } : {}),
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
                  for (const file of unitImages) {
                    onAdmission?.({ uri: file.uri, queued: true, tempGuid });
                  }
                }
              } catch (error) {
                logger.warn('[send] optional attachment admission observer failed', error);
              }
            },
            captureSessionRcsCapabilityLease(),
          );
        } catch (error) {
          // A batch that can't go as one message goes file by file below; report nothing yet.
          if (
            !queued &&
            accountLease.isCurrent() &&
            !(error instanceof SeveralFilesUnavailableError)
          ) {
            try {
              for (const file of unitImages) {
                onAdmission?.({
                  uri: file.uri,
                  queued: false,
                  ...(error instanceof UnsendableAttachmentNameError
                    ? { reason: 'file-name' as const }
                    : error instanceof RcsAttachmentTooLargeError
                      ? { reason: 'too-large' as const }
                      : {}),
                });
              }
            } catch (observerError) {
              logger.warn('[send] optional attachment admission observer failed', observerError);
            }
          }
          throw error;
        }
      };
      // Several files of one iMessage pick go as ONE message when the restored route takes them all
      // for this chat. When it can't, it says so before writing anything, and each file is sent as
      // its own message, exactly as before.
      const first = images[0];
      if (
        snapshot.service === 'iMessage' &&
        first &&
        images.length > 1 &&
        images.every((image) => (image.origin === 'share') === (first.origin === 'share'))
      ) {
        try {
          return [await sendUnit(first, images.slice(1))];
        } catch (error) {
          if (!(error instanceof SeveralFilesUnavailableError)) throw error;
        }
      }
      const settled = await Promise.allSettled(images.map((image) => sendUnit(image)));
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
      }
      // FP-006: a group, emoji or part > 0 tapback needs every matching restored switch; anything
      // else stays on the reviewed one-to-one, classic, part-zero path below.
      const restoredTapback =
        !isRcsChatGuid(snapshot.chatGuid) &&
        canSendRestoredIMessageTapback(capability?.serverInfo, {
          chatGuid: snapshot.chatGuid,
          reaction: snapshot.reaction,
          partIndex: snapshot.partIndex ?? 0,
        });
      if (
        !isRcsChatGuid(snapshot.chatGuid) &&
        !restoredTapback &&
        capability?.serverInfo?.supports_imessage_reactions !== true
      ) {
        throw new SendCapabilityUnavailableError();
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
      if (restoredTapback) {
        return sendRestoredIMessageReactionMessage(
          getDatabase(),
          accountHttp(accountLease),
          snapshot,
          () => accountLease.isCurrent(),
          serverAuthorization,
          () =>
            accountLease.isCurrent() && capability?.isCurrent() === true
              ? capability.serverInfo
              : null,
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
        () =>
          accountLease.isCurrent() &&
          capability?.isCurrent() === true &&
          capability?.serverInfo?.supports_imessage_reaction_temp_guid === true,
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
    /**
     * Part of the selected message that this reply targets: 0 on the reviewed path, or any part
     * the restored part-reply switch admits (FP-006).
     */
    replyToPartIndex: number;
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
      // FP-006: a group or part > 0 reply needs its restored switches; otherwise the reviewed
      // one-to-one part-zero reply rule applies unchanged.
      const restoredReply =
        !isRcsChatGuid(snapshot.chatGuid) &&
        canSendRestoredIMessageReply(capability?.serverInfo, {
          chatGuid: snapshot.chatGuid,
          partIndex: snapshot.replyToPartIndex,
        });
      if (
        snapshot.effectId !== undefined ||
        isRcsChatGuid(snapshot.chatGuid) ||
        !capability?.isCurrent() ||
        (!restoredReply &&
          (snapshot.replyToPartIndex !== 0 ||
            capability.serverInfo?.supports_imessage_replies !== true))
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
          partIndex: snapshot.replyToPartIndex,
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
        !messageChangeSupported(capability.serverInfo, snapshot.chatGuid, 'effect') ||
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
        !(
          restoredGroupCommandsAcceptAnyPrefix(capability.serverInfo)
            ? /^(?:iMessage|any);\+;.+$/u
            : /^iMessage;\+;.+$/u
        ).test(snapshot.chatGuid) ||
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
/** UI-facing one-shot FP-006 text with a subject line, one-to-one or in an all-iMessage group. */
export function sendSubject(
  args: SendSubjectArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  reportIssue?: SendIssueReporter,
): Promise<SendSubjectResult | null> {
  const snapshot: SendSubjectArgs = { ...args };
  return runUiAccountOperation(
    accountLease,
    () => {
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        isRcsChatGuid(snapshot.chatGuid) ||
        !canSendRestoredIMessageSubject(capability.serverInfo, snapshot.chatGuid) ||
        !capability.isCurrent()
      ) {
        throw new SendCapabilityUnavailableError();
      }
      return sendIMessageSubject(
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
/**
 * Whether the server will take this edit, unsend or effect right now: the reviewed one-to-one
 * command, or (FP-006) the restored group command while its own group switch is on. A group never
 * borrows the one-to-one switch, and a one-to-one chat never borrows a group switch.
 */
function messageChangeSupported(
  info: Parameters<typeof canUseRestoredIMessageGroupFeature>[0],
  chatGuid: string,
  change: 'edit' | 'unsend' | 'effect',
): boolean {
  if (restoredChatKind(chatGuid) === 'group') {
    return canUseRestoredIMessageGroupFeature(
      info,
      chatGuid,
      change === 'edit'
        ? 'supports_imessage_group_edit'
        : change === 'unsend'
          ? 'supports_imessage_group_unsend'
          : 'supports_imessage_group_effects',
    );
  }
  const direct =
    change === 'edit'
      ? info?.supports_imessage_edit
      : change === 'unsend'
        ? info?.supports_imessage_unsend
        : info?.supports_imessage_effects;
  return direct === true;
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
      !capability ||
      !messageChangeSupported(capability.serverInfo, args.chatGuid, 'edit') ||
      !capability.isCurrent()
    ) {
      throw new SendCapabilityUnavailableError();
    }
    const serverAuthorization = messageTargetServerAuthorization(
      capability.serverInfo,
      () =>
        accountLease.isCurrent() &&
        capability.isCurrent() &&
        messageChangeSupported(capability.serverInfo, args.chatGuid, 'edit'),
    );
    return sendEdit(
      getDatabase(),
      accountHttp(accountLease),
      { ...args, restoredGroup: restoredChatKind(args.chatGuid) === 'group' },
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
      !capability ||
      !messageChangeSupported(capability.serverInfo, args.chatGuid, 'unsend') ||
      !capability.isCurrent()
    ) {
      throw new SendCapabilityUnavailableError();
    }
    const serverAuthorization = messageTargetServerAuthorization(
      capability.serverInfo,
      () =>
        accountLease.isCurrent() &&
        capability.isCurrent() &&
        messageChangeSupported(capability.serverInfo, args.chatGuid, 'unsend'),
    );
    return sendUnsend(
      getDatabase(),
      accountHttp(accountLease),
      { ...args, restoredGroup: restoredChatKind(args.chatGuid) === 'group' },
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
      !capability ||
      !messageChangeSupported(capability.serverInfo, args.chatGuid, 'unsend') ||
      !capability.isCurrent()
    ) {
      throw new SendCapabilityUnavailableError();
    }
    const serverAuthorization = messageTargetServerAuthorization(
      capability.serverInfo,
      () =>
        accountLease.isCurrent() &&
        capability.isCurrent() &&
        messageChangeSupported(capability.serverInfo, args.chatGuid, 'unsend'),
    );
    return checkUnconfirmedUnsend(
      getDatabase(),
      accountHttp(accountLease),
      { ...args, restoredGroup: restoredChatKind(args.chatGuid) === 'group' },
      Date.now(),
      () => accountLease.isCurrent(),
      serverAuthorization,
    );
  });
}
