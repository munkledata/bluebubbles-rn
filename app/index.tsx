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
  const theme = useTheme();

  if (status === 'loading') {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.background }]}>
        <ActivityIndicator color={theme.color.tint} />
      </View>
    );
  }

  return <Redirect href={status === 'connected' ? '/home' : '/welcome'} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
