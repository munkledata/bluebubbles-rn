import { useRouter } from 'expo-router';
import * as Application from 'expo-application';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, Platform, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { SHARED_PASSWORD_PUSH_CUTOFF_MS } from '@core/config/constants';
import { isScopedDeviceCredential, logger } from '@core/secure';
import { showDialog } from '@ui/dialog/dialogStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { authenticate, hasDeviceCredential, isBiometricAvailable } from '@native/biometrics';
import {
  getSecureScreenState,
  setSecureScreenEnabled,
  type SecureScreenState,
} from '@native/screenSecurity';
import {
  disconnectFailureMessage,
  forget,
  forgetOnThisPhoneOnly,
  isUnconfirmedCredentialRetirement,
  previousUnrevokedServerOrigin,
  rotateDatabaseKey,
  setAppLockEnabled,
} from '@/services';
import { requestDisableBatteryOptimization } from '@/services/battery';
import {
  setAttachmentAutoDownloadDestination,
  setAttachmentAutoDownloadEnabled,
  setErrorReportingConsent,
} from '@/services/featureSettingsCommands';
import {
  getContactsPermissionState,
  isContactsAccountChangedError,
  isContactsPermissionDeniedError,
  syncContacts,
} from '@/services/contacts/contactsService';
import {
  getNotificationPermissionState,
  openNotificationPermissionSettings,
  requestNotificationPermission,
  type NotificationPermissionState,
} from '@/services/notifications/notifeeService';
import {
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';
import {
  MAX_CONCURRENT_DOWNLOADS_LIMIT,
  useFeatureSettingsStore,
  type AutoDownloadDestination,
} from '@state/featureSettingsStore';
import { MESSAGES_PER_CHAT_OPTIONS, useSyncSettingsStore } from '@state/syncSettingsStore';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { useThemeStore } from '@state/themeStore';
import { useTransportHealthStore } from '@state/transportHealthStore';
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
import { confirmForgetPreviousServer, transportHealthStatusLabel } from '@ui/connection';
import {
  showContactsPermissionRationale,
  showContactsPermissionRecovery,
} from '@ui/permissions/contactsPermission';
import { PRESET_ORDER, PRESETS } from '@ui/theme/tokens';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';

/** Where auto-downloaded images are additionally saved (the picker in the DOWNLOADS section). */
const AUTO_DOWNLOAD_DEST_OPTIONS: { value: AutoDownloadDestination; label: string }[] = [
  { value: 'app', label: 'App only' },
  { value: 'gallery', label: 'Photos gallery' },
  { value: 'album', label: 'Gator album' },
];

const APP_VERSION = Application.nativeApplicationVersion ?? '—';
const APP_BUILD = Application.nativeBuildVersion ?? '—';

const notificationPermissionLabel = (
  permission: NotificationPermissionState | 'loading' | 'unavailable',
): string => {
  if (permission === 'granted') return 'Android access is enabled.';
  if (permission === 'denied')
    return 'Android access is denied. Open Notification Access to enable it.';
  if (permission === 'not-determined') return 'Android access has not been requested.';
  return permission === 'loading'
    ? 'Checking Android notification access…'
    : 'Android notification status is unavailable.';
};

/** Settings: this phone's preferences, account, privacy and maintenance sections. */
export default function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Native permission/address-book reads can outlive this route. Keep their eventual DB result and
  // dialog bound to the account that mounted this screen instance.
  const accountLease = useScreenAccountLease();
  const mountedRef = useRef(true);
  const screenCurrent = (): boolean => mountedRef.current && accountLease.isCurrent();
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const preset = useThemeStore((s) => s.preset);
  const setPreset = useThemeStore((s) => s.setPreset);
  const appLock = useLockStore((s) => s.enabled);
  const appLockChangePending = useRef(false);
  const [secureScreen, setSecureScreen] = useState<SecureScreenState>(getSecureScreenState);
  const maxDownloads = useFeatureSettingsStore((s) => s.maxConcurrentDownloads);
  const setMaxDownloads = useFeatureSettingsStore((s) => s.setMaxConcurrentDownloads);
  const sendTypingIndicators = useFeatureSettingsStore((s) => s.sendTypingIndicators);
  const sendReadReceipts = useFeatureSettingsStore((s) => s.sendReadReceipts);
  const autoDownload = useFeatureSettingsStore((s) => s.autoDownloadAttachments);
  const autoDownloadWifiOnly = useFeatureSettingsStore((s) => s.autoDownloadOnWifiOnly);
  const autoDownloadDestination = useFeatureSettingsStore((s) => s.autoDownloadDestination);
  const sendWithReturn = useFeatureSettingsStore((s) => s.sendWithReturn);
  const showDeliveryTimestamps = useFeatureSettingsStore((s) => s.showDeliveryTimestamps);
  const compactChatList = useFeatureSettingsStore((s) => s.compactChatList);
  const filterUnknownSenders = useFeatureSettingsStore((s) => s.filterUnknownSenders);
  const messageNotifications = useFeatureSettingsStore((s) => s.messageNotifications);
  const errorReportingEnabled = useFeatureSettingsStore((s) => s.errorReportingEnabled);
  const setFlag = useFeatureSettingsStore((s) => s.setFlag);
  // The store switches a privacy choice back when it cannot be saved; say so instead of nothing.
  const savePrivacyFlag = (
    flag: 'sendTypingIndicators' | 'sendReadReceipts' | 'messageNotifications',
    value: boolean,
  ): void => {
    void setFlag(flag, value).catch(() => {
      if (!screenCurrent()) return;
      showDialog(
        'Setting not saved',
        'Gator could not save this change, so it was switched back. Try again.',
      );
    });
  };
  const messagesPerChat = useSyncSettingsStore((s) => s.messagesPerChat);
  const setMessagesPerChat = useSyncSettingsStore((s) => s.setMessagesPerChat);
  const mpcOptions = MESSAGES_PER_CHAT_OPTIONS as readonly number[];
  const mpcIndex = Math.max(0, mpcOptions.indexOf(messagesPerChat));
  const origin = useSessionStore((s) => s.origin);
  const serverInfo = useSessionStore((s) => s.serverInfo);
  const password = useSessionStore((s) => s.password);
  const transportStatus = useTransportHealthStore((s) => s.status);
  // Lease currentness revokes callbacks immediately but is not reactive. Commit a monotonic
  // retired state so account-A server values and routes disappear without waiting for an
  // incidental session-store rerender. Cleanup only unsubscribes; React StrictMode's probe must
  // not retire a still-current screen instance.
  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setAccountRetired(true);
      }),
    [accountLease],
  );
  const accountCurrent = !accountRetired && accountLease.isCurrent();
  // Phones still on the shared password lose background notifications at the cutoff; only a paired
  // per-device credential keeps them. The password is classified here, never shown.
  const sharedPasswordSession = accountCurrent && !!password && !isScopedDeviceCredential(password);
  // Read the clock once per visit, not on every render.
  const [pushCutoffPassed] = useState(() => Date.now() >= SHARED_PASSWORD_PUSH_CUTOFF_MS);
  const pushCutoffDate = new Date(SHARED_PASSWORD_PUSH_CUTOFF_MS).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const visibleOrigin = accountCurrent ? origin : null;
  const visibleServerInfo = accountCurrent ? serverInfo : null;
  const [syncing, setSyncing] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermissionState | 'loading' | 'unavailable'
  >('loading');
  const [query, setQuery] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const permission = await getNotificationPermissionState();
        if (active && accountLease.isCurrent()) setNotificationPermission(permission);
      } catch {
        if (active && accountLease.isCurrent()) setNotificationPermission('unavailable');
      }
    };
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      mountedRef.current = false;
      active = false;
      subscription.remove();
    };
  }, [accountLease]);
  const queryWords = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  // Match every search word independently, including labels whose words are separated in the bag.
  const SECTIONS = {
    theme: 'theme appearance oled dark gator custom presets colors',
    contacts: 'contacts sync names photos address book',
    general:
      'general app lock biometric secure screen screenshot recording capture reminders backup find my location facetime link call audio video',
    messaging: 'messaging typing indicators read receipts rcs privacy',
    conversation: 'conversation message view send with return enter delivery timestamps',
    chatlist:
      'chat list conversations compact dense appearance unknown senders filter spam folders groups organize',
    notifications:
      'notifications alerts message notifications sound battery optimization background doze delivery reliable',
    downloads:
      'downloads parallel concurrent attachments images media bandwidth auto-download wifi gallery album photos save destination location',
    sync: 'sync messages per chat initial history',
    privacy:
      'privacy encryption key rotate security storage files plaintext attachments cache logs wallpaper backups app private error reports crashes diagnostics consent share download integrity',
    server:
      'server connection live updates connecting reconnecting offline retry management restart logs statistics health diagnostics retired features rcs find my keys push uptime alerts imessage account aliases',
    about:
      'about app version build server version macos disconnect forget app logs debug diagnostics privacy data storage legal license notices third-party internal testing',
  } as const;
  const match = (terms: string): boolean => queryWords.every((word) => terms.includes(word));
  const anyMatch = Object.values(SECTIONS).some(match);

  const onDisconnect = (): void => {
    if (!accountLease.isCurrent()) return;
    showDialog(
      'Disconnect',
      // This is the ONLY consent gate on the wipe (home.tsx's Disconnect is inside the __DEV__
      // bar), so it has to name the UNRECOVERABLE half explicitly. Plenty of people tap Disconnect
      // just to re-enter a changed password or a rotated tunnel URL; conversations do come back on
      // reconnect, but the messaging server itself does not hold their local choices. An exported
      // encrypted backup or Gator backup slot can retain supported settings/folders; wallpapers,
      // reminders, and unsent work remain local. `clearLocalCache` removes account A's device copy.
      'Forget this server and clear stored credentials?\n\n' +
        'Conversations, messages and downloaded attachments are deleted from this device and re-sync when you reconnect.\n\n' +
        'Pins, mutes, custom chat names, chat themes, custom folders and device-owned contact colors are removed from this device; a compatible encrypted backup made first can restore them. Wallpapers, saved reminders, scheduled messages, unsent messages and drafts are deleted permanently. Exported files and server backup slots are not deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            // The dialog is global and can outlive this route. Never let account A's retained
            // confirmation disconnect account B. `forget()` itself owns the teardown barrier, so
            // it must not be wrapped in a tracked slot (that would wait on itself forever).
            if (!accountLease.isCurrent()) return;
            void forget().catch((e: unknown) => {
              logger.warn('[settings] Disconnect cleanup remains incomplete', e);
              showDialog(
                'Disconnect incomplete',
                disconnectFailureMessage(e),
                isUnconfirmedCredentialRetirement(e)
                  ? [
                      { text: 'OK', style: 'cancel' },
                      {
                        text: 'Forget on this phone only',
                        onPress: () => {
                          void confirmForgetPreviousServer({
                            previousServerOrigin: previousUnrevokedServerOrigin,
                            forgetOnThisPhoneOnly,
                            failureMessage: disconnectFailureMessage,
                          });
                        },
                      },
                    ]
                  : undefined,
              );
            });
          },
        },
      ],
    );
  };

  const onRotateKey = (): void => {
    if (!accountLease.isCurrent()) return;
    showDialog(
      'Rotate encryption key',
      'Re-encrypt the local database with a fresh key? Your data is unchanged; this is crash-safe.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Rotate',
          onPress: () => {
            // Rotation uses the one shared SQLCipher connection. Admit it under the account
            // barrier so Disconnect either drains the rekey or blocks the transition; a retained
            // account-A confirmation is rejected before it can touch account B's database.
            void runTrackedRealtimeWork(accountLease, async (activeLease) => {
              if (!activeLease.isCurrent()) return;
              await rotateDatabaseKey();
            })
              .then((status) => {
                if (status === 'delivered' && accountLease.isCurrent()) {
                  showDialog('Encryption key', 'Database key rotated.');
                }
              })
              .catch(() => {
                if (accountLease.isCurrent()) {
                  showDialog('Encryption key', 'Couldn’t rotate the key.');
                }
              });
          },
        },
      ],
    );
  };

  // Enabling requires enrolled biometrics, else the user could lock themselves out. Disabling asks
  // the phone's owner to confirm with any screen lock: fingerprint, face or the PIN the lock screen
  // also accepts (review M241). With no screen lock at all nothing could unlock Gator again anyway,
  // so the switch then stays usable.
  const onToggleAppLock = async (next: boolean): Promise<void> => {
    if (!screenCurrent() || appLockChangePending.current) return;
    appLockChangePending.current = true;
    try {
      if (next) {
        const available = await isBiometricAvailable();
        if (!screenCurrent()) return;
        if (!available) {
          showDialog(
            'Biometrics required',
            'Set up a fingerprint, face unlock, or device PIN before enabling App Lock.',
          );
          return;
        }
      } else if (await hasDeviceCredential()) {
        if (!screenCurrent()) return;
        const confirmed = await authenticate('Turn off App Lock');
        if (!screenCurrent() || !confirmed) return;
      }
      if (!screenCurrent()) return;
      await setAppLockEnabled(next);
    } catch {
      if (screenCurrent()) {
        showDialog(
          'App Lock',
          'Couldn’t finish updating App Lock. Notification previews may remain hidden. Try again before relying on App Lock.',
        );
      }
    } finally {
      appLockChangePending.current = false;
    }
  };

  const onToggleSecureScreen = (next: boolean): void => {
    if (!screenCurrent()) return;
    try {
      setSecureScreenEnabled(next);
      setSecureScreen({ available: true, enabled: next });
    } catch {
      showDialog('Secure Screen', 'Couldn’t update Android screen-capture protection.');
    }
  };

  const onToggleAutoDownload = (next: boolean): void => {
    if (!screenCurrent()) return;
    void setAttachmentAutoDownloadEnabled(next, accountLease).catch(() => {
      if (screenCurrent()) {
        showDialog(
          'Downloads',
          'Couldn’t update auto-download. The previous setting is unchanged.',
        );
      }
    });
  };

  const onSetAutoDownloadDestination = (destination: AutoDownloadDestination): void => {
    if (!screenCurrent()) return;
    void setAttachmentAutoDownloadDestination(destination, accountLease)
      .then((result) => {
        if (result === 'denied' && screenCurrent()) {
          showDialog('Photos', 'Photos permission is required for automatic outside copies.');
        }
      })
      .catch(() => {
        if (screenCurrent()) {
          showDialog(
            'Downloads',
            'Couldn’t update the save destination. The previous setting is unchanged.',
          );
        }
      });
  };

  const runContactsSync = async (): Promise<void> => {
    if (!screenCurrent()) return;
    setSyncing(true);
    try {
      // `force` because this button exists to refresh NOW: an unforced call would join whatever
      // background run is already in flight (startSync fires one on every connect/resume) and
      // report counts from an address-book read that began before the user's edit — telling them
      // the sync succeeded while the contact they just added is still missing. A forced call still
      // SERIALIZES behind that run (two overlapping contact syncs prune each other's rows), then
      // re-reads the address book.
      const { contacts, matched } = await syncContacts({ force: true, accountLease });
      if (!screenCurrent()) return;
      showDialog('Contacts synced', `Read ${contacts} contacts, matched ${matched}.`);
    } catch (error) {
      if (isContactsAccountChangedError(error) || !screenCurrent()) return;
      if (isContactsPermissionDeniedError(error)) {
        showContactsPermissionRecovery({
          canAskAgain: error.canAskAgain,
          isCurrent: screenCurrent,
          onTryAgain: () => void runContactsSync(),
        });
      } else {
        showDialog(
          'Contacts',
          'Sync failed. You can keep using phone numbers and email addresses manually.',
        );
      }
    } finally {
      if (screenCurrent()) setSyncing(false);
    }
  };

  const onSyncContacts = async (): Promise<void> => {
    if (!screenCurrent()) return;
    try {
      const permission = await getContactsPermissionState();
      if (!screenCurrent()) return;
      if (permission.status === 'granted') {
        await runContactsSync();
        return;
      }
      if (permission.status === 'denied' && !permission.canAskAgain) {
        showContactsPermissionRecovery({
          canAskAgain: false,
          isCurrent: screenCurrent,
          onTryAgain: () => void runContactsSync(),
        });
        return;
      }
      showContactsPermissionRationale({
        purpose: 'sync',
        isCurrent: screenCurrent,
        onContinue: () => void runContactsSync(),
      });
    } catch {
      if (screenCurrent()) {
        showDialog(
          'Contacts',
          'Contacts access is unavailable. You can still type phone numbers and email addresses manually.',
        );
      }
    }
  };

  const openNotificationSettings = async (): Promise<void> => {
    if (!screenCurrent()) return;
    try {
      await openNotificationPermissionSettings();
    } catch {
      if (screenCurrent()) {
        showDialog(
          'Notifications',
          'Couldn’t open Android notification settings. Open Settings and select Gator.',
        );
      }
    }
  };

  const requestNotificationAccess = async (): Promise<void> => {
    if (!screenCurrent()) return;
    try {
      const granted = await requestNotificationPermission();
      if (!screenCurrent()) return;
      setNotificationPermission(granted ? 'granted' : 'denied');
      if (!granted) {
        showDialog(
          'Notifications are off',
          'Gator still works while open. To receive alerts in the background, enable notifications in Android settings.',
          [
            { text: 'Not Now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => void openNotificationSettings() },
          ],
        );
      }
    } catch {
      if (screenCurrent()) {
        setNotificationPermission('unavailable');
        showDialog('Notifications', 'Android notification access is unavailable. Try again later.');
      }
    }
  };

  const onManageNotificationPermission = async (): Promise<void> => {
    if (!screenCurrent()) return;
    try {
      const permission = await getNotificationPermissionState();
      if (!screenCurrent()) return;
      setNotificationPermission(permission);
      if (permission !== 'not-determined') {
        await openNotificationSettings();
        return;
      }
      showDialog(
        'Turn on notifications?',
        'Gator uses notifications for new messages, calls, reminders, and send failures while the app is not open. You can continue without them.',
        [
          { text: 'Not Now', style: 'cancel' },
          { text: 'Enable', onPress: () => void requestNotificationAccess() },
        ],
      );
    } catch {
      if (screenCurrent()) {
        setNotificationPermission('unavailable');
        showDialog('Notifications', 'Android notification access is unavailable. Try again later.');
      }
    }
  };

  const persistErrorReportingConsent = async (next: boolean): Promise<void> => {
    if (!accountLease.isCurrent()) return;
    try {
      await setErrorReportingConsent(next, accountLease);
    } catch {
      if (!accountLease.isCurrent()) return;
      showDialog(
        'Error Reports',
        'Gator could not save that privacy choice. Your previous setting is still active; try again after restarting the app.',
      );
    }
  };

  const onToggleErrorReporting = (next: boolean): void => {
    if (!accountLease.isCurrent()) return;
    if (!next) {
      void persistErrorReportingConsent(false);
      return;
    }
    showDialog(
      'Share error reports?',
      'When allowed, Gator sends a finite error code, limited technical fields such as error type or HTTP status, app and Android versions, and an opaque Gator crash-site code to your connected server when it supports uploads. Gator does not send the original error message, filename, function name, or stack trace. You can turn this off at any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Allow',
          onPress: () => {
            if (accountLease.isCurrent()) void persistErrorReportingConsent(true);
          },
        },
      ],
    );
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
              label="App Lock"
              value={appLock}
              onValueChange={(v) => void onToggleAppLock(v)}
              accessibilityLabel="Require biometric unlock to open the app"
            />
            <SwitchRow
              label="Secure Screen"
              value={secureScreen.enabled}
              onValueChange={onToggleSecureScreen}
              disabled={!secureScreen.available}
              accessibilityLabel="Block Android screenshots and screen recording"
            />
            <NoteRow text="App Lock blocks protected routes and keeps their content out of Android Recents, including during its grace period. Enabling it clears displayed notifications; new message notices stay generic while it is enabled, including after unlock. Generic scheduled reminders are preserved. Secure Screen separately blocks screenshots and screen recording. Neither setting makes the database key biometric-bound or encrypts files." />
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
            {visibleOrigin &&
            (visibleServerInfo?.supports_facetime_link_creation === true ||
              visibleServerInfo?.supports_facetime_call_start === true) ? (
              <NavRow
                label="FaceTime"
                color="label"
                chevron={false}
                onPress={() => {
                  if (accountCurrent) router.push('/facetime');
                }}
                disabled={!accountCurrent}
              />
            ) : null}
          </SettingsSection>
        )}

        {match(SECTIONS.messaging) && (
          <SettingsSection label="MESSAGING" style={styles.gap}>
            <SwitchRow
              label="Send Typing Indicators"
              value={sendTypingIndicators}
              onValueChange={(v) => savePrivacyFlag('sendTypingIndicators', v)}
              accessibilityLabel="Let others see when you are typing on supported services"
            />
            <SwitchRow
              label="Send Read Receipts"
              value={sendReadReceipts}
              onValueChange={(v) => savePrivacyFlag('sendReadReceipts', v)}
              accessibilityLabel="Let others see when you have read their messages on supported services"
            />
            <NoteRow text="These preferences apply only when the connected messaging service supports them. They do not enable retired Private API features." />
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
            <NavRow
              label="Conversation Folders…"
              onPress={() => {
                if (accountCurrent) router.push('/folders');
              }}
              disabled={!accountCurrent}
            />
          </SettingsSection>
        )}

        {match(SECTIONS.notifications) && (
          <SettingsSection label="NOTIFICATIONS" style={styles.gap}>
            <SwitchRow
              label="Message Notifications"
              value={messageNotifications}
              onValueChange={(v) => savePrivacyFlag('messageNotifications', v)}
              accessibilityLabel="Show notifications for new messages"
            />
            <NavRow
              label="Notification Access…"
              onPress={() => void onManageNotificationPermission()}
              accessibilityLabel="Manage Android notification access"
            />
            <NoteRow text={notificationPermissionLabel(notificationPermission)} />
            {/* Android reliability: open the general battery-optimization settings, where the
                user can review or change Gator's treatment. This is not a direct exemption. */}
            {Platform.OS === 'android' ? (
              <NavRow
                label="Battery Optimization Settings…"
                onPress={() => void requestDisableBatteryOptimization()}
                accessibilityLabel="Open battery optimization settings for reliable notifications"
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
                onValueChange={onToggleAutoDownload}
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
                  onPress={() => onSetAutoDownloadDestination(opt.value)}
                  disabled={!autoDownload}
                  dimmed={!autoDownload}
                />
              ))}
              <NoteRow text="Images always appear in chats. Tap Photos gallery or Gator album to grant the required Photos access; on Android 12 and earlier, tap the choice even if it is already selected. Gator remembers a queued Photos or Gator Album copy and retries it on a later eligible foreground activation. Changing this choice or turning off auto-download cancels queued copies that have not started; a copy Android is already saving may still finish." />
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
              label="Share Error Reports"
              value={errorReportingEnabled}
              onValueChange={onToggleErrorReporting}
              accessibilityLabel="Allow Gator to send redacted error reports to your connected server"
            />
            <NoteRow text="Off by default. While off, Gator does not queue or send error reports, and any queued reports are deleted. Your connected server must also support report uploads." />
            <NavRow
              label="Storage & File Privacy…"
              onPress={() => router.push('/storage-privacy')}
            />
            <NavRow
              label="Download Integrity…"
              onPress={() => router.push('/download-integrity')}
              accessibilityLabel="View download integrity"
            />
            <NavRow label="Rotate encryption key…" chevron={false} onPress={onRotateKey} />
          </SettingsSection>
        )}

        {match(SECTIONS.server) && (
          <SettingsSection label="SERVER" style={styles.gap}>
            <InfoRow
              label="Live Updates"
              value={accountCurrent ? transportHealthStatusLabel(transportStatus) : '—'}
            />
            {sharedPasswordSession ? (
              <>
                <NoteRow
                  text={
                    pushCutoffPassed
                      ? `Background notifications ended on ${pushCutoffDate} for phones that sign in with the shared password. Pair this device to turn them back on.`
                      : `This phone signs in with the shared password. Background notifications for shared-password phones end on ${pushCutoffDate}. Pair this device to keep them.`
                  }
                />
                <NavRow
                  label="Pair This Device…"
                  onPress={() => router.push('/server-management')}
                />
              </>
            ) : null}
            <NavRow label="Server Management…" onPress={() => router.push('/server-management')} />
            <NavRow
              label="Change Server Address…"
              onPress={() => router.push('/change-server-address')}
            />
            <NavRow label="Server Health…" onPress={() => router.push('/server-health')} />
            {visibleServerInfo?.supports_imessage_account_status === true && (
              <NavRow
                label="iMessage Account…"
                accessibilityLabel="View iMessage account"
                onPress={() => router.push('/account')}
              />
            )}
          </SettingsSection>
        )}

        {match(SECTIONS.about) && (
          <SettingsSection label="ABOUT" style={styles.gap}>
            <InfoRow label="App Version" value={APP_VERSION} />
            <InfoRow label="App Build" value={APP_BUILD} />
            <InfoRow label="Server" value={visibleOrigin ?? '—'} />
            <InfoRow label="Server Version" value={visibleServerInfo?.server_version ?? '—'} />
            <InfoRow label="macOS" value={visibleServerInfo?.os_version ?? '—'} />
            <InfoRow label="Private API" value="Retired in this release" />
            <NavRow
              label="Privacy & Data Use…"
              onPress={() => router.push('/storage-privacy')}
              accessibilityLabel="View privacy and data use"
            />
            <NavRow
              label="Legal & Third-Party Notices…"
              onPress={() => router.push('/legal-notices')}
              accessibilityLabel="View legal and third-party notices"
            />
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

        {queryWords.length > 0 && !anyMatch && (
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
