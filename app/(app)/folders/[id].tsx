import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { MAX_CUSTOM_FOLDER_MEMBERS, type CustomFolderRow, type InboxRow } from '@db/repositories';
import { useChats } from '@features/conversations/useChats';
import {
  loadCustomFolderMembership,
  loadCustomFolders,
  replaceCustomFolderMembership,
} from '@/services/customFolderCommands';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';
import { resolveTitle } from '@utils';
import { Avatar, readableTextOn, Screen, ScreenHeader, useTheme } from '@ui';
import { InboxSeparator } from '@ui/conversations/FilteredChatListScreen';
import { useUnsavedChangesGuard } from '@ui/hooks/useUnsavedChangesGuard';

function parseFolderId(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number(raw);
  return raw != null && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((guid) => right.has(guid));
}

type PendingMembershipOutcome =
  | { readonly type: 'saved' }
  | { readonly type: 'missing' }
  | { readonly type: 'error'; readonly message: string };

interface MembershipSelection {
  readonly members: Set<string>;
  readonly validationError: string | null;
}

/** Edit one exact membership set while retaining chats not present in the currently loaded page. */
export default function ConversationFolderMembershipScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const folderId = parseFolderId(params.id);
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const [folder, setFolder] = useState<CustomFolderRow | null>(null);
  const [baseline, setBaseline] = useState<Set<string>>(() => new Set());
  const [selection, setSelection] = useState<MembershipSelection>(() => ({
    members: new Set(),
    validationError: null,
  }));
  const [initialized, setInitialized] = useState(folderId == null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [folderMissing, setFolderMissing] = useState(folderId == null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const focusedRef = useRef(false);
  const abandonedRef = useRef(false);
  const mutationInFlightRef = useRef(false);
  const pendingOutcomeRef = useRef<PendingMembershipOutcome | null>(null);

  const ownsRoute = useCallback(
    (): boolean =>
      mountedRef.current && focusedRef.current && !abandonedRef.current && accountLease.isCurrent(),
    [accountLease],
  );

  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        abandonedRef.current = true;
        setAccountRetired(true);
        setFolder(null);
        setBaseline(new Set());
        setSelection({ members: new Set(), validationError: null });
        setSaving(false);
        setSaveError(null);
      }),
    [accountLease],
  );

  const accountCurrent = !accountRetired && accountLease.isCurrent();
  const chats = useChats(true, {
    archive: 'all',
    pageSize: 50,
    enabled: accountCurrent && folderId != null,
  });

  useEffect(() => {
    mountedRef.current = true;
    abandonedRef.current = false;
    return () => {
      mountedRef.current = false;
      focusedRef.current = false;
      abandonedRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (folderId == null || !accountLease.isCurrent()) return;
    let mounted = true;
    const foldersRequest = loadCustomFolders(accountLease);
    const membershipRequest = loadCustomFolderMembership(folderId, accountLease);
    void Promise.all([foldersRequest, membershipRequest])
      .then(([foldersResult, membershipResult]) => {
        if (
          !mounted ||
          foldersResult.status === 'stale' ||
          membershipResult.status === 'stale' ||
          !accountLease.isCurrent()
        ) {
          return;
        }
        const currentFolder = foldersResult.value.find((row) => row.id === folderId) ?? null;
        if (!currentFolder) {
          setFolderMissing(true);
          return;
        }
        const members = new Set(membershipResult.value);
        setFolder(currentFolder);
        setBaseline(members);
        setSelection({ members: new Set(members), validationError: null });
        setFolderMissing(false);
      })
      .catch(() => {
        if (mounted && accountLease.isCurrent()) setLoadFailed(true);
      })
      .finally(() => {
        if (mounted && accountLease.isCurrent()) setInitialized(true);
      });
    return () => {
      mounted = false;
    };
  }, [accountLease, folderId]);

  const selected = selection.members;
  const dirty = accountCurrent && initialized && !sameMembers(baseline, selected);
  const { navigateWithoutPrompt } = useUnsavedChangesGuard({
    enabled: dirty || (accountCurrent && saving),
    title: saving ? 'Leave while updating this folder?' : 'Discard folder changes?',
    message: saving
      ? 'The update may still finish, but this screen will not navigate again after you leave.'
      : 'The membership changes on this screen will be lost.',
    onDiscard: () => {
      abandonedRef.current = true;
    },
  });

  const applyPendingOutcome = useCallback((): void => {
    if (!ownsRoute()) return;
    const outcome = pendingOutcomeRef.current;
    if (!outcome) return;
    pendingOutcomeRef.current = null;
    setSaving(false);
    if (outcome.type === 'error') {
      setSaveError(outcome.message);
    } else if (outcome.type === 'missing') {
      setFolderMissing(true);
      setSaveError('This folder no longer exists.');
    } else {
      navigateWithoutPrompt(() => router.back());
    }
  }, [navigateWithoutPrompt, ownsRoute, router]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      queueMicrotask(() => {
        if (!ownsRoute()) return;
        if (pendingOutcomeRef.current) applyPendingOutcome();
        else if (!mutationInFlightRef.current) setSaving(false);
      });
      return () => {
        focusedRef.current = false;
      };
    }, [applyPendingOutcome, ownsRoute]),
  );

  const toggle = useCallback(
    (guid: string): void => {
      if (!accountCurrent || !initialized || saving || folderMissing || !ownsRoute()) return;
      setSaveError(null);
      setSelection((current) => {
        if (!current.members.has(guid) && current.members.size >= MAX_CUSTOM_FOLDER_MEMBERS) {
          return {
            members: current.members,
            validationError: `A folder cannot contain more than ${MAX_CUSTOM_FOLDER_MEMBERS.toLocaleString()} conversations.`,
          };
        }
        const next = new Set(current.members);
        if (next.has(guid)) next.delete(guid);
        else next.add(guid);
        return { members: next, validationError: null };
      });
    },
    [accountCurrent, folderMissing, initialized, ownsRoute, saving],
  );

  const save = async (): Promise<void> => {
    if (!dirty || saving || folderId == null || mutationInFlightRef.current || !ownsRoute()) {
      return;
    }
    mutationInFlightRef.current = true;
    setSaving(true);
    setSaveError(null);
    setSelection((current) =>
      current.validationError == null ? current : { ...current, validationError: null },
    );
    try {
      const result = await replaceCustomFolderMembership(folderId, [...selected], accountLease);
      if (result.status === 'stale' || !accountLease.isCurrent()) return;
      if (!result.value) {
        pendingOutcomeRef.current = { type: 'missing' };
        applyPendingOutcome();
        return;
      }
      pendingOutcomeRef.current = { type: 'saved' };
      applyPendingOutcome();
    } catch {
      if (accountLease.isCurrent()) {
        // Keep every checkbox exactly as authored so the user can retry without reconstructing it.
        pendingOutcomeRef.current = {
          type: 'error',
          message: 'Couldn’t save this folder. Your membership changes are still selected.',
        };
        applyPendingOutcome();
      }
    } finally {
      mutationInFlightRef.current = false;
      if (ownsRoute() && pendingOutcomeRef.current == null) setSaving(false);
    }
  };

  const rows = useMemo(() => chats.data ?? [], [chats.data]);
  const visibleError = selection.validationError ?? saveError;
  const renderItem = useCallback(
    ({ item }: { item: InboxRow }): React.JSX.Element => {
      const checked = selected.has(item.guid);
      const disabled = saving || !initialized || !accountCurrent;
      const title = resolveTitle(item);
      const details = [
        item.isArchived ? 'Archived' : null,
        item.participantCount > 1
          ? `${item.participantCount.toLocaleString()} people`
          : 'Conversation',
      ]
        .filter((part): part is string => part != null)
        .join(' · ');
      return (
        <Pressable
          onPress={() => toggle(item.guid)}
          disabled={disabled}
          accessibilityRole="checkbox"
          accessibilityLabel={title}
          accessibilityState={{ checked, disabled }}
          style={styles.row}
        >
          <Avatar name={title} size={40} />
          <View style={styles.rowText}>
            <Text numberOfLines={1} style={[styles.title, { color: theme.color.label }]}>
              {title}
            </Text>
            <Text style={[styles.details, { color: theme.color.secondaryLabel }]}>{details}</Text>
          </View>
          <View
            style={[
              styles.checkbox,
              {
                borderColor: checked ? theme.color.tint : theme.color.tertiaryLabel,
                backgroundColor: checked ? theme.color.tint : 'transparent',
              },
            ]}
          >
            {checked ? (
              <Text style={[styles.check, { color: readableTextOn(theme.color.tint) }]}>✓</Text>
            ) : null}
          </View>
        </Pressable>
      );
    },
    [accountCurrent, initialized, saving, selected, theme, toggle],
  );

  if (!accountCurrent) return <Screen />;

  const saveEnabled = dirty && !saving && !folderMissing && !loadFailed;
  return (
    <Screen>
      <ScreenHeader
        title={folder?.name ?? 'Folder Membership'}
        onBack={() => router.back()}
        right={
          <Pressable
            onPress={() => void save()}
            disabled={!saveEnabled}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Save folder membership"
            accessibilityState={{ disabled: !saveEnabled, busy: saving }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={theme.color.tint} />
            ) : (
              <Text
                style={[
                  styles.save,
                  { color: saveEnabled ? theme.color.tint : theme.color.tertiaryLabel },
                ]}
              >
                Save
              </Text>
            )}
          </Pressable>
        }
      />

      {!initialized ? (
        <ActivityIndicator style={styles.loading} color={theme.color.tint} />
      ) : loadFailed ? (
        <Text selectable style={[styles.centerMessage, { color: theme.color.secondaryLabel }]}>
          Couldn’t load this folder. Go back and try again.
        </Text>
      ) : folderMissing ? (
        <Text selectable style={[styles.centerMessage, { color: theme.color.secondaryLabel }]}>
          This folder no longer exists.
        </Text>
      ) : (
        <>
          <View style={[styles.summary, { borderBottomColor: theme.color.separator }]}>
            <Text style={[styles.summaryCount, { color: theme.color.label }]}>
              {selected.size.toLocaleString()} selected
            </Text>
            <Text style={[styles.summaryNote, { color: theme.color.secondaryLabel }]}>
              Archived and temporarily unavailable conversations stay selected. Scroll to load more
              available conversations.
            </Text>
            {visibleError ? (
              <Text
                selectable
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
                style={[styles.saveError, { color: theme.color.destructive }]}
              >
                {visibleError}
              </Text>
            ) : null}
          </View>
          <FlashList
            data={rows}
            extraData={selected}
            keyExtractor={(row: InboxRow) => row.guid}
            renderItem={renderItem}
            ItemSeparatorComponent={InboxSeparator}
            onEndReached={chats.hasMore ? chats.loadMore : undefined}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={
              <View style={styles.empty}>
                {chats.isLoading ? (
                  <ActivityIndicator color={theme.color.tint} />
                ) : (
                  <Text
                    selectable
                    style={[styles.emptyText, { color: theme.color.secondaryLabel }]}
                  >
                    {chats.error
                      ? 'Couldn’t load conversations. Go back and try again.'
                      : 'No conversations are available to add.'}
                  </Text>
                )}
              </View>
            }
            contentContainerStyle={styles.listContent}
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  save: { fontSize: 16, fontWeight: '600', textAlign: 'right' },
  loading: { paddingTop: 72 },
  centerMessage: { textAlign: 'center', padding: 32, paddingTop: 72, fontSize: 15, lineHeight: 21 },
  summary: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  summaryCount: { fontSize: 15, fontWeight: '600' },
  summaryNote: { fontSize: 12, lineHeight: 17, paddingTop: 3 },
  saveError: { fontSize: 13, lineHeight: 18, paddingTop: 8 },
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 12,
  },
  rowText: { flex: 1 },
  title: { fontSize: 16, fontWeight: '500' },
  details: { fontSize: 13, paddingTop: 2 },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  check: { fontSize: 15, fontWeight: '800' },
  empty: { alignItems: 'center', paddingTop: 72, paddingHorizontal: 24 },
  emptyText: { textAlign: 'center', fontSize: 15, lineHeight: 21 },
  listContent: { paddingBottom: 32 },
});
