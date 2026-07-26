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
async function deliverRespectingLock(
  msg: RemoteMessage,
  source: 'background' | 'foreground',
): Promise<void> {
  // RECEIPT BREADCRUMB. Every push enters here — the killed-app background handler AND the
  // foreground onMessage — so this is the one place that can record "a push physically arrived".
  //
  // WHY LOGGING A SUCCESS MATTERS: until this line, only FAILURES were logged, which made a
  // dropped push and a silently-handled one indistinguishable in App Logs — both are simply
  // absent (an `updated-message` receipt posts no notification by design). So "I didn't get a
  // notification" could not be attributed to a side: server said sent, device said nothing, and
  // the missing hop was unobservable. With this, the device's own log IS the delivery record —
  // compare its timestamps against the server's sends and the failing hop is immediate.
  //
  // `source` is the axis the killed-app bug lives on (headless wake vs app-already-running), so
  // it is recorded explicitly rather than inferred. Event NAME only, NEVER the body — that
  // carries message text, and this line is written to the on-disk App Logs.
  const { eventName: receivedEvent } = parseFcmData(msg.data);
  logger.info('[fcm] push received', { event: receivedEvent, source });
  // No stored server = the user disconnected. `forget()` deletes both vault keys but CANNOT revoke
  // the push registration — the client API has no de-registration route (device removal is an
  // admin-only server command), so the old server keeps our token and keeps pushing. Without this
  // gate a `new-message` arriving minutes after Disconnect wakes us headlessly, `ensureDatabase()`
  // (which needs no credentials) re-inserts that server's handle/chat/message rows into the DB the
  // user just wiped, and we post a notification with the sender's name and body for an account
  // this device is no longer connected to. Read from the VAULT, never from `useSessionStore`: a
  // killed-app wake runs no React tree, so the store is at its module defaults and gating on it
  // would drop EVERY killed-app push. Fail OPEN on a vault error — a transient Keystore failure
  // must not cost a real delivery, and the lock gate below still withholds content.
  try {
    if (!(await vault.get('serverAddress'))) {
      logger.debug('[fcm] push for a forgotten server — dropped');
      return;
    }
  } catch (e) {
    logger.warn('[fcm] session check failed — delivering anyway', e);
  }
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
  setBackgroundMessageHandler(getMessaging(), (msg) => deliverRespectingLock(msg, 'background'));
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
    onMessage(m, (msg) => deliverRespectingLock(msg, 'foreground'));
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
