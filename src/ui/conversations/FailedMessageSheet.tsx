import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

interface FailedMessageSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Re-send the failed message (re-uploads the attachment when there is one). */
  onRetry: () => void;
  /** Discard the failed message. */
  onDelete: () => void;
  /** True when the failed message carries an attachment (tweaks the copy). */
  isAttachment?: boolean;
  /** True when this is a one-shot iMessage reply that must never be replayed. */
  isReply?: boolean;
  /** True when this is a one-shot current-location card that must never be replayed. */
  isLocation?: boolean;
  /** True when this is a one-shot effect send that must never be replayed. */
  isEffect?: boolean;
  /** True when this is a one-shot mention send that must never be replayed. */
  isMention?: boolean;
  /** True when this is a one-shot formatted send that must never be replayed. */
  isFormatted?: boolean;
  /** True when this is a one-shot iMessage contact card that must never be replayed. */
  isContact?: boolean;
  /** False for any one-shot helper send that cannot be replayed safely. */
  retryAllowed?: boolean;
  /** One-shot helper sends use this when dispatch may have happened but no ack arrived. */
  deliveryUnconfirmed?: boolean;
  /** Bounded/redacted server detail read from the encrypted failed-message row. */
  errorDetail?: string | null;
}

/** What a one-shot send was, most specific first; it picks the sheet's wording. */
type OneShotKind =
  'mention' | 'effect' | 'location' | 'reply' | 'formatted' | 'contact' | 'attachment' | 'message';

interface SheetCopy {
  readonly title: string;
  readonly subtitle: string;
}

const DELIVERY_MAY_HAVE_OCCURRED =
  'Delivery may have occurred. Check Messages before sending a new copy.';

/** The send may have reached Messages, so it is never retried. */
const UNCONFIRMED_COPY: Readonly<Record<OneShotKind, SheetCopy>> = {
  mention: {
    title: 'Mention Status Unconfirmed',
    subtitle:
      'This mention message may have been delivered. Check Messages before sending a new copy.',
  },
  effect: {
    title: 'Effect Status Unconfirmed',
    subtitle:
      'This effect message may have been delivered. Check Messages before sending a new copy.',
  },
  location: { title: 'Location Status Unconfirmed', subtitle: DELIVERY_MAY_HAVE_OCCURRED },
  reply: { title: 'Reply Status Unconfirmed', subtitle: DELIVERY_MAY_HAVE_OCCURRED },
  formatted: {
    title: 'Formatted Message Status Unconfirmed',
    subtitle:
      'This formatted message may have been delivered. Check Messages before sending a new copy.',
  },
  contact: {
    title: 'Contact Card Status Unconfirmed',
    subtitle:
      'This contact card may have been delivered. Check Messages before sending a new copy.',
  },
  attachment: { title: 'Attachment Status Unconfirmed', subtitle: DELIVERY_MAY_HAVE_OCCURRED },
  message: {
    title: 'Message Status Unconfirmed',
    subtitle: 'This message may have been delivered. Check Messages before sending a new copy.',
  },
};

const MESSAGE_NOT_SENT: SheetCopy = {
  title: 'Message Not Sent',
  subtitle: 'This message was not sent and cannot be retried. Send a new message if needed.',
};

/** A one-shot send that cannot be retried for any other reason, e.g. refused before dispatch. */
const NOT_RETRYABLE_COPY: Readonly<Record<OneShotKind, SheetCopy>> = {
  mention: MESSAGE_NOT_SENT,
  effect: MESSAGE_NOT_SENT,
  location: {
    title: 'Location Not Sent',
    subtitle:
      'This location was not sent and cannot be retried. Start a new location share if needed.',
  },
  reply: {
    title: 'Reply Needs Review',
    subtitle: 'This reply cannot be retried. Check Messages before sending another copy.',
  },
  formatted: MESSAGE_NOT_SENT,
  contact: {
    title: 'Contact Card Not Sent',
    subtitle:
      'This contact card was not sent and cannot be retried. Share the contact again if needed.',
  },
  attachment: {
    title: 'Attachment Needs Review',
    subtitle: 'This attachment cannot be retried. Review this copy before sending another.',
  },
  message: MESSAGE_NOT_SENT,
};

/**
 * Bottom action sheet shown when the "!" on a not-delivered message is tapped — a themed,
 * in-app alternative to the system Alert. Offers Try Again / Delete, plus a separated Cancel.
 * Same plain Modal + Pressable approach as {@link MessageActionsOverlay} (no gesture-handler).
 */
export function FailedMessageSheet({
  visible,
  onClose,
  onRetry,
  onDelete,
  isAttachment,
  isReply,
  isLocation,
  isEffect,
  isMention,
  isFormatted,
  isContact,
  retryAllowed = true,
  deliveryUnconfirmed = false,
  errorDetail,
}: FailedMessageSheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const kind: OneShotKind = isMention
    ? 'mention'
    : isEffect
      ? 'effect'
      : isLocation
        ? 'location'
        : isReply
          ? 'reply'
          : isFormatted
            ? 'formatted'
            : isContact
              ? 'contact'
              : isAttachment
                ? 'attachment'
                : 'message';
  const copy: SheetCopy = deliveryUnconfirmed
    ? UNCONFIRMED_COPY[kind]
    : !retryAllowed
      ? NOT_RETRYABLE_COPY[kind]
      : {
          title: 'Message Not Delivered',
          subtitle: isAttachment
            ? 'Your attachment couldn’t be sent.'
            : 'Your message couldn’t be sent.',
        };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Card: swallow taps so pressing inside doesn't dismiss. */}
        <Pressable
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + 12, backgroundColor: theme.color.background },
          ]}
          onPress={() => {}}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.color.label }]}>{copy.title}</Text>
            <Text style={[styles.subtitle, { color: theme.color.secondaryLabel }]}>
              {copy.subtitle}
            </Text>
            {retryAllowed && errorDetail ? (
              <Text style={[styles.detail, { color: theme.color.secondaryLabel }]}>
                {errorDetail}
              </Text>
            ) : null}
          </View>
          {retryAllowed ? (
            <Pressable
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => {
                onRetry();
                onClose();
              }}
              accessibilityRole="button"
            >
              <Text style={[styles.actionText, { color: theme.color.tint }]}>Try Again</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.action, { borderTopColor: theme.color.separator }]}
            onPress={() => {
              onDelete();
              onClose();
            }}
            accessibilityRole="button"
          >
            <Text style={[styles.actionText, { color: theme.color.destructive }]}>
              {retryAllowed ? 'Delete' : 'Remove from Gator'}
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.action,
              styles.cancel,
              { backgroundColor: theme.color.secondaryBackground },
            ]}
            onPress={onClose}
            accessibilityRole="button"
          >
            <Text style={[styles.actionText, { color: theme.color.tint, fontWeight: '600' }]}>
              Cancel
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 16, paddingTop: 4, gap: 0 },
  header: { paddingVertical: 16, alignItems: 'center', gap: 4 },
  title: { fontSize: 17, fontWeight: '700' },
  subtitle: { fontSize: 13, textAlign: 'center' },
  detail: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 4 },
  action: { paddingVertical: 14, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth },
  actionText: { fontSize: 17, fontWeight: '500' },
  cancel: { marginTop: 8, borderTopWidth: 0, borderRadius: 12 },
});
