import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { exportEncryptedBackup, importBackupAuto } from '@/services/backup/backupService';
import { NavRow, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';

const MIN_PASS = 6;

/** Settings/theme/chat-customization backup: encrypted export (share file) + restore (paste). */
export default function BackupScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [paste, setPaste] = useState('');
  const [restorePass, setRestorePass] = useState('');

  const canExport = !busy && pass.length >= MIN_PASS && pass === pass2;

  const onExport = async (): Promise<void> => {
    if (pass.length < MIN_PASS) {
      showDialog('Backup', `Choose a passphrase of at least ${MIN_PASS} characters.`);
      return;
    }
    if (pass !== pass2) {
      showDialog('Backup', 'Passphrases do not match.');
      return;
    }
    setBusy(true);
    try {
      await exportEncryptedBackup(pass, Date.now());
      setPass('');
      setPass2('');
    } catch (e) {
      showDialog(
        'Backup',
        e instanceof Error && e.message === 'sharing-unavailable'
          ? 'Sharing is not available on this device.'
          : 'Export failed.',
      );
    } finally {
      setBusy(false);
    }
  };

  // Pick a backup FILE (the exported .gatorbackup / .json) via the OS document picker and load its
  // contents into the restore field — so a user who exported a file can restore it without opening
  // it elsewhere and copy-pasting the whole ciphertext. They then enter the passphrase and Restore.
  const onPickFile = async (): Promise<void> => {
    setBusy(true);
    try {
      const DocumentPicker = await import('expo-document-picker');
      const res = await DocumentPicker.getDocumentAsync({
        // .gatorbackup has no registered MIME, so allow any file and validate on restore.
        type: ['application/json', 'application/octet-stream', '*/*'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets[0]) return;
      const { File } = await import('expo-file-system');
      const content = await new File(res.assets[0].uri).text();
      setPaste(content.trim());
    } catch {
      showDialog('Restore', 'Couldn’t open the backup file.');
    } finally {
      setBusy(false);
    }
  };

  const onImport = async (): Promise<void> => {
    if (!paste.trim()) return;
    setBusy(true);
    try {
      const r = await importBackupAuto(paste.trim(), restorePass);
      setPaste('');
      setRestorePass('');
      showDialog(
        'Restored',
        `Settings: ${r.kv}, themes: ${r.themes}, chats: ${r.chatCustomizations}.`,
      );
    } catch {
      showDialog(
        'Restore',
        'Couldn’t restore — check your passphrase and that the backup is valid.',
      );
    } finally {
      setBusy(false);
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
          <Pressable onPress={() => void onExport()} disabled={!canExport} style={styles.row}>
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
  paste: { minHeight: 100, padding: 14, fontSize: 13, textAlignVertical: 'top' },
});
