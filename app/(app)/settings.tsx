import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isBiometricAvailable } from '@native/biometrics';
import { forget, rotateDatabaseKey, setAppLockEnabled } from '@/services';
import { syncContacts } from '@/services/contacts/contactsService';
import {
  MAX_CONCURRENT_DOWNLOADS_LIMIT,
  useDownloadSettingsStore,
} from '@state/downloadSettingsStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
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
  const maxDownloads = useDownloadSettingsStore((s) => s.maxConcurrent);
  const setMaxDownloads = useDownloadSettingsStore((s) => s.setMaxConcurrent);
  const privateApiEnabled = useFeatureSettingsStore((s) => s.privateApiEnabled);
  const sendTypingIndicators = useFeatureSettingsStore((s) => s.sendTypingIndicators);
  const sendReadReceipts = useFeatureSettingsStore((s) => s.sendReadReceipts);
  const autoDownload = useFeatureSettingsStore((s) => s.autoDownloadAttachments);
  const autoDownloadWifiOnly = useFeatureSettingsStore((s) => s.autoDownloadOnWifiOnly);
  const sendWithReturn = useFeatureSettingsStore((s) => s.sendWithReturn);
  const showDeliveryTimestamps = useFeatureSettingsStore((s) => s.showDeliveryTimestamps);
  const compactChatList = useFeatureSettingsStore((s) => s.compactChatList);
  const messageNotifications = useFeatureSettingsStore((s) => s.messageNotifications);
  const setFlag = useFeatureSettingsStore((s) => s.setFlag);
  const origin = useSessionStore((s) => s.origin);
  const serverInfo = useSessionStore((s) => s.serverInfo);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // Keyword bag per section — a section is shown when the query is empty OR matches its bag.
  const SECTIONS = {
    theme: 'theme appearance oled dark gator custom presets colors',
    contacts: 'contacts sync names photos address book',
    general: 'general suggested smart replies app lock biometric reminders backup find my location',
    messaging: 'messaging private api typing indicators read receipts',
    conversation: 'conversation message view send with return enter delivery timestamps',
    chatlist: 'chat list conversations compact dense appearance',
    notifications: 'notifications alerts message notifications sound',
    downloads: 'downloads parallel concurrent attachments images media bandwidth auto-download wifi',
    privacy: 'privacy redacted mode hide previews encryption key rotate security',
    server: 'server management restart logs statistics',
    about: 'about server version macos private api disconnect forget',
  } as const;
  const match = (terms: string): boolean => q.length === 0 || terms.includes(q);
  const anyMatch = Object.values(SECTIONS).some(match);

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

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search settings"
          placeholderTextColor={theme.color.tertiaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          style={[
            styles.search,
            { backgroundColor: theme.color.secondaryBackground, color: theme.color.label },
          ]}
        />

        {match(SECTIONS.theme) && (
          <>
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
              style={[
                styles.group,
                { backgroundColor: theme.color.secondaryBackground, marginTop: 8 },
              ]}
            >
              <Pressable onPress={() => router.push('/themes')} style={styles.row}>
                <Text style={[styles.rowLabel, { color: theme.color.tint }]}>Custom Themes…</Text>
                <Text style={[styles.check, { color: theme.color.tertiaryLabel }]}>›</Text>
              </Pressable>
            </View>
          </>
        )}

        {match(SECTIONS.contacts) && (
          <>
            <Text
              style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}
            >
              CONTACTS
            </Text>
            <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
              <Pressable
                onPress={() => void onSyncContacts()}
                disabled={syncing}
                style={styles.row}
              >
                <Text style={[styles.rowLabel, { color: theme.color.tint }]}>
                  {syncing ? 'Syncing…' : 'Sync Contacts'}
                </Text>
              </Pressable>
            </View>
          </>
        )}

        {match(SECTIONS.general) && (
          <>
            <Text
              style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}
            >
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
                  {
                    borderTopColor: theme.color.separator,
                    borderTopWidth: StyleSheet.hairlineWidth,
                  },
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
                  {
                    borderTopColor: theme.color.separator,
                    borderTopWidth: StyleSheet.hairlineWidth,
                  },
                ]}
              >
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>Reminders</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push('/backup')}
                style={[
                  styles.row,
                  {
                    borderTopColor: theme.color.separator,
                    borderTopWidth: StyleSheet.hairlineWidth,
                  },
                ]}
              >
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>Backup</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push('/findmy')}
                style={[
                  styles.row,
                  {
                    borderTopColor: theme.color.separator,
                    borderTopWidth: StyleSheet.hairlineWidth,
                  },
                ]}
              >
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>Find My</Text>
              </Pressable>
            </View>
          </>
        )}

        {match(SECTIONS.messaging) && (
          <>
            <Text
              style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}
            >
              MESSAGING
            </Text>
            <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>
                  Enable Private API Features
                </Text>
                <Switch
                  value={privateApiEnabled}
                  onValueChange={(v) => void setFlag('privateApiEnabled', v)}
                  accessibilityLabel="Enable typing indicators, read receipts, and other Private API features"
                />
              </View>
              <View
                style={[
                  styles.row,
                  { borderTopColor: theme.color.separator, borderTopWidth: StyleSheet.hairlineWidth },
                ]}
              >
                <Text
                  style={[
                    styles.rowLabel,
                    { color: privateApiEnabled ? theme.color.label : theme.color.tertiaryLabel },
                  ]}
                >
                  Send Typing Indicators
                </Text>
                <Switch
                  value={sendTypingIndicators}
                  disabled={!privateApiEnabled}
                  onValueChange={(v) => void setFlag('sendTypingIndicators', v)}
                  accessibilityLabel="Let others see when you are typing"
                />
              </View>
              <View
                style={[
                  styles.row,
                  { borderTopColor: theme.color.separator, borderTopWidth: StyleSheet.hairlineWidth },
                ]}
              >
                <Text
                  style={[
                    styles.rowLabel,
                    { color: privateApiEnabled ? theme.color.label : theme.color.tertiaryLabel },
                  ]}
                >
                  Send Read Receipts
                </Text>
                <Switch
                  value={sendReadReceipts}
                  disabled={!privateApiEnabled}
                  onValueChange={(v) => void setFlag('sendReadReceipts', v)}
                  accessibilityLabel="Let others see when you have read their messages"
                />
              </View>
            </View>
          </>
        )}

        {match(SECTIONS.conversation) && (
          <>
            <Text
              style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}
            >
              CONVERSATION
            </Text>
            <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>
                  Send with Return Key
                </Text>
                <Switch
                  value={sendWithReturn}
                  onValueChange={(v) => void setFlag('sendWithReturn', v)}
                  accessibilityLabel="Pressing return sends the message instead of adding a new line"
                />
              </View>
              <View
                style={[
                  styles.row,
                  { borderTopColor: theme.color.separator, borderTopWidth: StyleSheet.hairlineWidth },
                ]}
              >
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>
                  Show Delivery Timestamps
                </Text>
                <Switch
                  value={showDeliveryTimestamps}
                  onValueChange={(v) => void setFlag('showDeliveryTimestamps', v)}
                  accessibilityLabel="Show Sent / Delivered / Read status under messages"
                />
              </View>
            </View>
          </>
        )}

        {match(SECTIONS.chatlist) && (
          <>
            <Text
              style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}
            >
              CHAT LIST
            </Text>
            <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>
                  Compact Conversation List
                </Text>
                <Switch
                  value={compactChatList}
                  onValueChange={(v) => void setFlag('compactChatList', v)}
                  accessibilityLabel="Use denser conversation tiles"
                />
              </View>
            </View>
          </>
        )}

        {match(SECTIONS.notifications) && (
          <>
            <Text
              style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}
            >
              NOTIFICATIONS
            </Text>
            <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>
                  Message Notifications
                </Text>
                <Switch
                  value={messageNotifications}
                  onValueChange={(v) => void setFlag('messageNotifications', v)}
                  accessibilityLabel="Show notifications for new messages"
                />
              </View>
            </View>
          </>
        )}

        {match(SECTIONS.downloads) && (
          <>
            <Text
              style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}
            >
              DOWNLOADS
            </Text>
            <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>
                  Auto-download Attachments
                </Text>
                <Switch
                  value={autoDownload}
                  onValueChange={(v) => void setFlag('autoDownloadAttachments', v)}
                  accessibilityLabel="Automatically download incoming attachments"
                />
              </View>
              <View
                style={[
                  styles.row,
                  { borderTopColor: theme.color.separator, borderTopWidth: StyleSheet.hairlineWidth },
                ]}
              >
                <Text
                  style={[
                    styles.rowLabel,
                    { color: autoDownload ? theme.color.label : theme.color.tertiaryLabel },
                  ]}
                >
                  Only on Wi-Fi
                </Text>
                <Switch
                  value={autoDownloadWifiOnly}
                  disabled={!autoDownload}
                  onValueChange={(v) => void setFlag('autoDownloadOnWifiOnly', v)}
                  accessibilityLabel="Only auto-download attachments on Wi-Fi"
                />
              </View>
              <View
                style={[
                  styles.row,
                  { borderTopColor: theme.color.separator, borderTopWidth: StyleSheet.hairlineWidth },
                ]}
              >
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>
                  Parallel Downloads
                </Text>
                <View style={styles.stepper}>
                  <Pressable
                    onPress={() => void setMaxDownloads(maxDownloads - 1)}
                    disabled={maxDownloads <= 1}
                    hitSlop={8}
                    accessibilityLabel="Fewer parallel downloads"
                  >
                    <Text
                      style={[
                        styles.stepBtn,
                        {
                          color:
                            maxDownloads <= 1 ? theme.color.tertiaryLabel : theme.color.tint,
                        },
                      ]}
                    >
                      −
                    </Text>
                  </Pressable>
                  <Text style={[styles.stepValue, { color: theme.color.label }]}>
                    {maxDownloads}
                  </Text>
                  <Pressable
                    onPress={() => void setMaxDownloads(maxDownloads + 1)}
                    disabled={maxDownloads >= MAX_CONCURRENT_DOWNLOADS_LIMIT}
                    hitSlop={8}
                    accessibilityLabel="More parallel downloads"
                  >
                    <Text
                      style={[
                        styles.stepBtn,
                        {
                          color:
                            maxDownloads >= MAX_CONCURRENT_DOWNLOADS_LIMIT
                              ? theme.color.tertiaryLabel
                              : theme.color.tint,
                        },
                      ]}
                    >
                      +
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </>
        )}

        {match(SECTIONS.privacy) && (
          <>
            <Text
              style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}
            >
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
                  {
                    borderTopColor: theme.color.separator,
                    borderTopWidth: StyleSheet.hairlineWidth,
                  },
                ]}
              >
                <Text style={[styles.rowLabel, { color: theme.color.tint }]}>
                  Rotate encryption key…
                </Text>
              </Pressable>
            </View>
          </>
        )}

        {match(SECTIONS.server) && (
          <>
            <Text
              style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}
            >
              SERVER
            </Text>
            <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
              <Pressable onPress={() => router.push('/server-management')} style={styles.row}>
                <Text style={[styles.rowLabel, { color: theme.color.tint }]}>
                  Server Management…
                </Text>
                <Text style={[styles.check, { color: theme.color.tertiaryLabel }]}>›</Text>
              </Pressable>
            </View>
          </>
        )}

        {match(SECTIONS.about) && (
          <>
            <Text
              style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}
            >
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
                  {
                    borderTopColor: theme.color.separator,
                    borderTopWidth: StyleSheet.hairlineWidth,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Disconnect from server"
              >
                <Text style={[styles.rowLabel, { color: theme.color.destructive }]}>Disconnect</Text>
              </Pressable>
            </View>
          </>
        )}

        {q.length > 0 && !anyMatch && (
          <Text style={[styles.noResults, { color: theme.color.secondaryLabel }]}>
            No settings match “{query}”.
          </Text>
        )}
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
  search: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    marginBottom: 8,
  },
  noResults: { fontSize: 15, textAlign: 'center', marginTop: 32 },
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
  stepper: { flexDirection: 'row', alignItems: 'center' },
  stepBtn: { fontSize: 24, fontWeight: '500', width: 32, textAlign: 'center' },
  stepValue: { fontSize: 16, fontWeight: '600', minWidth: 24, textAlign: 'center' },
});
