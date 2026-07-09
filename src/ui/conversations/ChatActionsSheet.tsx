import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDatabase } from '@db/database';
import {
  deleteChatLocal,
  setChatArchive,
  setChatMute,
  setChatPin,
  setChatUnreadLocal,
} from '@db/repositories';
import { markRead } from '@/services';
import { useTheme } from '../theme';

export interface ChatActionTarget {
  guid: string;
  title: string;
  isPinned: boolean;
  isArchived: boolean;
  muted: boolean;
  unread: boolean;
}

interface ChatActionsSheetProps {
  target: ChatActionTarget | null;
  onClose: () => void;
}

/**
 * Long-press action sheet for a conversation tile: pin / mute / archive / delete.
 * Plain Modal + Pressable (no gesture-handler). Pin/mute/archive are device-local
 * mutations; the reactive inbox query updates the list. Delete confirms first.
 */
export function ChatActionsSheet({ target, onClose }: ChatActionsSheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const run = (fn: () => Promise<void>): void => {
    void fn().finally(onClose);
  };

  const confirmDelete = (t: ChatActionTarget): void => {
    // Close THIS sheet first: Android reliably shows only one Modal at a time, and the themed
    // dialog is itself a Modal — so the confirm must not stack on top of the still-open sheet.
    onClose();
    showDialog(
      'Delete Conversation',
      `Delete “${t.title}”? This removes it from this device (not from the server).`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => void deleteChatLocal(getDatabase(), t.guid),
        },
      ],
    );
  };

  return (
    <Modal visible={!!target} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + 12, backgroundColor: theme.color.background },
          ]}
        >
          {target ? (
            <>
              <Text
                numberOfLines={1}
                style={[styles.heading, { color: theme.color.secondaryLabel }]}
              >
                {target.title}
              </Text>
              <Row
                label={target.unread ? 'Mark as Read' : 'Mark as Unread'}
                color={theme.color.tint}
                sep={theme.color.separator}
                onPress={() =>
                  run(() =>
                    target.unread ? markRead(target.guid) : setChatUnreadLocal(getDatabase(), target.guid),
                  )
                }
              />
              <Row
                label={target.isPinned ? 'Unpin' : 'Pin'}
                color={theme.color.tint}
                sep={theme.color.separator}
                onPress={() => run(() => setChatPin(getDatabase(), target.guid, !target.isPinned))}
              />
              <Row
                label={target.muted ? 'Unmute' : 'Mute'}
                color={theme.color.tint}
                sep={theme.color.separator}
                onPress={() =>
                  run(() => setChatMute(getDatabase(), target.guid, target.muted ? null : 'mute'))
                }
              />
              <Row
                label={target.isArchived ? 'Unarchive' : 'Archive'}
                color={theme.color.tint}
                sep={theme.color.separator}
                onPress={() =>
                  run(() => setChatArchive(getDatabase(), target.guid, !target.isArchived))
                }
              />
              <Row
                label="Delete"
                color={theme.color.destructive}
                sep={theme.color.separator}
                onPress={() => confirmDelete(target)}
              />
            </>
          ) : null}
        </View>
      </Pressable>
    </Modal>
  );
}

function Row({
  label,
  color,
  sep,
  onPress,
}: {
  label: string;
  color: string;
  sep: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      style={[styles.action, { borderTopColor: sep }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={[styles.actionText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 16, paddingTop: 8 },
  heading: { fontSize: 13, textAlign: 'center', paddingVertical: 10 },
  action: { paddingVertical: 15, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth },
  actionText: { fontSize: 17, fontWeight: '500' },
});
