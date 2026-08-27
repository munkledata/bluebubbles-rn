import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDatabase } from '@db/database';
import {
  setChatArchiveWithinTransaction,
  setChatMuteWithinTransaction,
  setChatPinWithinTransaction,
  swapPinnedChatOrder,
  type InboxRow,
  type InboxSenderFilter,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { deleteChat, markRead, markUnread } from '@/services';
import {
  captureRealtimeDeliveryLease,
  runAccountScopedLocalMutation,
} from '@/services/realtime/deliveryCoordinator';
import { resolveTitle } from '@utils';
import { useTheme } from '../theme';

export interface ChatActionTarget {
  guid: string;
  title: string;
  isPinned: boolean;
  isArchived: boolean;
  muted: boolean;
  unread: boolean;
  moveEarlierGuid?: string | null;
  moveLaterGuid?: string | null;
  pinSenderFilter?: InboxSenderFilter;
}

/** Map an inbox row to the sheet's target (shared by every conversation list's long-press). */
export function toChatActionTarget(
  row: InboxRow,
  movement: {
    earlierGuid?: string | null;
    laterGuid?: string | null;
    sender?: InboxSenderFilter;
  } = {},
): ChatActionTarget {
  return {
    guid: row.guid,
    title: resolveTitle(row),
    isPinned: !!row.isPinned,
    isArchived: !!row.isArchived,
    muted: row.muteType === 'mute',
    unread: (row.unreadCount ?? 0) > 0,
    moveEarlierGuid: movement.earlierGuid ?? null,
    moveLaterGuid: movement.laterGuid ?? null,
    pinSenderFilter: movement.sender ?? 'any',
  };
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
  // Bind every callback created by this sheet instance to the account that rendered it. The
  // global confirmation dialog can outlive this component; its old Delete callback must not
  // capture the next account merely because the user presses it after reconnecting.
  const [accountLease] = React.useState(() => captureRealtimeDeliveryLease());

  const run = (fn: () => Promise<void>): void => {
    void fn().finally(onClose);
  };

  const confirmDelete = (t: ChatActionTarget): void => {
    // Close THIS sheet first: Android reliably shows only one Modal at a time, and the themed
    // dialog is itself a Modal — so the confirm must not stack on top of the still-open sheet.
    onClose();
    showDialog(
      'Delete Conversation',
      'Delete this conversation? This removes it from this device (not from the server).',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => void deleteChat(t.guid, accountLease),
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
                    target.unread
                      ? markRead(target.guid, accountLease)
                      : markUnread(target.guid, accountLease),
                  )
                }
              />
              <Row
                label={target.isPinned ? 'Unpin' : 'Pin'}
                color={theme.color.tint}
                sep={theme.color.separator}
                onPress={() =>
                  run(() =>
                    runAccountScopedLocalMutation(accountLease, async () => {
                      const db = getDatabase();
                      const guid = target.guid;
                      const pinned = !target.isPinned;
                      await withDbTransaction(
                        db,
                        (context) => setChatPinWithinTransaction(context, guid, pinned),
                        () => accountLease.isCurrent(),
                      );
                    }),
                  )
                }
              />
              {target.isPinned && target.moveEarlierGuid ? (
                <Row
                  label="Move Earlier"
                  color={theme.color.tint}
                  sep={theme.color.separator}
                  onPress={() =>
                    run(() =>
                      runAccountScopedLocalMutation(accountLease, async () => {
                        const db = getDatabase();
                        const guid = target.guid;
                        const adjacentGuid = target.moveEarlierGuid!;
                        await swapPinnedChatOrder(
                          db,
                          guid,
                          adjacentGuid,
                          'earlier',
                          () => accountLease.isCurrent(),
                          target.pinSenderFilter ?? 'any',
                        );
                      }),
                    )
                  }
                />
              ) : null}
              {target.isPinned && target.moveLaterGuid ? (
                <Row
                  label="Move Later"
                  color={theme.color.tint}
                  sep={theme.color.separator}
                  onPress={() =>
                    run(() =>
                      runAccountScopedLocalMutation(accountLease, async () => {
                        const db = getDatabase();
                        const guid = target.guid;
                        const adjacentGuid = target.moveLaterGuid!;
                        await swapPinnedChatOrder(
                          db,
                          guid,
                          adjacentGuid,
                          'later',
                          () => accountLease.isCurrent(),
                          target.pinSenderFilter ?? 'any',
                        );
                      }),
                    )
                  }
                />
              ) : null}
              <Row
                label={target.muted ? 'Unmute' : 'Mute'}
                color={theme.color.tint}
                sep={theme.color.separator}
                onPress={() =>
                  run(() =>
                    runAccountScopedLocalMutation(accountLease, async () => {
                      const db = getDatabase();
                      const guid = target.guid;
                      const muteType = target.muted ? null : 'mute';
                      await withDbTransaction(
                        db,
                        (context) => setChatMuteWithinTransaction(context, guid, muteType),
                        () => accountLease.isCurrent(),
                      );
                    }),
                  )
                }
              />
              <Row
                label={target.isArchived ? 'Unarchive' : 'Archive'}
                color={theme.color.tint}
                sep={theme.color.separator}
                onPress={() =>
                  run(() =>
                    runAccountScopedLocalMutation(accountLease, async () => {
                      const db = getDatabase();
                      const guid = target.guid;
                      const archived = !target.isArchived;
                      await withDbTransaction(
                        db,
                        (context) => setChatArchiveWithinTransaction(context, guid, archived),
                        () => accountLease.isCurrent(),
                      );
                    }),
                  )
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
