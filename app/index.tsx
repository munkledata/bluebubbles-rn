import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useSessionStore } from '@state/sessionStore';
import { useTheme } from '@ui';

/**
 * Route guard. While credentials hydrate we show a spinner, then redirect to the
 * connected home or the setup flow based on session status.
 */
export default function Index(): React.JSX.Element {
  const status = useSessionStore((s) => s.status);
  // A saved session = a server URL + password persisted to the vault (hydrated at boot).
  const hasSession = useSessionStore((s) => !!(s.origin && s.password));
  const settingsHydrated = useFeatureSettingsStore((s) => s.hydrated);
  const permissionOnboardingCompleted = useFeatureSettingsStore(
    (s) => s.permissionOnboardingCompleted,
  );
  const theme = useTheme();

  if (status === 'loading' || (hasSession && !settingsHydrated)) {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.background }]}>
        <ActivityIndicator color={theme.color.tint} />
      </View>
    );
  }

  // A completed permission step is account-local and persisted in the encrypted DB. If Android
  // kills the process after credentials commit but before that write, boot returns to the choices
  // instead of silently skipping them. A transient connection error still keeps the saved session.
  if (!hasSession) return <Redirect href="/welcome" />;
  return <Redirect href={permissionOnboardingCompleted ? '/home' : '/permissions'} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
