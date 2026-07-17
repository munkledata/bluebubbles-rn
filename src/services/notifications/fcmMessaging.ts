import {
  getMessaging,
  setBackgroundMessageHandler,
  onMessage,
  onTokenRefresh,
  getToken,
} from '@react-native-firebase/messaging';
import type { RemoteMessage } from '@react-native-firebase/messaging';
import { Platform } from 'react-native';
import { fcmApi } from '@core/api';
import { logger } from '@core/secure';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { http, vault } from '../clients';
import { dispatchRealtimeEvent } from '../realtimeControl';
import { parseFcmData } from './fcmPayload';
import { decryptFcmPayload, FCM_ENCRYPTION_TYPE } from './fcmDecrypt';
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
async function deliver(msg: RemoteMessage): Promise<void> {
  const { eventName, body, encrypted, encryptionType } = parseFcmData(msg.data);
  if (encrypted) {
    // Supported scheme → decrypt the base64 body with the stored server password, then
    // dispatch as if it had arrived plaintext (coerceData re-parses the JSON string).
    if (encryptionType === FCM_ENCRYPTION_TYPE && typeof body === 'string') {
      const password = await vault.get('serverPassword');
      if (!password) {
        logger.warn(
          '[fcm] encrypted push but no stored server password — will arrive on next sync',
          {
            event: eventName,
          },
        );
        return;
      }
      try {
        const plaintext = await decryptFcmPayload(body, password);
        await dispatchRealtimeEvent(eventName, plaintext);
      } catch (e) {
        // Wrong password / corrupt frame — don't drop the message, it arrives on next sync.
        logger.warn('[fcm] failed to decrypt push — will arrive on next sync', e);
      }
      return;
    }
    // Unknown/legacy scheme this client can't decrypt; the message arrives on next sync.
    logger.warn('[fcm] encrypted push with unsupported scheme skipped — will arrive on next sync', {
      event: eventName,
      encryptionType,
    });
    return;
  }
  await dispatchRealtimeEvent(eventName, body);
}

/**
 * SECURITY: when app-lock is engaged, a push must NOT open/decrypt the encrypted DB or
 * reveal sender/content — it posts a content-less notification instead. The headless DB
 * open otherwise bypasses the lock entirely.
 */
async function deliverRespectingLock(msg: RemoteMessage): Promise<void> {
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
  setBackgroundMessageHandler(getMessaging(), deliverRespectingLock);
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
    // POST_NOTIFICATIONS is requested via requestNotificationPermission() in notifeeService.ts
    // on the boot path, so the deprecated messaging().requestPermission() is redundant here.
    const m = getMessaging();
    onMessage(m, deliverRespectingLock);
    onTokenRefresh(m, () => void registerFcmToken());
  } catch (e) {
    logger.warn('[fcm] startFcm failed — falling back to socket-only', e);
  }
}

const DEVICE_NAME = `Gator (Android ${Platform.Version})`;

/**
 * Register this device's FCM token with the connected server so it can push to us. The server
 * keys on the token (de-duping duplicate rows), so a generic device name is fine and re-registering
 * is idempotent. Called on EVERY (re)connect from `startRealtime()` — that per-connect retry is
 * what recovers a registration that failed at first boot or that targeted a previous server.
 * No-op when there's no session origin yet. Best-effort (a failure is logged, not thrown).
 */
export async function registerFcmToken(): Promise<void> {
  if (!useSessionStore.getState().origin) return;
  try {
    const token = await getToken(getMessaging());
    if (token) await fcmApi.registerDevice(http, DEVICE_NAME, token);
  } catch (e) {
    logger.warn('[fcm] device token registration failed', e);
  }
}
