import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import type { CustomFolderRow } from '@db/repositories';
import { loadCustomFolders, reorderCustomFolders } from '@/services/customFolderCommands';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';
import { Screen, ScreenHeader, useTheme } from '@ui';

/** Manage the small, explicitly bounded ordered set of device-local conversation folders. */
export default function ConversationFoldersScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const [rows, setRows] = useState<CustomFolderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyFolderId, setBusyFolderId] = useState<number | null>(null);
  const focusedRef = useRef(false);
  const reorderInFlightRef = useRef(false);

  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setAccountRetired(true);
        setRows([]);
        setBusyFolderId(null);
      }),
    [accountLease],
  );

  const accountCurrent = !accountRetired && accountLease.isCurrent();
  const refresh = useCallback(
    async (showLoading: boolean): Promise<boolean> => {
      if (!accountLease.isCurrent()) return false;
      if (showLoading && focusedRef.current) setLoading(true);
      try {
        const result = await loadCustomFolders(accountLease);
        if (!focusedRef.current || result.status === 'stale' || !accountLease.isCurrent()) {
          return false;
        }
        setRows(result.value);
        setLoadFailed(false);
        return true;
      } catch {
        if (focusedRef.current && accountLease.isCurrent()) setLoadFailed(true);
        return false;
      } finally {
        if (focusedRef.current && accountLease.isCurrent()) setLoading(false);
      }
    },
    [accountLease],
  );

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (!reorderInFlightRef.current) setBusyFolderId(null);
      void refresh(true);
      return () => {
        focusedRef.current = false;
      };
    }, [refresh]),
  );

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
        const recovered = await refresh(false);
        if (accountLease.isCurrent() && focusedRef.current) {
          showDialog(
            'Conversation Folders',
            recovered
              ? 'The folder list changed. Please try moving it again.'
              : 'The folder list changed, but it could not be reloaded. Use Try Again before making more changes.',
          );
        }
        return;
      }
      setRows(next.map((folder, sortOrder) => ({ ...folder, sortOrder })));
    } catch {
      const recovered = await refresh(false);
      if (accountLease.isCurrent() && focusedRef.current) {
        showDialog(
          'Conversation Folders',
          recovered
            ? 'Couldn’t change the folder order.'
            : 'Couldn’t change or reload the folder order. Use Try Again before making more changes.',
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
          Folders are private to this device. They organize conversations without changing them on
          your Mac or server. This version manages folder membership only; browsing, search, and
          unread totals for folders are not available yet.
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
              onPress={() => void refresh(true)}
              disabled={loading}
              accessibilityRole="button"
              accessibilityState={{ disabled: loading }}
              style={styles.retry}
            >
              <Text style={[styles.retryText, { color: theme.color.tint }]}>Try Again</Text>
            </Pressable>
          </View>
        ) : null}

        {loading && rows.length === 0 ? (
          <ActivityIndicator style={styles.loading} color={theme.color.tint} />
        ) : loadFailed && rows.length === 0 ? (
          <View style={styles.messageBlock}>
            <Text selectable style={[styles.message, { color: theme.color.secondaryLabel }]}>
              Couldn’t load conversation folders.
            </Text>
            <Pressable
              onPress={() => void refresh(true)}
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
              return (
                <View key={row.id}>
                  {index > 0 ? (
                    <View style={[styles.divider, { backgroundColor: theme.color.separator }]} />
                  ) : null}
                  <View style={[styles.row, controlsDisabled && !busy ? styles.dimmed : null]}>
                    <Pressable
                      style={styles.rowMain}
                      onPress={() => router.push(`/folders/${row.id}`)}
                      disabled={controlsDisabled}
                      accessibilityRole="button"
                      accessibilityLabel={`${row.name}, ${row.chatCount} ${row.chatCount === 1 ? 'conversation' : 'conversations'}`}
                      accessibilityHint="Opens the membership editor"
                      accessibilityState={{ disabled: controlsDisabled }}
                    >
                      <Text numberOfLines={1} style={[styles.name, { color: theme.color.label }]}>
                        {row.name}
                      </Text>
                      <Text style={[styles.count, { color: theme.color.secondaryLabel }]}>
                        {row.chatCount.toLocaleString()}{' '}
                        {row.chatCount === 1 ? 'conversation' : 'conversations'} · Manage membership
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
                      onPress={() => router.push(`/folders/edit?folderId=${row.id}`)}
                      disabled={controlsDisabled}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel={`Rename or delete ${row.name}`}
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
  name: { fontSize: 16, fontWeight: '500' },
  count: { fontSize: 13, paddingTop: 3 },
  control: { minWidth: 34, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  arrow: { fontSize: 21, fontWeight: '600' },
  edit: { minWidth: 66, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
  editText: { fontSize: 14, fontWeight: '600' },
});
