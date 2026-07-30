import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  PICKER_ORDER,
  reactionMeta,
  removalType,
  type ReactionBaseType,
} from '@core/reactions/reactionType';
import type { MessageSummaryInfo } from '@core/models';
import { placeReactionMenu, type BubbleRect } from '@utils';
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
  /** The pressed bubble's on-screen rectangle (window coords). Present → the menu floats around
   *  the bubble (iMessage-style); absent → a centered fallback sheet (tests / measure failure). */
  anchorRect?: BubbleRect;
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

// Floating-layout geometry (iMessage-style anchored menu).
const GAP = 8;
const SIDE_INSET = 12;
const BAR_HEIGHT = 56; // the tapback pill's height (44px targets + padding)
const HOLE_PAD = 6; // breathing room around the "lifted" bubble in the scrim punch-out
const SCRIM = 'rgba(0,0,0,0.45)';

/** One row in the action menu (Reply / Copy / … ), built once and rendered in either layout. */
interface ActionDef {
  key: string;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

/**
 * Long-press menu: a tapback picker + Reply/Copy/… actions, with Edit/Unsend on your own recent
 * messages. iMessage-style — the tapback bar floats above the pressed bubble and the action menu
 * below it, positioned to the bubble's measured rectangle. Falls back to a centered sheet when the
 * bubble rectangle is missing. Built with a plain Modal + Pressable + Animated (no
 * gesture-handler/reanimated).
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
  const win = useWindowDimensions();
  const mine = new Set(selected?.mine ?? []);
  const myEmojis = selected?.myEmojis ?? [];
  const [emojiDraft, setEmojiDraft] = useState('');
  const [showEmojiInput, setShowEmojiInput] = useState(false);
  // A single spring drives the pop-in (scrim fade + bar/menu scale) of the anchored layout.
  const anim = useRef(new Animated.Value(0)).current;
  // Fresh input state + a replayed pop each time the menu opens for a (different) message.
  useEffect(() => {
    setEmojiDraft('');
    setShowEmojiInput(false);
    if (!selected?.anchorRect) return;
    anim.setValue(0);
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 9, tension: 90 }).start();
  }, [selected?.guid, selected?.anchorRect, anim]);

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

  // The tapback buttons — identical in both layouts (labels/toggle behaviour are asserted by tests).
  const pickerButtons = (
    <>
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
    </>
  );

  const emojiInputNode = showEmojiInput ? (
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
        { backgroundColor: theme.color.secondaryBackground, color: theme.color.label },
      ]}
    />
  ) : null;

  // Assemble the action list once (same gating as before) — order preserved.
  const actions: ActionDef[] = [{ key: 'reply', label: 'Reply', onPress: onReply }];
  if (hasText) actions.push({ key: 'copy', label: 'Copy', onPress: onCopy });
  if (hasText || hasAttachments)
    actions.push({ key: 'forward', label: 'Forward', onPress: onForward });
  if (hasAttachments) actions.push({ key: 'save', label: 'Save to Photos', onPress: onSave });
  if (hasText || hasAttachments) actions.push({ key: 'share', label: 'Share…', onPress: onShare });
  if (onViewThread && selected?.inThread)
    actions.push({ key: 'thread', label: 'View Thread', onPress: onViewThread });
  if (onViewEditHistory && selected?.isEdited)
    actions.push({ key: 'edithistory', label: 'View Edit History', onPress: onViewEditHistory });
  if (onDetails) actions.push({ key: 'details', label: 'Details', onPress: onDetails });
  if (onSelect) actions.push({ key: 'select', label: 'Select', onPress: onSelect });
  actions.push({ key: 'remind', label: 'Remind Me Later', onPress: onRemindLater });
  if (canEditUnsend && selected?.text)
    actions.push({ key: 'edit', label: 'Edit', onPress: onEdit });
  if (canEditUnsend)
    actions.push({ key: 'unsend', label: 'Unsend', onPress: onUnsend, destructive: true });
  if (canCancel)
    actions.push({
      key: 'cancel',
      label: selected?.sendState === 'error' ? 'Remove' : 'Cancel Sending',
      onPress: onCancelSend,
      destructive: true,
    });
  if (canDelete)
    actions.push({ key: 'delete', label: 'Delete', onPress: onDelete, destructive: true });

  const renderAction = (a: ActionDef, i: number): React.JSX.Element => (
    <Pressable
      key={a.key}
      style={[
        styles.action,
        i > 0 && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.color.separator,
        },
      ]}
      onPress={() => {
        a.onPress();
        onClose();
      }}
      accessibilityRole="button"
    >
      <Text
        style={[
          styles.actionText,
          { color: a.destructive ? theme.color.destructive : theme.color.tint },
        ]}
      >
        {a.label}
      </Text>
    </Pressable>
  );

  // The floating pop-in transform, shared by the bar and the menu card.
  const popStyle = {
    opacity: anim,
    transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }],
  };

  // ANCHORED (iMessage-style) layout — used whenever we have the bubble's rectangle.
  const rect = selected?.anchorRect;
  let body: React.JSX.Element;
  if (selected && rect) {
    const place = placeReactionMenu({
      bubble: rect,
      screen: { width: win.width, height: win.height },
      insets: { top: insets.top, bottom: insets.bottom },
      isFromMe: selected.isFromMe,
      barHeight: BAR_HEIGHT,
      gap: GAP,
      sideInset: SIDE_INSET,
    });
    const holeTop = Math.max(0, rect.y - HOLE_PAD);
    const holeBottom = rect.y + rect.height + HOLE_PAD;
    const holeLeft = Math.max(0, rect.x - HOLE_PAD);
    const holeRight = rect.x + rect.width + HOLE_PAD;
    const maxWidth = win.width - SIDE_INSET * 2;
    // Absolute horizontal anchor ('left' or 'right') → the bar + menu hug the bubble's near side.
    const sideStyle = { [place.align]: place.edgeOffset } as { left?: number; right?: number };
    const menuVerticalStyle =
      place.menu.anchor === 'top' ? { top: place.menu.value } : { bottom: place.menu.value };

    body = (
      <View style={StyleSheet.absoluteFill}>
        {/* Tap anywhere off the bar/menu (incl. the highlighted bubble) to dismiss. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Dismiss" />
        {/* Dim scrim with a punch-out over the pressed bubble so it stays bright ("lifts"). */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: anim }]} pointerEvents="none">
          <View style={[styles.scrim, { top: 0, left: 0, right: 0, height: holeTop }]} />
          <View style={[styles.scrim, { top: holeBottom, left: 0, right: 0, bottom: 0 }]} />
          <View
            style={[
              styles.scrim,
              { top: holeTop, height: holeBottom - holeTop, left: 0, width: holeLeft },
            ]}
          />
          <View
            style={[
              styles.scrim,
              { top: holeTop, height: holeBottom - holeTop, left: holeRight, right: 0 },
            ]}
          />
        </Animated.View>
        {/* Floating tapback bar, hugging the bubble's near top corner. */}
        <Animated.View
          style={[styles.floatBar, sideStyle, { top: place.barTop, maxWidth }, popStyle]}
        >
          <View style={[styles.barPill, { backgroundColor: theme.color.secondaryBackground }]}>
            {pickerButtons}
          </View>
          {emojiInputNode}
        </Animated.View>
        {/* Floating action menu card. */}
        <Animated.View
          style={[styles.floatMenu, sideStyle, menuVerticalStyle, { maxWidth }, popStyle]}
        >
          <View style={[styles.menuCard, { backgroundColor: theme.color.secondaryBackground }]}>
            <ScrollView style={{ maxHeight: place.menuMaxHeight }} bounces={false}>
              {actions.map(renderAction)}
            </ScrollView>
          </View>
        </Animated.View>
      </View>
    );
  } else if (selected) {
    // FALLBACK: a centered/bottom sheet when we couldn't measure the bubble.
    body = (
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
          <View style={[styles.picker, { backgroundColor: theme.color.secondaryBackground }]}>
            {pickerButtons}
          </View>
          {emojiInputNode}
          <View style={[styles.menuCard, { backgroundColor: theme.color.secondaryBackground }]}>
            {actions.map(renderAction)}
          </View>
        </View>
      </Pressable>
    );
  } else {
    body = <></>;
  }

  return (
    <Modal visible={!!selected} transparent animationType="none" onRequestClose={onClose}>
      {body}
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Floating shadow shared by the bar + menu card so they read as lifted above the dim.
  scrim: { position: 'absolute', backgroundColor: SCRIM },
  floatBar: { position: 'absolute', alignItems: 'flex-start' },
  barPill: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    borderRadius: 26,
    paddingHorizontal: 6,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  floatMenu: { position: 'absolute', minWidth: 224 },
  menuCard: {
    borderRadius: 14,
    overflow: 'hidden',
    minWidth: 224,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  // Fallback bottom sheet.
  backdrop: { flex: 1, backgroundColor: SCRIM, justifyContent: 'flex-end' },
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
  emojiInput: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 17,
    marginTop: 8,
    // The floating bar is content-sized (no width to stretch into), so give the field a usable
    // floor; in the fallback sheet it still stretches wider than this.
    minWidth: 220,
  },
  action: { paddingVertical: 13, paddingHorizontal: 16 },
  actionText: { fontSize: 17, fontWeight: '500' },
});
