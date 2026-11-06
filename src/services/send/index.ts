import { getDatabase } from '@db/database';
import { accountHttp } from '../clients';
import { runDueScheduled, ScheduledSessionChangedError } from './scheduleService';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { captureSessionRcsCapabilityLease } from './rcsAttemptCapability';
import { runScheduledAccountOperation } from './sendShared';
export { hasLogicalSendCapacity, outgoingQueueIO } from './sendShared';
export type { SendIssueReporter, SendOperationIssue } from './sendShared';
export {
  acquireAndSendCurrentLocation,
  checkUnsend,
  editText,
  pickAndSendContact,
  react,
  reply,
  send,
  sendContactCard,
  sendEffect,
  sendFormatted,
  sendImage,
  sendImages,
  sendMention,
  sendSubject,
  sendTextAttachment,
  sendVoice,
  unsend,
} from './messageSends';
export type {
  AttachmentQueueAdmission,
  AttachmentQueueAdmissionObserver,
  ForegroundLocationLifecycle,
  SendQueuedObserver,
  ShareCurrentLocationOptions,
  ShareCurrentLocationResult,
} from './messageSends';
export {
  ScheduledCancellationChangedError,
  ScheduledEditChangedError,
  cancelScheduled,
  clearScheduledHistoryItem,
  editScheduled,
  schedule,
  scheduleAttachment,
  syncScheduledFromServer,
} from './scheduledSends';
export { discardMessage, recoverOutgoing, retry } from './outgoingRecovery';
export type { DiscardMessageResult, ManualRetryResult } from './outgoingRecovery';

export { isContactsPermissionDeniedError } from '../contacts/contactsService';
export { runOutgoingQueue, type OutgoingQueueIO } from './outgoingQueueService';
/** Development sender injected into the scheduled runner instead of the real HTTP send path. */
export type ScheduledDevelopmentSender = (
  chatGuid: string,
  text: string,
  selectedMessageGuid: string | undefined,
  onQueued: () => Promise<void>,
  selectedMessagePartIndex?: number,
) => Promise<void>;
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
export {
  sendIMessageSubject,
  type SendSubjectArgs,
  type SendSubjectResult,
} from './sendSubjectService';
export { runDueScheduled, scheduleTextMessage, type ScheduleArgs } from './scheduleService';
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
