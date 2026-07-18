import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  PICKER_ORDER,
  reactionMeta,
  removalType,
  type ReactionBaseType,
} from '@core/reactions/reactionType';
import type { MessageSummaryInfo } from '@core/models';
import { useTheme } from '../theme';

export interface SelectedMessage {
  guid: string;
  text: string | null;
  isFromMe: boolean;
  senderName: string | null;
  /** Classic reaction types the current user has already applied to this message. */
  mine: ReactionBaseType[];
  /** Arbitrary-emoji tapback glyphs the current user has already applied. */
  myEmojis?: string[];
  dateCreated: number | null; // for the "recent" edit/unsend gate
  /** Delivery/read/edit timestamps + per-message service — surfaced by the "Details" sheet.
   *  Optional so existing SelectedMessage literals (tests) stay valid. */
  dateDelivered?: number | null;
  dateRead?: number | null;
  dateEdited?: number | null;
  senderService?: string | null;
  isRetracted: boolean;
  /** The message carries an edit marker (dateEdited) → offers "View Edit History". Distinct from
   *  the own-recent Edit/Unsend gate: you can view the history of ANY edited message. */
  isEdited: boolean;
  /** Parsed edit history / unsent parts for this message (or null). Threaded through from the
   *  reactive row so the history sheet needs no extra fetch. Present only when isEdited. */
  messageSummaryInfo?: MessageSummaryInfo | null;
  isTemp: boolean; // not yet on the server → can't edit/unsend
  /** Local send lifecycle of an optimistic message ('sending' | 'error' | 'sent'). */
  sendState: string;
  /** This message's attachments (for Save-to-device). */
  attachments: { guid: string; localPath: string | null; mimeType: string | null }[];
  /** Part of a reply thread (is a reply, or has replies) → offers "View Thread". */
  inThread?: boolean;
  /** The thread originator's guid when this message is a reply (else it IS the originator). */
  threadOriginatorGuid?: string | null;
}

interface MessageActionsOverlayProps {
  selected: SelectedMessage | null;
  onClose: () => void;
  /** reaction is a base type ('love'), a removal ('-love'), or 'emoji'/'-emoji' with a glyph. */
  onReact: (reaction: string, emoji?: string) => void;
  onReply: () => void;
  onRemindLater: () => void;
  onEdit: () => void;
  onUnsend: () => void;
  /** Cancel a still-queued/sending (or errored) optimistic message before it confirms. */
  onCancelSend: () => void;
  /** Copy the message text to the clipboard. */
  onCopy: () => void;
  /** Forward the message text and/or downloaded attachments (opens the new-message composer). */
  onForward: () => void;
  /** Save the message's attachment(s) to the device gallery. */
  onSave: () => void;
  /** Share the message's attachment file or text via the OS share sheet. */
  onShare: () => void;
  /** Delete this message from the local device (any delivered/received message). */
  onDelete: () => void;
  /** Open the reply-thread sheet (shown only when the message is in a thread). */
  onViewThread?: () => void;
  /** Open the edit-history sheet (shown only when the message was edited). */
  onViewEditHistory?: () => void;
  /** Open the message-details sheet (sent/delivered/read times, sender, service). */
  onDetails?: () => void;
  /** Enter multi-select mode seeded with this message. */
  onSelect?: () => void;
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
  onShare,
  onDelete,
  onViewThread,
  onViewEditHistory,
  onDetails,
  onSelect,
}: MessageActionsOverlayProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const mine = new Set(selected?.mine ?? []);
  const myEmojis = selected?.myEmojis ?? [];
  const [emojiDraft, setEmojiDraft] = useState('');
  const [showEmojiInput, setShowEmojiInput] = useState(false);
  // Fresh input state each time the menu opens for a (different) message.
  useEffect(() => {
    setEmojiDraft('');
    setShowEmojiInput(false);
  }, [selected?.guid]);
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

  // Any confirmed message (sent, received, or an unsent tombstone) can be removed from the local
  // device. An optimistic in-flight/errored own message uses Cancel Sending/Remove (canCancel)
  // instead, so Delete is offered only when that path doesn't apply.
  const canDelete = !!selected && !canCancel;

  const pick = (base: ReactionBaseType): void => {
    // Tapping a type you already applied removes it (toggle).
    onReact(mine.has(base) ? removalType(base) : base);
    onClose();
  };

  const pickEmoji = (glyph: string): void => {
    // Same toggle for an arbitrary-emoji tapback; the glyph rides separately.
    onReact(myEmojis.includes(glyph) ? removalType('emoji') : 'emoji', glyph);
    onClose();
  };

  const submitEmojiDraft = (): void => {
    const glyph = emojiDraft.trim();
    // Reject empty or obviously-not-an-emoji input (letters/digits); leave the field open.
    if (!glyph || /[A-Za-z0-9]/.test(glyph)) return;
    pickEmoji(glyph);
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
            {myEmojis.map((g) => (
              <Pressable
                key={`emoji-${g}`}
                onPress={() => pickEmoji(g)}
                style={[styles.tap, { backgroundColor: theme.color.tint }]}
                accessibilityRole="button"
                accessibilityState={{ selected: true }}
                accessibilityLabel={`Remove ${g} reaction`}
              >
                <Text style={styles.emoji}>{g}</Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => setShowEmojiInput((v) => !v)}
              style={styles.tap}
              accessibilityRole="button"
              accessibilityState={{ expanded: showEmojiInput }}
              accessibilityLabel="React with any emoji"
            >
              <Text style={[styles.plus, { color: theme.color.secondaryLabel }]}>+</Text>
            </Pressable>
          </View>
          {showEmojiInput ? (
            <TextInput
              value={emojiDraft}
              onChangeText={setEmojiDraft}
              onSubmitEditing={submitEmojiDraft}
              placeholder="Type an emoji…"
              placeholderTextColor={theme.color.secondaryLabel}
              autoFocus
              returnKeyType="send"
              accessibilityLabel="Emoji reaction input"
              style={[
                styles.emojiInput,
                {
                  backgroundColor: theme.color.secondaryBackground,
                  color: theme.color.label,
                },
              ]}
            />
          ) : null}
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
          {hasText || hasAttachments ? (
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
          {hasText || hasAttachments ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onShare();
                onClose();
              }}
            >
              <Text style={[styles.actionText, { color: theme.color.tint }]}>Share…</Text>
            </Pressable>
          ) : null}
          {onViewThread && selected?.inThread ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onViewThread();
                onClose();
              }}
            >
              <Text style={[styles.actionText, { color: theme.color.tint }]}>View Thread</Text>
            </Pressable>
          ) : null}
          {onViewEditHistory && selected?.isEdited ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onViewEditHistory();
                onClose();
              }}
            >
              <Text style={[styles.actionText, { color: theme.color.tint }]}>View Edit History</Text>
            </Pressable>
          ) : null}
          {onDetails ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onDetails();
                onClose();
              }}
            >
              <Text style={[styles.actionText, { color: theme.color.tint }]}>Details</Text>
            </Pressable>
          ) : null}
          {onSelect ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onSelect();
                onClose();
              }}
            >
              <Text style={[styles.actionText, { color: theme.color.tint }]}>Select</Text>
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
          {canDelete ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onDelete();
                onClose();
              }}
            >
              <Text style={[styles.actionText, { color: theme.color.destructive }]}>Delete</Text>
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
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    borderRadius: 28,
    padding: 8,
  },
  tap: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 22 },
  plus: { fontSize: 26, fontWeight: '300', lineHeight: 30 },
  emojiInput: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 17 },
  action: { paddingVertical: 14, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth },
  actionText: { fontSize: 17, fontWeight: '500' },
});
