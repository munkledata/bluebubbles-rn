import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  disconnectFailureMessage,
  forgetOnThisPhoneOnly,
  PREVIOUS_CREDENTIAL_UNREVOKED_MESSAGE,
  previousServerRevocationPending,
  previousUnrevokedServerOrigin,
} from '@/services';
import { startDevFixtureSession } from '@features/conversations/devFixtureSession';
import { showDialog } from '@ui/dialog/dialogStore';
import { Button, Screen, useTheme } from '@ui';
import { ForgetPreviousServerAction } from '@ui/connection';
import { createI18n } from '@utils/i18n';

export default function Welcome(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const i18n = useMemo(() => createI18n(), []);
  const mountedRef = useRef(true);
  const devStartedRef = useRef(false);
  const [devBusy, setDevBusy] = useState(false);
  const [revocationPending, setRevocationPending] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A previous server that never confirmed removing this phone keeps new connections blocked. Say
  // so here, with the way out, instead of only after the user scans a new code.
  useEffect(() => {
    void previousServerRevocationPending().then((pending) => {
      if (mountedRef.current) setRevocationPending(pending);
    });
  }, []);

  const forgetPreviousServer = async (): Promise<void> => {
    await forgetOnThisPhoneOnly();
    if (mountedRef.current) setRevocationPending(false);
  };

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
        showDialog(
          i18n.text('welcome.dev.dialog.title'),
          `${i18n.text('welcome.brand')}${i18n.text('welcome.dev.dialog.messageSuffix')}`,
        );
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
          <Text style={[styles.title, { color: theme.color.label }]}>
            {i18n.text('welcome.brand')}
          </Text>
          <Text style={[styles.subtitle, { color: theme.color.secondaryLabel }]}>
            {i18n.text('welcome.subtitle')}
          </Text>
        </View>
        {revocationPending ? (
          <View style={styles.notice}>
            <Text style={[styles.noticeText, { color: theme.color.secondaryLabel }]}>
              {PREVIOUS_CREDENTIAL_UNREVOKED_MESSAGE}
            </Text>
            <ForgetPreviousServerAction
              previousServerOrigin={previousUnrevokedServerOrigin}
              forgetOnThisPhoneOnly={forgetPreviousServer}
              failureMessage={disconnectFailureMessage}
            />
          </View>
        ) : null}
        <Button
          title={i18n.text('welcome.action.start')}
          disabled={devBusy}
          onPress={() => router.push('/connect')}
        />
        {__DEV__ ? (
          <Button
            title={i18n.text('welcome.dev.action')}
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
  notice: { marginBottom: 16 },
  noticeText: { fontSize: 15, textAlign: 'center' },
});
