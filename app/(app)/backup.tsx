import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { exportEncryptedBackup, importBackupAuto } from '@/services/backup/backupService';
import { Screen, useTheme } from '@ui';

const MIN_PASS = 6;

/** Settings/theme/chat-customization backup: encrypted export (share file) + restore (paste). */
export default function BackupScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [paste, setPaste] = useState('');
  const [restorePass, setRestorePass] = useState('');

  const canExport = !busy && pass.length >= MIN_PASS && pass === pass2;

  const onExport = async (): Promise<void> => {
    if (pass.length < MIN_PASS) {
      Alert.alert('Backup', `Choose a passphrase of at least ${MIN_PASS} characters.`);
      return;
    }
    if (pass !== pass2) {
      Alert.alert('Backup', 'Passphrases do not match.');
      return;
    }
    setBusy(true);
    try {
      await exportEncryptedBackup(pass, Date.now());
      setPass('');
      setPass2('');
    } catch (e) {
      Alert.alert(
        'Backup',
        e instanceof Error && e.message === 'sharing-unavailable'
          ? 'Sharing is not available on this device.'
          : 'Export failed.',
      );
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
      Alert.alert(
        'Restored',
        `Settings: ${r.kv}, themes: ${r.themes}, chats: ${r.chatCustomizations}.`,
      );
    } catch {
      Alert.alert(
        'Restore',
        'Couldn’t restore — check your passphrase and that the backup is valid.',
      );
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = [
    styles.input,
    { color: theme.color.label, borderColor: theme.color.separator },
  ];

  return (
    <Screen>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, borderBottomColor: theme.color.separator },
        ]}
      >
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.back, { color: theme.color.tint }]}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.color.label }]}>Backup</Text>
        <View style={styles.spacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.note, { color: theme.color.secondaryLabel }]}>
          Backs up your theme, settings, and per-chat customizations — not messages or credentials.
          The file is encrypted with a passphrase you choose; keep it safe, it can’t be recovered.
        </Text>

        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
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
        </View>

        <Text style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}>
          RESTORE
        </Text>
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          <TextInput
            value={paste}
            onChangeText={setPaste}
            placeholder="Paste backup contents here"
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
        </View>
        <View
          style={[
            styles.group,
            { backgroundColor: theme.color.secondaryBackground, marginTop: 12 },
          ]}
        >
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
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { fontSize: 17, width: 70 },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  spacer: { width: 70 },
  content: { padding: 16 },
  note: { fontSize: 13, marginBottom: 16, marginHorizontal: 4, lineHeight: 18 },
  sectionLabel: { fontSize: 13, marginBottom: 6, marginLeft: 12 },
  group: { borderRadius: 12, overflow: 'hidden' },
  row: { paddingHorizontal: 16, paddingVertical: 14 },
  rowLabel: { fontSize: 16 },
  input: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  paste: { minHeight: 100, padding: 14, fontSize: 13, textAlignVertical: 'top' },
});
