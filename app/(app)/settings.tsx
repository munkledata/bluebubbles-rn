import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isBiometricAvailable } from '@native/biometrics';
import { forget, rotateDatabaseKey, setAppLockEnabled } from '@/services';
import { syncContacts } from '@/services/contacts/contactsService';
import { useLockStore } from '@state/lockStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { useSessionStore } from '@state/sessionStore';
import { useSmartReplyStore } from '@state/smartReplyStore';
import { useThemeStore } from '@state/themeStore';
import { Screen, useTheme } from '@ui';
import { PRESET_ORDER, PRESETS } from '@ui/theme/tokens';

/** Settings: theme presets + contacts sync (more sections land in later phases). */
export default function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const preset = useThemeStore((s) => s.preset);
  const setPreset = useThemeStore((s) => s.setPreset);
  const smartReplies = useSmartReplyStore((s) => s.enabled);
  const setSmartReplies = useSmartReplyStore((s) => s.setEnabled);
  const appLock = useLockStore((s) => s.enabled);
  const redacted = useRedactedModeStore((s) => s.enabled);
  const setRedacted = useRedactedModeStore((s) => s.setEnabled);
  const origin = useSessionStore((s) => s.origin);
  const serverInfo = useSessionStore((s) => s.serverInfo);
  const [syncing, setSyncing] = useState(false);

  const onDisconnect = (): void => {
    Alert.alert('Disconnect', 'Forget this server and clear stored credentials?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => void forget() },
    ]);
  };

  const onRotateKey = (): void => {
    Alert.alert(
      'Rotate encryption key',
      'Re-encrypt the local database with a fresh key? Your data is unchanged; this is crash-safe.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Rotate',
          onPress: () =>
            void rotateDatabaseKey()
              .then(() => Alert.alert('Encryption key', 'Database key rotated.'))
              .catch(() => Alert.alert('Encryption key', 'Couldn’t rotate the key.')),
        },
      ],
    );
  };

  // Enabling requires enrolled biometrics, else the user could lock themselves out.
  const onToggleAppLock = async (next: boolean): Promise<void> => {
    if (next && !(await isBiometricAvailable())) {
      Alert.alert(
        'Biometrics required',
        'Set up a fingerprint, face unlock, or device PIN before enabling App Lock.',
      );
      return;
    }
    await setAppLockEnabled(next);
  };

  const onSyncContacts = async (): Promise<void> => {
    setSyncing(true);
    try {
      const { contacts, matched } = await syncContacts();
      Alert.alert('Contacts synced', `Read ${contacts} contacts, matched ${matched}.`);
    } catch (e) {
      Alert.alert(
        'Contacts',
        e instanceof Error && e.message === 'contacts-permission-denied'
          ? 'Permission denied. Enable Contacts access in system settings to show names and photos.'
          : 'Sync failed.',
      );
    } finally {
      setSyncing(false);
    }
  };

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
        <Text style={[styles.title, { color: theme.color.label }]}>Settings</Text>
        <View style={styles.spacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.sectionLabel, { color: theme.color.secondaryLabel }]}>THEME</Text>
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          {PRESET_ORDER.map((key, i) => (
            <Pressable
              key={key}
              onPress={() => void setPreset(key)}
              style={[
                styles.row,
                i > 0 && {
                  borderTopColor: theme.color.separator,
                  borderTopWidth: StyleSheet.hairlineWidth,
                },
              ]}
            >
              <Text style={[styles.rowLabel, { color: theme.color.label }]}>
                {PRESETS[key].label}
              </Text>
              {preset === key ? (
                <Text style={[styles.check, { color: theme.color.tint }]}>✓</Text>
              ) : null}
            </Pressable>
          ))}
        </View>
        <View
          style={[styles.group, { backgroundColor: theme.color.secondaryBackground, marginTop: 8 }]}
        >
          <Pressable onPress={() => router.push('/themes')} style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.color.tint }]}>Custom Themes…</Text>
            <Text style={[styles.check, { color: theme.color.tertiaryLabel }]}>›</Text>
          </Pressable>
        </View>

        <Text style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}>
          CONTACTS
        </Text>
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          <Pressable onPress={() => void onSyncContacts()} disabled={syncing} style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.color.tint }]}>
              {syncing ? 'Syncing…' : 'Sync Contacts'}
            </Text>
          </Pressable>
        </View>

        <Text style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}>
          GENERAL
        </Text>
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          <View style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Suggested Replies</Text>
            <Switch
              value={smartReplies}
              onValueChange={(v) => void setSmartReplies(v)}
              accessibilityLabel="Toggle suggested replies"
            />
          </View>
          <View
            style={[
              styles.row,
              { borderTopColor: theme.color.separator, borderTopWidth: StyleSheet.hairlineWidth },
            ]}
          >
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>App Lock</Text>
            <Switch
              value={appLock}
              onValueChange={(v) => void onToggleAppLock(v)}
              accessibilityLabel="Require biometric unlock to open the app"
            />
          </View>
          <Pressable
            onPress={() => router.push('/reminders')}
            style={[
              styles.row,
              { borderTopColor: theme.color.separator, borderTopWidth: StyleSheet.hairlineWidth },
            ]}
          >
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Reminders</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/backup')}
            style={[
              styles.row,
              { borderTopColor: theme.color.separator, borderTopWidth: StyleSheet.hairlineWidth },
            ]}
          >
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Backup</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/findmy')}
            style={[
              styles.row,
              { borderTopColor: theme.color.separator, borderTopWidth: StyleSheet.hairlineWidth },
            ]}
          >
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Find My</Text>
          </Pressable>
        </View>

        <Text style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}>
          PRIVACY
        </Text>
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          <View style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Redacted Mode</Text>
            <Switch
              value={redacted}
              onValueChange={(v) => void setRedacted(v)}
              accessibilityLabel="Hide message previews, names, and notification contents"
            />
          </View>
          <Pressable
            onPress={onRotateKey}
            style={[
              styles.row,
              { borderTopColor: theme.color.separator, borderTopWidth: StyleSheet.hairlineWidth },
            ]}
          >
            <Text style={[styles.rowLabel, { color: theme.color.tint }]}>
              Rotate encryption key…
            </Text>
          </Pressable>
        </View>

        <Text style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}>
          SERVER
        </Text>
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          <Pressable onPress={() => router.push('/server-management')} style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.color.tint }]}>Server Management…</Text>
            <Text style={[styles.check, { color: theme.color.tertiaryLabel }]}>›</Text>
          </Pressable>
        </View>

        <Text style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}>
          ABOUT
        </Text>
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          <InfoRow label="Server" value={origin ?? '—'} theme={theme} />
          <InfoRow label="Version" value={serverInfo?.server_version ?? '—'} theme={theme} top />
          <InfoRow label="macOS" value={serverInfo?.os_version ?? '—'} theme={theme} top />
          <InfoRow
            label="Private API"
            value={serverInfo?.private_api ? 'Enabled' : 'Disabled'}
            theme={theme}
            top
          />
          <Pressable
            onPress={onDisconnect}
            style={[
              styles.row,
              { borderTopColor: theme.color.separator, borderTopWidth: StyleSheet.hairlineWidth },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Disconnect from server"
          >
            <Text style={[styles.rowLabel, { color: theme.color.destructive }]}>Disconnect</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  );
}

function InfoRow({
  label,
  value,
  theme,
  top,
}: {
  label: string;
  value: string;
  theme: ReturnType<typeof useTheme>;
  top?: boolean;
}): React.JSX.Element {
  return (
    <View
      style={[
        styles.row,
        top
          ? { borderTopColor: theme.color.separator, borderTopWidth: StyleSheet.hairlineWidth }
          : null,
      ]}
    >
      <Text style={[styles.rowLabel, { color: theme.color.label }]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.infoValue, { color: theme.color.secondaryLabel }]}>
        {value}
      </Text>
    </View>
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
  sectionLabel: { fontSize: 13, marginBottom: 6, marginLeft: 12 },
  group: { borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowLabel: { fontSize: 16 },
  infoValue: { fontSize: 15, flexShrink: 1, marginLeft: 16, textAlign: 'right' },
  check: { fontSize: 16, fontWeight: '700' },
});
