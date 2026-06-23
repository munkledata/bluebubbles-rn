import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
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
  const theme = useTheme();

  if (status === 'loading') {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.background }]}>
        <ActivityIndicator color={theme.color.tint} />
      </View>
    );
  }

  // Skip the connect screen whenever credentials are saved — go straight to home and let the
  // connection/sync resume in the background. Even a transient connection error keeps the saved
  // session, so the user is never bounced back to setup. Only a truly unauthenticated state
  // (no saved server URL/password) shows the welcome/connect flow.
  return <Redirect href={hasSession ? '/home' : '/welcome'} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
