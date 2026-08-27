import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDatabase } from '@db/database';
import {
  getContactsPermissionState,
  isContactsPermissionDeniedError,
  syncContacts,
  type ContactsPermissionState,
} from '@/services/contacts/contactsService';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import {
  getNotificationPermissionState,
  openNotificationPermissionSettings,
  requestNotificationPermission,
  type NotificationPermissionState,
} from '@/services/notifications/notifeeService';
import {
  openContactsPermissionSettings,
  showContactsPermissionRecovery,
} from '@ui/permissions/contactsPermission';
import { showDialog } from '@ui/dialog/dialogStore';
import { completePermissionOnboarding } from '@state/featureSettingsStore';
import { Button, Screen, useTheme } from '@ui';

type NotificationUiState = NotificationPermissionState | 'loading' | 'unavailable';
type ContactsUiState =
  | ContactsPermissionState
  | { readonly status: 'loading' | 'unavailable'; readonly canAskAgain: false };

const notificationLabel = (state: NotificationUiState): string => {
  if (state === 'granted') return 'Enabled';
  if (state === 'denied') return 'Denied — open Android settings to enable';
  if (state === 'not-determined') return 'Not enabled yet';
  return state === 'loading' ? 'Checking…' : 'Status unavailable';
};

const contactsLabel = (state: ContactsUiState): string => {
  if (state.status === 'granted') return 'Allowed';
  if (state.status === 'undetermined') return 'Optional — not requested';
  if (state.status === 'denied') {
    return state.canAskAgain ? 'Denied — you can try again' : 'Denied — enable in Android settings';
  }
  return state.status === 'loading' ? 'Checking…' : 'Status unavailable';
};

/** First-connect permission choices. Native prompts only follow the matching explicit button. */
export default function PermissionsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [accountLease] = useState<RealtimeDeliveryLease>(() => captureRealtimeDeliveryLease());
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
          'Notifications',
          'Couldn’t open Android notification settings. Open Settings and select Gator.',
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
        showDialog('Notifications', 'Android notification access is unavailable. Try again later.');
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
        'Contacts synced',
        `Read ${result.contacts} contacts, matched ${result.matched}. You can sync again from Settings.`,
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
        showDialog('Contacts', 'Contacts could not be synced. You can try again from Settings.');
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
      const completed = await completePermissionOnboarding({
        db: getDatabase(),
        shouldCommit: isCurrent,
      });
      if (completed && isCurrent()) router.replace('/home');
    } catch {
      if (isCurrent()) {
        showDialog(
          'Couldn’t save this choice',
          'Gator kept this step open so it won’t be skipped. Try Continue again.',
        );
      }
    } finally {
      continueStartedRef.current = false;
      if (isCurrent()) setContinueBusy(false);
    }
  };

  const notificationButton =
    notification === 'granted' || notification === 'denied'
      ? 'Open Notification Settings'
      : notification === 'not-determined'
        ? 'Enable Notifications'
        : 'Check Again';
  const contactsButton =
    contacts.status === 'granted'
      ? 'Sync Again'
      : contacts.status === 'denied' && !contacts.canAskAgain
        ? 'Open App Settings'
        : 'Sync Contacts';

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
            Choose what Gator can access
          </Text>
          <Text style={[styles.intro, { color: theme.color.secondaryLabel }]}>
            Both choices are optional. Gator keeps working if you choose Not Now or deny either
            Android prompt.
          </Text>
        </View>

        <View style={[styles.card, { backgroundColor: theme.color.secondaryBackground }]}>
          <Text style={[styles.cardTitle, { color: theme.color.label }]}>Notifications</Text>
          <Text style={[styles.copy, { color: theme.color.secondaryLabel }]}>
            Allow notifications to see new messages, calls, reminders, and send failures while Gator
            is not open.
          </Text>
          <Text
            accessibilityRole="text"
            style={[styles.status, { color: theme.color.tertiaryLabel }]}
          >
            {notificationLabel(notification)}
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
          <Text style={[styles.cardTitle, { color: theme.color.label }]}>Contacts</Text>
          <Text style={[styles.copy, { color: theme.color.secondaryLabel }]}>
            Allow Contacts access to show saved names and photos. You can always start a message by
            typing a phone number or email address instead.
          </Text>
          <Text
            accessibilityRole="text"
            style={[styles.status, { color: theme.color.tertiaryLabel }]}
          >
            {contactsLabel(contacts)}
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
          title="Continue to Messages"
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
