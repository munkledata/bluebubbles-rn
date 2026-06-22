import messaging from '@react-native-firebase/messaging';
import type { FirebaseMessagingTypes } from '@react-native-firebase/messaging';
import { Platform } from 'react-native';
import { fcmApi } from '@core/api';
import { logger } from '@core/secure';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { dispatchRealtimeEvent, http, vault } from '@/services';
import { parseFcmData } from './fcmPayload';
import { effectivelyLocked } from './lockGate';
import { postLockedNotification } from './notifeeService';

/**
 * FCM glue. The receive pipeline (EventRouter → DbEventSink → Notifee) already exists;
 * this connects Firebase to it. Imported for side-effect at the top of app/_layout.tsx.
 *
 * GOTCHA: `setBackgroundMessageHandler` MUST be registered at MODULE TOP LEVEL — it has
 * to run in the headless killed-app wake context (which re-evaluates the entry but has
 * NO React tree, so a registration inside a component/effect would be missed and
 * killed-app delivery would silently drop).
 *
 * The envelope parsing lives in `./fcmPayload` (firebase-free, unit-tested).
 */
function deliver(msg: FirebaseMessagingTypes.RemoteMessage): Promise<void> {
  const { eventName, body, encrypted } = parseFcmData(msg.data);
  if (encrypted) {
    // Can't decrypt the server's legacy-AES payload (RN uses libsodium); don't silently
    // drop it — log and let the next sync deliver the message.
    logger.warn('[fcm] encrypted push skipped — will arrive on next sync', { event: eventName });
    return Promise.resolve();
  }
  return Promise.resolve(dispatchRealtimeEvent(eventName, body));
}

/**
 * SECURITY: when app-lock is engaged, a push must NOT open/decrypt the encrypted DB or
 * reveal sender/content — it posts a content-less notification instead. The headless DB
 * open otherwise bypasses the lock entirely.
 */
async function deliverRespectingLock(msg: FirebaseMessagingTypes.RemoteMessage): Promise<void> {
  // Fail CLOSED: if we can't determine the lock state we assume LOCKED, so a vault failure
  // can never leak sender/content. This does NOT drop delivery — postLockedNotification()
  // still posts a content-less notice; we just withhold the body until the user unlocks.
  let locked = true;
  try {
    locked = effectivelyLocked(
      useLockStore.getState(),
      (await vault.get('appLockEnabled')) === 'true',
    );
  } catch (e) {
    logger.warn('[fcm] lock-state check failed — failing closed (content-less notice)', e);
  }
  if (locked) {
    await postLockedNotification();
    return;
  }
  return deliver(msg);
}

// Killed-app / background delivery — registered at entry eval (see gotcha above). Wrapped
// in try/catch so a misconfigured Firebase project degrades to socket-only instead of
// crashing app boot (the import + this call run on the startup path).
try {
  messaging().setBackgroundMessageHandler(deliverRespectingLock);
} catch (e) {
  logger.warn('[fcm] setBackgroundMessageHandler unavailable — push disabled', e);
}

/**
 * Foreground FCM: request notification permission and handle messages while the app
 * is open. Called once at boot when FCM is enabled (the background handler above is
 * already registered by importing this module). Also re-registers our device token
 * with the server whenever Firebase rotates it. Guarded so a Firebase failure degrades
 * to socket-only rather than throwing on the boot path.
 */
export async function startFcm(): Promise<void> {
  try {
    await messaging().requestPermission();
    messaging().onMessage(deliverRespectingLock);
    messaging().onTokenRefresh(() => void registerFcmToken());
  } catch (e) {
    logger.warn('[fcm] startFcm failed — falling back to socket-only', e);
  }
}

const DEVICE_NAME = `BlueBubbles RN (Android ${Platform.Version})`;

/**
 * Register this device's FCM token with the connected server so it can push to us. The
 * server keys on the token, so a generic device name is fine. No-op when offline — it's
 * re-run from `startRealtime()` once a server connection is established. Best-effort.
 */
export async function registerFcmToken(): Promise<void> {
  if (!useSessionStore.getState().origin) return;
  try {
    const token = await messaging().getToken();
    if (token) await fcmApi.registerDevice(http, DEVICE_NAME, token);
  } catch (e) {
    logger.warn('[fcm] device token registration failed', e);
  }
}
