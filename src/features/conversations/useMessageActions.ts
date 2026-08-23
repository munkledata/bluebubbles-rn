import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Share } from 'react-native';
import { parseReactionType, type ReactionBaseType } from '@core/reactions/reactionType';
import { parseMessageSummaryInfo, type MessageSummaryInfo } from '@core/models';
import { getDatabase } from '@db/database';
import { type MessagePreview } from '@db/repositories';
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
import { attachmentCacheCoordinator } from '@/services/download/attachmentCacheCoordinator';
import { scheduleReminder } from '@/services/notifications/remindersService';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { discardMessage, react, unsend } from '@/services/send';
import type { SelectedMessage } from '@ui';
import { pickReminderTime } from '@ui/conversations/pickReminderTime';
import { showDialog } from '@ui/dialog/dialogStore';
import { isDevServer } from '@utils/isDev';
import { isLocalFileUri, type BubbleRect } from '@utils';
import { devSendFakeReaction, devUnsendFake } from './devSeed';
import { stageForwardAttachmentHandoff } from './forwardAttachmentHandoff';
import { buildForwardParams } from './forwardParams';
import type { EnrichedMessage } from './useMessages';

export interface MessageActionsArgs {
  guid: string;
  /** The reactive message window — read through a ref by the stable callbacks. */
  messages: EnrichedMessage[];
  /** The chat's display title, for the reminder notification. */
  chatTitle: string;
  /** Account generation captured when the owning chat screen mounted. */
  accountLease?: RealtimeDeliveryLease;
  /** Must be the useState setters themselves (stable) — onSwipeReply's identity rides on it. */
  setReplyTo: (preview: MessagePreview | null) => void;
  setEditing: (editing: { guid: string; text: string } | null) => void;
}

/**
 * The chat screen's message-action handlers: the long-press menu (tapback/reply/edit/unsend/
 * copy/share/save/forward/delete/remind-later), the reply swipe, and multi-select with its
 * bulk actions. Owns the `selected` / `selectedGuids` / `threadFor` state; the screen is
 * thin wiring from these to MessageList / MessageActionsOverlay / ThreadSheet.
 *
 * CONTRACT: `onLongPressMessage`, `onSwipeReply`, and `onToggleSelect` are STABLE
 * (useCallback over refs/setters only) — they feed the memoized MessageList → MessageRow
 * chain, and a fresh closure per render would silently kill the row memoization.
 */
export function useMessageActions({
  guid,
  messages,
  chatTitle,
  accountLease,
  setReplyTo,
  setEditing,
}: MessageActionsArgs) {
  const router = useRouter();
  const isDev = isDevServer;
  const [screenLease] = useState(() => accountLease ?? captureRealtimeDeliveryLease());

  // Latest messages for the stable long-press callback (thread membership check).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const [selected, setSelected] = useState<SelectedMessage | null>(null);

  // Long-press a bubble → open the tapback/reply/edit menu. Stable so the
  // memoized message rows aren't re-rendered by a fresh closure each render.
  const onLongPressMessage = useCallback((msg: EnrichedMessage, rect: BubbleRect): void => {
    const mine = msg.reactions
      .filter((r) => r.isFromMe && r.baseType !== 'emoji')
      .map((r) => r.baseType)
      .filter((t): t is ReactionBaseType => !!parseReactionType(t));
    const myEmojis = msg.reactions
      .filter((r) => r.isFromMe && r.baseType === 'emoji' && !!r.emoji)
      .map((r) => r.emoji as string);
    setSelected({
      guid: msg.guid,
      text: msg.text,
      isFromMe: msg.isFromMe === 1,
      senderName: msg.senderName,
      mine,
      myEmojis,
      dateCreated: msg.dateCreated,
      // For the "Details" sheet: delivery/read/edit timestamps + this message's own service.
      dateDelivered: msg.dateDelivered,
      dateRead: msg.dateRead,
      dateEdited: msg.dateEdited,
      senderService: msg.senderService,
      isRetracted: !!msg.dateRetracted,
      // Any edited message offers "View Edit History" (independent of the own-recent Edit gate).
      isEdited: !!msg.dateEdited,
      // Parse the persisted JSON blob (raw string on the row) into the history shape, tolerantly —
      // a garbage/legacy value degrades to null (empty sheet), never throws. Threaded onto the
      // selection so the sheet needs no extra DB fetch (the row is already loaded).
      messageSummaryInfo: parseMessageSummaryInfo(msg.messageSummaryInfo),
      isTemp: msg.guid.startsWith('temp-'),
      sendState: msg.sendState,
      attachments: (msg.attachments ?? []).map((a) => ({
        guid: a.guid,
        localPath: a.localPath,
        mimeType: a.mimeType,
      })),
      // Thread membership: this message is a reply, or something in the loaded window replies to it.
      inThread:
        !!msg.threadOriginatorGuid ||
        messagesRef.current.some((m) => m.threadOriginatorGuid === msg.guid),
      threadOriginatorGuid: msg.threadOriginatorGuid,
      // The pressed bubble's on-screen rectangle → the overlay floats the tapback bar + menu
      // around it (iMessage-style). Absent → the overlay falls back to a centered sheet.
      anchorRect: rect,
    });
  }, []);

  // "View Thread": the reply chain sheet, keyed by the thread ORIGINATOR's guid.
  const [threadFor, setThreadFor] = useState<string | null>(null);
  const onViewThreadSelected = (): void => {
    if (!selected) return;
    setThreadFor(selected.threadOriginatorGuid ?? selected.guid);
  };

  // "View Edit History": the edit-history sheet. Wrapped so the wrapper's presence is the open
  // signal (null = closed) even when there's no synced summary info (an optimistic local edit) —
  // the sheet then shows an empty state. The value is already on the selection (parsed from the
  // reactive row), so no fetch is needed.
  const [editHistory, setEditHistory] = useState<{ info: MessageSummaryInfo | null } | null>(null);
  const onViewEditHistorySelected = (): void => {
    if (!selected) return;
    setEditHistory({ info: selected.messageSummaryInfo ?? null });
  };

  // "Details": the read-only message-info sheet. Presence of `details` is the open signal (null =
  // closed); the value is the current selection, so no fetch is needed.
  const [details, setDetails] = useState<SelectedMessage | null>(null);
  const onDetailsSelected = (): void => {
    if (selected) setDetails(selected);
  };

  // Multi-select mode: null = off; a Set of selected guids while active. Entered from the
  // long-press menu's "Select" (seeded with that message); exited via Done or after a bulk action.
  const [selectedGuids, setSelectedGuids] = useState<Set<string> | null>(null);
  const onEnterSelect = (): void => {
    if (selected) setSelectedGuids(new Set([selected.guid]));
  };
  const onToggleSelect = useCallback((msg: EnrichedMessage): void => {
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
      .filter((m) => set.has(m.guid) && !!m.text?.trim())
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
              for (const g of set) await discardMessage(g, now, screenLease);
            })();
            setSelectedGuids(null);
          },
        },
      ],
    );
  };

  // Swipe a bubble right past the threshold → reply to it (stable for the memoized rows).
  const onSwipeReply = useCallback(
    (msg: EnrichedMessage): void => {
      if (msg.guid.startsWith('temp-')) return;
      setReplyTo({
        guid: msg.guid,
        text: msg.text,
        isFromMe: msg.isFromMe,
        senderName: msg.senderName,
        hasAttachments: msg.hasAttachments,
      });
    },
    [setReplyTo],
  );

  const onEditSelected = (): void => {
    if (!selected) return;
    setReplyTo(null);
    setEditing({ guid: selected.guid, text: selected.text ?? '' });
  };

  const onUnsendSelected = (): void => {
    if (!selected) return;
    const g = selected.guid;
    showDialog('Unsend message?', 'This removes it for you and retracts it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unsend',
        style: 'destructive',
        onPress: () => {
          if (isDev()) void devUnsendFake(g, screenLease);
          else void unsend({ messageGuid: g, chatGuid: guid }, screenLease);
        },
      },
    ]);
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
          onPress: () => void discardMessage(g, Date.now(), screenLease),
        },
      ],
    );
  };

  const onReact = (reaction: string, emoji?: string): void => {
    if (!selected || selected.isTemp) return;
    const args = {
      chatGuid: guid,
      targetGuid: selected.guid,
      reaction,
      emoji,
      selectedMessageText: selected.text ?? '',
    };
    if (isDev()) void devSendFakeReaction(guid, selected.guid, reaction, emoji, screenLease);
    else void react(args, screenLease);
  };

  const onReplyToSelected = (): void => {
    if (!selected || selected.isTemp) return;
    setReplyTo({
      guid: selected.guid,
      text: selected.text,
      isFromMe: selected.isFromMe ? 1 : 0,
      senderName: selected.senderName,
      hasAttachments: 0,
    });
  };

  const onCopySelected = (): void => {
    if (selected?.text) void Clipboard.setStringAsync(selected.text);
  };

  // Share a message to another app via the OS share sheet: prefer a downloaded attachment file
  // (expo-sharing), else the message text (RN Share). An undownloaded attachment prompts to open
  // it first (which triggers the download).
  const onShareSelected = (): void => {
    const sel = selected;
    if (!sel) return;
    void (async () => {
      const att = sel.attachments.find((a) => isLocalFileUri(a.localPath));
      if (att?.localPath) {
        const res = await shareAttachment(att.localPath, att.mimeType);
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
        if (sel.text) await Share.share({ message: sel.text });
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
        onPress: () => void discardMessage(g, Date.now(), screenLease),
      },
    ]);
  };

  // Forward: open the new-message composer pre-filled with this message's text and/or its
  // DOWNLOADED attachments (staged behind a one-time nonce; no file path enters the public route).
  // An attachment-only message with nothing downloaded gets the existing-style "download first"
  // notice — forwarding never triggers a download.
  const onForwardSelected = (): void => {
    if (!selected) return;
    const plan = buildForwardParams(
      { text: selected.text, attachments: selected.attachments },
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
    const atts = selected?.attachments ?? [];
    if (atts.length === 0) return;
    void (async () => {
      const res = await saveAttachmentsToPhotos(atts.map((a) => a.localPath));
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
    if (!selected) return;
    const msg = selected;
    void (async () => {
      try {
        const when = await pickReminderTime();
        if (when == null || !screenLease.isCurrent()) return;
        await scheduleReminder(
          getDatabase(),
          {
            chatGuid: guid,
            messageGuid: msg.guid,
            chatTitle,
            messagePreview: msg.text,
            senderName: msg.senderName,
            scheduledFor: when,
            now: Date.now(),
          },
          undefined,
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
    onSwipeReply,
    onToggleSelect,
    onEnterSelect,
    onBulkCopy,
    onBulkDelete,
    onViewThreadSelected,
    onEditSelected,
    onUnsendSelected,
    onCancelSelected,
    onReact,
    onReplyToSelected,
    onCopySelected,
    onShareSelected,
    onDeleteSelected,
    onForwardSelected,
    onSaveSelected,
    onRemindLater,
  };
}
