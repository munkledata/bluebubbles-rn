import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { isUnimplementedEndpoint } from '@core/api/errors';
import {
  BackupPassphraseRejectedError,
  isBackupAccountChangedError,
} from '@/services/backup/backupService';
import {
  deleteServerBackupSlot,
  listServerBackupSlots,
  normalizeServerBackupSlotName,
  restoreServerBackupSlot,
  saveServerBackupSlot,
  ServerBackupSlotError,
  SERVER_BACKUP_SLOT_LIMITS,
  type ServerBackupSlot,
} from '@/services/backup/serverBackupSlots';
import {
  getNewBackupPassphraseIssue,
  MIN_NEW_BACKUP_PASSPHRASE_LENGTH,
} from '@/services/backup/backupSchema';
import {
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { showDialog } from '../dialog/dialogStore';
import { NavRow, SettingsSection } from '../primitives';
import { useTheme } from '../theme';

interface ServerBackupSlotsSectionProps {
  lease: RealtimeDeliveryLease;
  operationBusy: boolean;
  tryBeginOperation(): boolean;
  finishOperation(): void;
}

type BusyAction = 'save' | `restore:${string}` | `delete:${string}` | null;

function sortSlots(slots: ServerBackupSlot[]): ServerBackupSlot[] {
  return [...slots].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

function formatUpdatedAt(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
}

function saveFailureCopy(error: unknown): string {
  if (error instanceof BackupPassphraseRejectedError) {
    return error.issue === 'too-short'
      ? `Use at least ${MIN_NEW_BACKUP_PASSPHRASE_LENGTH} characters.`
      : 'Choose a less common passphrase.';
  }
  if (error instanceof ServerBackupSlotError) {
    if (error.kind === 'ciphertext-too-large') {
      return 'This backup is too large for the server’s 1 MB slot endpoint. Use local export instead.';
    }
    if (error.kind === 'slot-limit') {
      return `This device won’t add more than ${SERVER_BACKUP_SLOT_LIMITS.slots} visible slots. Delete a slot first.`;
    }
    if (error.kind === 'invalid-name') return 'Choose a shorter backup name.';
  }
  if (isUnimplementedEndpoint(error)) return 'Server backups aren’t supported on this server.';
  return 'Couldn’t save the server backup. Check your connection.';
}

/** Named cross-device slots. Only BB2 ciphertext is retained in query state or sent to the server. */
export function ServerBackupSlotsSection({
  lease,
  operationBusy,
  tryBeginOperation,
  finishOperation,
}: ServerBackupSlotsSectionProps): React.JSX.Element {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const queryKey = ['server', 'backup-slots', lease.generation] as const;
  const mounted = useRef(true);
  const activeRequest = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeRealtimeGenerationInvalidation(lease.generation, () => {
      activeRequest.current?.abort('backup account retired');
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      activeRequest.current?.abort('backup screen closed');
      activeRequest.current = null;
    };
  }, [lease.generation]);

  const canPublish = (): boolean => mounted.current && lease.isCurrent();
  const slotsQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => listServerBackupSlots(lease, signal),
    retry: false,
    staleTime: 0,
  });
  const slots = canPublish() ? (slotsQuery.data ?? []) : [];
  const unsupported = slotsQuery.isError && isUnimplementedEndpoint(slotsQuery.error);
  const isBusy = operationBusy || busy !== null;

  let normalizedName: string | null = null;
  try {
    normalizedName = normalizeServerBackupSlotName(name);
  } catch {
    // The save action remains disabled until the user enters a bounded, non-control name.
  }
  const passphraseIssue = getNewBackupPassphraseIssue(passphrase);
  const canSave =
    !isBusy &&
    normalizedName !== null &&
    passphraseIssue === null &&
    passphrase === confirmPassphrase;

  const upsertCachedSlot = (slot: ServerBackupSlot): void => {
    queryClient.setQueryData<ServerBackupSlot[]>(queryKey, (current = []) =>
      sortSlots([...current.filter((item) => item.name !== slot.name), slot]),
    );
  };

  const performSave = async (slotName: string): Promise<void> => {
    if (!canPublish() || !tryBeginOperation()) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy('save');
    try {
      await queryClient.cancelQueries({ queryKey, exact: true });
      if (!canPublish()) return;
      const saved = await saveServerBackupSlot(
        {
          name: slotName,
          passphrase,
          now: Date.now(),
          existingSlotNames: slots.map((slot) => slot.name),
        },
        lease,
        controller.signal,
      );
      if (!canPublish()) return;
      upsertCachedSlot(saved);
      void queryClient.invalidateQueries({ queryKey, exact: true });
      setName('');
      setPassphrase('');
      setConfirmPassphrase('');
      showDialog('Server backup saved', `“${saved.name}” now contains a new encrypted backup.`);
    } catch (error) {
      if (!canPublish() || isBackupAccountChangedError(error)) return;
      showDialog('Server backup', saveFailureCopy(error));
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      finishOperation();
      if (canPublish()) setBusy(null);
    }
  };

  const onSave = (): void => {
    const slotName = normalizedName;
    if (!canSave || slotName === null) return;
    const existing = slots.some((slot) => slot.name === slotName);
    if (!existing) {
      void performSave(slotName);
      return;
    }
    showDialog(
      'Replace server backup?',
      `This replaces “${slotName}” with a newly encrypted copy. Refresh first if another device may have changed it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Replace',
          style: 'destructive',
          onPress: () => {
            if (canPublish()) void performSave(slotName);
          },
        },
      ],
    );
  };

  const onRestore = (slot: ServerBackupSlot): void => {
    if (!canPublish() || isBusy || slot.ciphertext === null) return;
    if (passphrase.length === 0) {
      showDialog('Restore server backup', 'Enter this backup’s passphrase above first.');
      return;
    }
    if (!tryBeginOperation()) return;
    setBusy(`restore:${slot.name}`);
    void (async () => {
      try {
        const result = await restoreServerBackupSlot(slot, passphrase, lease);
        if (!canPublish()) return;
        setPassphrase('');
        setConfirmPassphrase('');
        showDialog(
          'Restored',
          `Settings: ${result.kv}, themes: ${result.themes}, chats restored: ${result.chatCustomizations}, chats skipped: ${result.chatCustomizationsSkipped}.`,
        );
      } catch (error) {
        if (!canPublish() || isBackupAccountChangedError(error)) return;
        showDialog(
          'Restore server backup',
          'Couldn’t restore — check the passphrase and that this is a valid Gator backup.',
        );
      } finally {
        finishOperation();
        if (canPublish()) setBusy(null);
      }
    })();
  };

  const performDelete = async (slot: ServerBackupSlot): Promise<void> => {
    if (!canPublish() || !tryBeginOperation()) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(`delete:${slot.name}`);
    try {
      await queryClient.cancelQueries({ queryKey, exact: true });
      if (!canPublish()) return;
      await deleteServerBackupSlot(slot.name, lease, controller.signal);
      if (!canPublish()) return;
      queryClient.setQueryData<ServerBackupSlot[]>(queryKey, (current = []) =>
        current.filter((item) => item.name !== slot.name),
      );
      void queryClient.invalidateQueries({ queryKey, exact: true });
    } catch (error) {
      if (!canPublish() || isBackupAccountChangedError(error)) return;
      showDialog(
        'Delete server backup',
        isUnimplementedEndpoint(error)
          ? 'Server backups aren’t supported on this server.'
          : 'Couldn’t delete the server backup. Check your connection.',
      );
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      finishOperation();
      if (canPublish()) setBusy(null);
    }
  };

  const onDelete = (slot: ServerBackupSlot): void => {
    if (!canPublish() || isBusy) return;
    showDialog(
      'Delete server backup?',
      `Delete “${slot.name}” from the server? Refresh first if another device may have changed it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (canPublish()) void performDelete(slot);
          },
        },
      ],
    );
  };

  if (slotsQuery.isLoading) {
    return (
      <SettingsSection label="SERVER BACKUPS" style={styles.section}>
        <View style={styles.statusRow}>
          <ActivityIndicator color={theme.color.tint} />
          <Text style={[styles.statusText, { color: theme.color.secondaryLabel }]}>Checking…</Text>
        </View>
      </SettingsSection>
    );
  }

  if (unsupported) {
    return (
      <SettingsSection label="SERVER BACKUPS" style={styles.section}>
        <Text style={[styles.messageRow, { color: theme.color.secondaryLabel }]}>
          Named encrypted backups aren’t supported on this server. Local export and restore still
          work normally.
        </Text>
      </SettingsSection>
    );
  }

  if (slotsQuery.isError) {
    return (
      <SettingsSection label="SERVER BACKUPS" style={styles.section}>
        <Text style={[styles.messageRow, { color: theme.color.secondaryLabel }]}>
          Couldn’t load server backups. Local export and restore are still available.
        </Text>
        <NavRow
          label="Try again"
          chevron={false}
          disabled={isBusy}
          onPress={() => void slotsQuery.refetch()}
        />
      </SettingsSection>
    );
  }

  return (
    <View style={styles.section}>
      <Text style={[styles.note, { color: theme.color.secondaryLabel }]}>
        Server slots sync encrypted settings across your devices. The passphrase stays on this
        device; the server receives only ciphertext. Enter the original passphrase before Restore.
      </Text>

      <SettingsSection label="SAVE TO SERVER">
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Backup name"
          placeholderTextColor={theme.color.tertiaryLabel}
          autoCapitalize="sentences"
          maxLength={SERVER_BACKUP_SLOT_LIMITS.nameCharacters}
          accessibilityLabel="Server backup name"
          style={[styles.input, { color: theme.color.label }]}
        />
        <TextInput
          value={passphrase}
          onChangeText={setPassphrase}
          placeholder="Passphrase"
          placeholderTextColor={theme.color.tertiaryLabel}
          secureTextEntry
          autoCapitalize="none"
          accessibilityLabel="Server backup passphrase"
          style={[styles.input, { color: theme.color.label }]}
        />
        <TextInput
          value={confirmPassphrase}
          onChangeText={setConfirmPassphrase}
          placeholder="Confirm passphrase for saving"
          placeholderTextColor={theme.color.tertiaryLabel}
          secureTextEntry
          autoCapitalize="none"
          accessibilityLabel="Confirm server backup passphrase"
          style={[styles.input, { color: theme.color.label }]}
        />
        <Text style={[styles.hint, { color: theme.color.secondaryLabel }]}>
          New saves require at least {MIN_NEW_BACKUP_PASSPHRASE_LENGTH} characters. Restoring an
          older slot still accepts its original passphrase.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save encrypted backup to server"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          onPress={onSave}
          style={styles.actionRow}
        >
          <Text
            style={[
              styles.actionLabel,
              { color: canSave ? theme.color.tint : theme.color.tertiaryLabel },
            ]}
          >
            Save encrypted backup
          </Text>
        </Pressable>
      </SettingsSection>

      <SettingsSection label={`SAVED ON SERVER (${slots.length})`} style={styles.savedSection}>
        {slots.length === 0 ? (
          <Text style={[styles.messageRow, { color: theme.color.secondaryLabel }]}>
            No server backups yet.
          </Text>
        ) : (
          slots.map((slot) => {
            const restoring = busy === `restore:${slot.name}`;
            const deleting = busy === `delete:${slot.name}`;
            return (
              <View key={slot.name} style={styles.slotRow}>
                <View style={styles.slotCopy}>
                  <Text numberOfLines={2} style={[styles.slotName, { color: theme.color.label }]}>
                    {slot.name}
                  </Text>
                  <Text style={[styles.slotMeta, { color: theme.color.secondaryLabel }]}>
                    {slot.ciphertext === null
                      ? 'Legacy or incompatible data'
                      : formatUpdatedAt(slot.updatedAt)}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Restore ${slot.name}`}
                  accessibilityState={{ disabled: isBusy || slot.ciphertext === null }}
                  disabled={isBusy || slot.ciphertext === null}
                  onPress={() => onRestore(slot)}
                  style={styles.smallAction}
                >
                  {restoring ? (
                    <ActivityIndicator color={theme.color.tint} />
                  ) : (
                    <Text
                      style={{
                        color:
                          !isBusy && slot.ciphertext !== null
                            ? theme.color.tint
                            : theme.color.tertiaryLabel,
                      }}
                    >
                      Restore
                    </Text>
                  )}
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${slot.name}`}
                  accessibilityState={{ disabled: isBusy }}
                  disabled={isBusy}
                  onPress={() => onDelete(slot)}
                  style={styles.smallAction}
                >
                  {deleting ? (
                    <ActivityIndicator color={theme.color.destructive} />
                  ) : (
                    <Text
                      style={{
                        color: !isBusy ? theme.color.destructive : theme.color.tertiaryLabel,
                      }}
                    >
                      Delete
                    </Text>
                  )}
                </Pressable>
              </View>
            );
          })
        )}
        <NavRow
          label="Refresh server backups"
          chevron={false}
          disabled={isBusy || slotsQuery.isFetching}
          onPress={() => void slotsQuery.refetch()}
        />
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 24 },
  note: { fontSize: 13, lineHeight: 18, marginBottom: 12, marginHorizontal: 4 },
  savedSection: { marginTop: 16 },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  statusText: { fontSize: 15 },
  messageRow: { fontSize: 14, lineHeight: 19, paddingHorizontal: 16, paddingVertical: 14 },
  input: { fontSize: 16, paddingHorizontal: 16, paddingVertical: 12 },
  hint: { fontSize: 12, lineHeight: 16, paddingBottom: 8, paddingHorizontal: 16 },
  actionRow: { paddingHorizontal: 16, paddingVertical: 14 },
  actionLabel: { fontSize: 16 },
  slotRow: { alignItems: 'center', flexDirection: 'row', minHeight: 60, paddingLeft: 16 },
  slotCopy: { flex: 1, minWidth: 0, paddingVertical: 10 },
  slotName: { fontSize: 16 },
  slotMeta: { fontSize: 12, marginTop: 3 },
  smallAction: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 64,
    paddingHorizontal: 8,
  },
});
