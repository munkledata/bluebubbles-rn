import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Share } from 'react-native';
import { parseReactionType, type ReactionBaseType } from '@core/reactions/reactionType';
import { getDatabase } from '@db/database';
import { deleteMessageByGuid, type MessagePreview } from '@db/repositories';
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
import { scheduleReminder } from '@/services/notifications/remindersService';
import { cancelOutgoing, react, unsend } from '@/services/send';
import type { SelectedMessage } from '@ui';
import { pickReminderTime } from '@ui/conversations/pickReminderTime';
import { showDialog } from '@ui/dialog/dialogStore';
import { isDevServer } from '@utils/isDev';
import { isLocalFileUri } from '@utils';
import { devSendFakeReaction, devUnsendFake } from './devSeed';
import type { EnrichedMessage } from './useMessages';

export interface MessageActionsArgs {
  guid: string;
  /** The reactive message window — read through a ref by the stable callbacks. */
  messages: EnrichedMessage[];
  /** The chat's display title, for the reminder notification. */
  chatTitle: string;
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
  setReplyTo,
  setEditing,
}: MessageActionsArgs) {
  const router = useRouter();
  const isDev = isDevServer;

  // Latest messages for the stable long-press callback (thread membership check).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const [selected, setSelected] = useState<SelectedMessage | null>(null);

  // Long-press a bubble → open the tapback/reply/edit menu. Stable so the
  // memoized message rows aren't re-rendered by a fresh closure each render.
  const onLongPressMessage = useCallback((msg: EnrichedMessage): void => {
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
      isRetracted: !!msg.dateRetracted,
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
    });
  }, []);

  // "View Thread": the reply chain sheet, keyed by the thread ORIGINATOR's guid.
  const [threadFor, setThreadFor] = useState<string | null>(null);
  const onViewThreadSelected = (): void => {
    if (!selected) return;
    setThreadFor(selected.threadOriginatorGuid ?? selected.guid);
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
            const db = getDatabase();
            for (const g of set) void deleteMessageByGuid(db, g);
            setSelectedGuids(null);
          },
        },
      ],
    );
  };

  // Swipe a bubble right past the threshold → reply to it (stable for the memoized rows).
  const onSwipeReply = useCallback(
    (msg: EnrichedMessage): void => {
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
          if (isDev()) void devUnsendFake(g);
          else void unsend({ messageGuid: g, chatGuid: guid });
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
          text: sending ? 'Cancel Sending' : 'Remove',
          style: 'destructive',
          onPress: () => void cancelOutgoing(g),
        },
      ],
    );
  };

  const onReact = (reaction: string, emoji?: string): void => {
    if (!selected) return;
    const args = {
      chatGuid: guid,
      targetGuid: selected.guid,
      reaction,
      emoji,
      selectedMessageText: selected.text ?? '',
    };
    if (isDev()) void devSendFakeReaction(guid, selected.guid, reaction, emoji);
    else void react(args);
  };

  const onReplyToSelected = (): void => {
    if (!selected) return;
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
      if (att?.localPath && (await shareAttachment(att.localPath, att.mimeType))) return;
      try {
        if (sel.text) await Share.share({ message: sel.text });
        else showDialog('Share', 'Open the attachment first to download it, then Share again.');
      } catch {
        // user cancelled the share sheet — no-op
      }
    })();
  };

  // Delete a message from the local device (parity with the old app's local Delete). The reactive
  // query drops it from the list. Note: a later full re-sync of this chat can bring it back, since
  // this is a local-only removal — same behavior as the old app.
  const onDeleteSelected = (): void => {
    if (!selected) return;
    const g = selected.guid;
    showDialog('Delete message?', 'This removes it from this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => void deleteMessageByGuid(getDatabase(), g),
      },
    ]);
  };

  // Forward: open the new-message composer pre-filled with this message's text (parity with the
  // old app's "Forward" → chat creator). Attachment forwarding is not yet supported.
  const onForwardSelected = (): void => {
    if (!selected?.text) return;
    router.push({ pathname: '/new-chat', params: { forwardText: selected.text } });
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
      const when = await pickReminderTime();
      if (when == null) return;
      try {
        await scheduleReminder(getDatabase(), {
          chatGuid: guid,
          messageGuid: msg.guid,
          chatTitle,
          messagePreview: msg.text,
          senderName: msg.senderName,
          scheduledFor: when,
          now: Date.now(),
        });
        showDialog('Reminder set', 'You’ll be reminded about this message.');
      } catch {
        showDialog('Reminder', 'Couldn’t set the reminder.');
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
