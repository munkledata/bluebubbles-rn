import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

export const FIND_MY_REFRESH_INTERVAL_MS = 60_000;

/**
 * Poll Find My only while its route is focused and Android considers the app active.
 *
 * The screen's initial `load()` owns the first request. Later focus/resume transitions refresh
 * immediately, then restart the one-minute interval. An already-started store refresh is allowed
 * to settle; the store coalesces overlap and session teardown disowns old-account results.
 */
export function useFindMyPolling(refresh: () => Promise<void>): void {
  const refreshRef = useRef(refresh);
  const hasFocusedOnce = useRef(false);
  refreshRef.current = refresh;

  useFocusEffect(
    useCallback(() => {
      let focused = true;
      let appState: AppStateStatus = AppState.currentState;
      let interval: ReturnType<typeof setInterval> | null = null;

      const stop = (): void => {
        if (interval == null) return;
        clearInterval(interval);
        interval = null;
      };
      const refreshNow = (): void => {
        void refreshRef.current();
      };
      const start = (immediate: boolean): void => {
        if (!focused || appState !== 'active' || interval != null) return;
        if (immediate) refreshNow();
        interval = setInterval(refreshNow, FIND_MY_REFRESH_INTERVAL_MS);
      };

      // Avoid duplicating the screen's initial load. Returning to the route should not wait up to
      // a minute to replace stale locations, so every later focus refreshes immediately.
      start(hasFocusedOnce.current);
      hasFocusedOnce.current = true;

      const subscription = AppState.addEventListener('change', (nextState) => {
        const resumed = appState !== 'active' && nextState === 'active';
        appState = nextState;
        if (nextState === 'active') start(resumed);
        else stop();
      });

      return () => {
        focused = false;
        stop();
        subscription.remove();
      };
    }, []),
  );
}
