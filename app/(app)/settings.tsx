import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isBiometricAvailable } from '@native/biometrics';
import { forget, rotateDatabaseKey, setAppLockEnabled } from '@/services';
import { requestDisableBatteryOptimization } from '@/services/battery';
import { syncContacts } from '@/services/contacts/contactsService';
import {
  MAX_CONCURRENT_DOWNLOADS_LIMIT,
  useFeatureSettingsStore,
  type AutoDownloadDestination,
} from '@state/featureSettingsStore';
import { MESSAGES_PER_CHAT_OPTIONS, useSyncSettingsStore } from '@state/syncSettingsStore';
import { useLockStore } from '@state/lockStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { useSessionStore } from '@state/sessionStore';
import { useSmartReplyStore } from '@state/smartReplyStore';
import { useThemeStore } from '@state/themeStore';
import {
  CheckRow,
  InfoRow,
  NavRow,
  NoteRow,
  Screen,
  ScreenHeader,
  SettingsSection,
  StepperRow,
  SwitchRow,
  useTheme,
} from '@ui';
import { PRESET_ORDER, PRESETS } from '@ui/theme/tokens';

/** Where auto-downloaded images are additionally saved (the picker in the DOWNLOADS section). */
const AUTO_DOWNLOAD_DEST_OPTIONS: { value: AutoDownloadDestination; label: string }[] = [
  { value: 'app', label: 'App only' },
  { value: 'gallery', label: 'Photos gallery' },
  { value: 'album', label: 'Gator album' },
];

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
  const maxDownloads = useFeatureSettingsStore((s) => s.maxConcurrentDownloads);
  const setMaxDownloads = useFeatureSettingsStore((s) => s.setMaxConcurrentDownloads);
  const privateApiEnabled = useFeatureSettingsStore((s) => s.privateApiEnabled);
  const sendTypingIndicators = useFeatureSettingsStore((s) => s.sendTypingIndicators);
  const sendReadReceipts = useFeatureSettingsStore((s) => s.sendReadReceipts);
  const sendSubjectLines = useFeatureSettingsStore((s) => s.sendSubjectLines);
  const autoDownload = useFeatureSettingsStore((s) => s.autoDownloadAttachments);
  const autoDownloadWifiOnly = useFeatureSettingsStore((s) => s.autoDownloadOnWifiOnly);
  const autoDownloadDestination = useFeatureSettingsStore((s) => s.autoDownloadDestination);
  const setAutoDownloadDestination = useFeatureSettingsStore((s) => s.setAutoDownloadDestination);
  const sendWithReturn = useFeatureSettingsStore((s) => s.sendWithReturn);
  const showDeliveryTimestamps = useFeatureSettingsStore((s) => s.showDeliveryTimestamps);
  const compactChatList = useFeatureSettingsStore((s) => s.compactChatList);
  const filterUnknownSenders = useFeatureSettingsStore((s) => s.filterUnknownSenders);
  const messageNotifications = useFeatureSettingsStore((s) => s.messageNotifications);
  const setFlag = useFeatureSettingsStore((s) => s.setFlag);
  const messagesPerChat = useSyncSettingsStore((s) => s.messagesPerChat);
  const setMessagesPerChat = useSyncSettingsStore((s) => s.setMessagesPerChat);
  const mpcOptions = MESSAGES_PER_CHAT_OPTIONS as readonly number[];
  const mpcIndex = Math.max(0, mpcOptions.indexOf(messagesPerChat));
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
    messaging: 'messaging private api typing indicators read receipts subject lines',
    conversation: 'conversation message view send with return enter delivery timestamps',
    chatlist: 'chat list conversations compact dense appearance unknown senders filter spam',
    notifications:
      'notifications alerts message notifications sound battery optimization background doze delivery reliable',
    downloads:
      'downloads parallel concurrent attachments images media bandwidth auto-download wifi gallery album photos save destination location',
    sync: 'sync messages per chat initial history',
    privacy: 'privacy redacted mode hide previews encryption key rotate security',
    server:
      'server management restart logs statistics health diagnostics private api find my keys push uptime alerts account alias apple id imessage start chats using',
    about: 'about server version macos private api disconnect forget app logs debug diagnostics',
  } as const;
  const match = (terms: string): boolean => q.length === 0 || terms.includes(q);
  const anyMatch = Object.values(SECTIONS).some(match);

  const onDisconnect = (): void => {
    showDialog('Disconnect', 'Forget this server and clear stored credentials?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => void forget() },
    ]);
  };

  const onRotateKey = (): void => {
    showDialog(
      'Rotate encryption key',
      'Re-encrypt the local database with a fresh key? Your data is unchanged; this is crash-safe.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Rotate',
          onPress: () =>
            void rotateDatabaseKey()
              .then(() => showDialog('Encryption key', 'Database key rotated.'))
              .catch(() => showDialog('Encryption key', 'Couldn’t rotate the key.')),
        },
      ],
    );
  };

  // Enabling requires enrolled biometrics, else the user could lock themselves out.
  const onToggleAppLock = async (next: boolean): Promise<void> => {
    if (next && !(await isBiometricAvailable())) {
      showDialog(
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
      showDialog('Contacts synced', `Read ${contacts} contacts, matched ${matched}.`);
    } catch (e) {
      showDialog(
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
      <ScreenHeader title="Settings" onBack={() => router.back()} />

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
            <SettingsSection label="THEME">
              {PRESET_ORDER.map((key) => (
                <CheckRow
                  key={key}
                  label={PRESETS[key].label}
                  checked={preset === key}
                  onPress={() => void setPreset(key)}
                />
              ))}
            </SettingsSection>
            <SettingsSection style={styles.subGroup}>
              <NavRow label="Custom Themes…" onPress={() => router.push('/themes')} />
            </SettingsSection>
          </>
        )}

        {match(SECTIONS.contacts) && (
          <SettingsSection label="CONTACTS" style={styles.gap}>
            <NavRow
              label={syncing ? 'Syncing…' : 'Sync Contacts'}
              onPress={() => void onSyncContacts()}
              disabled={syncing}
              chevron={false}
            />
          </SettingsSection>
        )}

        {match(SECTIONS.general) && (
          <SettingsSection label="GENERAL" style={styles.gap}>
            <SwitchRow
              label="Suggested Replies"
              value={smartReplies}
              onValueChange={(v) => void setSmartReplies(v)}
              accessibilityLabel="Toggle suggested replies"
            />
            <SwitchRow
              label="App Lock"
              value={appLock}
              onValueChange={(v) => void onToggleAppLock(v)}
              accessibilityLabel="Require biometric unlock to open the app"
            />
            <NavRow
              label="Reminders"
              color="label"
              chevron={false}
              onPress={() => router.push('/reminders')}
            />
            <NavRow
              label="Backup"
              color="label"
              chevron={false}
              onPress={() => router.push('/backup')}
            />
            <NavRow
              label="Find My"
              color="label"
              chevron={false}
              onPress={() => router.push('/findmy')}
            />
          </SettingsSection>
        )}

        {match(SECTIONS.messaging) && (
          <SettingsSection label="MESSAGING" style={styles.gap}>
            <SwitchRow
              label="Enable Private API Features"
              value={privateApiEnabled}
              onValueChange={(v) => void setFlag('privateApiEnabled', v)}
              accessibilityLabel="Enable typing indicators, read receipts, and other Private API features"
            />
            <SwitchRow
              label="Send Typing Indicators"
              value={sendTypingIndicators}
              disabled={!privateApiEnabled}
              onValueChange={(v) => void setFlag('sendTypingIndicators', v)}
              accessibilityLabel="Let others see when you are typing"
            />
            <SwitchRow
              label="Send Read Receipts"
              value={sendReadReceipts}
              disabled={!privateApiEnabled}
              onValueChange={(v) => void setFlag('sendReadReceipts', v)}
              accessibilityLabel="Let others see when you have read their messages"
            />
            <SwitchRow
              label="Send Subject Lines"
              value={sendSubjectLines}
              disabled={!privateApiEnabled}
              onValueChange={(v) => void setFlag('sendSubjectLines', v)}
              accessibilityLabel="Show a subject-line field above the message composer"
            />
          </SettingsSection>
        )}

        {match(SECTIONS.conversation) && (
          <SettingsSection label="CONVERSATION" style={styles.gap}>
            <SwitchRow
              label="Send with Return Key"
              value={sendWithReturn}
              onValueChange={(v) => void setFlag('sendWithReturn', v)}
              accessibilityLabel="Pressing return sends the message instead of adding a new line"
            />
            <SwitchRow
              label="Show Delivery Timestamps"
              value={showDeliveryTimestamps}
              onValueChange={(v) => void setFlag('showDeliveryTimestamps', v)}
              accessibilityLabel="Show Sent / Delivered / Read status under messages"
            />
          </SettingsSection>
        )}

        {match(SECTIONS.chatlist) && (
          <SettingsSection label="CHAT LIST" style={styles.gap}>
            <SwitchRow
              label="Compact Conversation List"
              value={compactChatList}
              onValueChange={(v) => void setFlag('compactChatList', v)}
              accessibilityLabel="Use denser conversation tiles"
            />
            <SwitchRow
              label="Filter Unknown Senders"
              value={filterUnknownSenders}
              onValueChange={(v) => void setFlag('filterUnknownSenders', v)}
              accessibilityLabel="Move chats from non-contacts to a separate list and silence their notifications"
            />
          </SettingsSection>
        )}

        {match(SECTIONS.notifications) && (
          <SettingsSection label="NOTIFICATIONS" style={styles.gap}>
            <SwitchRow
              label="Message Notifications"
              value={messageNotifications}
              onValueChange={(v) => void setFlag('messageNotifications', v)}
              accessibilityLabel="Show notifications for new messages"
            />
            {/* Android reliability: exempting the app from battery optimization (Doze) keeps
                background FCM/notification delivery from being killed. Opens the OS dialog. */}
            {Platform.OS === 'android' ? (
              <NavRow
                label="Disable Battery Optimization…"
                onPress={() => void requestDisableBatteryOptimization()}
                accessibilityLabel="Disable battery optimization for reliable notifications"
              />
            ) : null}
          </SettingsSection>
        )}

        {match(SECTIONS.downloads) && (
          <>
            <SettingsSection label="DOWNLOADS" style={styles.gap}>
              <SwitchRow
                label="Auto-download Attachments"
                value={autoDownload}
                onValueChange={(v) => void setFlag('autoDownloadAttachments', v)}
                accessibilityLabel="Automatically download incoming attachments"
              />
              <SwitchRow
                label="Only on Wi-Fi"
                value={autoDownloadWifiOnly}
                disabled={!autoDownload}
                onValueChange={(v) => void setFlag('autoDownloadOnWifiOnly', v)}
                accessibilityLabel="Only auto-download attachments on Wi-Fi"
              />
              <StepperRow
                label="Parallel Downloads"
                value={maxDownloads}
                onDecrement={() => void setMaxDownloads(maxDownloads - 1)}
                onIncrement={() => void setMaxDownloads(maxDownloads + 1)}
                canDecrement={maxDownloads > 1}
                canIncrement={maxDownloads < MAX_CONCURRENT_DOWNLOADS_LIMIT}
                decrementLabel="Fewer parallel downloads"
                incrementLabel="More parallel downloads"
              />
            </SettingsSection>
            <SettingsSection label="SAVE AUTO-DOWNLOADED IMAGES TO" style={styles.subGroup}>
              {AUTO_DOWNLOAD_DEST_OPTIONS.map((opt) => (
                <CheckRow
                  key={opt.value}
                  label={opt.label}
                  checked={autoDownloadDestination === opt.value}
                  onPress={() => void setAutoDownloadDestination(opt.value)}
                  disabled={!autoDownload}
                  dimmed={!autoDownload}
                />
              ))}
              <NoteRow text="A copy is saved outside the app. Photos permission is requested the first time. Images always appear in chats regardless." />
            </SettingsSection>
          </>
        )}

        {match(SECTIONS.sync) && (
          <SettingsSection label="SYNC" style={styles.gap}>
            <StepperRow
              label="Messages per Chat"
              value={messagesPerChat === 0 ? 'All' : messagesPerChat}
              onDecrement={() => void setMessagesPerChat(mpcOptions[mpcIndex - 1] ?? 0)}
              onIncrement={() =>
                void setMessagesPerChat(mpcOptions[mpcIndex + 1] ?? messagesPerChat)
              }
              canDecrement={mpcIndex > 0}
              canIncrement={mpcIndex < mpcOptions.length - 1}
              decrementLabel="Fewer messages per chat"
              incrementLabel="More messages per chat"
            />
            <NoteRow text="Caps the initial sync per chat (full history still loads when you open a chat)." />
          </SettingsSection>
        )}

        {match(SECTIONS.privacy) && (
          <SettingsSection label="PRIVACY" style={styles.gap}>
            <SwitchRow
              label="Redacted Mode"
              value={redacted}
              onValueChange={(v) => void setRedacted(v)}
              accessibilityLabel="Hide message previews, names, and notification contents"
            />
            <NavRow label="Rotate encryption key…" chevron={false} onPress={onRotateKey} />
          </SettingsSection>
        )}

        {match(SECTIONS.server) && (
          <SettingsSection label="SERVER" style={styles.gap}>
            <NavRow label="iMessage Account…" onPress={() => router.push('/account')} />
            <NavRow label="Server Management…" onPress={() => router.push('/server-management')} />
            <NavRow label="Server Health…" onPress={() => router.push('/server-health')} />
          </SettingsSection>
        )}

        {match(SECTIONS.about) && (
          <SettingsSection label="ABOUT" style={styles.gap}>
            <InfoRow label="Server" value={origin ?? '—'} />
            <InfoRow label="Version" value={serverInfo?.server_version ?? '—'} />
            <InfoRow label="macOS" value={serverInfo?.os_version ?? '—'} />
            <InfoRow label="Private API" value={serverInfo?.private_api ? 'Enabled' : 'Disabled'} />
            <NavRow
              label="App Logs…"
              onPress={() => router.push('/logs')}
              accessibilityLabel="View app logs"
            />
            <NavRow
              label="Disconnect"
              color="destructive"
              chevron={false}
              onPress={onDisconnect}
              accessibilityLabel="Disconnect from server"
            />
          </SettingsSection>
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

const styles = StyleSheet.create({
  content: { padding: 16 },
  search: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    marginBottom: 8,
  },
  noResults: { fontSize: 15, textAlign: 'center', marginTop: 32 },
  gap: { marginTop: 24 },
  subGroup: { marginTop: 8 },
});
