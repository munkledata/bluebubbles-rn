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
import type { EventOccurrenceMetadata } from '@core/realtime';
import { logger } from '@core/secure';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { accountRevocationMarker, http, vault } from '../clients';
import { flushPersistentLogsForHeadlessCompletion } from '../logging/fileLogSink';
import { dispatchRealtimeEvent } from '../realtimeControl';
import { parseFcmData, rehydrateFcmEnvelopeChatGuid, type ParsedFcm } from './fcmPayload';
import { decryptFcmPayload, FCM_ENCRYPTION_TYPE } from './fcmDecrypt';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeDelivery,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { readFcmSessionState } from './fcmSessionGate';
import { effectivelyLocked } from './lockGate';
import { postLockedNotification } from './notifeeService';

/**
 * FCM glue. The receive pipeline (durable intake → EventRouter → DbEventSink → Notifee) already
 * exists; this connects Firebase to it. Imported for side-effect from the bundle entry.
 *
 * GOTCHA: `setBackgroundMessageHandler` MUST be registered at MODULE TOP LEVEL — it has
 * to run in the headless killed-app wake context (which re-evaluates the entry but has
 * NO React tree, so a registration inside a component/effect would be missed and
 * killed-app delivery would silently drop).
 *
 * The envelope parsing lives in `./fcmPayload` (firebase-free, unit-tested).
 */
const fcmProcessOccurrenceNonce = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 14)}`;
let fcmLocalOccurrenceSequence = 0;
let fcmAdmissionTail: Promise<void> = Promise.resolve();

interface CapturedFcmDelivery {
  readonly parsed: ParsedFcm;
  readonly occurrence: EventOccurrenceMetadata;
}

/** Treat only the two disabled representations as off; corrupt/unknown values fail closed. */
function storedAppLockRequiresProtection(value: string | null): boolean {
  return value !== null && value !== 'false';
}

/**
 * Snapshot native callback data before the first await. RNFB's provider message id is stable across
 * redelivery and therefore gives durable intake a stable duplicate key. The bounded local fallback
 * is unique within this process and carries a per-process nonce to avoid colliding after restart;
 * it is occurrence metadata only, never a credential or security token.
 */
function captureFcmDelivery(msg: RemoteMessage): CapturedFcmDelivery {
  const providerMessageId =
    typeof msg.messageId === 'string' && msg.messageId.length > 0 ? msg.messageId : null;
  let transportOccurrenceId = providerMessageId;
  if (!transportOccurrenceId) {
    fcmLocalOccurrenceSequence += 1;
    transportOccurrenceId = `fcm-local:${fcmProcessOccurrenceNonce}:${fcmLocalOccurrenceSequence}`;
  }
  // RemoteMessage.data values are strings, so a shallow copy snapshots the complete envelope.
  const data = msg.data ? { ...msg.data } : undefined;
  const receivedAt = Date.now();
  return {
    parsed: parseFcmData(data),
    occurrence: { transportOccurrenceId, receivedAt },
  };
}

async function deliver(delivery: CapturedFcmDelivery, lease: RealtimeDeliveryLease): Promise<void> {
  const { eventName, body, envelopeChatGuid, encrypted, encryptionType } = delivery.parsed;
  if (encrypted) {
    // Supported scheme → decrypt the base64 body with the stored server password, then
    // dispatch as if it had arrived plaintext (the realtime normalizer re-parses JSON strings).
    if (encryptionType === FCM_ENCRYPTION_TYPE && typeof body === 'string') {
      const password = await vault.get('serverPassword');
      if (!lease.isCurrent()) return;
      if (!password) {
        logger.warn(
          '[fcm] encrypted push but no stored server password — will arrive on next sync',
          {
            event: eventName,
          },
        );
        return;
      }
      let plaintext: string;
      try {
        plaintext = await decryptFcmPayload(body, password);
      } catch (e) {
        // This catch deliberately covers DECRYPTION ONLY. A later durable enqueue/dispatch error
        // must propagate to the native-callback owner instead of being mislabeled and swallowed.
        logger.warn('[fcm] failed to decrypt push — will arrive on next sync', e);
        return;
      }
      if (!lease.isCurrent()) return;
      const hydratedBody = rehydrateFcmEnvelopeChatGuid(plaintext, envelopeChatGuid);
      await dispatchRealtimeEvent(eventName, hydratedBody, 'fcm', lease, delivery.occurrence);
      return;
    }
    // Unknown/legacy scheme this client can't decrypt; the message arrives on next sync.
    logger.warn('[fcm] encrypted push with unsupported scheme skipped — will arrive on next sync', {
      event: eventName,
      encryptionType,
    });
    return;
  }
  await dispatchRealtimeEvent(eventName, body, 'fcm', lease, delivery.occurrence);
}

/**
 * SECURITY: when app-lock is engaged, a push must NOT open/decrypt the encrypted DB or
 * reveal sender/content — it posts a content-less notification instead. The headless DB
 * open otherwise bypasses the lock entirely.
 */
async function deliverRespectingLock(
  delivery: CapturedFcmDelivery,
  source: 'background' | 'foreground',
  lease: RealtimeDeliveryLease,
): Promise<void> {
  // FINITE RECEIPT BREADCRUMB. Every push enters here — the killed-app background handler AND the
  // foreground onMessage — so this is the one place App Logs records that a push physically
  // arrived. The strict event projector retains only the finite event name and delivery source.
  //
  // WHY LOGGING A SUCCESS MATTERS: until this line, only FAILURES were logged, which made a
  // dropped push and a silently-handled one indistinguishable in development App Logs — both are
  // simply absent (an `updated-message` receipt posts no notification by design). During device
  // investigation, compare this local breadcrumb with server sends.
  //
  // `source` is the axis the killed-app bug lives on (headless wake vs app-already-running), so
  // it is recorded explicitly rather than inferred. Event NAME only, NEVER the body — that
  // carries message text. Even in development, never attach the body to this local line.
  const { eventName: receivedEvent } = delivery.parsed;
  logger.event('fcm.push_received', { eventName: receivedEvent, source });
  // No complete stored session = the user disconnected. `forget()` deletes both vault keys and
  // retires the Firebase installation token, but this gate is still required while that cleanup is
  // running, when native token retirement fails, and for a push already in flight. Without it
  // gate a `new-message` arriving minutes after Disconnect wakes us headlessly, `ensureDatabase()`
  // (which needs no credentials) re-inserts that server's handle/chat/message rows into the DB the
  // user just wiped, and we post a notification with the sender's name and body for an account
  // this device is no longer connected to. Read from the VAULT, never from `useSessionStore`: a
  // killed-app wake runs no React tree, so the store is at its module defaults and gating on it
  // would drop EVERY killed-app push. The correlated session marker must be `active` (or absent for
  // a pre-protocol legacy install) AND both address/password must exist: a partial connect or failed
  // double-delete must not let an old server repopulate the newly cleared database. SecureStore
  // failures fail closed too; foreground/socket sync can recover a legitimate event later.
  const sessionState = await readFcmSessionState(vault, accountRevocationMarker);
  if (!lease.isCurrent()) return;
  if (sessionState !== 'active') {
    if (sessionState === 'unavailable') {
      logger.warn('[fcm] session check unavailable — push dropped; sync will recover');
    } else {
      logger.debug('[fcm] push for a forgotten server — dropped');
    }
    return;
  }
  // Fail CLOSED: if we can't determine the lock state we assume LOCKED, so a vault failure
  // can never leak sender/content. This does NOT drop delivery — postLockedNotification()
  // still posts a content-less notice; we just withhold the body until the user unlocks.
  let locked = true;
  try {
    const storedAppLock = await vault.get('appLockEnabled');
    locked = effectivelyLocked(
      useLockStore.getState(),
      storedAppLockRequiresProtection(storedAppLock),
    );
  } catch (e) {
    logger.warn('[fcm] lock-state check failed — failing closed (content-less notice)', e);
  }
  if (!lease.isCurrent()) return;
  if (locked) {
    await postLockedNotification(lease);
    return;
  }
  return deliver(delivery, lease);
}

/**
 * Own one native callback through its whole database/presentation lifetime.
 *
 * The coordinator lets Disconnect close admission synchronously and drain work that already
 * passed the vault check before it wipes. Errors are contained here because RNFB's foreground
 * EventEmitter does not await listener promises; returning a naked promise creates an unhandled
 * rejection rather than a useful delivery failure record.
 */
async function handleIncomingFcm(
  msg: RemoteMessage,
  source: 'background' | 'foreground',
): Promise<void> {
  try {
    // Capture provider identity + envelope synchronously, before the session/lock/decrypt awaits.
    const delivery = captureFcmDelivery(msg);
    // Reserve FIFO position synchronously, while also registering this callback with teardown
    // before it waits for an earlier FCM delivery. Otherwise a faster later callback can persist
    // and drain before an earlier callback has cleared its session/lock/decrypt gates.
    const previous = fcmAdmissionTail;
    const tracked = runTrackedRealtimeDelivery(async (lease) => {
      await previous;
      if (!lease.isCurrent()) return;
      await deliverRespectingLock(delivery, source, lease);
    });
    fcmAdmissionTail = tracked.then(
      () => undefined,
      () => undefined,
    );
    const result = await tracked;
    if (result === 'paused') {
      logger.debug('[fcm] delivery paused during account transition', { source });
    }
  } catch (error) {
    logger.warn('[fcm] push delivery failed; sync will recover', {
      source,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

async function handleBackgroundFcm(msg: RemoteMessage): Promise<void> {
  try {
    await handleIncomingFcm(msg, 'background');
  } finally {
    // Android may tear down this headless runtime as soon as the native callback settles.
    await flushPersistentLogsForHeadlessCompletion();
  }
}

// Killed-app / background delivery — registered at entry eval (see gotcha above). Wrapped
// in try/catch so a misconfigured Firebase project degrades to socket-only instead of
// crashing app boot (the import + this call run on the startup path).
try {
  setBackgroundMessageHandler(getMessaging(), handleBackgroundFcm);
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
export async function startFcm(): Promise<'ready' | 'failed'> {
  try {
    // POST_NOTIFICATIONS is requested only after an explicit setup/Settings action; the deprecated
    // Firebase request would be both redundant and an unacceptable surprise prompt on this path.
    const m = getMessaging();
    onMessage(m, (msg) => {
      void handleIncomingFcm(msg, 'foreground');
    });
    onTokenRefresh(m, () => void registerFcmToken());
    return 'ready';
  } catch (e) {
    logger.warn('[fcm] startFcm failed — falling back to socket-only', e);
    return 'failed';
  }
}

const DEVICE_NAME = `Gator (Android ${Platform.Version})`;

interface FcmRegistrationSession {
  readonly epoch: number;
  readonly origin: string;
  readonly password: string;
}

function registrationSessionIsCurrent(
  session: FcmRegistrationSession,
  lease: RealtimeDeliveryLease,
): boolean {
  const current = useSessionStore.getState();
  return (
    lease.isCurrent() &&
    current.status === 'connected' &&
    current.epoch === session.epoch &&
    current.origin === session.origin &&
    current.password === session.password
  );
}

/**
 * Register this device's FCM token with the connected server so it can push to us. The server
 * keys on the token (de-duping duplicate rows), so a generic device name is fine and re-registering
 * is idempotent. Called on EVERY (re)connect from `startRealtime()` — that per-connect retry is
 * what recovers a registration that failed at first boot or that targeted a previous server.
 * No-op unless there is one complete, current connected session. Best-effort (a current-session
 * failure is logged, while an expected account-transition cancellation stays quiet).
 */
export async function registerFcmToken(): Promise<'registered' | 'skipped' | 'failed'> {
  // Capture ownership before `getToken()` (the first await). Firebase token lookup may suspend
  // while Disconnect wipes account A and connects account B. Without this lease, the eventual
  // POST would take its origin/password from the shared HttpClient at that later moment and could
  // register A's callback using B's credentials.
  const accountLease = captureRealtimeDeliveryLease();
  const state = useSessionStore.getState();
  if (
    !accountLease.isCurrent() ||
    state.status !== 'connected' ||
    !state.origin ||
    !state.password
  ) {
    return 'skipped';
  }
  const session: FcmRegistrationSession = {
    epoch: state.epoch,
    origin: state.origin,
    password: state.password,
  };

  try {
    let registered = false;
    const result = await runTrackedRealtimeWork(accountLease, async () => {
      if (!registrationSessionIsCurrent(session, accountLease)) return;

      // Deliberately re-read the current installation token instead of trusting the value supplied
      // to RNFB's long-lived onTokenRefresh callback. A native callback queued across reconnect has
      // no account identity of its own; a fresh lookup inside this account lease is unambiguous.
      const token = await getToken(getMessaging());
      if (!token || !registrationSessionIsCurrent(session, accountLease)) return;

      await fcmApi.registerDevice(http, DEVICE_NAME, token);
      registered = true;
    });
    return result === 'delivered' && registered ? 'registered' : 'skipped';
  } catch (e) {
    // Disconnect intentionally revokes in-flight registration. Logging that expected cancellation
    // as a network failure is noisy and can attach stale account context to the next session's log.
    if (registrationSessionIsCurrent(session, accountLease)) {
      logger.warn('[fcm] device token registration failed', e);
      return 'failed';
    }
    return 'skipped';
  }
}
