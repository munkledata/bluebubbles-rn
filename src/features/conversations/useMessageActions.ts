import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Share } from 'react-native';
import {
  isAggregateRetractionTombstone,
  isExactMessagePartTopology,
} from '@core/messages/retraction';
import {
  parseMessagePartTopology,
  parseMessageSummaryInfo,
  type MessageSummaryInfo,
} from '@core/models';
import { parseReactionType, type ReactionBaseType } from '@core/reactions/reactionType';
import { parseRcsChatGuid, parseRcsMessageGuid } from '@core/rcs/providerIdentity';
import { bodyTextFromRuns, parseAttributedRuns } from '@core/richtext';
import type { MessagePreview } from '@db/repositories';
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
import { attachmentCacheCoordinator } from '@/services/download/attachmentCacheCoordinator';
import { scheduleMessageReminder } from '@/services/notifications/remindersService';
import { deleteMessageFromMac } from '@/services/remoteMessageDeleteUiService';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { discardMessage, react, unsend } from '@/services/send';
import { useRcsMutationEnabled } from '@state/sessionStore';
import type { SelectedMessage } from '@ui';
import { pickReminderTime } from '@ui/conversations/pickReminderTime';
import { presentDiscardMessageResult, presentSendIssue } from '@ui/conversations/sendNotices';
import { showDialog } from '@ui/dialog/dialogStore';
import { isDevServer } from '@utils/isDev';
import {
  buildMessageSnippet,
  isLocalFileUri,
  isRcsChatGuid,
  isUserFileAttachment,
  type BubbleRect,
} from '@utils';
import { devSendFakeReaction } from './devSeed';
import { stageForwardAttachmentHandoff } from './forwardAttachmentHandoff';
import { buildForwardParams } from './forwardParams';
import type { EnrichedMessage } from './useMessages';

function actionContentOf(msg: EnrichedMessage) {
  const bodyRuns = parseAttributedRuns(msg.attributedBody, msg.text);
  const bodyText = bodyTextFromRuns(bodyRuns);
  // Private Messages-extension payloads are not visible user attachments and therefore cannot own
  // a part in this aggregate action target. Keep exactly MessageBubble's filter (and the headless
  // getMessageActionPartLayoutByGuid query), so every surface targets the same parts.
  const visibleAttachments = (msg.attachments ?? []).filter(
    (attachment) =>
      !attachment.hideAttachment && isUserFileAttachment(attachment, msg.balloonBundleId),
  );
  const visibleAttachmentCount = visibleAttachments.length;
  return {
    bodyRuns,
    bodyText,
    visibleAttachments,
    visibleAttachmentCount,
  };
}

const IMESSAGE_EDIT_WINDOW_MS = 15 * 60_000;
const IMESSAGE_UNSEND_WINDOW_MS = 2 * 60_000;

function canEditExactPlainTextPartZero(msg: EnrichedMessage, now: number): boolean {
  const { bodyRuns, bodyText, visibleAttachmentCount } = actionContentOf(msg);
  const topology = parseMessagePartTopology(msg.messagePartTopology);
  const age = msg.dateCreated == null ? null : now - msg.dateCreated;
  return (
    msg.isFromMe === 1 &&
    msg.sendState === 'sent' &&
    !msg.guid.startsWith('temp-') &&
    !isAggregateRetractionTombstone(msg) &&
    msg.dateRetracted == null &&
    (msg.senderService == null || msg.senderService === 'iMessage') &&
    age != null &&
    age >= 0 &&
    age <= IMESSAGE_EDIT_WINDOW_MS &&
    bodyText.trim().length > 0 &&
    !bodyText.includes('\uFFFC') &&
    bodyRuns.every((run) => !run.attachment && !run.mention) &&
    !msg.subject?.trim() &&
    !msg.balloonBundleId &&
    visibleAttachmentCount === 0 &&
    msg.attachments.length === 0 &&
    !msg.hasAttachments &&
    isExactMessagePartTopology(topology) &&
    topology.currentParts.length === 1 &&
    topology.currentParts[0]?.index === 0 &&
    topology.currentParts[0]?.kind === 'text'
  );
}

function canUnsendExactPlainTextPartZero(msg: EnrichedMessage, now: number): boolean {
  const { bodyRuns, bodyText, visibleAttachmentCount } = actionContentOf(msg);
  const topology = parseMessagePartTopology(msg.messagePartTopology);
  const summary = parseMessageSummaryInfo(msg.messageSummaryInfo);
  const hasEditedPartHistory = Object.values(summary?.editedParts ?? {}).some(
    (revisions) => (revisions?.length ?? 0) > 0,
  );
  const age = msg.dateCreated == null ? null : now - msg.dateCreated;
  return (
    msg.isFromMe === 1 &&
    msg.sendState === 'sent' &&
    msg.isSent === 1 &&
    msg.error === 0 &&
    !msg.guid.startsWith('temp-') &&
    !isAggregateRetractionTombstone(msg) &&
    msg.dateRetracted == null &&
    msg.dateEdited == null &&
    !hasEditedPartHistory &&
    (msg.senderService == null || msg.senderService === 'iMessage') &&
    age != null &&
    age >= 0 &&
    age <= IMESSAGE_UNSEND_WINDOW_MS &&
    bodyText.trim().length > 0 &&
    !bodyText.includes('\uFFFC') &&
    bodyRuns.every((run) => !run.attachment && !run.mention) &&
    !msg.subject?.trim() &&
    !msg.balloonBundleId &&
    !msg.payloadData &&
    !msg.expressiveSendStyleId &&
    !msg.threadOriginatorGuid &&
    msg.threadOriginatorPart == null &&
    !msg.associatedMessageGuid &&
    !msg.associatedMessageType &&
    !msg.associatedMessageEmoji &&
    visibleAttachmentCount === 0 &&
    msg.attachments.length === 0 &&
    !msg.hasAttachments &&
    isExactMessagePartTopology(topology) &&
    topology.currentParts.length === 1 &&
    topology.currentParts[0]?.index === 0 &&
    topology.currentParts[0]?.kind === 'text'
  );
}

function canTargetReplyPartZero(msg: EnrichedMessage): boolean {
  const topology = parseMessagePartTopology(msg.messagePartTopology);
  return (
    !msg.guid.startsWith('temp-') &&
    !isAggregateRetractionTombstone(msg) &&
    (msg.senderService == null || msg.senderService === 'iMessage') &&
    isExactMessagePartTopology(topology) &&
    topology.currentParts.some((part) => part.index === 0)
  );
}

/** Whole-message deletion needs stable server identity but deliberately does not inspect parts. */
function canRemoteDeleteWholeMessage(msg: EnrichedMessage): boolean {
  return (
    msg.guid.length > 0 &&
    msg.guid.trim() === msg.guid &&
    !msg.guid.startsWith('temp-') &&
    !isAggregateRetractionTombstone(msg) &&
    (msg.senderService == null || msg.senderService === 'iMessage')
  );
}

function replyPreviewOf(msg: EnrichedMessage): MessagePreview {
  const content = actionContentOf(msg);
  return {
    guid: msg.guid,
    text: content.bodyText || msg.text,
    subject: msg.subject,
    senderName: msg.senderName,
    isFromMe: msg.isFromMe,
    hasAttachments: msg.hasAttachments,
    attachmentDescription: msg.attachmentDescription,
    balloonBundleId: msg.balloonBundleId,
    partCount: msg.partCount,
    targetPartIndex: 0,
    hasVisibleAttachments: content.visibleAttachmentCount > 0 ? 1 : 0,
    isRetracted: false,
  };
}

function retractionFingerprintOf(msg: EnrichedMessage): string {
  return JSON.stringify([
    msg.dateRetracted ?? null,
    msg.retractionState ?? null,
    msg.messagePartTopology ?? null,
    msg.messageSummaryInfo ?? null,
  ]);
}

export interface MessageActionsArgs {
  guid: string;
  /** The reactive message window — read through a ref by the stable callbacks. */
  messages: EnrichedMessage[];
  /** The chat's display title, for the reminder notification. */
  chatTitle: string;
  /** Account generation captured when the owning chat screen mounted. */
  accountLease?: RealtimeDeliveryLease;
  /** Proven existing one-to-one chat plus live narrow helper reaction capability. */
  imessageReactionsAvailable?: boolean;
  /** Proven existing one-to-one chat plus live narrow helper reply capability. */
  imessageRepliesAvailable?: boolean;
  /** Proven existing one-to-one chat plus live narrow helper edit capability. */
  imessageEditsAvailable?: boolean;
  /** Proven existing one-to-one chat plus live narrow helper unsend capability. */
  imessageUnsendsAvailable?: boolean;
  /** Proven existing one-to-one or group chat plus live whole-message remote-delete capability. */
  imessageRemoteDeleteAvailable?: boolean;
  /** Select one exact message-part-zero target for the composer. */
  setReplyTo?: (preview: MessagePreview | null) => void;
  /** Switch the existing composer into exact-part-zero edit mode. */
  setEditing?: (editing: { guid: string; text: string; partIndex: 0 } | null) => void;
}

/**
 * The chat screen's message-action handlers: RCS reactions, local copy/share/save/forward/delete/
 * remind-later/details, and multi-select with its bulk actions.
 *
 * CONTRACT: `onLongPressMessage` and `onToggleSelect` are STABLE
 * (useCallback over refs/setters only) — they feed the memoized MessageList → MessageRow
 * chain, and a fresh closure per render would silently kill the row memoization.
 */
export function useMessageActions({
  guid,
  messages,
  chatTitle,
  accountLease,
  imessageReactionsAvailable = false,
  imessageRepliesAvailable = false,
  imessageEditsAvailable = false,
  imessageUnsendsAvailable = false,
  imessageRemoteDeleteAvailable = false,
  setReplyTo,
  setEditing,
}: MessageActionsArgs) {
  const router = useRouter();
  const isDev = isDevServer;
  const rcsEnabled = useRcsMutationEnabled(guid);
  const [screenLease] = useState(() => accountLease ?? captureRealtimeDeliveryLease());
  const imessageReactionInFlight = useRef(false);
  const imessageUnsendInFlight = useRef(false);
  const imessageRemoteDeleteInFlight = useRef(false);
  const rcsProviderEpoch = parseRcsChatGuid(guid)?.providerEpoch ?? null;

  // Latest messages for the stable long-press callback (thread membership check).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const [selected, setSelected] = useState<SelectedMessage | null>(null);

  const currentSelectedMessage = (): EnrichedMessage | null => {
    if (!selected) return null;
    const current = messagesRef.current.find((message) => message.guid === selected.guid);
    if (
      !current ||
      isAggregateRetractionTombstone(current) ||
      selected.sourceRetractionFingerprint !== retractionFingerprintOf(current)
    ) {
      return null;
    }
    return current;
  };

  // Long-press a bubble → open the local-action menu (plus RCS reactions). Stable so the
  // memoized message rows aren't re-rendered by a fresh closure each render.
  const onLongPressMessage = useCallback(
    (msg: EnrichedMessage, rect: BubbleRect): void => {
      if (isAggregateRetractionTombstone(msg)) return;
      const { bodyText, visibleAttachments, visibleAttachmentCount } = actionContentOf(msg);
      const rcsReaction =
        rcsEnabled &&
        rcsProviderEpoch !== null &&
        parseRcsMessageGuid(msg.guid)?.providerEpoch === rcsProviderEpoch;
      const topology = parseMessagePartTopology(msg.messagePartTopology);
      const imessageReaction =
        imessageReactionsAvailable &&
        !isRcsChatGuid(guid) &&
        !msg.guid.startsWith('temp-') &&
        isExactMessagePartTopology(topology) &&
        topology.currentParts.length === 1 &&
        topology.currentParts[0]?.index === 0;
      const imessageReply = imessageRepliesAvailable && canTargetReplyPartZero(msg);
      const imessageEdit = imessageEditsAvailable && canEditExactPlainTextPartZero(msg, Date.now());
      const imessageUnsend =
        imessageUnsendsAvailable && canUnsendExactPlainTextPartZero(msg, Date.now());
      const imessageRemoteDelete =
        imessageRemoteDeleteAvailable && canRemoteDeleteWholeMessage(msg);
      const canReact = rcsReaction || imessageReaction;
      const mine = canReact
        ? msg.reactions
            .filter((r) => r.isFromMe && r.baseType !== 'emoji')
            .map((r) => r.baseType)
            .filter((t): t is ReactionBaseType => !!parseReactionType(t))
        : [];
      const myEmojis = rcsReaction
        ? msg.reactions
            .filter((r) => r.isFromMe && r.baseType === 'emoji' && !!r.emoji)
            .map((r) => r.emoji as string)
        : [];
      setSelected({
        guid: msg.guid,
        text: msg.text,
        bodyText,
        subject: msg.subject,
        balloonBundleId: msg.balloonBundleId,
        hasAttachments: msg.hasAttachments,
        // A balloon payload is private extension data even when a lean notification omitted the
        // attachment's hide flag; an iMessage app's real photos count like any other.
        hasVisibleAttachments: visibleAttachmentCount > 0 ? 1 : 0,
        attachmentDescription: msg.attachmentDescription,
        isFromMe: msg.isFromMe === 1,
        senderName: msg.senderName,
        mine,
        myEmojis,
        canReact,
        canUseEmojiReactions: rcsReaction,
        replyPartIndex: imessageReply ? 0 : undefined,
        editPartIndex: imessageEdit ? 0 : undefined,
        unsendPartIndex: imessageUnsend ? 0 : undefined,
        canRemoteDeleteFromMac: imessageRemoteDelete,
        dateCreated: msg.dateCreated,
        // For the "Details" sheet: delivery/read/edit timestamps + this message's own service.
        dateDelivered: msg.dateDelivered,
        dateRead: msg.dateRead,
        dateEdited: msg.dateEdited,
        senderService: msg.senderService,
        isRetracted: isAggregateRetractionTombstone(msg),
        sourceRetractionFingerprint: retractionFingerprintOf(msg),
        // Read-only history remains useful independently of the narrow outgoing edit command.
        isEdited: !!msg.dateEdited,
        messageSummaryInfo: parseMessageSummaryInfo(msg.messageSummaryInfo),
        isTemp: msg.guid.startsWith('temp-'),
        sendState: msg.sendState,
        // Keep private Messages-extension payload blobs out of Share/Save/Forward as well as the
        // bubble. A lean notification can report hideAttachment=0, so on an iMessage app message
        // only real typed files (never Apple's payload file) are offered.
        attachments: visibleAttachments.map((a) => ({
          guid: a.guid,
          localPath: a.localPath,
          mimeType: a.mimeType,
        })),
        inThread:
          !!msg.threadOriginatorGuid ||
          messagesRef.current.some((candidate) => candidate.threadOriginatorGuid === msg.guid),
        threadOriginatorGuid: msg.threadOriginatorGuid,
        // The pressed bubble's on-screen rectangle → the overlay floats the tapback bar + menu
        // around it (iMessage-style). Absent → the overlay falls back to a centered sheet.
        anchorRect: rect,
      });
    },
    [
      guid,
      imessageEditsAvailable,
      imessageReactionsAvailable,
      imessageRepliesAvailable,
      imessageRemoteDeleteAvailable,
      imessageUnsendsAvailable,
      rcsEnabled,
      rcsProviderEpoch,
    ],
  );

  const onSwipeReply = useCallback(
    (msg: EnrichedMessage): void => {
      if (!imessageRepliesAvailable || !setReplyTo || !canTargetReplyPartZero(msg)) return;
      setReplyTo(replyPreviewOf(msg));
    },
    [imessageRepliesAvailable, setReplyTo],
  );

  const onReplyToSelected = (): void => {
    const current = currentSelectedMessage();
    if (
      !imessageRepliesAvailable ||
      !setReplyTo ||
      selected?.replyPartIndex !== 0 ||
      !current ||
      !canTargetReplyPartZero(current)
    ) {
      return;
    }
    setReplyTo(replyPreviewOf(current));
  };

  const onEditSelected = (): void => {
    const current = currentSelectedMessage();
    if (
      !imessageEditsAvailable ||
      !setEditing ||
      selected?.editPartIndex !== 0 ||
      !current ||
      !canEditExactPlainTextPartZero(current, Date.now())
    ) {
      return;
    }
    const bodyText = actionContentOf(current).bodyText;
    setReplyTo?.(null);
    setEditing({ guid: current.guid, text: bodyText, partIndex: 0 });
  };

  const onUnsendSelected = (): void => {
    const initial = currentSelectedMessage();
    if (
      !imessageUnsendsAvailable ||
      selected?.unsendPartIndex !== 0 ||
      !initial ||
      !canUnsendExactPlainTextPartZero(initial, Date.now())
    ) {
      return;
    }
    const targetGuid = initial.guid;
    showDialog(
      'Unsend message?',
      'This retracts the message for everyone. You can still delete your local copy separately.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unsend',
          style: 'destructive',
          onPress: () => {
            if (imessageUnsendInFlight.current) return;
            const current = messagesRef.current.find((message) => message.guid === targetGuid);
            if (
              !imessageUnsendsAvailable ||
              !current ||
              !canUnsendExactPlainTextPartZero(current, Date.now())
            ) {
              showDialog('Unsend Unavailable', 'This message can no longer be safely unsent.');
              return;
            }
            imessageUnsendInFlight.current = true;
            void unsend({ messageGuid: current.guid, chatGuid: guid, partIndex: 0 }, screenLease)
              .then((result) => {
                if (!screenLease.isCurrent()) return;
                if (result == null || result.status === 'rejected') {
                  showDialog('Unsend Not Sent', 'The message was not retracted.');
                } else if (result.status === 'outcome-unknown') {
                  showDialog(
                    'Unsend Not Confirmed',
                    'It may have been retracted. Check the conversation before taking any further action.',
                  );
                }
              })
              .catch(() => {
                if (!screenLease.isCurrent()) return;
                showDialog(
                  'Unsend Not Confirmed',
                  'Couldn’t confirm whether the message was retracted. Check the conversation before taking any further action.',
                );
              })
              .finally(() => {
                imessageUnsendInFlight.current = false;
              });
          },
        },
      ],
    );
  };

  const onRemoteDeleteSelected = (): void => {
    const initial = currentSelectedMessage();
    if (
      !imessageRemoteDeleteAvailable ||
      selected?.canRemoteDeleteFromMac !== true ||
      !initial ||
      !canRemoteDeleteWholeMessage(initial)
    ) {
      return;
    }
    const targetGuid = initial.guid;
    showDialog(
      'Delete from Mac?',
      'Delete this whole message from Messages on your Mac? If Messages in iCloud is enabled, it may also be deleted from your other Apple devices. This does not unsend it for anyone else.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete from Mac',
          style: 'destructive',
          onPress: () => {
            if (imessageRemoteDeleteInFlight.current) return;
            const current = messagesRef.current.find((message) => message.guid === targetGuid);
            if (!current || !canRemoteDeleteWholeMessage(current)) {
              showDialog(
                'Remote Delete Unavailable',
                'This message can no longer be safely deleted from the Mac.',
              );
              return;
            }
            imessageRemoteDeleteInFlight.current = true;
            void deleteMessageFromMac({ messageGuid: current.guid, chatGuid: guid }, screenLease)
              .then((result) => {
                if (!screenLease.isCurrent()) return;
                if (result == null || result.status === 'rejected') {
                  showDialog('Not Deleted from Mac', 'The message was not deleted from the Mac.');
                } else if (result.status === 'outcome-unknown') {
                  showDialog(
                    'Deletion Not Confirmed',
                    'Couldn’t confirm whether the message was deleted. Check Messages on your Mac before trying again.',
                  );
                }
              })
              .catch(() => {
                if (!screenLease.isCurrent()) return;
                showDialog(
                  'Deletion Not Confirmed',
                  'Couldn’t confirm whether the message was deleted. Check Messages on your Mac before trying again.',
                );
              })
              .finally(() => {
                imessageRemoteDeleteInFlight.current = false;
              });
          },
        },
      ],
    );
  };

  // Read-only received-message affordances do not depend on the retired helper send path.
  const [threadFor, setThreadFor] = useState<string | null>(null);
  const onViewThreadSelected = (): void => {
    if (!currentSelectedMessage() || !selected) return;
    setThreadFor(selected.threadOriginatorGuid ?? selected.guid);
  };

  const [editHistory, setEditHistory] = useState<{ info: MessageSummaryInfo | null } | null>(null);
  const onViewEditHistorySelected = (): void => {
    const current = currentSelectedMessage();
    if (!current) return;
    setEditHistory({ info: parseMessageSummaryInfo(current.messageSummaryInfo) });
  };

  // "Details": the read-only message-info sheet. Presence of `details` is the open signal (null =
  // closed); the value is the current selection, so no fetch is needed.
  const [details, setDetails] = useState<SelectedMessage | null>(null);
  const onDetailsSelected = (): void => {
    if (currentSelectedMessage() && selected) setDetails(selected);
  };

  // Multi-select mode: null = off; a Set of selected guids while active. Entered from the
  // long-press menu's "Select" (seeded with that message); exited via Done or after a bulk action.
  const [selectedGuids, setSelectedGuids] = useState<Set<string> | null>(null);

  // A retraction can arrive while an action, history, or details sheet is open. Those surfaces
  // contain snapshots, so retire them as soon as the reactive DB row changes its retraction proof.
  useEffect(() => {
    if (!selected) return;
    const current = messages.find((message) => message.guid === selected.guid);
    if (
      current &&
      !isAggregateRetractionTombstone(current) &&
      selected.sourceRetractionFingerprint === retractionFingerprintOf(current)
    ) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(null);
    setEditHistory(null);
    setDetails(null);
  }, [messages, selected]);

  useEffect(() => {
    if (selectedGuids == null) return;
    const visibleGuids = new Set(
      messages
        .filter((message) => !isAggregateRetractionTombstone(message))
        .map((message) => message.guid),
    );
    const next = new Set([...selectedGuids].filter((messageGuid) => visibleGuids.has(messageGuid)));
    if (next.size === selectedGuids.size) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedGuids(next.size > 0 ? next : null);
  }, [messages, selectedGuids]);
  const onEnterSelect = (): void => {
    if (currentSelectedMessage() && selected) setSelectedGuids(new Set([selected.guid]));
  };
  const onToggleSelect = useCallback((msg: EnrichedMessage): void => {
    if (isAggregateRetractionTombstone(msg)) return;
    setSelectedGuids((cur) => {
      if (cur == null) return cur;
      const next = new Set(cur);
      if (next.has(msg.guid)) next.delete(msg.guid);
      else next.add(msg.guid);
      return next;
    });
  }, []);
  const onBulkCopy = (): void => {
    const set = selectedGuids;
    if (!set || set.size === 0) return;
    // Chronological order (messages is newest-first) so the copied text reads top-down.
    const texts = [...messagesRef.current]
      .reverse()
      .filter((m) => set.has(m.guid) && !isAggregateRetractionTombstone(m) && !!m.text?.trim())
      .map((m) => m.text!.trim());
    if (texts.length > 0) void Clipboard.setStringAsync(texts.join('\n'));
    setSelectedGuids(null);
  };
  const onBulkDelete = (): void => {
    const set = selectedGuids;
    if (!set || set.size === 0) return;
    showDialog(
      `Delete ${set.size} ${set.size === 1 ? 'message' : 'messages'}?`,
      'This removes them from this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            // One timestamp for the whole selection so a bulk delete tombstones as one act.
            const now = Date.now();
            // SEQUENTIALLY, and that await is load-bearing. `discardMessage` opens a write
            // TRANSACTION, and the transaction queue slot is claimed SYNCHRONOUSLY — so N
            // unawaited calls claim all N slots in loop order before any of them runs, and each
            // chain's later plain writes (the tombstone + the chat sort-key recompute) are then
            // issued while the NEXT message's transaction is open and silently join it. Every
            // tombstone but the last would be durable only because a sibling happened to commit,
            // and one rollback would take the previous message's deletion with it — invisibly,
            // since nothing awaits these. Awaiting means chain i is finished before chain i+1
            // even constructs its transaction.
            //
            // discardMessage, not the raw tombstone: a selection can include an optimistic row
            // whose POST is still in flight, and that one also has to take its retry ladder with
            // it or the queue re-POSTs the message the user just deleted.
            void (async () => {
              for (const g of set) {
                const result = await discardMessage(g, now, screenLease);
                if (screenLease.isCurrent()) presentDiscardMessageResult(result);
              }
            })();
            setSelectedGuids(null);
          },
        },
      ],
    );
  };

  const onCancelSelected = (): void => {
    if (!selected) return;
    const g = selected.guid;
    const sending = selected.sendState === 'sending';
    showDialog(
      sending ? 'Cancel sending?' : 'Remove message?',
      sending
        ? 'Stop sending this message and remove it.'
        : 'Remove this unsent message from the conversation.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          // discardMessage, NOT the optimistic-only cancel. `selected` is frozen at long-press and
          // never re-derived, so by the time the user has read the menu and confirmed the dialog
          // (seconds) the send may have completed — promoted to its real guid, or flipped to 'sent'
          // keeping the temp guid on the RCS/AppleScript paths. The optimistic-only write then
          // matches nothing, and its boolean is discarded: the dialog closes and the destructive
          // action the user asked for silently does nothing, with Delete deliberately hidden from
          // this menu as the alternative. discardMessage falls through to the tombstone for
          // anything its guarded first step does not own, so the message is removed either way.
          text: sending ? 'Cancel Sending' : 'Remove',
          style: 'destructive',
          onPress: () => {
            void discardMessage(g, Date.now(), screenLease).then((result) => {
              if (screenLease.isCurrent()) presentDiscardMessageResult(result);
            });
          },
        },
      ],
    );
  };

  const onReact = (reaction: string, emoji?: string): void => {
    const current = currentSelectedMessage();
    const parsed = parseReactionType(reaction);
    const rcsReaction =
      rcsEnabled &&
      rcsProviderEpoch !== null &&
      parseRcsMessageGuid(current?.guid)?.providerEpoch === rcsProviderEpoch;
    const topology = current ? parseMessagePartTopology(current.messagePartTopology) : null;
    const imessageReaction =
      imessageReactionsAvailable &&
      current != null &&
      !isRcsChatGuid(guid) &&
      isExactMessagePartTopology(topology) &&
      topology.currentParts.length === 1 &&
      topology.currentParts[0]?.index === 0 &&
      parsed?.baseType !== 'emoji' &&
      emoji === undefined;
    if (!current || !parsed || (!rcsReaction && !imessageReaction)) {
      return;
    }
    if (imessageReaction && imessageReactionInFlight.current) return;
    const { bodyText } = actionContentOf(current);
    const partIndex = 0;
    const args = {
      chatGuid: guid,
      targetGuid: current.guid,
      reaction,
      emoji,
      partIndex,
      selectedMessageText: bodyText || current.text || '',
    };
    if (isDev() && rcsReaction)
      void devSendFakeReaction(guid, current.guid, reaction, emoji, partIndex, screenLease);
    else {
      if (imessageReaction) imessageReactionInFlight.current = true;
      void react(args, screenLease, presentSendIssue)
        .catch(() => {
          if (!screenLease.isCurrent()) return;
          showDialog(
            'Reaction not confirmed',
            imessageReaction
              ? 'It may have sent. Check the conversation before trying again.'
              : 'Couldn’t send this reaction.',
          );
        })
        .finally(() => {
          if (imessageReaction) imessageReactionInFlight.current = false;
        });
    }
  };

  const onCopySelected = (): void => {
    const current = currentSelectedMessage();
    if (!current) return;
    const text = actionContentOf(current).bodyText || current.text;
    if (text) void Clipboard.setStringAsync(text);
  };

  // Share a message to another app via the OS share sheet: prefer a downloaded attachment file
  // (expo-sharing), else the message text (RN Share). An undownloaded attachment prompts to open
  // it first (which triggers the download).
  const onShareSelected = (): void => {
    void (async () => {
      const current = currentSelectedMessage();
      if (!current || !screenLease.isCurrent()) return;
      const content = actionContentOf(current);
      const att = content.visibleAttachments.find((a) => isLocalFileUri(a.localPath));
      if (att?.localPath) {
        const res = await shareAttachment(att.localPath, att.mimeType, screenLease.isCurrent);
        if (!screenLease.isCurrent()) return;
        if (res.ok) return;
        // Report it and STOP. The two tempting fall-throughs are both wrong here: the notice below
        // blames a missing download (the file was there), and sharing `sel.text` would quietly send
        // a captioned photo's CAPTION to whichever app the user picked, when they asked to share
        // the picture. The text fallback stays for its original case — no downloaded attachment.
        showDialog(
          'Share',
          res.reason === 'unavailable'
            ? 'Sharing isn’t available on this device.'
            : 'Couldn’t open the share sheet for this attachment.',
        );
        return;
      }
      try {
        const text = content.bodyText || current.text;
        if (text) await Share.share({ message: text });
        else showDialog('Share', 'Open the attachment first to download it, then Share again.');
      } catch {
        // user cancelled the share sheet — no-op
      }
    })();
  };

  // Delete a message from the local device (parity with the old app's local Delete). The reactive
  // query drops it from the list. It is a TOMBSTONE, not a row removal (deleteMessageLocal): the
  // server still has the message, and ensureChatSynced re-pages this chat on every open — a hard
  // delete would be undone the very next time the thread is opened, not by some later full re-sync.
  const onDeleteSelected = (): void => {
    if (!selected) return;
    const g = selected.guid;
    showDialog('Delete message?', 'This removes it from this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void discardMessage(g, Date.now(), screenLease).then((result) => {
            if (screenLease.isCurrent()) presentDiscardMessageResult(result);
          });
        },
      },
    ]);
  };

  // Forward: open the new-message composer pre-filled with this message's text and/or its
  // DOWNLOADED attachments (staged behind a one-time nonce; no file path enters the public route).
  // An attachment-only message with nothing downloaded gets the existing-style "download first"
  // notice — forwarding never triggers a download.
  const onForwardSelected = (): void => {
    const current = currentSelectedMessage();
    if (!current) return;
    const content = actionContentOf(current);
    const plan = buildForwardParams(
      {
        text: content.bodyText || current.text,
        attachments: content.visibleAttachments.map((attachment) => ({
          guid: attachment.guid,
          localPath: attachment.localPath,
          mimeType: attachment.mimeType,
        })),
      },
      (attachments) =>
        stageForwardAttachmentHandoff({
          nonce: Crypto.randomUUID(),
          attachments,
          isCurrent: screenLease.isCurrent,
          protectPath: (path) => attachmentCacheCoordinator.protect(path),
        }),
    );
    if (plan.kind === 'notice') showDialog('Forward', plan.message);
    else if (plan.kind === 'navigate') router.push({ pathname: '/new-chat', params: plan.params });
  };

  // Save the message's attachment(s) to the device gallery. Saves any already-downloaded local
  // file; if none is downloaded yet, tells the user to open it first (which triggers the download).
  const onSaveSelected = (): void => {
    const current = currentSelectedMessage();
    const atts = current ? actionContentOf(current).visibleAttachments : [];
    if (atts.length === 0 || !screenLease.isCurrent()) return;
    void (async () => {
      const res = await saveAttachmentsToPhotos(
        atts.map((a) => a.localPath),
        screenLease.isCurrent,
      );
      if (!screenLease.isCurrent()) return;
      if (res.status === 'denied') {
        showDialog('Save', 'Photos permission is required to save attachments.');
      } else if (res.status === 'error') {
        showDialog('Save', 'Couldn’t save the attachment.');
      } else {
        showDialog(
          'Save',
          res.status === 'saved'
            ? `Saved ${res.saved} ${res.saved === 1 ? 'item' : 'items'} to Photos.`
            : 'Open the attachment first to download it, then try Save again.',
        );
      }
    })();
  };

  const onRemindLater = (): void => {
    if (!currentSelectedMessage()) return;
    void (async () => {
      try {
        const when = await pickReminderTime();
        if (when == null || !screenLease.isCurrent()) return;
        const msg = currentSelectedMessage();
        if (!msg) return;
        const content = actionContentOf(msg);
        await scheduleMessageReminder(
          {
            chatGuid: guid,
            messageGuid: msg.guid,
            chatTitle,
            messagePreview:
              buildMessageSnippet({
                text: content.bodyText || msg.text,
                subject: msg.subject,
                hasAttachments: msg.hasAttachments,
                hasVisibleAttachments: content.visibleAttachmentCount > 0 ? 1 : 0,
                attachmentDescription: msg.attachmentDescription,
                balloonBundleId: msg.balloonBundleId,
                isRetracted: isAggregateRetractionTombstone(msg),
              }) || null,
            senderName: msg.senderName,
            scheduledFor: when,
            now: Date.now(),
          },
          screenLease,
        );
        if (screenLease.isCurrent()) {
          showDialog('Reminder set', 'You’ll be reminded about this message.');
        }
      } catch {
        if (screenLease.isCurrent()) showDialog('Reminder', 'Couldn’t set the reminder.');
      }
    })();
  };

  return {
    selected,
    setSelected,
    selectedGuids,
    setSelectedGuids,
    threadFor,
    setThreadFor,
    editHistory,
    setEditHistory,
    onViewEditHistorySelected,
    details,
    setDetails,
    onDetailsSelected,
    onLongPressMessage,
    ...(imessageRepliesAvailable ? { onSwipeReply, onReplyToSelected } : {}),
    ...(imessageEditsAvailable ? { onEditSelected } : {}),
    ...(imessageUnsendsAvailable ? { onUnsendSelected } : {}),
    ...(imessageRemoteDeleteAvailable ? { onRemoteDeleteSelected } : {}),
    onToggleSelect,
    onEnterSelect,
    onBulkCopy,
    onBulkDelete,
    onViewThreadSelected,
    onCancelSelected,
    onReact,
    onCopySelected,
    onShareSelected,
    onDeleteSelected,
    onForwardSelected,
    onSaveSelected,
    onRemindLater,
  };
}
