import { useRouter } from 'expo-router';
import { useLayoutEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import {
  BackupPassphraseRejectedError,
  exportEncryptedBackup,
  importBackupAuto,
  isBackupAccountChangedError,
  readPickedBackupCopy,
} from '@/services/backup/backupService';
import {
  BACKUP_LIMITS,
  getNewBackupPassphraseIssue,
  MIN_NEW_BACKUP_PASSPHRASE_LENGTH,
  type NewBackupPassphraseIssue,
} from '@/services/backup/backupSchema';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { NavRow, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';

interface BackupDocumentPickerModule {
  getDocumentAsync(options: { type: string[]; copyToCacheDirectory: boolean }): Promise<{
    canceled: boolean;
    assets: Array<{ uri: string }> | null;
  }>;
}

type BackupDocumentPickerLoader = () => Promise<BackupDocumentPickerModule>;

/**
 * Open the account-neutral picker, then always clean up any private cache copy it returns. The
 * loader is injectable solely to make the delayed Android return deterministic in Node tests.
 */
export async function pickBackupFileForLease(
  lease: RealtimeDeliveryLease,
  loadPicker: BackupDocumentPickerLoader = () => import('expo-document-picker'),
): Promise<string | null> {
  const DocumentPicker = await loadPicker();
  if (!lease.isCurrent()) return null;
  const result = await DocumentPicker.getDocumentAsync({
    // .gatorbackup has no registered MIME, so allow any file and validate on restore.
    type: ['application/json', 'application/octet-stream', '*/*'],
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.[0]) return null;

  // The picker created this private copy before returning control. Even if the lease retired while
  // Android's UI was open, readPickedBackupCopy must receive it so its finally block deletes it.
  const content = await readPickedBackupCopy(result.assets[0].uri, lease);
  return lease.isCurrent() ? content : null;
}

function passphraseIssueMessage(issue: NewBackupPassphraseIssue): string {
  return issue === 'too-short'
    ? `Choose a passphrase of at least ${MIN_NEW_BACKUP_PASSPHRASE_LENGTH} characters.`
    : 'Choose a less common passphrase.';
}

/** Settings/theme/chat-customization backup: encrypted export (share file) + restore (paste). */
export default function BackupScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [paste, setPaste] = useState('');
  const [restorePass, setRestorePass] = useState('');
  // A retained picker/dialog callback must never adopt credentials from a later connection.
  const [screenLease] = useState(captureRealtimeDeliveryLease);
  const [accountRetired, setAccountRetired] = useState(() => !screenLease.isCurrent());

  // Lease currentness is not reactive. Hide and clear secrets as soon as this mounted account is
  // retired instead of waiting for navigation or an unrelated state update to cause a render.
  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(screenLease.generation, () => {
        setAccountRetired(true);
        setPass('');
        setPass2('');
        setPaste('');
        setRestorePass('');
        setBusy(false);
      }),
    [screenLease],
  );

  // Passphrases and pasted backup contents are secrets. The route can render once more while its
  // account is being replaced, so fail closed instead of repainting account-A input in B's tree.
  if (accountRetired || !screenLease.isCurrent()) {
    return (
      <Screen>
        <ScreenHeader title="Backup" onBack={() => router.back()} />
      </Screen>
    );
  }

  const passphraseIssue = getNewBackupPassphraseIssue(pass);
  const canExport = !busy && passphraseIssue === null && pass === pass2;

  const onExport = async (): Promise<void> => {
    if (!screenLease.isCurrent()) return;
    const issue = getNewBackupPassphraseIssue(pass);
    if (issue) {
      showDialog('Backup', passphraseIssueMessage(issue));
      return;
    }
    if (pass !== pass2) {
      showDialog('Backup', 'Passphrases do not match.');
      return;
    }
    setBusy(true);
    try {
      await exportEncryptedBackup(pass, Date.now(), screenLease);
      if (!screenLease.isCurrent()) return;
      setPass('');
      setPass2('');
    } catch (e) {
      if (!screenLease.isCurrent() || isBackupAccountChangedError(e)) return;
      if (e instanceof BackupPassphraseRejectedError) {
        showDialog('Backup', passphraseIssueMessage(e.issue));
        return;
      }
      showDialog(
        'Backup',
        e instanceof Error && e.message === 'sharing-unavailable'
          ? 'Sharing is not available on this device.'
          : 'Export failed.',
      );
    } finally {
      if (screenLease.isCurrent()) setBusy(false);
    }
  };

  // Pick a backup FILE (the exported .gatorbackup / .json) via the OS document picker and load its
  // contents into the restore field — so a user who exported a file can restore it without opening
  // it elsewhere and copy-pasting the whole ciphertext. They then enter the passphrase and Restore.
  const onPickFile = async (): Promise<void> => {
    if (!screenLease.isCurrent()) return;
    setBusy(true);
    try {
      const content = await pickBackupFileForLease(screenLease);
      if (content !== null && screenLease.isCurrent()) setPaste(content);
    } catch (e) {
      if (!screenLease.isCurrent() || isBackupAccountChangedError(e)) return;
      showDialog('Restore', 'Couldn’t open the backup file.');
    } finally {
      if (screenLease.isCurrent()) setBusy(false);
    }
  };

  const onImport = async (): Promise<void> => {
    if (!screenLease.isCurrent()) return;
    if (!paste.trim()) return;
    setBusy(true);
    try {
      const r = await importBackupAuto(paste.trim(), restorePass, screenLease);
      if (!screenLease.isCurrent()) return;
      setPaste('');
      setRestorePass('');
      showDialog(
        'Restored',
        `Settings: ${r.kv}, themes: ${r.themes}, chats: ${r.chatCustomizations}.`,
      );
    } catch (e) {
      if (!screenLease.isCurrent() || isBackupAccountChangedError(e)) return;
      showDialog(
        'Restore',
        'Couldn’t restore — check your passphrase and that the backup is valid.',
      );
    } finally {
      if (screenLease.isCurrent()) setBusy(false);
    }
  };

  const inputStyle = [styles.input, { color: theme.color.label }];

  return (
    <Screen>
      <ScreenHeader title="Backup" onBack={() => router.back()} />

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.note, { color: theme.color.secondaryLabel }]}>
          Backs up your theme, settings, and per-chat customizations — not messages or credentials.
          The file is encrypted with a passphrase you choose; keep it safe, it can’t be recovered.
        </Text>

        <SettingsSection>
          <TextInput
            value={pass}
            onChangeText={setPass}
            placeholder="Passphrase"
            placeholderTextColor={theme.color.tertiaryLabel}
            secureTextEntry
            autoCapitalize="none"
            style={inputStyle}
          />
          <TextInput
            value={pass2}
            onChangeText={setPass2}
            placeholder="Confirm passphrase"
            placeholderTextColor={theme.color.tertiaryLabel}
            secureTextEntry
            autoCapitalize="none"
            style={inputStyle}
          />
          <Text style={[styles.passphraseHint, { color: theme.color.secondaryLabel }]}>
            Use at least {MIN_NEW_BACKUP_PASSPHRASE_LENGTH} characters, avoid common phrases, and
            don’t reuse an important password.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Export encrypted backup"
            accessibilityState={{ disabled: !canExport }}
            onPress={() => void onExport()}
            disabled={!canExport}
            style={styles.row}
          >
            <Text
              style={[
                styles.rowLabel,
                { color: canExport ? theme.color.tint : theme.color.tertiaryLabel },
              ]}
            >
              Export encrypted backup…
            </Text>
          </Pressable>
        </SettingsSection>

        <SettingsSection label="RESTORE" style={styles.gap}>
          <NavRow
            label="Choose a backup file…"
            chevron={false}
            disabled={busy}
            onPress={() => void onPickFile()}
          />
        </SettingsSection>
        <SettingsSection style={styles.gapSm}>
          <TextInput
            value={paste}
            onChangeText={setPaste}
            placeholder="…or paste backup contents here"
            placeholderTextColor={theme.color.tertiaryLabel}
            multiline
            autoCapitalize="none"
            maxLength={BACKUP_LIMITS.encodedCharacters}
            style={[styles.paste, { color: theme.color.label }]}
          />
          <TextInput
            value={restorePass}
            onChangeText={setRestorePass}
            placeholder="Passphrase (for encrypted backups)"
            placeholderTextColor={theme.color.tertiaryLabel}
            secureTextEntry
            autoCapitalize="none"
            style={inputStyle}
          />
        </SettingsSection>
        <SettingsSection style={styles.gapSm}>
          <Pressable
            onPress={() => void onImport()}
            disabled={busy || !paste.trim()}
            style={styles.row}
          >
            <Text
              style={[
                styles.rowLabel,
                { color: paste.trim() ? theme.color.tint : theme.color.tertiaryLabel },
              ]}
            >
              Restore from backup
            </Text>
          </Pressable>
        </SettingsSection>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16 },
  note: { fontSize: 13, marginBottom: 16, marginHorizontal: 4, lineHeight: 18 },
  gap: { marginTop: 24 },
  gapSm: { marginTop: 12 },
  row: { paddingHorizontal: 16, paddingVertical: 14 },
  rowLabel: { fontSize: 16 },
  input: { paddingHorizontal: 16, paddingVertical: 12, fontSize: 16 },
  passphraseHint: { paddingHorizontal: 16, paddingBottom: 8, fontSize: 12, lineHeight: 16 },
  paste: { minHeight: 100, padding: 14, fontSize: 13, textAlignVertical: 'top' },
});
