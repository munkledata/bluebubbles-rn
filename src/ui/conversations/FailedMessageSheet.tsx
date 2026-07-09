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
            <Text style={[styles.title, { color: theme.color.label }]}>Message Not Delivered</Text>
            <Text style={[styles.subtitle, { color: theme.color.secondaryLabel }]}>
              {isAttachment
                ? 'Your attachment couldn’t be sent.'
                : 'Your message couldn’t be sent.'}
            </Text>
          </View>
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
          <Pressable
            style={[styles.action, { borderTopColor: theme.color.separator }]}
            onPress={() => {
              onDelete();
              onClose();
            }}
            accessibilityRole="button"
          >
            <Text style={[styles.actionText, { color: theme.color.destructive }]}>Delete</Text>
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
  action: { paddingVertical: 14, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth },
  actionText: { fontSize: 17, fontWeight: '500' },
  cancel: { marginTop: 8, borderTopWidth: 0, borderRadius: 12 },
});
