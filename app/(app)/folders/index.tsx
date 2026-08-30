import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import type { CustomFolderSummaryRow } from '@db/repositories';
import { useCustomFolderSummaries } from '@features/conversations/useCustomFolderSummaries';
import { reorderCustomFolders } from '@/services/customFolderCommands';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';
import { readableTextOn, Screen, ScreenHeader, useTheme } from '@ui';

/** Manage the small, explicitly bounded ordered set of device-local conversation folders. */
export default function ConversationFoldersScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const [busyFolderId, setBusyFolderId] = useState<number | null>(null);
  const [optimisticReorder, setOptimisticReorder] = useState<{
    baseRows: CustomFolderSummaryRow[] | null;
    rows: CustomFolderSummaryRow[];
  } | null>(null);
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const reorderInFlightRef = useRef(false);

  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setAccountRetired(true);
        setBusyFolderId(null);
        setOptimisticReorder(null);
      }),
    [accountLease],
  );

  const accountCurrent = !accountRetired && accountLease.isCurrent();
  const {
    data: folderRows,
    error: folderLoadError,
    isLoading: foldersLoading,
    retry: retryFolders,
  } = useCustomFolderSummaries(accountLease, accountCurrent && focused);
  const rows =
    optimisticReorder?.baseRows === folderRows ? optimisticReorder.rows : (folderRows ?? []);
  const loadFailed = folderLoadError != null;

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      setFocused(true);
      if (!reorderInFlightRef.current) setBusyFolderId(null);
      return () => {
        focusedRef.current = false;
        setFocused(false);
      };
    }, []),
  );

  const retryFolderSummaries = useCallback((): void => {
    if (!accountLease.isCurrent() || !focusedRef.current) return;
    retryFolders();
  }, [accountLease, retryFolders]);

  const moveFolder = async (index: number, offset: -1 | 1): Promise<void> => {
    if (
      !accountCurrent ||
      !focusedRef.current ||
      loadFailed ||
      busyFolderId != null ||
      reorderInFlightRef.current
    ) {
      return;
    }
    const destination = index + offset;
    const row = rows[index];
    if (!row || destination < 0 || destination >= rows.length) return;

    const next = [...rows];
    const destinationRow = next[destination];
    if (!destinationRow) return;
    next[index] = destinationRow;
    next[destination] = row;
    reorderInFlightRef.current = true;
    setBusyFolderId(row.id);
    try {
      const result = await reorderCustomFolders(
        next.map((folder) => folder.id),
        accountLease,
      );
      if (result.status === 'stale' || !accountLease.isCurrent() || !focusedRef.current) return;
      if (!result.value) {
        retryFolders();
        if (accountLease.isCurrent() && focusedRef.current) {
          showDialog(
            'Conversation Folders',
            'The folder list changed. It is being reloaded; please try moving it again.',
          );
        }
        return;
      }
      setOptimisticReorder({
        baseRows: folderRows,
        rows: next.map((folder, sortOrder) => ({ ...folder, sortOrder })),
      });
      retryFolders();
    } catch {
      retryFolders();
      if (accountLease.isCurrent() && focusedRef.current) {
        showDialog(
          'Conversation Folders',
          'Couldn’t change the folder order. The folder list is being reloaded.',
        );
      }
    } finally {
      reorderInFlightRef.current = false;
      if (accountLease.isCurrent() && focusedRef.current) setBusyFolderId(null);
    }
  };

  if (!accountCurrent) return <Screen grouped />;
  const controlsBlocked = busyFolderId != null || loadFailed;

  return (
    <Screen grouped>
      <ScreenHeader
        title="Conversation Folders"
        onBack={() => router.back()}
        right={
          <Pressable
            onPress={() => router.push('/folders/edit')}
            disabled={controlsBlocked}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Create conversation folder"
            accessibilityState={{ disabled: controlsBlocked }}
          >
            <Text style={[styles.add, { color: theme.color.tint }]}>＋</Text>
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.note, { color: theme.color.secondaryLabel }]}>
          Folders are private to this device and do not change your Mac or server. Tap a folder to
          browse it, or Manage its membership. Open a folder and use Edit to rename or delete it.
          Unread badges count currently available conversations, including archived or muted ones;
          Manage can hide a folder’s badge. Folder search matches names, participants, and locally
          synced message text; it does not search the server.
        </Text>

        {loadFailed && rows.length > 0 ? (
          <View style={styles.recoveryBlock}>
            <Text
              selectable
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={[styles.recoveryMessage, { color: theme.color.destructive }]}
            >
              Folder changes are paused because the latest list could not be loaded.
            </Text>
            <Pressable
              onPress={retryFolderSummaries}
              disabled={foldersLoading}
              accessibilityRole="button"
              accessibilityState={{ disabled: foldersLoading }}
              style={styles.retry}
            >
              <Text style={[styles.retryText, { color: theme.color.tint }]}>Try Again</Text>
            </Pressable>
          </View>
        ) : null}

        {foldersLoading && rows.length === 0 ? (
          <ActivityIndicator style={styles.loading} color={theme.color.tint} />
        ) : loadFailed && rows.length === 0 ? (
          <View style={styles.messageBlock}>
            <Text selectable style={[styles.message, { color: theme.color.secondaryLabel }]}>
              Couldn’t load conversation folders.
            </Text>
            <Pressable
              onPress={retryFolderSummaries}
              accessibilityRole="button"
              style={styles.retry}
            >
              <Text style={[styles.retryText, { color: theme.color.tint }]}>Try Again</Text>
            </Pressable>
          </View>
        ) : rows.length === 0 ? (
          <Text style={[styles.message, { color: theme.color.secondaryLabel }]}>
            No folders yet. Tap ＋ to create one.
          </Text>
        ) : (
          <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
            {rows.map((row, index) => {
              const busy = busyFolderId === row.id;
              const controlsDisabled = controlsBlocked;
              const showUnreadBadge = row.showUnreadBadge === 1 && row.unreadChatCount > 0;
              const unreadLabel = `${row.unreadChatCount.toLocaleString()} unread ${row.unreadChatCount === 1 ? 'conversation' : 'conversations'}`;
              return (
                <View key={row.id}>
                  {index > 0 ? (
                    <View style={[styles.divider, { backgroundColor: theme.color.separator }]} />
                  ) : null}
                  <View style={[styles.row, controlsDisabled && !busy ? styles.dimmed : null]}>
                    <Pressable
                      style={styles.rowMain}
                      onPress={() => router.push(`/folders/${row.id}/browse`)}
                      disabled={controlsDisabled}
                      accessibilityRole="button"
                      accessibilityLabel={`${row.name}, ${row.chatCount} saved ${row.chatCount === 1 ? 'conversation' : 'conversations'}${showUnreadBadge ? `, ${unreadLabel}` : ''}`}
                      accessibilityHint="Opens conversations currently available in this folder"
                      accessibilityState={{ disabled: controlsDisabled }}
                    >
                      <View style={styles.titleRow}>
                        <Text numberOfLines={1} style={[styles.name, { color: theme.color.label }]}>
                          {row.name}
                        </Text>
                        {showUnreadBadge ? (
                          <View style={[styles.badge, { backgroundColor: theme.color.tint }]}>
                            <Text
                              style={[
                                styles.badgeText,
                                { color: readableTextOn(theme.color.tint) },
                              ]}
                            >
                              {row.unreadChatCount > 99 ? '99+' : row.unreadChatCount}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <Text style={[styles.count, { color: theme.color.secondaryLabel }]}>
                        {row.chatCount.toLocaleString()}{' '}
                        {row.chatCount === 1 ? 'saved conversation' : 'saved conversations'} · Tap
                        to browse
                      </Text>
                    </Pressable>

                    <Pressable
                      onPress={() => void moveFolder(index, -1)}
                      disabled={controlsDisabled || index === 0}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel={`Move ${row.name} earlier`}
                      accessibilityState={{ disabled: controlsDisabled || index === 0 }}
                      style={styles.control}
                    >
                      <Text
                        style={[
                          styles.arrow,
                          {
                            color: index === 0 ? theme.color.tertiaryLabel : theme.color.tint,
                          },
                        ]}
                      >
                        ↑
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void moveFolder(index, 1)}
                      disabled={controlsDisabled || index === rows.length - 1}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel={`Move ${row.name} later`}
                      accessibilityState={{
                        disabled: controlsDisabled || index === rows.length - 1,
                      }}
                      style={styles.control}
                    >
                      <Text
                        style={[
                          styles.arrow,
                          {
                            color:
                              index === rows.length - 1
                                ? theme.color.tertiaryLabel
                                : theme.color.tint,
                          },
                        ]}
                      >
                        ↓
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => router.push(`/folders/${row.id}`)}
                      disabled={controlsDisabled}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel={`Manage membership and unread badge for ${row.name}`}
                      accessibilityState={{ disabled: controlsDisabled, busy }}
                      style={styles.edit}
                    >
                      {busy ? (
                        <ActivityIndicator size="small" color={theme.color.tint} />
                      ) : (
                        <Text style={[styles.editText, { color: theme.color.tint }]}>Manage</Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  add: { fontSize: 26, fontWeight: '400', textAlign: 'right' },
  content: { paddingHorizontal: 16, paddingVertical: 16, paddingBottom: 32 },
  note: { fontSize: 14, lineHeight: 20, paddingHorizontal: 4, paddingBottom: 14 },
  loading: { paddingTop: 56 },
  messageBlock: { alignItems: 'center', paddingTop: 48, gap: 16 },
  message: { textAlign: 'center', paddingTop: 48, fontSize: 15, lineHeight: 21 },
  retry: { paddingHorizontal: 12, paddingVertical: 8 },
  retryText: { fontSize: 16, fontWeight: '600' },
  recoveryBlock: { alignItems: 'center', paddingBottom: 14, gap: 4 },
  recoveryMessage: { textAlign: 'center', fontSize: 13, lineHeight: 18 },
  group: { borderRadius: 12, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  row: { minHeight: 68, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 },
  dimmed: { opacity: 0.5 },
  rowMain: { flex: 1, alignSelf: 'stretch', justifyContent: 'center', paddingVertical: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, fontSize: 16, fontWeight: '500' },
  badge: {
    minWidth: 24,
    minHeight: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    justifyContent: 'center',
  },
  badgeText: {
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  count: { fontSize: 13, paddingTop: 3, fontVariant: ['tabular-nums'] },
  control: { minWidth: 34, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  arrow: { fontSize: 21, fontWeight: '600' },
  edit: { minWidth: 66, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
  editText: { fontSize: 14, fontWeight: '600' },
});
