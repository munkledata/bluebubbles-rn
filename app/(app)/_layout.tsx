import notifee, { EventType } from 'react-native-notify-kit';
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { isLockExpired } from '@core/security/lockTimeout';
import { handleNotificationAction } from '@/services/notifications/actions';
import { pauseRealtime, resumeRealtime } from '@/services';
import { useLockStore } from '@state/lockStore';
import { FaceTimeCallOverlay, IncomingFaceTimeOverlay } from '@ui/facetime';
import { ShareIntentHandler } from '@ui/ShareIntentHandler';

/**
 * Layout for the connected app. Drives the resume re-lock (the gate itself is
 * rendered as an overlay in the root layout) and handles foreground notification
 * actions (reply / mark-read).
 */
export default function AppLayout(): React.JSX.Element {
  // App-lock: record background time; lock on foreground once the timeout passes.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      const s = useLockStore.getState();
      if (!s.enabled) return;
      if (state === 'background' || state === 'inactive') {
        s.noteBackgrounded(Date.now());
      } else if (state === 'active' && isLockExpired(s.lastBackgrounded, Date.now(), s.timeoutMs)) {
        s.lock();
      }
    });
    return () => sub.remove();
  }, []);

  // Keep realtime warm across the app/background boundary. Android freezes the socket in the
  // background, so on resume we reconnect it and pull anything missed over HTTP — otherwise
  // Delivered/new-message updates arrive only via slow FCM. Kept SEPARATE from the app-lock
  // effect above (which early-returns when lock is disabled, the default).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        void resumeRealtime();
      } else if (state === 'background') {
        pauseRealtime();
      }
    });
    return () => sub.remove();
  }, []);

  // Foreground notification actions (reply / mark-read from the tray while open).
  useEffect(
    () =>
      notifee.onForegroundEvent(({ type, detail }) => {
        if (type === EventType.ACTION_PRESS) void handleNotificationAction(detail);
      }),
    [],
  );

  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      {/* Captures content shared INTO Gator from the Android share sheet → new-chat creator. */}
      <ShareIntentHandler />
      {/* App-wide so an incoming call rings on any screen; the in-call WebView overlay
          takes over once answered (and is also opened by outgoing calls from the chat). */}
      <IncomingFaceTimeOverlay />
      <FaceTimeCallOverlay />
    </>
  );
}
