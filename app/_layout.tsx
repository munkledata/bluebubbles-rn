import { QueryClientProvider } from '@tanstack/react-query';
import { Stack, ThemeProvider as NavThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { completeUnlock } from '@/services';
import {
  getForegroundBootSnapshot,
  invalidateForegroundBootRun,
  retryForegroundBoot,
  startForegroundBoot,
  unlockForegroundBoot,
} from '@/services/boot/foregroundBoot';
// Side-effect registrations that MUST run at module top level (before React mounts):
// the headless Notifee background handler, the WorkManager background-sync task, and
// the FCM background message handler (registers killed-app push delivery).
//
// NOTE: these are ALSO imported from `index.js` (the bundle entry), and THAT is the copy that
// actually matters. This file is a ROUTE module — expo-router loads it lazily at RENDER time, so
// a headless wake (FCM push / background task), which never renders, would not evaluate it and
// the handlers would go unregistered. See the comment in `index.js`. Kept here as a harmless
// no-op (module cache) so the app still works if the entry is ever changed.
import '@/services/notifications/backgroundEvents';
import { logger } from '@core/secure';
import { prepareNotificationPresentationState } from '@/services/notifications/notifeeService';
import { useForegroundBootState } from '@features/boot/useForegroundBootState';
import { ForegroundLockGate } from '@features/lock/ForegroundLockGate';
import { useLockStore } from '@state/lockStore';
import { queryClient } from '@state/queryClient';
import { AppDialog, AppToast, ErrorBoundary, ThemeProvider, useTheme } from '@ui';
import { showToast } from '@ui/toast/toastStore';
import { buildDarkNavigationTheme, DARK_STATUS_BAR_STYLE } from '@ui/theme/dark-navigation-theme';

function hasForegroundAuthority(): boolean {
  return AppState.currentState === 'active';
}

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
  const navTheme = useMemo(
    () => buildDarkNavigationTheme(theme.color.background),
    [theme.color.background],
  );
  return (
    <NavThemeProvider value={navTheme}>
      <Stack screenOptions={{ headerShown: false }} />
    </NavThemeProvider>
  );
}

/**
 * Root layout: app-wide providers + the navigation stack. On mount it starts the one foreground
 * coordinator, which reads App Lock before durable session/DB/settings activation. The lock gate
 * unmounts the protected route/dialog tree while the choice is unknown or locked, so even React
 * Native Modals (which use a separate Android window) cannot remain visible above it. A cold UI
 * launch therefore does not render stored data before unlock. This does not make the SecureStore
 * key user-auth-bound; the separate locked FCM policy also refuses to open the DB and leaves the
 * event for post-unlock sync.
 */
export default function RootLayout(): React.JSX.Element {
  const bootState = useForegroundBootState();
  const locked = useLockStore((s) => s.locked);
  const lockHydrated = useLockStore((s) => s.hydrated);
  const shownBootIssues = useRef<{ runId: number; codes: Set<string> }>({
    runId: 0,
    codes: new Set(),
  });
  const preparedNotificationRun = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const appActiveRef = useRef(hasForegroundAuthority());
  const pendingColdUnlockRunRef = useRef<number | null>(null);
  const restartBootOnActiveRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    appActiveRef.current = hasForegroundAuthority();

    const retireOwnedRun = (): boolean => {
      const pendingRunId = pendingColdUnlockRunRef.current;
      if (pendingRunId !== null) {
        pendingColdUnlockRunRef.current = null;
        const current = getForegroundBootSnapshot();
        if (current.status !== 'idle' && current.runId === pendingRunId) {
          invalidateForegroundBootRun(pendingRunId);
          return true;
        }
      }

      const current = getForegroundBootSnapshot();
      if (current.status !== 'loading') return false;
      invalidateForegroundBootRun(current.runId);
      return true;
    };

    const startOwnedRun = (): void => {
      if (!mountedRef.current || !appActiveRef.current) {
        restartBootOnActiveRef.current = true;
        return;
      }
      restartBootOnActiveRef.current = false;
      void startForegroundBoot();
    };

    const subscription = AppState.addEventListener('change', (state) => {
      appActiveRef.current = state === 'active';
      if (!appActiveRef.current) {
        if (retireOwnedRun()) restartBootOnActiveRef.current = true;
        return;
      }
      if (restartBootOnActiveRef.current) startOwnedRun();
    });

    if (appActiveRef.current) startOwnedRun();
    else restartBootOnActiveRef.current = true;

    return () => {
      mountedRef.current = false;
      appActiveRef.current = false;
      retireOwnedRun();
      restartBootOnActiveRef.current = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    // Reminder repair reads the encrypted account DB, so it belongs only to an admitted connected
    // boot run. The service captures that account before joining its serialized native queue.
    if (bootState.status !== 'ready' || bootState.mode !== 'connected') return;
    if (preparedNotificationRun.current === bootState.runId) return;
    preparedNotificationRun.current = bootState.runId;
    void prepareNotificationPresentationState().catch((error) => {
      logger.warn('[notif] notification presentation maintenance failed', error);
    });
  }, [bootState]);

  useEffect(() => {
    if (bootState.status !== 'ready') return;
    if (shownBootIssues.current.runId !== bootState.runId) {
      shownBootIssues.current = { runId: bootState.runId, codes: new Set() };
    }
    for (const issue of bootState.issues) {
      if (issue.level !== 'degraded' || !issue.userMessage) continue;
      const key = `${issue.stage}:${issue.code}`;
      if (shownBootIssues.current.codes.has(key)) continue;
      shownBootIssues.current.codes.add(key);
      showToast(issue.userMessage, { durationMs: 6_000 });
    }
  }, [bootState]);

  const completeColdUnlock = async (runId: number): Promise<void> => {
    if (!mountedRef.current || !appActiveRef.current || pendingColdUnlockRunRef.current !== null) {
      return;
    }
    pendingColdUnlockRunRef.current = runId;
    try {
      const result = await unlockForegroundBoot(runId);
      if (
        mountedRef.current &&
        appActiveRef.current &&
        pendingColdUnlockRunRef.current === runId &&
        result.status === 'ready' &&
        result.runId === runId
      ) {
        useLockStore.getState().unlock();
      }
    } finally {
      if (pendingColdUnlockRunRef.current === runId) {
        pendingColdUnlockRunRef.current = null;
      }
    }
  };

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider renderWithFallbackTheme>
            <StatusBar style={DARK_STATUS_BAR_STYLE} />
            <ForegroundLockGate
              bootState={bootState}
              lockHydrated={lockHydrated}
              locked={locked}
              onColdUnlock={completeColdUnlock}
              onWarmUnlock={completeUnlock}
              onRetry={(runId) => {
                void retryForegroundBoot(runId);
              }}
            >
              <ThemedStack />
              {/* App-wide themed dialog host (replaces native Alert.alert). Mounted here inside
                  ThemeProvider so it's themed and covers every screen, above the nav stack. */}
              <AppDialog />
              {/* Ephemeral, non-blocking status pill (e.g. auto-download confirmations). After
                  the dialog so it paints above it if both are up. */}
              <AppToast />
            </ForegroundLockGate>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
