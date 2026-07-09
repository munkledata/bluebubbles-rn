import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { boot, completeUnlock } from '@/services';
// Side-effect registrations that MUST run at module top level (before React mounts):
// the headless Notifee background handler, the WorkManager background-sync task, and
// the FCM background message handler (registers killed-app push delivery).
import '@/services/notifications/backgroundEvents';
import { registerBackgroundSync } from '@/services/background/backgroundSync';
import { startFcm } from '@/services/notifications/fcmMessaging';
import { FCM_ENABLED } from '@core/realtime';
import { setHideNotificationPreview } from '@/services/notifications/notifeeService';
import { LockScreen } from '@features/lock/LockScreen';
import { useLockStore } from '@state/lockStore';
import { queryClient } from '@state/queryClient';
import { useDownloadSettingsStore } from '@state/downloadSettingsStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useSyncSettingsStore } from '@state/syncSettingsStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { useSmartReplyStore } from '@state/smartReplyStore';
import { useThemeStore } from '@state/themeStore';
import { AppDialog, ErrorBoundary, ThemeProvider } from '@ui';

/**
 * Root layout: app-wide providers + the navigation stack. On mount it boots —
 * reading the app-lock setting first, then hydrating credentials (which drives the
 * initial route via index.tsx) UNLESS locked. The lock gate is an overlay here, ABOVE
 * the DB-opening boot step, so a cold launch withholds the SQLCipher key until unlock.
 */
export default function RootLayout(): React.JSX.Element {
  const locked = useLockStore((s) => s.locked);

  useEffect(() => {
    void useThemeStore.getState().hydrate();
    void useSmartReplyStore.getState().hydrate();
    void useDownloadSettingsStore.getState().hydrate();
    void useFeatureSettingsStore.getState().hydrate();
    void useSyncSettingsStore.getState().hydrate();
    void useRedactedModeStore
      .getState()
      .hydrate()
      .then(() => setHideNotificationPreview(useRedactedModeStore.getState().enabled));
    void boot();
    void registerBackgroundSync();
    // Foreground FCM (permission + onMessage); the background handler is already
    // registered by importing the fcmMessaging module above.
    if (FCM_ENABLED) void startFcm();
    // Keep the (headless-safe) notification hide-preview flag in sync with the toggle.
    return useRedactedModeStore.subscribe((s) => setHideNotificationPreview(s.enabled));
  }, []);

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <StatusBar style="auto" />
            <Stack screenOptions={{ headerShown: false }} />
            {/* App-wide themed dialog host (replaces native Alert.alert). Mounted here inside
                ThemeProvider so it's themed and covers every screen, above the nav stack. */}
            <AppDialog />
            {locked ? (
              <View style={StyleSheet.absoluteFill}>
                <LockScreen onUnlock={completeUnlock} />
              </View>
            ) : null}
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
