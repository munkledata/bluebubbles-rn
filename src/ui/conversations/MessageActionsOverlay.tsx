import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  PICKER_ORDER,
  reactionMeta,
  removalType,
  type ReactionBaseType,
} from '@core/reactions/reactionType';
import { useTheme } from '../theme';

export interface SelectedMessage {
  guid: string;
  text: string | null;
  isFromMe: boolean;
  senderName: string | null;
  /** Reaction types the current user has already applied to this message. */
  mine: ReactionBaseType[];
  dateCreated: number | null; // for the "recent" edit/unsend gate
  isRetracted: boolean;
  isTemp: boolean; // not yet on the server → can't edit/unsend
  /** Local send lifecycle of an optimistic message ('sending' | 'error' | 'sent'). */
  sendState: string;
  /** This message's attachments (for Save-to-device). */
  attachments: { guid: string; localPath: string | null; mimeType: string | null }[];
}

interface MessageActionsOverlayProps {
  selected: SelectedMessage | null;
  onClose: () => void;
  /** reaction is a base type ('love') or a removal ('-love'). */
  onReact: (reaction: string) => void;
  onReply: () => void;
  onRemindLater: () => void;
  onEdit: () => void;
  onUnsend: () => void;
  /** Cancel a still-queued/sending (or errored) optimistic message before it confirms. */
  onCancelSend: () => void;
  /** Copy the message text to the clipboard. */
  onCopy: () => void;
  /** Forward the message text to another conversation (opens the new-message composer). */
  onForward: () => void;
  /** Save the message's attachment(s) to the device gallery. */
  onSave: () => void;
}

// iMessage allows edit/unsend on your own messages for ~15 minutes.
const EDIT_WINDOW_MS = 15 * 60_000;

/**
 * Long-press menu: a tapback picker + Reply, plus Edit/Unsend on your own recent
 * messages. Built with a plain Modal + Pressable (no gesture-handler/reanimated).
 */
export function MessageActionsOverlay({
  selected,
  onClose,
  onReact,
  onReply,
  onRemindLater,
  onEdit,
  onUnsend,
  onCancelSend,
  onCopy,
  onForward,
  onSave,
}: MessageActionsOverlayProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const mine = new Set(selected?.mine ?? []);
  const hasText = !!selected?.text && selected.text.trim().length > 0;
  const hasAttachments = (selected?.attachments?.length ?? 0) > 0;

  const canEditUnsend =
    !!selected &&
    selected.isFromMe &&
    !selected.isRetracted &&
    !selected.isTemp &&
    selected.dateCreated != null &&
    Date.now() - selected.dateCreated <= EDIT_WINDOW_MS;

  // A still-optimistic own message (queued/sending or errored, not yet confirmed)
  // can be cancelled — drop it before it lands rather than only retry an error.
  const canCancel =
    !!selected &&
    selected.isFromMe &&
    !selected.isRetracted &&
    (selected.sendState === 'sending' || selected.sendState === 'error');

  const pick = (base: ReactionBaseType): void => {
    // Tapping a type you already applied removes it (toggle).
    onReact(mine.has(base) ? removalType(base) : base);
    onClose();
  };

  return (
    <Modal visible={!!selected} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + 12, backgroundColor: theme.color.background },
          ]}
        >
          <View style={[styles.picker, { backgroundColor: theme.color.secondaryBackground }]}>
            {PICKER_ORDER.map((t) => (
              <Pressable
                key={t}
                onPress={() => pick(t)}
                style={[styles.tap, mine.has(t) && { backgroundColor: theme.color.tint }]}
                accessibilityRole="button"
                accessibilityState={{ selected: mine.has(t) }}
                accessibilityLabel={reactionMeta(t).label}
              >
                <Text style={styles.emoji}>{reactionMeta(t).emoji}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            style={[styles.action, { borderTopColor: theme.color.separator }]}
            onPress={() => {
              onReply();
              onClose();
            }}
          >
            <Text style={[styles.actionText, { color: theme.color.tint }]}>Reply</Text>
          </Pressable>
          {hasText ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onCopy();
                onClose();
              }}
            >
              <Text style={[styles.actionText, { color: theme.color.tint }]}>Copy</Text>
            </Pressable>
          ) : null}
          {hasText ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onForward();
                onClose();
              }}
            >
              <Text style={[styles.actionText, { color: theme.color.tint }]}>Forward</Text>
            </Pressable>
          ) : null}
          {hasAttachments ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onSave();
                onClose();
              }}
            >
              <Text style={[styles.actionText, { color: theme.color.tint }]}>Save to Photos</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.action, { borderTopColor: theme.color.separator }]}
            onPress={() => {
              onRemindLater();
              onClose();
            }}
          >
            <Text style={[styles.actionText, { color: theme.color.tint }]}>Remind Me Later</Text>
          </Pressable>
          {canEditUnsend && selected?.text ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onEdit();
                onClose();
              }}
            >
              <Text style={[styles.actionText, { color: theme.color.tint }]}>Edit</Text>
            </Pressable>
          ) : null}
          {canEditUnsend ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onUnsend();
                onClose();
              }}
            >
              <Text style={[styles.actionText, { color: theme.color.destructive }]}>Unsend</Text>
            </Pressable>
          ) : null}
          {canCancel ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onCancelSend();
                onClose();
              }}
            >
              <Text style={[styles.actionText, { color: theme.color.destructive }]}>
                {selected?.sendState === 'error' ? 'Remove' : 'Cancel Sending'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 16, paddingTop: 16, gap: 12 },
  picker: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderRadius: 28,
    padding: 8,
  },
  tap: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 22 },
  action: { paddingVertical: 14, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth },
  actionText: { fontSize: 17, fontWeight: '500' },
});
