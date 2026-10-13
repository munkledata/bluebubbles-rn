import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getContactsPermissionState,
  isContactsPermissionDeniedError,
  syncContacts,
  type ContactsPermissionState,
} from '@/services/contacts/contactsService';
import {
  getNotificationPermissionState,
  openNotificationPermissionSettings,
  requestNotificationPermission,
  type NotificationPermissionState,
} from '@/services/notifications/notifeeService';
import { finishPermissionOnboarding } from '@/services/featureSettingsCommands';
import {
  openContactsPermissionSettings,
  showContactsPermissionRecovery,
} from '@ui/permissions/contactsPermission';
import { showDialog } from '@ui/dialog/dialogStore';
import { Button, Screen, useTheme } from '@ui';
import { createI18n, type I18n } from '@utils/i18n';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';

type NotificationUiState = NotificationPermissionState | 'loading' | 'unavailable';
type ContactsUiState =
  | ContactsPermissionState
  | { readonly status: 'loading' | 'unavailable'; readonly canAskAgain: false };

const notificationLabel = (i18n: I18n, state: NotificationUiState): string => {
  if (state === 'granted') return i18n.text('permissions.status.enabled');
  if (state === 'denied') return i18n.text('permissions.status.notificationDeniedSettings');
  if (state === 'not-determined') return i18n.text('permissions.status.notificationNotEnabled');
  return i18n.text(
    state === 'loading' ? 'permissions.status.checking' : 'permissions.status.unavailable',
  );
};

const contactsLabel = (i18n: I18n, state: ContactsUiState): string => {
  if (state.status === 'granted') return i18n.text('permissions.status.allowed');
  if (state.status === 'undetermined') return i18n.text('permissions.status.contactsOptional');
  if (state.status === 'denied') {
    return i18n.text(
      state.canAskAgain
        ? 'permissions.status.contactsDeniedRetry'
        : 'permissions.status.contactsDeniedSettings',
    );
  }
  return i18n.text(
    state.status === 'loading' ? 'permissions.status.checking' : 'permissions.status.unavailable',
  );
};

/** First-connect permission choices. Native prompts only follow the matching explicit button. */
export default function PermissionsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const i18n = useMemo(() => createI18n(), []);
  const accountLease = useScreenAccountLease();
  const mountedRef = useRef(true);
  const [notification, setNotification] = useState<NotificationUiState>('loading');
  const [contacts, setContacts] = useState<ContactsUiState>({
    status: 'loading',
    canAskAgain: false,
  });
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [contactsBusy, setContactsBusy] = useState(false);
  const [continueBusy, setContinueBusy] = useState(false);
  const continueStartedRef = useRef(false);
  const isCurrent = useCallback(
    () => mountedRef.current && accountLease.isCurrent(),
    [accountLease],
  );

  useEffect(() => {
    mountedRef.current = true;
    const refresh = async (): Promise<void> => {
      const [notificationResult, contactsResult] = await Promise.allSettled([
        getNotificationPermissionState(),
        getContactsPermissionState(),
      ]);
      if (!isCurrent()) return;
      setNotification(
        notificationResult.status === 'fulfilled' ? notificationResult.value : 'unavailable',
      );
      setContacts(
        contactsResult.status === 'fulfilled'
          ? contactsResult.value
          : { status: 'unavailable', canAskAgain: false },
      );
    };
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      mountedRef.current = false;
      subscription.remove();
    };
  }, [isCurrent]);

  const openNotificationSettings = async (): Promise<void> => {
    try {
      await openNotificationPermissionSettings();
    } catch {
      if (isCurrent()) {
        showDialog(
          i18n.text('permissions.section.notifications'),
          i18n.format('permissions.dialog.notificationSettingsFailed.message', {
            appName: i18n.text('welcome.brand'),
          }),
        );
      }
    }
  };

  const onNotificationPress = async (): Promise<void> => {
    if (!isCurrent() || notificationBusy || notification === 'loading') return;
    if (notification === 'granted' || notification === 'denied') {
      await openNotificationSettings();
      return;
    }
    setNotificationBusy(true);
    try {
      if (notification === 'unavailable') {
        const permission = await getNotificationPermissionState();
        if (isCurrent()) setNotification(permission);
        return;
      }
      const granted = await requestNotificationPermission();
      if (isCurrent()) setNotification(granted ? 'granted' : 'denied');
    } catch {
      if (isCurrent()) {
        setNotification('unavailable');
        showDialog(
          i18n.text('permissions.section.notifications'),
          i18n.text('permissions.dialog.notificationsUnavailable.message'),
        );
      }
    } finally {
      if (isCurrent()) setNotificationBusy(false);
    }
  };

  async function runContactsSync(): Promise<void> {
    if (!isCurrent() || contactsBusy) return;
    setContactsBusy(true);
    try {
      const result = await syncContacts({ force: true, accountLease });
      if (!isCurrent()) return;
      setContacts({ status: 'granted', canAskAgain: true });
      showDialog(
        i18n.text('permissions.dialog.contactsSynced.title'),
        i18n.format(
          result.contacts === 1
            ? 'permissions.dialog.contactsSynced.message.one'
            : 'permissions.dialog.contactsSynced.message.other',
          {
            contacts: i18n.number(result.contacts),
            matched: i18n.number(result.matched),
          },
        ),
      );
    } catch (error) {
      if (!isCurrent()) return;
      if (isContactsPermissionDeniedError(error)) {
        setContacts({ status: 'denied', canAskAgain: error.canAskAgain });
        showContactsPermissionRecovery({
          canAskAgain: error.canAskAgain,
          isCurrent,
          onTryAgain: () => void runContactsSync(),
        });
      } else {
        setContacts({ status: 'unavailable', canAskAgain: false });
        showDialog(
          i18n.text('permissions.section.contacts'),
          i18n.text('permissions.dialog.contactsFailed.message'),
        );
      }
    } finally {
      if (isCurrent()) setContactsBusy(false);
    }
  }

  const onContactsPress = (): void => {
    if (!isCurrent() || contactsBusy || contacts.status === 'loading') return;
    if (contacts.status === 'denied' && !contacts.canAskAgain) {
      void openContactsPermissionSettings(isCurrent);
      return;
    }
    void runContactsSync();
  };

  const onContinue = async (): Promise<void> => {
    if (!isCurrent() || continueStartedRef.current) return;
    continueStartedRef.current = true;
    setContinueBusy(true);
    try {
      const completed = await finishPermissionOnboarding(accountLease, isCurrent);
      if (completed && isCurrent()) router.replace('/home');
    } catch {
      if (isCurrent()) {
        showDialog(
          i18n.text('permissions.dialog.saveFailed.title'),
          i18n.format('permissions.dialog.saveFailed.message', {
            appName: i18n.text('welcome.brand'),
          }),
        );
      }
    } finally {
      continueStartedRef.current = false;
      if (isCurrent()) setContinueBusy(false);
    }
  };

  const notificationButton =
    notification === 'granted' || notification === 'denied'
      ? i18n.text('permissions.action.openNotificationSettings')
      : notification === 'not-determined'
        ? i18n.text('permissions.action.enableNotifications')
        : i18n.text('permissions.action.checkAgain');
  const contactsButton =
    contacts.status === 'granted'
      ? i18n.text('permissions.action.syncAgain')
      : contacts.status === 'denied' && !contacts.canAskAgain
        ? i18n.text('permissions.action.openAppSettings')
        : i18n.text('permissions.action.syncContacts');

  return (
    <Screen grouped>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.container,
          { paddingTop: insets.top + 36, paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.color.label }]}>
            {i18n.format('permissions.title', { appName: i18n.text('welcome.brand') })}
          </Text>
          <Text style={[styles.intro, { color: theme.color.secondaryLabel }]}>
            {i18n.format('permissions.intro', { appName: i18n.text('welcome.brand') })}
          </Text>
        </View>

        <View style={[styles.card, { backgroundColor: theme.color.secondaryBackground }]}>
          <Text style={[styles.cardTitle, { color: theme.color.label }]}>
            {i18n.text('permissions.section.notifications')}
          </Text>
          <Text style={[styles.copy, { color: theme.color.secondaryLabel }]}>
            {i18n.format('permissions.notifications.copy', {
              appName: i18n.text('welcome.brand'),
            })}
          </Text>
          <Text
            accessibilityRole="text"
            style={[styles.status, { color: theme.color.tertiaryLabel }]}
          >
            {notificationLabel(i18n, notification)}
          </Text>
          <Button
            title={notificationButton}
            variant="tinted"
            loading={notificationBusy}
            disabled={notification === 'loading'}
            onPress={() => void onNotificationPress()}
          />
        </View>

        <View style={[styles.card, { backgroundColor: theme.color.secondaryBackground }]}>
          <Text style={[styles.cardTitle, { color: theme.color.label }]}>
            {i18n.text('permissions.section.contacts')}
          </Text>
          <Text style={[styles.copy, { color: theme.color.secondaryLabel }]}>
            {i18n.text('permissions.contacts.copy')}
          </Text>
          <Text
            accessibilityRole="text"
            style={[styles.status, { color: theme.color.tertiaryLabel }]}
          >
            {contactsLabel(i18n, contacts)}
          </Text>
          <Button
            title={contactsButton}
            variant="tinted"
            loading={contactsBusy}
            disabled={contacts.status === 'loading'}
            onPress={onContactsPress}
          />
        </View>

        <Button
          title={i18n.text('permissions.action.continue')}
          loading={continueBusy}
          onPress={() => void onContinue()}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, paddingHorizontal: 24, gap: 16 },
  header: { gap: 10, paddingBottom: 4 },
  title: { fontSize: 28, fontWeight: '700', lineHeight: 34 },
  intro: { fontSize: 16, lineHeight: 22 },
  card: { borderRadius: 14, padding: 18, gap: 12 },
  cardTitle: { fontSize: 20, fontWeight: '700' },
  copy: { fontSize: 15, lineHeight: 21 },
  status: { fontSize: 14, fontWeight: '600' },
});
