import { useCallback, type Dispatch, type SetStateAction } from 'react';
import {
  UnsupportedIMessageTextError,
  type IMessageTextFormattingRange,
} from '@core/api/endpoints/messages';
import type { Recurrence } from '@core/schedule';
import { logger } from '@core/secure';
import type { MessagePreview } from '@db/repositories';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import {
  editText,
  reply,
  schedule,
  scheduleAttachment,
  send,
  sendEffect,
  sendFormatted,
  sendMention,
  type SendOperationIssue,
} from '@/services/send';
import { showToast, type PendingAttachment } from '@ui';
import { presentSendIssue } from '@ui/conversations/sendNotices';
import { showDialog } from '@ui/dialog/dialogStore';
import { isDevServer } from '@utils/isDev';
import { devSendFake } from '@features/conversations/devSeed';
import { observeQueueAdmission } from './observeQueueAdmission';
import type { ChatCapabilities } from './useChatCapabilities';

/** The message the composer is editing (only part 0 of a message can be edited). */
export interface ComposerEditTarget {
  guid: string;
  text: string;
  partIndex: 0;
}

export interface ChatComposerSendOptions {
  guid: string;
  accountLease: RealtimeDeliveryLease;
  capabilities: Pick<
    ChatCapabilities,
    | 'imessageScheduledAttachmentsAvailable'
    | 'imessageEditsAvailable'
    | 'imessageRepliesAvailable'
    | 'imessageEffectsAvailable'
    | 'imessageMentionsAvailable'
    | 'mentionParticipants'
    | 'imessageFormattedAvailable'
  >;
  editing: ComposerEditTarget | null;
  setEditing: Dispatch<SetStateAction<ComposerEditTarget | null>>;
  replyTo: MessagePreview | null;
  setReplyTo: Dispatch<SetStateAction<MessagePreview | null>>;
}

/**
 * The composer's text sends for the open chat: plain send (or the pending edit or reply), effects,
 * mentions, formatted text, and scheduling. Each one reports its own failure and returns whether
 * the composer may clear its draft; a send that never reached the queue keeps the draft.
 */
export function useChatComposerSends({
  guid,
  accountLease,
  capabilities,
  editing,
  setEditing,
  replyTo,
  setReplyTo,
}: ChatComposerSendOptions) {
  const {
    imessageScheduledAttachmentsAvailable,
    imessageEditsAvailable,
    imessageRepliesAvailable,
    imessageEffectsAvailable,
    imessageMentionsAvailable,
    mentionParticipants,
    imessageFormattedAvailable,
  } = capabilities;

  // useCallback-stable: these feed the memoized Composer, so a reactive tick re-rendering the
  // screen doesn't re-render the composer through fresh closures.
  const onSchedule = useCallback(
    async (
      text: string,
      scheduledFor: number,
      recurrence?: Recurrence | null,
    ): Promise<boolean> => {
      try {
        await schedule(
          {
            chatGuid: guid,
            text,
            scheduledFor,
            recurrence,
          },
          accountLease,
        );
        return accountLease.isCurrent();
      } catch (error) {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] could not schedule message', error);
          showDialog('Scheduled', 'Couldn’t schedule that message.');
        }
        return false;
      }
    },
    [accountLease, guid],
  );

  const onScheduleAttachment = useCallback(
    async (text: string, item: PendingAttachment, scheduledFor: number): Promise<boolean> => {
      if (!imessageScheduledAttachmentsAvailable || !accountLease.isCurrent()) return false;
      try {
        await scheduleAttachment(
          { chatGuid: guid, text, scheduledFor, attachment: { ...item } },
          accountLease,
        );
        return accountLease.isCurrent();
      } catch (error) {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] file schedule could not be confirmed', error);
          showDialog(
            'Scheduled file',
            'Couldn’t confirm this schedule. Check Scheduled before trying again; your draft and file are still here.',
          );
        }
        return false;
      }
    },
    [accountLease, guid, imessageScheduledAttachmentsAvailable],
  );

  const onSend = useCallback(
    (text: string): Promise<boolean> => {
      const editTarget = editing;
      if (editTarget) {
        if (!imessageEditsAvailable || editTarget.partIndex !== 0) {
          showToast('Editing is unavailable right now. Your changes are still here');
          return Promise.resolve(false);
        }
        return editText(
          {
            chatGuid: guid,
            messageGuid: editTarget.guid,
            newText: text,
            partIndex: 0,
          },
          accountLease,
        )
          .then((result) => {
            if (!accountLease.isCurrent()) return false;
            if (result == null || result.status === 'rejected') {
              showDialog('Edit Not Sent', 'Your edited text is still here so you can try again.');
              return false;
            }
            setEditing((current) => (current?.guid === editTarget.guid ? null : current));
            if (result.status === 'outcome-unknown') {
              showDialog(
                'Edit Not Confirmed',
                'It may have been applied. Check the conversation before trying another edit.',
              );
            }
            return true;
          })
          .catch((error: unknown) => {
            if (accountLease.isCurrent()) {
              logger.warn('[chat] edit submission failed', error);
              showDialog('Edit Not Sent', 'Your edited text is still here so you can try again.');
            }
            return false;
          });
      }
      // A send refused before the queue (for example, capabilities refreshed mid-admission) resolves
      // null. Say so once; a queue-capacity refusal has already shown its own notice.
      let issuePresented = false;
      const reportIssue = (issue: SendOperationIssue): void => {
        issuePresented = true;
        presentSendIssue(issue);
      };
      const target = replyTo;
      if (target) {
        if (!imessageRepliesAvailable || target.targetPartIndex !== 0) {
          return Promise.resolve(false);
        }
        return observeQueueAdmission(
          (onQueued) =>
            reply(
              {
                chatGuid: guid,
                text,
                replyToGuid: target.guid,
                replyToPartIndex: 0,
              },
              accountLease,
              reportIssue,
              onQueued,
            ).then((result) => {
              if (result == null && accountLease.isCurrent() && !issuePresented) {
                throw new Error('The iMessage reply capability changed before queue admission.');
              }
              return result;
            }),
          () => {
            setReplyTo((current) => (current?.guid === target.guid ? null : current));
          },
          (error) => {
            if (!accountLease.isCurrent()) return;
            logger.warn('[chat] reply queue admission failed', error);
            showToast('Couldn’t queue that reply. Your draft is still here');
          },
        );
      }
      // DEV: when on the local dev session, simulate the server round-trip so the
      // optimistic → sent flow is visible without a real Gator server.
      return observeQueueAdmission(
        (onQueued) => {
          if (isDevServer()) {
            return devSendFake(guid, text, undefined, accountLease, onQueued);
          }
          return send({ chatGuid: guid, text }, accountLease, reportIssue, onQueued).then(
            (result) => {
              if (result == null && accountLease.isCurrent() && !issuePresented) {
                throw new Error('Send capabilities changed before queue admission.');
              }
              return result;
            },
          );
        },
        () => undefined,
        (error) => {
          if (!accountLease.isCurrent()) return;
          logger.warn('[chat] message queue admission failed', error);
          showToast(
            error instanceof UnsupportedIMessageTextError
              ? 'iMessage can’t send this text. Remove hidden attachment or control characters, or shorten it. Your draft is still here.'
              : 'Couldn’t queue that message. Your draft is still here—try again when connected',
          );
        },
      );
    },
    [
      accountLease,
      editing,
      guid,
      imessageEditsAvailable,
      imessageRepliesAvailable,
      replyTo,
      setEditing,
      setReplyTo,
    ],
  );

  const onSendEffect = useCallback(
    async (text: string, effectId: string): Promise<boolean> => {
      if (!imessageEffectsAvailable || !accountLease.isCurrent()) return false;
      try {
        const result = await sendEffect(
          { chatGuid: guid, text, effectId },
          accountLease,
          presentSendIssue,
        );
        if (!accountLease.isCurrent()) return false;
        if (result == null || result.status === 'rejected') {
          showDialog('Effect Not Sent', 'Your message is still here so you can try again.');
          return false;
        }
        if (result.status === 'outcome-unknown') {
          showDialog(
            'Effect Not Confirmed',
            'It may have been delivered. Check the conversation before sending another copy.',
          );
        }
        return true;
      } catch (error) {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] effect submission failed', error);
          showDialog('Effect Not Sent', 'Your message is still here so you can try again.');
        }
        return false;
      }
    },
    [accountLease, guid, imessageEffectsAvailable],
  );

  const onSendMention = useCallback(
    async (
      text: string,
      mentions: Array<{ start: number; length: number; address: string }>,
    ): Promise<boolean> => {
      if (
        !imessageMentionsAvailable ||
        mentionParticipants.length < 2 ||
        !accountLease.isCurrent()
      ) {
        return false;
      }
      try {
        const result = await sendMention(
          { chatGuid: guid, text, mentions },
          accountLease,
          presentSendIssue,
        );
        if (!accountLease.isCurrent()) return false;
        if (result == null || result.status === 'rejected') {
          showDialog('Mention Not Sent', 'Your message is still here so you can try again.');
          return false;
        }
        if (result.status === 'outcome-unknown') {
          showDialog(
            'Mention Not Confirmed',
            'It may have been delivered. Check the conversation before sending another copy.',
          );
        }
        return true;
      } catch (error) {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] mention submission failed', error);
          showDialog('Mention Not Sent', 'Your message is still here so you can try again.');
        }
        return false;
      }
    },
    [accountLease, guid, imessageMentionsAvailable, mentionParticipants.length],
  );

  const onSendFormatted = useCallback(
    async (text: string, textFormatting: IMessageTextFormattingRange[]): Promise<boolean> => {
      if (!imessageFormattedAvailable || !accountLease.isCurrent()) return false;
      try {
        const result = await sendFormatted(
          { chatGuid: guid, text, textFormatting },
          accountLease,
          presentSendIssue,
        );
        if (!accountLease.isCurrent()) return false;
        if (result == null || result.status === 'rejected') {
          showDialog(
            'Formatted Message Not Sent',
            'Your message is still here so you can try again.',
          );
          return false;
        }
        if (result.status === 'outcome-unknown') {
          showDialog(
            'Formatted Message Not Confirmed',
            'It may have been delivered. Check the conversation before sending another copy.',
          );
        }
        return true;
      } catch (error) {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] formatted-message submission failed', error);
          showDialog(
            'Formatted Message Not Sent',
            'Your message is still here so you can try again.',
          );
        }
        return false;
      }
    },
    [accountLease, guid, imessageFormattedAvailable],
  );

  return { onSchedule, onScheduleAttachment, onSend, onSendEffect, onSendMention, onSendFormatted };
}
