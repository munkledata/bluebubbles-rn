import {
  getMessaging,
  onMessage,
  onTokenRefresh,
  getToken,
} from '@react-native-firebase/messaging';
import type { RemoteMessage } from '@react-native-firebase/messaging';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { fcmApi, serverApi } from '@core/api';
import {
  activeFcmPushKeyState,
  activeFcmDeviceEncryptionV3State,
  activeFcmDeviceEncryptionState,
  encodeFcmDeviceEncryptionKey,
  FCM_DEVICE_ENCRYPTION_KEY_BYTES,
  FCM_DEVICE_ENCRYPTION_TYPE,
  FCM_PUSH_KEY_ROTATION_INTERVAL_MS,
  FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS,
  FCM_PUSH_ENCRYPTION_TYPE_V3,
  fcmPushDecryptionKeyCandidates,
  fcmPushKeyRotationDue,
  pendingFcmPushKeyState,
  pendingFcmDeviceEncryptionV3State,
  pendingFcmDeviceEncryptionState,
  rotatingFcmPushKeyState,
  snapshotIncomingEvent,
  type ActiveFcmPushKeyState,
  type ActiveFcmDeviceEncryptionV3State,
  type EventOccurrenceMetadata,
  type FcmPushUsableKeyState,
  type FcmPushEnvelopeIdentityV3,
  type NormalizedEvent,
  type PendingFcmPushKeyState,
  type RotatingFcmPushKeyState,
} from '@core/realtime';
import { inspectCredentialUpgradeJournal, isScopedDeviceCredential, logger } from '@core/secure';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { accountRevocationMarker, http, vault } from '../clients';
import {
  beginRealtimeHeadlessEffectCollection,
  REALTIME_HEADLESS_EFFECT_WINDOW_MS,
  type RealtimeHeadlessEffectCollection,
  type RealtimeHeadlessEffectOutcome,
} from '../background/realtimeHeadlessEffects';
import { flushPersistentLogsForHeadlessCompletion } from '../logging/fileLogSink';
import { dispatchRealtimeEvent, persistAuthenticatedLockedFcmV3Event } from '../realtimeControl';
import { parseFcmData, type ParsedFcm } from './fcmPayload';
import {
  decryptFcmV2Payload,
  decryptFcmV3Payload,
  FCM_V2_ENCRYPTION_TYPE,
  FCM_V3_ENCRYPTION_TYPE,
} from './fcmDecrypt';
import { readFcmDeviceEncryptionState, writeFcmDeviceEncryptionState } from './fcmEncryptionState';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeDelivery,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { readFcmSessionState } from './fcmSessionGate';
import { runSerializedFcmRegistration } from './fcmRegistrationCoordinator';
import { effectivelyLocked } from './lockGate';
import { postLockedNotification } from './notifeeService';

/**
 * FCM glue. The receive pipeline (durable intake → EventRouter → DbEventSink → Notifee) already
 * exists; this connects Firebase to it. The bundle entry registers the background callback through
 * `registerFcmBackgroundHandler.ts`; importing this operational module alone is inert.
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
/** Stop delivery before final logging so RNFB's 60-second Android task retains an OS margin. */
export const FCM_HEADLESS_DELIVERY_WINDOW_MS = 50_000;
export const FCM_HEADLESS_FINALIZATION_WINDOW_MS = 55_000;
/** Maximum accepted positive difference between the server's issue clock and callback receipt. */
const FCM_V3_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;
/** Exclusive retirement date for the legacy FCM v2 envelope. */
export const FCM_V2_COMPATIBILITY_CUTOFF_MS = 1_801_440_000_000; // 2027-02-01T00:00:00Z
let fcmLocalOccurrenceSequence = 0;
let fcmAdmissionTail: Promise<void> = Promise.resolve();
const FCM_ROTATION_TIMER_MAX_DELAY_MS = 24 * 60 * 60 * 1_000;
let fcmRotationCheckTimer: ReturnType<typeof setTimeout> | null = null;
let fcmRotationCheckDeadlineAt: number | null = null;

interface FcmHeadlessCallbackLifetime {
  readonly receivedAt: number;
  readonly deliveryDeadlineAt: number;
  readonly finalizationDeadlineAt: number;
  readonly signal: AbortSignal;
  readonly expired: Promise<void>;
  isCurrent(): boolean;
  didExpire(): boolean;
  finish(): void;
}

/** Revoke late delivery authority before resolving the deadline observed by the tracked slot. */
function createFcmHeadlessCallbackLifetime(receivedAt: number): FcmHeadlessCallbackLifetime {
  const controller = new AbortController();
  const deliveryDeadlineAt = receivedAt + FCM_HEADLESS_DELIVERY_WINDOW_MS;
  const finalizationDeadlineAt = receivedAt + FCM_HEADLESS_FINALIZATION_WINDOW_MS;
  let current = true;
  let expired = false;
  let resolveExpired!: () => void;
  const expiredPromise = new Promise<void>((resolve) => {
    resolveExpired = resolve;
  });
  const expire = (): void => {
    if (!current) return;
    expired = true;
    current = false;
    controller.abort(new Error('FCM callback delivery deadline expired'));
    resolveExpired();
  };
  const deadlineTimer = setTimeout(expire, Math.max(0, deliveryDeadlineAt - Date.now()));
  if (typeof deadlineTimer === 'object' && 'unref' in deadlineTimer) deadlineTimer.unref();
  const expireIfDue = (): void => {
    if (current && Date.now() >= deliveryDeadlineAt) expire();
  };

  return {
    receivedAt,
    deliveryDeadlineAt,
    finalizationDeadlineAt,
    signal: controller.signal,
    expired: expiredPromise,
    isCurrent: () => {
      expireIfDue();
      return current;
    },
    didExpire: () => {
      expireIfDue();
      return expired;
    },
    finish: () => {
      clearTimeout(deadlineTimer);
      current = false;
    },
  };
}

/**
 * Bound only the tracked teardown slot. The caller keeps the real delivery promise as its FIFO
 * tail, so releasing a stale account/callback can never let a newer delivery overtake it.
 */
async function waitForFcmDeliveryOwner(
  deliveryTask: Promise<void>,
  lease: RealtimeDeliveryLease,
  backgroundLifetime?: FcmHeadlessCallbackLifetime,
): Promise<void> {
  let resolveGenerationInvalidated!: () => void;
  const generationInvalidated = new Promise<void>((resolve) => {
    resolveGenerationInvalidated = resolve;
  });
  const unsubscribeInvalidation = subscribeRealtimeGenerationInvalidation(
    lease.generation,
    resolveGenerationInvalidated,
  );
  try {
    await Promise.race(
      backgroundLifetime
        ? [deliveryTask, generationInvalidated, backgroundLifetime.expired]
        : [deliveryTask, generationInvalidated],
    );
  } finally {
    unsubscribeInvalidation();
  }
}

function scheduleFcmRotationCheck(deadlineAt: number): void {
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0) return;
  if (fcmRotationCheckTimer !== null) clearTimeout(fcmRotationCheckTimer);
  fcmRotationCheckDeadlineAt = deadlineAt;
  const delay = Math.max(0, Math.min(FCM_ROTATION_TIMER_MAX_DELAY_MS, deadlineAt - Date.now()));
  fcmRotationCheckTimer = setTimeout(() => {
    fcmRotationCheckTimer = null;
    const target = fcmRotationCheckDeadlineAt;
    if (target !== null && Date.now() < target) {
      scheduleFcmRotationCheck(target);
      return;
    }
    void registerFcmToken().finally(() => {
      // A successful versioned registration schedules its exact next deadline. Failed/skipped and
      // old-server paths retry capability/deadline discovery within one bounded timer interval.
      if (fcmRotationCheckTimer === null) {
        scheduleFcmRotationCheck(Date.now() + FCM_ROTATION_TIMER_MAX_DELAY_MS);
      }
    });
  }, delay);
  // Long security timers must not keep Node/Jest alive; React Native returns a numeric timer id.
  if (typeof fcmRotationCheckTimer === 'object' && 'unref' in fcmRotationCheckTimer) {
    fcmRotationCheckTimer.unref();
  }
}

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
function captureFcmDelivery(msg: RemoteMessage, receivedAt = Date.now()): CapturedFcmDelivery {
  const providerMessageId =
    typeof msg.messageId === 'string' && msg.messageId.length > 0 ? msg.messageId : null;
  let transportOccurrenceId = providerMessageId;
  if (!transportOccurrenceId) {
    fcmLocalOccurrenceSequence += 1;
    transportOccurrenceId = `fcm-local:${fcmProcessOccurrenceNonce}:${fcmLocalOccurrenceSequence}`;
  }
  // RemoteMessage.data values are strings, so a shallow copy snapshots the complete envelope.
  const data = msg.data ? { ...msg.data } : undefined;
  return {
    parsed: parseFcmData(data),
    occurrence: { transportOccurrenceId, receivedAt },
  };
}

function normalizedMessageId(event: NormalizedEvent): string | undefined {
  switch (event.type) {
    case 'new-message':
    case 'updated-message':
      return event.message.guid;
    case 'message-deleted':
      return event.payload.guid;
    case 'message-send-error':
      return (
        event.payload.messageGuid ??
        event.payload.guid ??
        event.payload.message?.guid ??
        event.payload.tempGuid ??
        undefined
      );
    default:
      return undefined;
  }
}

function v3IdentityMatchesPayload(identity: FcmPushEnvelopeIdentityV3, plaintext: string): boolean {
  const event = snapshotIncomingEvent(identity.eventType, plaintext);
  // Server rotation is deliberately socket-only: its URL cannot be replay-claimed without
  // persisting credential-bearing content, and the ephemeral approval path has no durable receipt.
  return (
    event !== null &&
    event.type !== 'new-server' &&
    identity.messageId === normalizedMessageId(event)
  );
}

function v3ServerEventId(identity: FcmPushEnvelopeIdentityV3): string {
  return [
    'fcm3',
    identity.serverInstallationId,
    identity.principalId,
    identity.deviceId,
    identity.occurrenceId,
  ].join(':');
}

interface AuthenticatedFcmV3Delivery {
  readonly plaintext: string;
  readonly identity: FcmPushEnvelopeIdentityV3;
}

async function authenticateFcmV3Delivery(
  delivery: CapturedFcmDelivery,
  state: FcmPushUsableKeyState,
  lease: RealtimeDeliveryLease,
): Promise<AuthenticatedFcmV3Delivery | null> {
  const { eventName, body, encrypted, encryptionType } = delivery.parsed;
  let currentOrigin: string | null;
  try {
    currentOrigin = await vault.get('serverAddress');
  } catch {
    logger.warn('[fcm] push-encryption origin unavailable — push dropped');
    return null;
  }
  if (!lease.isCurrent()) return null;
  if (!currentOrigin || state.origin !== currentOrigin) {
    logger.warn('[fcm] push-encryption origin changed — push dropped until re-enrollment');
    return null;
  }
  if (!encrypted || encryptionType !== FCM_V3_ENCRYPTION_TYPE || typeof body !== 'string') {
    logger.warn('[fcm] legacy or unsupported push rejected after V3 migration');
    return null;
  }

  try {
    let authenticated: AuthenticatedFcmV3Delivery | null = null;
    for (const candidate of fcmPushDecryptionKeyCandidates(state, Date.now())) {
      try {
        const decrypted = await decryptFcmV3Payload(body, candidate.key, eventName);
        // Native crypto can straddle the exclusive overlap deadline. Re-evaluate persisted key
        // eligibility after decryption so work started one millisecond early cannot accept the old
        // key after its bounded window has closed.
        if (
          candidate.role === 'previous' &&
          !fcmPushDecryptionKeyCandidates(state, Date.now()).some(
            (eligible) => eligible.role === 'previous' && eligible.key === candidate.key,
          )
        ) {
          throw new Error('FCM V3 previous-key overlap expired during authentication');
        }
        authenticated = decrypted;
        break;
      } catch {
        // Try the bounded previous key only while its persisted exclusive deadline remains open.
      }
    }
    if (!authenticated) throw new Error('no FCM V3 key authenticated the payload');
    if (!lease.isCurrent()) return null;
    const { identity, plaintext } = authenticated;
    const receivedAt = delivery.occurrence.receivedAt ?? Date.now();
    if (
      identity.issuedAt > receivedAt + FCM_V3_FUTURE_CLOCK_SKEW_MS ||
      identity.expiresAt <= Date.now()
    ) {
      throw new Error('FCM V3 authenticated identity is outside its accepted time window');
    }
    if (
      'deviceId' in state &&
      (identity.serverInstallationId !== state.serverInstallationId ||
        identity.principalId !== state.principalId ||
        identity.deviceId !== state.deviceId)
    ) {
      throw new Error('FCM V3 authenticated identity does not match enrolled device');
    }
    if (identity.eventType !== eventName || !v3IdentityMatchesPayload(identity, plaintext)) {
      throw new Error('FCM V3 authenticated message identity does not match payload');
    }
    return authenticated;
  } catch (error) {
    logger.warn(
      '[fcm] failed to authenticate V3 push; sync may recover server state, but a one-time event may be lost',
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
    );
    return null;
  }
}

async function deliver(
  delivery: CapturedFcmDelivery,
  lease: RealtimeDeliveryLease,
  lockedContext?: RealtimeDeliveryLease,
): Promise<void> {
  const { eventName, body, encrypted, encryptionType } = delivery.parsed;

  let encryptionState;
  try {
    encryptionState = await readFcmDeviceEncryptionState(vault);
  } catch {
    logger.warn('[fcm] push-encryption state unavailable — push dropped');
    return;
  }
  if (!lease.isCurrent()) return;

  // No random-key state means there is no authenticated receive key. Password-derived V1 and
  // plaintext compatibility are intentionally retired for both shared and scoped credentials;
  // ordinary sync may recover server-backed state without trusting an unauthenticated push body.
  if (encryptionState.kind === 'absent') {
    logger.warn('[fcm] push rejected without an enrolled random-key encryption state');
    return;
  }

  // A present record means this installation began encrypted-push migration. Malformed/revoked
  // state and every older/unknown envelope fail closed instead of silently restoring a downgrade.
  if (encryptionState.kind !== 'valid' || encryptionState.state.status === 'revoked') {
    logger.warn('[fcm] push-encryption state is not usable — push dropped');
    return;
  }

  if (encryptionState.state.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3) {
    // A pending key can authenticate an acknowledgement-loss recovery push, but it has no
    // locally acknowledged identity triple to compare. While locked, require that exact active
    // binding before either encrypted persistence or a user-visible generic notice.
    if (lockedContext && !('deviceId' in encryptionState.state)) {
      logger.warn('[fcm] pending V3 binding cannot enter locked intake — push dropped');
      return;
    }
    const authenticated = await authenticateFcmV3Delivery(delivery, encryptionState.state, lease);
    if (!authenticated || !lease.isCurrent()) return;
    const occurrence: EventOccurrenceMetadata = {
      ...delivery.occurrence,
      serverEventId: v3ServerEventId(authenticated.identity),
      authenticatedExpiresAt: authenticated.identity.expiresAt,
    };
    if (lockedContext) {
      const admission = await persistAuthenticatedLockedFcmV3Event(
        eventName,
        authenticated.plaintext,
        lockedContext,
        occurrence,
      );
      if (admission === 'enqueued' && lockedContext.isCurrent()) {
        await postLockedNotification(lockedContext);
      }
      return;
    }
    // Keep durable enqueue/effects outside the authentication catch so a database/presentation
    // failure propagates to the native callback owner instead of being mislabeled as bad crypto.
    await dispatchRealtimeEvent(eventName, authenticated.plaintext, 'fcm', lease, occurrence);
    return;
  }

  if (Date.now() >= FCM_V2_COMPATIBILITY_CUTOFF_MS) {
    logger.warn('[fcm] V2 compatibility window has ended — push dropped until V3 enrollment');
    return;
  }

  let currentOrigin: string | null;
  try {
    currentOrigin = await vault.get('serverAddress');
  } catch {
    logger.warn('[fcm] push-encryption origin unavailable — push dropped');
    return;
  }
  if (!lease.isCurrent()) return;
  if (!currentOrigin || encryptionState.state.origin !== currentOrigin) {
    logger.warn('[fcm] push-encryption origin changed — push dropped until re-enrollment');
    return;
  }

  if (!encrypted || encryptionType !== FCM_V2_ENCRYPTION_TYPE || typeof body !== 'string') {
    logger.warn('[fcm] legacy or unsupported push rejected after V2 migration');
    return;
  }

  let plaintext: string;
  try {
    plaintext = await decryptFcmV2Payload(body, encryptionState.state.key, eventName);
  } catch (error) {
    logger.warn(
      '[fcm] failed to authenticate encrypted push; sync may recover server state, but a one-time event may be lost',
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
    );
    return;
  }
  if (!lease.isCurrent()) return;
  if (lockedContext) {
    if (lockedContext.isCurrent()) await postLockedNotification(lockedContext);
    return;
  }
  // V2 authenticates only `eventName` in the current server foundation. Do not merge any other
  // unauthenticated outer-envelope metadata into the authenticated plaintext.
  await dispatchRealtimeEvent(eventName, plaintext, 'fcm', lease, delivery.occurrence);
}

/**
 * SECURITY: while App Lock is engaged, an authenticated pre-cutoff V2 push receives only the
 * historical generic notice and never opens the encrypted database. An authenticated V3 push may
 * use the narrow encrypted-at-rest intake seam, but cannot claim/read/route that row until unlock.
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
  // failures fail closed too. Later sync may recover server-backed state, but cannot recreate a
  // one-time event such as message-send-error.
  const sessionState = await readFcmSessionState(vault, accountRevocationMarker);
  if (!lease.isCurrent()) return;
  if (sessionState !== 'active') {
    if (sessionState === 'unavailable') {
      logger.warn(
        '[fcm] session check unavailable — push dropped; sync may recover server state, but a one-time event may be lost',
      );
    } else {
      logger.debug('[fcm] push for a forgotten server — dropped');
    }
    return;
  }
  // Fail CLOSED: if we can't determine the lock state we assume LOCKED, so a vault failure can
  // never leak sender/content. A pre-cutoff V2 frame must authenticate before its generic notice;
  // V3 must authenticate and win durable admission before it can post that same content-less notice.
  let locked = true;
  let storedLockRequiresProtection = true;
  let lockStateAvailable = false;
  try {
    const storedAppLock = await vault.get('appLockEnabled');
    storedLockRequiresProtection = storedAppLockRequiresProtection(storedAppLock);
    locked = effectivelyLocked(useLockStore.getState(), storedLockRequiresProtection);
    lockStateAvailable = true;
  } catch (e) {
    logger.warn('[fcm] lock-state check failed — failing closed (assuming locked)', e);
  }
  if (!lease.isCurrent()) return;
  if (locked) {
    // A warm unlock can race native crypto or the SQLCipher write. Retain the original persisted
    // decision for a killed process, but let a hydrated live store revoke both the transaction and
    // the later generic notice before either crosses the unlock boundary.
    const lockedContext: RealtimeDeliveryLease = {
      generation: lease.generation,
      signal: lease.signal,
      isCurrent: () =>
        lease.isCurrent() &&
        (!lockStateAvailable ||
          effectivelyLocked(useLockStore.getState(), storedLockRequiresProtection)),
    };
    return deliver(delivery, lease, lockedContext);
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
  backgroundLifetime?: FcmHeadlessCallbackLifetime,
): Promise<void> {
  try {
    // Capture provider identity + envelope synchronously, before the session/lock/decrypt awaits.
    const delivery = captureFcmDelivery(msg, backgroundLifetime?.receivedAt);
    const headlessEffectDeadlineAt =
      source === 'background'
        ? (delivery.occurrence.receivedAt ?? Date.now()) + REALTIME_HEADLESS_EFFECT_WINDOW_MS
        : null;
    const headlessEffect: {
      collection: RealtimeHeadlessEffectCollection | null;
      completion: Promise<RealtimeHeadlessEffectOutcome> | null;
    } = { collection: null, completion: null };
    let underlyingDelivery: Promise<void> | null = null;
    // Reserve FIFO position synchronously, while also registering this callback with teardown
    // before it waits for an earlier FCM delivery. Otherwise a faster later callback can persist
    // and drain before an earlier callback has cleared its session/lock/decrypt gates.
    const previous = fcmAdmissionTail;
    const tracked = runTrackedRealtimeDelivery(async (accountLease) => {
      const lease: RealtimeDeliveryLease = backgroundLifetime
        ? {
            generation: accountLease.generation,
            signal: backgroundLifetime.signal,
            isCurrent: () => accountLease.isCurrent() && backgroundLifetime.isCurrent(),
          }
        : accountLease;
      const deliveryTask = (async (): Promise<void> => {
        await previous;
        if (!lease.isCurrent()) return;
        if (headlessEffectDeadlineAt == null) {
          await deliverRespectingLock(delivery, source, lease);
          return;
        }
        const collection = beginRealtimeHeadlessEffectCollection(lease, {
          deadlineAt: headlessEffectDeadlineAt,
        });
        headlessEffect.collection = collection;
        try {
          await deliverRespectingLock(delivery, source, lease);
        } finally {
          // Start waiting now, but do not keep the long transfer inside account teardown. The
          // native callback below still owns it; Disconnect or the callback deadline revokes it.
          headlessEffect.completion ??= collection.close();
        }
      })();
      underlyingDelivery = deliveryTask;
      await waitForFcmDeliveryOwner(deliveryTask, lease, backgroundLifetime);
    });
    // Preserve provider FIFO against the real continuation, not the 50-second public bound. A
    // successor may itself expire while waiting, but it must never overlap an older delivery that
    // ignored cancellation.
    fcmAdmissionTail = (underlyingDelivery ?? previous).then(
      () => undefined,
      () => undefined,
    );
    let result: 'delivered' | 'paused' | undefined;
    try {
      result = await tracked;
    } finally {
      const effectOutcome = await (headlessEffect.completion ?? headlessEffect.collection?.close());
      if (effectOutcome === 'deadline') {
        logger.warn('[fcm] headless side effects reached their bounded effect deadline');
      }
    }
    if (backgroundLifetime?.didExpire()) {
      logger.warn('[fcm] delivery reached its bounded callback deadline');
    }
    if (result === 'paused') {
      logger.debug('[fcm] delivery paused during account transition', { source });
    }
  } catch (error) {
    logger.warn(
      '[fcm] push delivery failed; sync may recover server state, but a one-time event may be lost',
      {
        source,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
    );
  }
}

export async function handleBackgroundFcm(msg: RemoteMessage): Promise<void> {
  // One callback-entry timestamp governs the effect collector and the final persistence barrier.
  // Capturing it here also preserves the provider envelope's before-first-await ownership.
  const receivedAt = Date.now();
  const lifetime = createFcmHeadlessCallbackLifetime(receivedAt);
  try {
    await handleIncomingFcm(msg, 'background', lifetime);
  } finally {
    lifetime.finish();
    // Android may tear down this headless runtime as soon as the native callback settles.
    await flushPersistentLogsForHeadlessCompletion(lifetime.finalizationDeadlineAt);
  }
}

/**
 * Foreground FCM: request notification permission and handle messages while the app
 * is open. Called once at boot when FCM is enabled (the background handler is already
 * registered by the bundle-entry wrapper). Also re-registers our device token
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
    scheduleFcmRotationCheck(Date.now() + FCM_ROTATION_TIMER_MAX_DELAY_MS);
    return 'ready';
  } catch (e) {
    logger.warn('[fcm] startFcm failed — falling back to socket-only', e);
    return 'failed';
  }
}

const DEVICE_NAME = `Gator (Android ${Platform.Version})`;

interface FcmRegistrationSession {
  readonly epoch: number;
  readonly transportRevision: number;
  readonly origin: string;
  readonly password: string;
}

type FcmPushRegistrationBinding = Pick<
  FcmPushEnvelopeIdentityV3,
  'serverInstallationId' | 'principalId' | 'deviceId'
>;

function sameFcmPushRegistrationBinding(
  left: FcmPushRegistrationBinding,
  right: FcmPushRegistrationBinding,
): boolean {
  return (
    left.serverInstallationId === right.serverInstallationId &&
    left.principalId === right.principalId &&
    left.deviceId === right.deviceId
  );
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
    current.transportRevision === session.transportRevision &&
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
    transportRevision: state.transportRevision,
    origin: state.origin,
    password: state.password,
  };

  try {
    let registered = false;
    // Reserve FIFO position synchronously and admit this whole flow to teardown before waiting on
    // an older call. Reconnect and token-refresh can otherwise generate K1/K2 concurrently and
    // leave the server holding one key while SecureStore holds the other.
    const tracked = runTrackedRealtimeWork(accountLease, () =>
      runSerializedFcmRegistration(async () => {
        if (!registrationSessionIsCurrent(session, accountLease)) return;

        // SEC-04 adoption owns the same Firebase token from candidate custody through promotion.
        // The shared FIFO prevents overlap; this journal gate also prevents a later ordinary retry
        // from re-registering it under the legacy credential between adoption recovery steps.
        const credentialUpgrade = inspectCredentialUpgradeJournal(
          await vault.get('serverCredentialUpgrade'),
        );
        if (!registrationSessionIsCurrent(session, accountLease)) return;
        if (credentialUpgrade.kind === 'invalid') {
          throw new Error('credential-upgrade journal is invalid');
        }
        if (credentialUpgrade.kind === 'valid') return;

        // Deliberately re-read the current installation token instead of trusting the value supplied
        // to RNFB's long-lived onTokenRefresh callback. A native callback queued across reconnect has
        // no account identity of its own; a fresh lookup inside this account lease is unambiguous.
        const token = await getToken(getMessaging());
        if (!token || !registrationSessionIsCurrent(session, accountLease)) return;

        let serverInfo = useSessionStore.getState().serverInfo;
        const scopedCredential = isScopedDeviceCredential(session.password);
        // A cached true value is a monotonic security pin. False/absent capability is refreshed so
        // an upgraded server does not leave a scoped installation on V2 indefinitely.
        if (
          scopedCredential
            ? serverInfo?.supports_fcm_push_encryption_v3 !== true ||
              serverInfo?.supports_fcm_push_key_rotation !== true
            : serverInfo?.supports_fcm_device_encryption !== true
        ) {
          serverInfo = await serverApi.serverInfo(http);
          if (!registrationSessionIsCurrent(session, accountLease)) return;
          if (
            !useSessionStore
              .getState()
              .setServerInfoForTransport(session.origin, session.transportRevision, serverInfo)
          ) {
            return;
          }
        }
        if (!serverInfo) throw new Error('server push-encryption capabilities are unavailable');
        if (!registrationSessionIsCurrent(session, accountLease)) return;

        if (!scopedCredential && Date.now() >= FCM_V2_COMPATIBILITY_CUTOFF_MS) {
          throw new Error('shared-password FCM compatibility window has ended');
        }

        const stored = await readFcmDeviceEncryptionState(vault);
        if (!registrationSessionIsCurrent(session, accountLease)) return;

        if (scopedCredential && serverInfo.supports_fcm_push_encryption_v3 !== true) {
          throw new Error('scoped device credentials require identity-bound FCM encryption');
        }

        if (scopedCredential) {
          if (stored.kind === 'invalid') {
            throw new Error('FCM push-encryption state is invalid');
          }
          if (
            stored.kind === 'valid' &&
            stored.state.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
            stored.state.status !== 'revoked' &&
            stored.state.origin !== session.origin
          ) {
            throw new Error('FCM push-encryption state belongs to another server');
          }

          if (serverInfo.supports_fcm_push_key_rotation === true) {
            const existing = stored.kind === 'valid' ? stored.state : null;
            let registrationState:
              PendingFcmPushKeyState | RotatingFcmPushKeyState | ActiveFcmPushKeyState;

            if (
              existing?.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
              existing.status !== 'revoked' &&
              existing.version === 3
            ) {
              registrationState = existing;
            } else if (
              existing?.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
              existing.status === 'pending'
            ) {
              // Schema-v2 candidates predate server key versions. Preserve the exact key while
              // adding a durable request timestamp, then retry the idempotent initial enrollment.
              registrationState = pendingFcmPushKeyState(existing.key, session.origin, Date.now());
              await writeFcmDeviceEncryptionState(vault, registrationState);
              if (!registrationSessionIsCurrent(session, accountLease)) return;
            } else if (
              existing?.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
              existing.status === 'active'
            ) {
              // An active schema-v2 V3 key is generation one. Rotate it immediately once the
              // capability appears rather than leaving an unversioned key indefinitely active.
              const keyBytes = await Crypto.getRandomBytesAsync(FCM_DEVICE_ENCRYPTION_KEY_BYTES);
              if (!registrationSessionIsCurrent(session, accountLease)) return;
              registrationState = rotatingFcmPushKeyState(
                encodeFcmDeviceEncryptionKey(keyBytes),
                existing.key,
                1,
                existing,
                session.origin,
                Crypto.randomUUID(),
                Date.now(),
              );
              await writeFcmDeviceEncryptionState(vault, registrationState);
              if (!registrationSessionIsCurrent(session, accountLease)) return;
            } else {
              const keyBytes = await Crypto.getRandomBytesAsync(FCM_DEVICE_ENCRYPTION_KEY_BYTES);
              if (!registrationSessionIsCurrent(session, accountLease)) return;
              registrationState = pendingFcmPushKeyState(
                encodeFcmDeviceEncryptionKey(keyBytes),
                session.origin,
                Date.now(),
              );
              await writeFcmDeviceEncryptionState(vault, registrationState);
              if (!registrationSessionIsCurrent(session, accountLease)) return;
            }

            if (
              registrationState.status === 'active' &&
              fcmPushKeyRotationDue(registrationState, Date.now())
            ) {
              const keyBytes = await Crypto.getRandomBytesAsync(FCM_DEVICE_ENCRYPTION_KEY_BYTES);
              if (!registrationSessionIsCurrent(session, accountLease)) return;
              registrationState = rotatingFcmPushKeyState(
                encodeFcmDeviceEncryptionKey(keyBytes),
                registrationState.key,
                registrationState.keyVersion,
                registrationState,
                session.origin,
                Crypto.randomUUID(),
                Date.now(),
              );
              // Candidate, previous key, request id, and local overlap anchor become durable as one
              // value before the server can commit. A lost response therefore retries exactly.
              await writeFcmDeviceEncryptionState(vault, registrationState);
              if (!registrationSessionIsCurrent(session, accountLease)) return;
            }

            if (
              registrationState.status === 'rotating' &&
              Date.now() >= registrationState.requestedAt + FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS
            ) {
              // The server may never have received an old attempt. Refresh only the local request
              // anchor while retaining its exact candidate/id/version. If it did commit, the server
              // returns the original (possibly expired) deadline and the min() below cannot extend it.
              registrationState = rotatingFcmPushKeyState(
                registrationState.key,
                registrationState.previousKey,
                registrationState.previousKeyVersion,
                registrationState,
                session.origin,
                registrationState.rotationId,
                Date.now(),
                registrationState.rotationStartedAt,
              );
              await writeFcmDeviceEncryptionState(vault, registrationState);
              if (!registrationSessionIsCurrent(session, accountLease)) return;
            }

            const ack = await fcmApi.registerDevice(http, DEVICE_NAME, token, {
              type: FCM_PUSH_ENCRYPTION_TYPE_V3,
              key: registrationState.key,
              ...(registrationState.status === 'rotating'
                ? {
                    rotation: {
                      id: registrationState.rotationId,
                      previousKeyVersion: registrationState.previousKeyVersion,
                    },
                  }
                : {}),
            });
            const binding = ack.pushEncryptionIdentity;
            if (
              ack.pushEncryptionType !== FCM_PUSH_ENCRYPTION_TYPE_V3 ||
              !ack.id ||
              !binding ||
              ack.id !== binding.deviceId ||
              ack.pushEncryptionKeyVersion === undefined ||
              (ack.pushEncryptionRotationId === undefined) !==
                (ack.pushEncryptionPreviousKeyExpiresAt === undefined)
            ) {
              throw new Error('server did not acknowledge versioned FCM push encryption');
            }

            let nextActive: ActiveFcmPushKeyState;
            if (registrationState.status === 'rotating') {
              const localPreviousExpiry =
                registrationState.requestedAt + FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS;
              const serverPreviousExpiry = ack.pushEncryptionPreviousKeyExpiresAt;
              if (
                !sameFcmPushRegistrationBinding(binding, registrationState) ||
                ack.pushEncryptionKeyVersion !== registrationState.previousKeyVersion + 1 ||
                ack.pushEncryptionRotationId !== registrationState.rotationId ||
                serverPreviousExpiry === undefined ||
                serverPreviousExpiry <= registrationState.rotationStartedAt
              ) {
                throw new Error('server did not acknowledge the exact FCM push-key rotation');
              }
              const previousExpiresAt = Math.min(serverPreviousExpiry, localPreviousExpiry);
              const freshOverlap = previousExpiresAt > registrationState.requestedAt;
              nextActive = activeFcmPushKeyState(
                registrationState.key,
                ack.pushEncryptionKeyVersion,
                binding,
                session.origin,
                freshOverlap ? registrationState.requestedAt : registrationState.rotationStartedAt,
                freshOverlap
                  ? {
                      key: registrationState.previousKey,
                      keyVersion: registrationState.previousKeyVersion,
                      expiresAt: previousExpiresAt,
                    }
                  : undefined,
              );
            } else {
              if (
                registrationState.status === 'pending'
                  ? ack.pushEncryptionKeyVersion !== 1 || ack.pushEncryptionRotationId !== undefined
                  : ack.pushEncryptionKeyVersion !== registrationState.keyVersion ||
                    !sameFcmPushRegistrationBinding(binding, registrationState) ||
                    ack.pushEncryptionRotationId !== undefined
              ) {
                throw new Error('server changed the active FCM push-key generation');
              }
              const now = Date.now();
              nextActive = activeFcmPushKeyState(
                registrationState.key,
                ack.pushEncryptionKeyVersion,
                binding,
                session.origin,
                registrationState.status === 'active'
                  ? registrationState.activatedAt
                  : registrationState.requestedAt,
                registrationState.status === 'active' &&
                  registrationState.previous !== undefined &&
                  now < registrationState.previous.expiresAt
                  ? registrationState.previous
                  : undefined,
              );
            }
            if (!registrationSessionIsCurrent(session, accountLease)) return;
            await writeFcmDeviceEncryptionState(vault, nextActive);
            if (!registrationSessionIsCurrent(session, accountLease)) return;
            scheduleFcmRotationCheck(nextActive.activatedAt + FCM_PUSH_KEY_ROTATION_INTERVAL_MS);
            registered = true;
            return;
          }

          if (
            stored.kind === 'valid' &&
            stored.state.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
            stored.state.version === 3
          ) {
            throw new Error('FCM push-key rotation capability downgrade rejected');
          }

          let key: string;
          let activeState: ActiveFcmDeviceEncryptionV3State | null = null;
          if (
            stored.kind === 'valid' &&
            stored.state.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
            stored.state.version === 2 &&
            stored.state.status !== 'revoked' &&
            stored.state.origin === session.origin
          ) {
            key = stored.state.key;
            if (stored.state.status === 'active') activeState = stored.state;
          } else {
            const keyBytes = await Crypto.getRandomBytesAsync(FCM_DEVICE_ENCRYPTION_KEY_BYTES);
            if (!registrationSessionIsCurrent(session, accountLease)) return;
            key = encodeFcmDeviceEncryptionKey(keyBytes);
          }

          if (!activeState) {
            // Persist a NEW candidate before POST. A lost acknowledgement cannot make this
            // installation accept V2 again, and enrollment recovery reuses the exact key. An
            // already-active binding deliberately remains active throughout token refresh.
            await writeFcmDeviceEncryptionState(
              vault,
              pendingFcmDeviceEncryptionV3State(key, session.origin),
            );
            if (!registrationSessionIsCurrent(session, accountLease)) return;
          }

          const ack = await fcmApi.registerDevice(http, DEVICE_NAME, token, {
            type: FCM_PUSH_ENCRYPTION_TYPE_V3,
            key,
          });
          const binding = ack.pushEncryptionIdentity;
          if (
            ack.pushEncryptionType !== FCM_PUSH_ENCRYPTION_TYPE_V3 ||
            !ack.id ||
            !binding ||
            ack.id !== binding.deviceId
          ) {
            throw new Error('server did not acknowledge identity-bound FCM encryption');
          }
          if (
            activeState &&
            (binding.serverInstallationId !== activeState.serverInstallationId ||
              binding.principalId !== activeState.principalId ||
              binding.deviceId !== activeState.deviceId)
          ) {
            throw new Error('server changed an active FCM encryption identity');
          }
          if (!registrationSessionIsCurrent(session, accountLease)) return;

          await writeFcmDeviceEncryptionState(
            vault,
            activeFcmDeviceEncryptionV3State(key, binding, session.origin),
          );
          if (!registrationSessionIsCurrent(session, accountLease)) return;
          registered = true;
          return;
        }

        // Any present V3/unknown record is a permanent downgrade pin. It can be repaired only by an
        // exact V3-capable scoped enrollment, never by V2 or legacy registration.
        if (
          stored.kind === 'invalid' ||
          (stored.kind === 'valid' && stored.state.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3)
        ) {
          throw new Error('FCM push-encryption V3 downgrade rejected');
        }

        if (serverInfo.supports_fcm_device_encryption === true) {
          let key: string;
          if (
            stored.kind === 'valid' &&
            stored.state.encryptionType === FCM_DEVICE_ENCRYPTION_TYPE &&
            stored.state.status !== 'revoked' &&
            stored.state.origin === session.origin
          ) {
            key = stored.state.key;
          } else {
            const keyBytes = await Crypto.getRandomBytesAsync(FCM_DEVICE_ENCRYPTION_KEY_BYTES);
            if (!registrationSessionIsCurrent(session, accountLease)) return;
            key = encodeFcmDeviceEncryptionKey(keyBytes);
          }

          // Persist BEFORE POST. A server commit followed by a lost response can then be decrypted,
          // and the next retry reuses this exact candidate instead of rotating blindly.
          await writeFcmDeviceEncryptionState(
            vault,
            pendingFcmDeviceEncryptionState(key, session.origin),
          );
          if (!registrationSessionIsCurrent(session, accountLease)) return;

          const ack = await fcmApi.registerDevice(http, DEVICE_NAME, token, {
            type: FCM_DEVICE_ENCRYPTION_TYPE,
            key,
          });
          if (
            ack.pushEncryptionType !== FCM_DEVICE_ENCRYPTION_TYPE ||
            !ack.id ||
            ack.id.length > 256
          ) {
            throw new Error('server did not acknowledge FCM device encryption');
          }
          if (!registrationSessionIsCurrent(session, accountLease)) return;

          await writeFcmDeviceEncryptionState(
            vault,
            activeFcmDeviceEncryptionState(key, ack.id, session.origin),
          );
          if (!registrationSessionIsCurrent(session, accountLease)) return;
          registered = true;
          return;
        }

        if (stored.kind !== 'absent') {
          throw new Error('FCM push-encryption downgrade rejected');
        }
        await fcmApi.registerDevice(http, DEVICE_NAME, token);
        if (registrationSessionIsCurrent(session, accountLease)) registered = true;
      }),
    );
    const result = await tracked;
    return result === 'delivered' && registered ? 'registered' : 'skipped';
  } catch (e) {
    // Disconnect intentionally revokes in-flight registration. Logging that expected cancellation
    // as a network failure is noisy and can attach stale account context to the next session's log.
    if (registrationSessionIsCurrent(session, accountLease)) {
      logger.warn('[fcm] device token registration failed', {
        errorName: e instanceof Error ? e.name : 'UnknownError',
      });
      return 'failed';
    }
    return 'skipped';
  }
}
