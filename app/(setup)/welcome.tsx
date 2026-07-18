import { useRouter } from 'expo-router';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ensureDatabase } from '@/services';
import { seedFixtures } from '@features/conversations/devSeed';
import { useSessionStore } from '@state/sessionStore';
import { Button, Screen, useTheme } from '@ui';

export default function Welcome(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // DEV: seed fixtures and jump straight to the inbox without a live server.
  const devSeedAndOpen = async (): Promise<void> => {
    await ensureDatabase();
    await seedFixtures();
    useSessionStore.getState().connected('https://dev.local', 'dev', { server_version: '1.9.0' });
    router.replace('/home');
  };

  return (
    <Screen>
      <View
        style={[
          styles.container,
          { paddingTop: insets.top + 72, paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={styles.hero}>
          <Image source={require('../../assets/icon.png')} style={styles.logo} />
          <Text style={[styles.title, { color: theme.color.label }]}>Gator</Text>
          <Text style={[styles.subtitle, { color: theme.color.secondaryLabel }]}>
            Your Mac’s messages, on Android.
          </Text>
        </View>
        <Button title="Get Started" onPress={() => router.push('/connect')} />
        {__DEV__ ? (
          <Button
            title="Dev: seed & open inbox"
            variant="tinted"
            onPress={() => void devSeedAndOpen()}
            style={styles.devBtn}
          />
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'space-between', paddingHorizontal: 24 },
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 128, height: 128, borderRadius: 28, marginBottom: 20 },
  title: { fontSize: 36, fontWeight: '700' },
  subtitle: { fontSize: 17, marginTop: 8, textAlign: 'center' },
  devBtn: { marginTop: 8 },
});
