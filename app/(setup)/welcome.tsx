import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { startDevFixtureSession } from '@features/conversations/devFixtureSession';
import { showDialog } from '@ui/dialog/dialogStore';
import { Button, Screen, useTheme } from '@ui';

export default function Welcome(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const mountedRef = useRef(true);
  const devStartedRef = useRef(false);
  const [devBusy, setDevBusy] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // DEV: seed fixtures and jump straight to the inbox without a live server.
  const devSeedAndOpen = async (): Promise<void> => {
    if (devStartedRef.current) return;
    devStartedRef.current = true;
    setDevBusy(true);
    try {
      await startDevFixtureSession();
      if (mountedRef.current) router.replace('/home');
    } catch {
      if (mountedRef.current) {
        showDialog('Developer fixtures', 'Gator could not prepare the local fixture session.');
      }
    } finally {
      devStartedRef.current = false;
      if (mountedRef.current) setDevBusy(false);
    }
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
        <Button title="Get Started" disabled={devBusy} onPress={() => router.push('/connect')} />
        {__DEV__ ? (
          <Button
            title="Dev: seed & open inbox"
            variant="tinted"
            loading={devBusy}
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
