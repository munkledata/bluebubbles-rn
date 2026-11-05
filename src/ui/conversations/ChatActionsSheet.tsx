import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CustomFolderListRow, InboxRow, InboxSenderFilter } from '@db/repositories';
import {
  deleteChat,
  markRead,
  markUnread,
  movePinnedChat,
  setChatArchived,
  setChatMuted,
  setChatPinned,
} from '@/services';
import {
  addChatToCustomFolder,
  CustomFolderMembershipLimitError,
  loadCustomFolders,
} from '@/services/customFolderCommands';
import { clearChatNotification } from '@/services/notifications/notifeeService';
import { captureRealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { resolveDisplayTitle } from '@utils';
import { useTheme } from '../theme';
import { showToast } from '../toast/toastStore';

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
    title: resolveDisplayTitle(row),
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

  // "Add to Folder…" swaps this sheet's rows for a folder list. The list belongs to one chat; the
  // epoch makes a late folder load a no-op once the sheet closes or moves to another chat.
  type FolderList = null | 'loading' | 'error' | readonly CustomFolderListRow[];
  const [folderState, setFolderState] = React.useState<{
    guid: string | null;
    epoch: number;
    value: FolderList;
  }>({ guid: null, epoch: 0, value: null });
  const targetGuid = target?.guid ?? null;
  if (folderState.guid !== null && folderState.guid !== targetGuid) {
    setFolderState((prev) => ({ guid: null, epoch: prev.epoch + 1, value: null }));
  }
  const folders = folderState.guid === targetGuid ? folderState.value : null;

  const openFolderList = (guid: string): void => {
    const epoch = folderState.epoch + 1;
    setFolderState({ guid, epoch, value: 'loading' });
    const settle = (value: FolderList): void =>
      setFolderState((prev) => (prev.epoch === epoch ? { ...prev, value } : prev));
    loadCustomFolders(accountLease)
      // A stale account just drops back to the ordinary rows; the inbox is being torn down.
      .then((result) => settle(result.status === 'committed' ? result.value : null))
      .catch(() => settle('error'));
  };

  const addToFolder = (t: ChatActionTarget, folder: CustomFolderListRow): void => {
    onClose();
    addChatToCustomFolder(folder.id, t.guid, accountLease)
      .then((result) => {
        if (result.status !== 'committed' || !accountLease.isCurrent()) return;
        if (result.value === 'added') showToast(`Added to ${folder.name}`);
        else if (result.value === 'already') showToast(`Already in ${folder.name}`);
        else showToast('That folder no longer exists');
      })
      .catch((error: unknown) => {
        if (!accountLease.isCurrent()) return;
        showToast(
          error instanceof CustomFolderMembershipLimitError
            ? 'Folders are full. Remove some chats from a folder first.'
            : 'Couldn’t add to the folder. Try again.',
        );
      });
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
          {target && folders !== null ? (
            <>
              <Text
                numberOfLines={1}
                style={[styles.heading, { color: theme.color.secondaryLabel }]}
              >
                Add {target.title} to…
              </Text>
              {folders === 'loading' ? (
                <Text style={[styles.note, { color: theme.color.secondaryLabel }]}>
                  Loading folders…
                </Text>
              ) : folders === 'error' ? (
                <Text
                  accessibilityRole="alert"
                  style={[styles.note, { color: theme.color.destructive }]}
                >
                  Couldn’t load your folders.
                </Text>
              ) : folders.length === 0 ? (
                <Text style={[styles.note, { color: theme.color.secondaryLabel }]}>
                  No folders yet. Create one in Settings › Folders.
                </Text>
              ) : (
                <ScrollView style={styles.folderList}>
                  {folders.map((folder) => (
                    <Row
                      key={folder.id}
                      label={folder.name}
                      color={theme.color.tint}
                      sep={theme.color.separator}
                      onPress={() => addToFolder(target, folder)}
                    />
                  ))}
                </ScrollView>
              )}
              <Row
                label="Cancel"
                color={theme.color.secondaryLabel}
                sep={theme.color.separator}
                onPress={onClose}
              />
            </>
          ) : target ? (
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
                  run(async () => {
                    if (!target.unread) return markUnread(target.guid, accountLease);
                    await markRead(target.guid, accountLease);
                    // Read now, so its tray notification is stale — dismiss it exactly as opening
                    // the chat does. The lease keeps a retired account's cleanup from running.
                    clearChatNotification(target.guid, accountLease);
                  })
                }
              />
              <Row
                label={target.isPinned ? 'Unpin' : 'Pin'}
                color={theme.color.tint}
                sep={theme.color.separator}
                onPress={() =>
                  run(() => setChatPinned(target.guid, !target.isPinned, accountLease))
                }
              />
              {target.isPinned && target.moveEarlierGuid ? (
                <Row
                  label="Move Earlier"
                  color={theme.color.tint}
                  sep={theme.color.separator}
                  onPress={() =>
                    run(() =>
                      movePinnedChat(
                        {
                          chatGuid: target.guid,
                          adjacentChatGuid: target.moveEarlierGuid!,
                          direction: 'earlier',
                          sender: target.pinSenderFilter ?? 'any',
                        },
                        accountLease,
                      ),
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
                      movePinnedChat(
                        {
                          chatGuid: target.guid,
                          adjacentChatGuid: target.moveLaterGuid!,
                          direction: 'later',
                          sender: target.pinSenderFilter ?? 'any',
                        },
                        accountLease,
                      ),
                    )
                  }
                />
              ) : null}
              <Row
                label={target.muted ? 'Unmute' : 'Mute'}
                color={theme.color.tint}
                sep={theme.color.separator}
                onPress={() => run(() => setChatMuted(target.guid, !target.muted, accountLease))}
              />
              <Row
                label={target.isArchived ? 'Unarchive' : 'Archive'}
                color={theme.color.tint}
                sep={theme.color.separator}
                onPress={() =>
                  run(() => setChatArchived(target.guid, !target.isArchived, accountLease))
                }
              />
              <Row
                label="Add to Folder…"
                color={theme.color.tint}
                sep={theme.color.separator}
                onPress={() => openFolderList(target.guid)}
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
  note: { fontSize: 15, textAlign: 'center', paddingVertical: 16, paddingHorizontal: 8 },
  folderList: { maxHeight: 360 },
});
