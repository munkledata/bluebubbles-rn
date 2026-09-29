import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
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
  /** Renderable body with attributed attachment placeholders removed. */
  bodyText?: string;
  /** Optional subject/extension metadata retained for the reply preview. */
  subject?: string | null;
  balloonBundleId?: string | null;
  hasAttachments?: number;
  hasVisibleAttachments?: number;
  attachmentDescription?: string | null;
  isFromMe: boolean;
  senderName: string | null;
  /** Classic reaction types the current user has already applied to this message. */
  mine: ReactionBaseType[];
  /** Arbitrary-emoji tapback glyphs the current user has already applied. */
  myEmojis?: string[];
  /** A confirmed RCS message or narrowly admitted iMessage can receive a reaction. */
  canReact?: boolean;
  /** Exact reply target admitted by the live narrow helper capability. */
  replyPartIndex?: 0;
  /** Exact plain-text edit target admitted by the live narrow helper capability. */
  editPartIndex?: 0;
  /** Exact plain-text unsend target admitted by the live narrow helper capability. */
  unsendPartIndex?: 0;
  /** Whole-message Mac deletion admitted by its separate live capability and chat proof. */
  canRemoteDeleteFromMac?: boolean;
  /** Arbitrary emoji remains RCS-only while the narrow iMessage path admits classic tapbacks. */
  canUseEmojiReactions?: boolean;
  dateCreated: number | null;
  /** Delivery/read/edit timestamps + per-message service — surfaced by the "Details" sheet.
   *  Optional so existing SelectedMessage literals (tests) stay valid. */
  dateDelivered?: number | null;
  dateRead?: number | null;
  dateEdited?: number | null;
  senderService?: string | null;
  isRetracted: boolean;
  /** Internal proof that retires this frozen menu snapshot after a live retraction change. */
  sourceRetractionFingerprint?: string;
  /** Read-only local edit history is independent of outgoing edit availability. */
  isEdited?: boolean;
  messageSummaryInfo?: MessageSummaryInfo | null;
  isTemp: boolean;
  /** Local send lifecycle of an optimistic message ('sending' | 'error' | 'sent'). */
  sendState: string;
  /** This message's attachments (for Save-to-device). */
  attachments: { guid: string; localPath: string | null; mimeType: string | null }[];
  /** Read-only reply-thread membership derived from received/persisted rows. */
  inThread?: boolean;
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
  onRemindLater: () => void;
  /** Cancel a still-queued/sending (or errored) optimistic message before it confirms. */
  onCancelSend: () => void;
  /** Copy the message text to the clipboard. */
  onCopy: () => void;
  /** Start a plain-text reply to exact message part zero. */
  onReply?: () => void;
  /** Start a plain-text edit of exact message part zero. */
  onEdit?: () => void;
  /** Confirm and retract exact plain-text message part zero for everyone. */
  onUnsend?: () => void;
  /** Confirm and delete this whole message from Messages on the Mac; never a part or whole chat. */
  onRemoteDeleteFromMac?: () => void;
  /** Forward the message text and/or downloaded attachments (opens the new-message composer). */
  onForward?: () => void;
  /** Save the message's attachment(s) to the device gallery. */
  onSave: () => void;
  /** Share the message's attachment file or text via the OS share sheet. */
  onShare: () => void;
  /** Delete this message from the local device (any delivered/received message). */
  onDelete: () => void;
  /** Open read-only received/persisted reply and edit-history views. */
  onViewThread?: () => void;
  onViewEditHistory?: () => void;
  /** Open the message-details sheet (sent/delivered/read times, sender, service). */
  onDetails?: () => void;
  /** Enter multi-select mode seeded with this message. */
  onSelect?: () => void;
}

// Floating-layout geometry (iMessage-style anchored menu).
const GAP = 8;
const SIDE_INSET = 12;
const BAR_HEIGHT = 56; // the tapback pill's height (44px targets + padding)
const HOLE_PAD = 6; // breathing room around the "lifted" bubble in the scrim punch-out
const SCRIM = 'rgba(0,0,0,0.45)';

function useReduceMotionPreference(): boolean | null {
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    let receivedPreferenceEvent = false;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      receivedPreferenceEvent = true;
      if (mounted) setReduceMotion(enabled);
    });

    void AccessibilityInfo.isReduceMotionEnabled().then(
      (enabled) => {
        if (mounted && !receivedPreferenceEvent) setReduceMotion(enabled);
      },
      () => {
        // If the native query is unavailable, retain the existing animated behavior.
        if (mounted && !receivedPreferenceEvent) setReduceMotion(false);
      },
    );

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}

/** One row in the local action menu, built once and rendered in either layout. */
interface ActionDef {
  key: string;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

/**
 * Long-press menu: an RCS reaction picker plus local copy/share/details/select/reminder/delete
 * actions. The bar and action menu float around the measured bubble, with a centered fallback when
 * measurement is unavailable.
 */
export function MessageActionsOverlay({
  selected,
  onClose,
  onReact,
  onRemindLater,
  onCancelSend,
  onCopy,
  onReply,
  onEdit,
  onUnsend,
  onRemoteDeleteFromMac,
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
  const reduceMotion = useReduceMotionPreference();
  const selectedGuid = selected?.guid ?? null;
  const hasAnchor = selected?.anchorRect != null;
  const mine = new Set(selected?.mine ?? []);
  const myEmojis = selected?.myEmojis ?? [];
  const [emojiDraft, setEmojiDraft] = useState('');
  const [showEmojiInput, setShowEmojiInput] = useState(false);
  // A single retained spring drives the pop-in (scrim fade + bar/menu scale) of the anchored layout.
  const anim = useRef(new Animated.Value(1)).current;
  const activePop = useRef<Animated.CompositeAnimation | null>(null);
  const openingGuid = useRef<string | null>(null);

  // Fresh input state each time the menu opens for a different message.
  useEffect(() => {
    // The same mounted overlay can switch messages; drafts must never leak to the next message.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEmojiDraft('');
    setShowEmojiInput(false);
  }, [selectedGuid]);

  useLayoutEffect(() => {
    const stopAndSnap = (): void => {
      const current = activePop.current;
      activePop.current = null;
      current?.stop();
      anim.setValue(1);
    };

    if (selectedGuid === null) {
      stopAndSnap();
      openingGuid.current = null;
      return stopAndSnap;
    }

    const isNewOpening = openingGuid.current !== selectedGuid;
    if (isNewOpening) {
      stopAndSnap();
      openingGuid.current = selectedGuid;
      if (hasAnchor && reduceMotion === false) {
        anim.setValue(0);
        const next = Animated.spring(anim, {
          toValue: 1,
          useNativeDriver: true,
          friction: 9,
          tension: 90,
        });
        activePop.current = next;
        next.start();
      }
      return stopAndSnap;
    }

    if (!hasAnchor || reduceMotion !== false) stopAndSnap();
    return stopAndSnap;
  }, [anim, hasAnchor, reduceMotion, selectedGuid]);

  const selectedBodyText = selected?.bodyText ?? selected?.text ?? '';
  const hasText = selectedBodyText.trim().length > 0;
  const hasAttachments = (selected?.attachments?.length ?? 0) > 0;
  const canReactToServerMessage = !!selected && !selected.isTemp && selected.canReact === true;

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
      {selected?.canUseEmojiReactions !== false
        ? myEmojis.map((g) => (
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
          ))
        : null}
      {selected?.canUseEmojiReactions !== false ? (
        <Pressable
          onPress={() => setShowEmojiInput((v) => !v)}
          style={styles.tap}
          accessibilityRole="button"
          accessibilityState={{ expanded: showEmojiInput }}
          accessibilityLabel="React with any emoji"
        >
          <Text style={[styles.plus, { color: theme.color.secondaryLabel }]}>+</Text>
        </Pressable>
      ) : null}
    </>
  );

  const emojiInputNode =
    canReactToServerMessage && selected?.canUseEmojiReactions !== false && showEmojiInput ? (
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

  // Assemble local actions once. Server-targeted reply is present only when the caller provides
  // the separately capability-gated callback and this snapshot names exact part zero.
  const actions: ActionDef[] = [];
  if (onReply && !selected?.isTemp && !selected?.isRetracted && selected?.replyPartIndex === 0) {
    actions.push({ key: 'reply', label: 'Reply', onPress: onReply });
  }
  if (hasText) actions.push({ key: 'copy', label: 'Copy', onPress: onCopy });
  if (onForward && (hasText || hasAttachments))
    actions.push({ key: 'forward', label: 'Forward', onPress: onForward });
  if (hasAttachments) actions.push({ key: 'save', label: 'Save to Photos', onPress: onSave });
  if (hasText || hasAttachments) actions.push({ key: 'share', label: 'Share…', onPress: onShare });
  if (onViewThread && selected?.inThread) {
    actions.push({ key: 'thread', label: 'View Thread', onPress: onViewThread });
  }
  if (onViewEditHistory && selected?.isEdited) {
    actions.push({ key: 'edithistory', label: 'View Edit History', onPress: onViewEditHistory });
  }
  if (onDetails) actions.push({ key: 'details', label: 'Details', onPress: onDetails });
  if (onSelect) actions.push({ key: 'select', label: 'Select', onPress: onSelect });
  actions.push({ key: 'remind', label: 'Remind Me Later', onPress: onRemindLater });
  if (
    onEdit &&
    selected?.editPartIndex === 0 &&
    selected.isFromMe &&
    !selected.isTemp &&
    !selected.isRetracted &&
    selected.sendState === 'sent' &&
    hasText &&
    !hasAttachments
  ) {
    actions.push({ key: 'edit', label: 'Edit', onPress: onEdit });
  }
  if (
    onUnsend &&
    selected?.unsendPartIndex === 0 &&
    selected.isFromMe &&
    !selected.isTemp &&
    !selected.isRetracted &&
    selected.sendState === 'sent' &&
    hasText &&
    !hasAttachments
  ) {
    actions.push({ key: 'unsend', label: 'Unsend', onPress: onUnsend, destructive: true });
  }
  if (
    onRemoteDeleteFromMac &&
    selected?.canRemoteDeleteFromMac === true &&
    !selected.isTemp &&
    !selected.isRetracted &&
    !canCancel
  ) {
    actions.push({
      key: 'remote-delete',
      label: 'Delete from Mac',
      onPress: onRemoteDeleteFromMac,
      destructive: true,
    });
  }
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
      barHeight: canReactToServerMessage ? BAR_HEIGHT : 0,
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
        {canReactToServerMessage ? (
          <Animated.View
            style={[styles.floatBar, sideStyle, { top: place.barTop, maxWidth }, popStyle]}
          >
            <View style={[styles.barPill, { backgroundColor: theme.color.secondaryBackground }]}>
              {pickerButtons}
            </View>
            {emojiInputNode}
          </Animated.View>
        ) : null}
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
          {canReactToServerMessage ? (
            <>
              <View style={[styles.picker, { backgroundColor: theme.color.secondaryBackground }]}>
                {pickerButtons}
              </View>
              {emojiInputNode}
            </>
          ) : null}
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
