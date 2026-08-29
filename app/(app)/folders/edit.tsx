import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import {
  createCustomFolder,
  deleteCustomFolder,
  loadCustomFolders,
  renameCustomFolder,
} from '@/services/customFolderCommands';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';
import { Screen, ScreenHeader, TextField, useTheme } from '@ui';
import { useUnsavedChangesGuard } from '@ui/hooks/useUnsavedChangesGuard';

function parseFolderId(value: string | string[] | undefined): {
  id: number | null;
  invalid: boolean;
} {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null) return { id: null, invalid: false };
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? { id, invalid: false } : { id: null, invalid: true };
}

function folderNameError(error: unknown): string {
  if (error instanceof RangeError || error instanceof TypeError) return error.message;
  if (error instanceof Error && error.message === 'A folder with that name already exists.') {
    return error.message;
  }
  return 'Couldn’t save the folder. Your changes are still here.';
}

type PendingEditOutcome =
  | { readonly type: 'created'; readonly folderId: number }
  | { readonly type: 'return' }
  | { readonly type: 'deleted' }
  | { readonly type: 'missing' }
  | { readonly type: 'error'; readonly message: string };

/** Create or rename one folder without losing typed text on a failed write. */
export default function ConversationFolderEditScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ folderId?: string | string[] }>();
  const parsed = parseFolderId(params.folderId);
  const folderId = parsed.id;
  const creating = params.folderId == null;
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const [loading, setLoading] = useState(!creating && !parsed.invalid);
  const [loadFailed, setLoadFailed] = useState(false);
  const [folderMissing, setFolderMissing] = useState(parsed.invalid);
  const [initialName, setInitialName] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const focusedRef = useRef(false);
  const abandonedRef = useRef(false);
  const mutationInFlightRef = useRef(false);
  const deleteConfirmationOpenRef = useRef(false);
  const pendingOutcomeRef = useRef<PendingEditOutcome | null>(null);

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
        setSaving(false);
      }),
    [accountLease],
  );

  const accountCurrent = !accountRetired && accountLease.isCurrent();

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
    if (creating || parsed.invalid || folderId == null || !accountLease.isCurrent()) return;
    let mounted = true;
    void loadCustomFolders(accountLease)
      .then((result) => {
        if (!mounted || result.status === 'stale' || !accountLease.isCurrent()) return;
        const folder = result.value.find((row) => row.id === folderId);
        if (!folder) {
          setFolderMissing(true);
          return;
        }
        setInitialName(folder.name);
        setDraft(folder.name);
      })
      .catch(() => {
        if (mounted && accountLease.isCurrent()) {
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (mounted && accountLease.isCurrent()) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [accountLease, creating, folderId, parsed.invalid]);

  const dirty = accountCurrent && !loading && draft !== initialName;
  const { navigateWithoutPrompt } = useUnsavedChangesGuard({
    enabled: dirty || (accountCurrent && saving),
    title: saving
      ? 'Leave while updating this folder?'
      : creating
        ? 'Discard new folder?'
        : 'Discard folder changes?',
    message: saving
      ? 'The update may still finish, but this screen will not navigate again after you leave.'
      : 'The folder name you entered will be lost.',
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
      setError(outcome.message);
    } else if (outcome.type === 'missing') {
      setFolderMissing(true);
      setError('This folder no longer exists.');
    } else if (outcome.type === 'created') {
      navigateWithoutPrompt(() => router.replace(`/folders/${outcome.folderId}`));
    } else if (outcome.type === 'deleted') {
      navigateWithoutPrompt(() => router.dismissTo('/folders'));
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

  const saveEnabled =
    accountCurrent &&
    !loading &&
    !loadFailed &&
    !folderMissing &&
    !saving &&
    draft.trim().length > 0 &&
    (creating || draft !== initialName);

  const save = async (): Promise<void> => {
    if (!saveEnabled || mutationInFlightRef.current || !ownsRoute()) return;
    mutationInFlightRef.current = true;
    setSaving(true);
    setError(null);
    try {
      if (creating) {
        const result = await createCustomFolder(draft, accountLease);
        if (result.status === 'stale' || !accountLease.isCurrent()) return;
        pendingOutcomeRef.current = { type: 'created', folderId: result.value.id };
        applyPendingOutcome();
        return;
      }
      if (folderId == null) return;
      const result = await renameCustomFolder(folderId, draft, accountLease);
      if (result.status === 'stale' || !accountLease.isCurrent()) return;
      if (!result.value) {
        pendingOutcomeRef.current = { type: 'missing' };
        applyPendingOutcome();
        return;
      }
      pendingOutcomeRef.current = { type: 'return' };
      applyPendingOutcome();
    } catch (saveError) {
      if (accountLease.isCurrent()) {
        pendingOutcomeRef.current = { type: 'error', message: folderNameError(saveError) };
        applyPendingOutcome();
      }
    } finally {
      mutationInFlightRef.current = false;
      if (ownsRoute() && pendingOutcomeRef.current == null) setSaving(false);
    }
  };

  const confirmDelete = (): void => {
    if (
      creating ||
      folderId == null ||
      saving ||
      mutationInFlightRef.current ||
      deleteConfirmationOpenRef.current ||
      !ownsRoute()
    ) {
      return;
    }
    deleteConfirmationOpenRef.current = true;
    showDialog(
      'Delete Folder',
      `Delete “${initialName}”? The conversations and messages inside it will not be deleted.`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => {
            deleteConfirmationOpenRef.current = false;
          },
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteConfirmationOpenRef.current = false;
            if (mutationInFlightRef.current || !ownsRoute()) return;
            mutationInFlightRef.current = true;
            setSaving(true);
            setError(null);
            void deleteCustomFolder(folderId, accountLease)
              .then((result) => {
                if (result.status === 'stale' || !accountLease.isCurrent()) return;
                if (!result.value) {
                  pendingOutcomeRef.current = { type: 'missing' };
                  applyPendingOutcome();
                  return;
                }
                pendingOutcomeRef.current = { type: 'deleted' };
                applyPendingOutcome();
              })
              .catch(() => {
                if (accountLease.isCurrent()) {
                  pendingOutcomeRef.current = {
                    type: 'error',
                    message: 'Couldn’t delete the folder. Nothing else was changed.',
                  };
                  applyPendingOutcome();
                }
              })
              .finally(() => {
                mutationInFlightRef.current = false;
                if (ownsRoute() && pendingOutcomeRef.current == null) setSaving(false);
              });
          },
        },
      ],
    );
  };

  if (!accountCurrent) return <Screen grouped />;

  return (
    <Screen grouped>
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScreenHeader
          title={creating ? 'New Folder' : 'Manage Folder'}
          onBack={() => router.back()}
          right={
            <Pressable
              onPress={() => void save()}
              disabled={!saveEnabled}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Save folder"
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

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {loading ? (
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
              <TextField
                label="Folder name"
                value={draft}
                onChangeText={(value) => {
                  setDraft(value);
                  setError(null);
                }}
                onSubmitEditing={() => void save()}
                returnKeyType="done"
                autoCapitalize="sentences"
                autoCorrect
                autoFocus={creating}
                editable={!saving}
              />
              <Text style={[styles.note, { color: theme.color.secondaryLabel }]}>
                Folder names and membership stay on this device and are removed when you disconnect.
                They are not included in backups yet.
              </Text>
              {error ? (
                <Text
                  selectable
                  accessibilityRole="alert"
                  accessibilityLiveRegion="assertive"
                  style={[styles.error, { color: theme.color.destructive }]}
                >
                  {error}
                </Text>
              ) : null}
              {!creating ? (
                <View style={styles.deleteWrap}>
                  <Pressable
                    onPress={confirmDelete}
                    disabled={saving}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${initialName}`}
                    accessibilityState={{ disabled: saving }}
                    style={styles.deleteButton}
                  >
                    <Text style={[styles.deleteText, { color: theme.color.destructive }]}>
                      Delete Folder
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  save: { fontSize: 16, fontWeight: '600', textAlign: 'right' },
  content: { paddingHorizontal: 16, paddingTop: 24, paddingBottom: 32 },
  loading: { paddingTop: 48 },
  centerMessage: { textAlign: 'center', paddingTop: 48, fontSize: 15 },
  note: { fontSize: 13, lineHeight: 19, paddingHorizontal: 4 },
  error: { fontSize: 14, lineHeight: 20, paddingHorizontal: 4, paddingTop: 16 },
  deleteWrap: { alignItems: 'center', paddingTop: 36 },
  deleteButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
  deleteText: { fontSize: 16, fontWeight: '600' },
});
