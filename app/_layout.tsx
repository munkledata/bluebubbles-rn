import { QueryClientProvider } from '@tanstack/react-query';
import {
  Stack,
  ThemeProvider as NavThemeProvider,
  DarkTheme as NavDarkTheme,
  DefaultTheme as NavDefaultTheme,
} from 'expo-router';
import { ShareIntentProvider } from 'expo-share-intent';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
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
import { hydrateAllStores } from '@state/hydrateStores';
import { useLockStore } from '@state/lockStore';
import { queryClient } from '@state/queryClient';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { AppDialog, AppToast, ErrorBoundary, ThemeProvider, useTheme } from '@ui';
import { ShareIntentCapture } from '@ui/ShareIntentHandler';

// Verbose expo-share-intent logs in dev only (visible in `adb logcat`). `__DEV__` is a RN runtime
// global that is UNDEFINED under Jest — guard it so this module never throws when imported in tests.
const SHARE_DEBUG = typeof __DEV__ !== 'undefined' && __DEV__;

/**
 * The navigation stack, themed. Expo Router (React Navigation) paints each screen's
 * scene container — and the native container behind the stack — with the navigation
 * theme's `background`/`card` colors. Without this it defaults to a near-white light
 * theme, so every push/pop briefly flashes light-gray before the screen's own view
 * paints (jarring on the app's dark presets). Feeding the app theme's background in
 * makes the transition background match the screens. Rendered under `<ThemeProvider>`
 * so `useTheme()` resolves; the nested (app) stack inherits this via context.
 */
function ThemedStack(): React.JSX.Element {
  const theme = useTheme();
  const navTheme = useMemo(() => {
    const base = theme.mode === 'dark' ? NavDarkTheme : NavDefaultTheme;
    return {
      ...base,
      colors: { ...base.colors, background: theme.color.background, card: theme.color.background },
    };
  }, [theme.mode, theme.color.background]);
  return (
    <NavThemeProvider value={navTheme}>
      <Stack screenOptions={{ headerShown: false }} />
    </NavThemeProvider>
  );
}

/**
 * Root layout: app-wide providers + the navigation stack. On mount it boots —
 * reading the app-lock setting first, then hydrating credentials (which drives the
 * initial route via index.tsx) UNLESS locked. The lock gate is an overlay here, ABOVE
 * the DB-opening boot step, so a cold launch withholds the SQLCipher key until unlock.
 */
export default function RootLayout(): React.JSX.Element {
  const locked = useLockStore((s) => s.locked);

  useEffect(() => {
    void hydrateAllStores().then(() =>
      setHideNotificationPreview(useRedactedModeStore.getState().enabled),
    );
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
      {/* Share-target capture lives at the ROOT — above the lock/auth gate — so a picture shared
          into Gator while the app was killed or locked is stashed the instant it arrives, not lost
          because the connected-app layout hadn't mounted yet. resetOnBackground:false stops the
          library from clearing the pending share during the app-switch flicker before we consume
          it (we clear the native intent ourselves right after capturing). */}
      <ShareIntentProvider options={{ resetOnBackground: false, debug: SHARE_DEBUG }}>
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <StatusBar style="auto" />
              <ThemedStack />
              {/* App-wide themed dialog host (replaces native Alert.alert). Mounted here inside
                  ThemeProvider so it's themed and covers every screen, above the nav stack. */}
              <AppDialog />
              {/* Ephemeral, non-blocking status pill (e.g. auto-download confirmations). After the
                  dialog so it paints above it if both are up. */}
              <AppToast />
              {/* Stashes an incoming share into the store; ShareIntentNavigator (in the (app)
                  layout) opens new-chat once the connected app is mounted. Renders nothing. */}
              <ShareIntentCapture />
              {locked ? (
                <View style={StyleSheet.absoluteFill}>
                  <LockScreen onUnlock={completeUnlock} />
                </View>
              ) : null}
            </ThemeProvider>
          </QueryClientProvider>
        </SafeAreaProvider>
      </ShareIntentProvider>
    </ErrorBoundary>
  );
}
