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
  /** False for any one-shot helper send that cannot be replayed safely. */
  retryAllowed?: boolean;
  /** One-shot helper sends use this when dispatch may have happened but no ack arrived. */
  deliveryUnconfirmed?: boolean;
  /** Bounded/redacted server detail read from the encrypted failed-message row. */
  errorDetail?: string | null;
}

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
  retryAllowed = true,
  deliveryUnconfirmed = false,
  errorDetail,
}: FailedMessageSheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

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
            <Text style={[styles.title, { color: theme.color.label }]}>
              {deliveryUnconfirmed
                ? isMention
                  ? 'Mention Status Unconfirmed'
                  : isEffect
                    ? 'Effect Status Unconfirmed'
                    : isLocation
                      ? 'Location Status Unconfirmed'
                      : isReply
                        ? 'Reply Status Unconfirmed'
                        : isFormatted
                          ? 'Formatted Message Status Unconfirmed'
                          : 'Attachment Status Unconfirmed'
                : retryAllowed
                  ? 'Message Not Delivered'
                  : isLocation
                    ? 'Location Not Sent'
                    : isReply
                      ? 'Reply Needs Review'
                      : 'Attachment Needs Review'}
            </Text>
            <Text style={[styles.subtitle, { color: theme.color.secondaryLabel }]}>
              {deliveryUnconfirmed
                ? isMention
                  ? 'This mention message may have been delivered. Check Messages before sending a new copy.'
                  : isEffect
                    ? 'This effect message may have been delivered. Check Messages before sending a new copy.'
                    : isFormatted
                      ? 'This formatted message may have been delivered. Check Messages before sending a new copy.'
                      : 'Delivery may have occurred. Check Messages before sending a new copy.'
                : !retryAllowed
                  ? isLocation
                    ? 'This location was not sent and cannot be retried. Start a new location share if needed.'
                    : isReply
                      ? 'This reply cannot be retried. Check Messages before sending another copy.'
                      : 'This attachment cannot be retried. Review this copy before sending another.'
                  : isAttachment
                    ? 'Your attachment couldn’t be sent.'
                    : 'Your message couldn’t be sent.'}
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
