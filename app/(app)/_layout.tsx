import notifee, { EventType } from '@notifee/react-native';
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { isLockExpired } from '@core/security/lockTimeout';
import { handleNotificationAction } from '@/services/notifications/actions';
import { useLockStore } from '@state/lockStore';
import { FaceTimeCallOverlay, IncomingFaceTimeOverlay } from '@ui/facetime';

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
      {/* App-wide so an incoming call rings on any screen; the in-call WebView overlay
          takes over once answered (and is also opened by outgoing calls from the chat). */}
      <IncomingFaceTimeOverlay />
      <FaceTimeCallOverlay />
    </>
  );
}
