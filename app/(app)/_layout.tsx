import notifee, { EventType } from 'react-native-notify-kit';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { isLockExpired } from '@core/security/lockTimeout';
import { handleNotificationAction, handleNotificationPress } from '@/services/notifications/actions';
import {
  drainNotificationTap,
  openFromNotification,
} from '@/services/notifications/notificationOpen';
import { takePendingNotification } from '@/services/notifications/pendingNav';
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
  const router = useRouter();

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

  // Drain a pending notification tap and open its chat. Reads BOTH the notify-kit launch event
  // (getInitialNotification) and the pendingNav stash a background-alive tap leaves behind, once.
  const consumeNotificationTap = useCallback(() => {
    void drainNotificationTap(
      () => notifee.getInitialNotification(),
      takePendingNotification,
      handleNotificationPress,
      (path) => router.push(path),
    );
  }, [router]);

  // Foreground notification handling. Action buttons (reply / mark-read / love) run their
  // side-effects; a body tap (PRESS) while the app is VISIBLE runs its side-effects AND deep-links
  // to the chat, scrolling to the message. On Android `launchActivity: 'default'` only foregrounds
  // the app — it does NOT navigate — so we route the tap here.
  useEffect(
    () =>
      notifee.onForegroundEvent(({ type, detail }) => {
        if (type === EventType.ACTION_PRESS) {
          void handleNotificationAction(detail);
        } else if (type === EventType.PRESS) {
          void handleNotificationPress(detail);
          openFromNotification(detail.notification?.data, (path) => router.push(path));
        }
      }),
    [router],
  );

  // Cold start: a tap that LAUNCHED the app from killed isn't replayed as a foreground event —
  // getInitialNotification() reports it once, drained here on mount.
  useEffect(() => {
    consumeNotificationTap();
  }, [consumeNotificationTap]);

  // Resume: a tap while the app was ALIVE-BUT-BACKGROUNDED is delivered to the headless
  // onBackgroundEvent (which can't navigate), NOT to onForegroundEvent above — this is the common
  // case and the reason taps used to just foreground the app on its last screen. Drain the pending
  // tap when we come active so the chat actually opens. (Kept separate from the app-lock / realtime
  // AppState listeners; drainNotificationTap is a no-op when there's nothing pending.)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') consumeNotificationTap();
    });
    return () => sub.remove();
  }, [consumeNotificationTap]);

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
