import * as Crypto from 'expo-crypto';
import { serverApi } from '@core/api';
import { strictServerOrigin } from '@core/config';
import { logger } from '@core/secure';
import {
  captureIncomingEvent,
  type EventDeliveryContext,
  type EventOccurrenceMetadata,
  type EventSink,
  type EventSource,
  type IncomingEventConflictRecovery,
  type NormalizedEvent,
  type NotificationIntent,
  EventRouter,
  FCM_ENABLED,
} from '@core/realtime';
import { chatHasKnownSender, getIncomingEventQueueHealth } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { useFaceTimeStore } from '@state/faceTimeStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useLockStore } from '@state/lockStore';
import { useRcsHealthStore } from '@state/rcsHealthStore';
import { useSessionStore } from '@state/sessionStore';
import { useTypingStore } from '@state/typingStore';
import { isDevServer } from '@utils/isDev';
import { http } from './clients';
import { ensureSyncedBackground } from './backgrounds/syncedBackground';
import { ensureDatabase } from './databaseControl';
import { ensureChatSynced, maybeResumeSync, startSync } from './syncControl';
import { autoDownloadMessageAttachments } from './download/autoDownloadAttachments';
import { createAttachmentCacheAccountScope } from './download/attachmentCacheAccountScope';
import { attachmentCacheCoordinator } from './download/attachmentCacheCoordinator';
import { startReachabilityWatch } from './reachability';
import { buildMessageIntents } from './notifications/intents';
import { postNotification, requestNotificationPermission } from './notifications/notifeeService';
import { effectivelyLocked } from './notifications/lockGate';
import { DbEventSink } from './realtime/dbEventSink';
import { expoDigestBackend } from './realtime/expoDigestBackend';
import { GroupEventSideEffectSink } from './realtime/groupEventSideEffectSink';
import { NotifyingEventSink } from './realtime/notifyingEventSink';
import { TypingEventSink } from './realtime/typingEventSink';
import { FaceTimeEventSink } from './realtime/faceTimeEventSink';
import { ServerUrlEventSink } from './realtime/serverUrlEventSink';
import { RcsAlertEventSink } from './realtime/rcsAlertEventSink';
import { createServerUrlResolver } from './realtime/serverUrlResolver';
import { SocketService } from './realtime/socketService';
import { IncomingEventDrain } from './realtime/incomingEventDrain';
import { DurableRealtimeDispatcher } from './realtime/incomingEventDispatcher';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeDelivery,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
} from './realtime/deliveryCoordinator';

/**
 * Awaitable `postNotification` boundary that logs and contains native presentation failures.
 *
 * The notifying sink awaits this after the DB write (the DB remains the source of truth). Any
 * channel-create failure, bad avatar uri, or notify-kit rejection is contained and logged at
 * `warn` for development diagnosis without becoming an unhandled rejection. Release builds drop
 * free-form non-error logs; durable deliveries still retain their retry/backoff behavior below.
 */
async function postNotificationSafely(
  intent: NotificationIntent,
  context?: EventDeliveryContext,
): Promise<void> {
  await postNotification(intent, context).catch((e) => {
    logger.warn('[notify] failed to post notification', { kind: intent.kind, error: e });
    // A durable claimed attempt owns retry/backoff. DB + queue checkpoint already committed, so a
    // retry will skip DB and safely repeat the deterministic native notification operation.
    if (context?.durableEvent) throw e;
  });
}

/** Unknown feature settings must never opt a user into message presentation by default. */
export function shouldPresentMessageNotification(settings: {
  readonly hydrated: boolean;
  readonly messageNotifications: boolean;
}): boolean {
  return settings.hydrated && settings.messageNotifications;
}

class RealtimeNotificationSettingsUnavailableError extends Error {
  override readonly name = 'RealtimeNotificationSettingsUnavailableError';

  constructor() {
    super('notification settings are not hydrated yet');
  }
}

/** Message notification consent is load-bearing: unknown is a retry, never silent completion. */
async function prepareMessageNotificationSettings(
  context?: EventDeliveryContext,
): Promise<boolean> {
  if (context && !context.isCurrent()) return false;
  const features = useFeatureSettingsStore.getState();
  if (!features.hydrated) {
    await features.hydrate({
      shouldCommit: () => !context || context.isCurrent(),
      onError: (error) => logger.warn('[realtime] feature settings hydration failed', error),
    });
  }
  if (context && !context.isCurrent()) return false;
  if (!useFeatureSettingsStore.getState().hydrated) {
    if (context?.durableEvent) throw new RealtimeNotificationSettingsUnavailableError();
    return false;
  }
  return true;
}

let socket: SocketService | null = null;
// Guards the ONE-TIME realtime setup (notification/FCM permission + token registration) so it
// runs on the FIRST connect only — never on a foreground reconnect. See startRealtime().
let realtimeOneTimeSetupDone = false;

export interface RealtimeStartupIssue {
  readonly stage: 'notifications' | 'fcm';
  readonly level: 'degraded';
  readonly code: string;
  readonly userMessage: string;
}

interface StartRealtimeOptions {
  readonly reportIssue?: (issue: RealtimeStartupIssue) => void;
}

function reportRealtimeStartupIssue(
  options: StartRealtimeOptions,
  issue: RealtimeStartupIssue,
): void {
  try {
    options.reportIssue?.(issue);
  } catch (error) {
    logger.warn('[realtime] optional startup issue reporter failed', error);
  }
}

/** Read the live socket (or null). Used by callers outside this module (e.g. sendTyping). */
export function getSocket(): SocketService | null {
  return socket;
}

/** Replace the live socket reference (or clear it). Used by teardown callers (e.g. forget). */
export function setSocket(next: SocketService | null): void {
  socket = next;
  if (next === null) {
    resetRealtimeRuntime();
  }
}

const pendingRealtimeRecoveries = new Set<string>();

/** Schedule recovery without holding a claimed event or the account teardown barrier open. */
function requestRealtimeRecovery(
  recovery: IncomingEventConflictRecovery,
  context?: EventDeliveryContext,
): void {
  if (recovery.kind === 'none' || (context && !context.isCurrent())) return;
  const key = `${context?.generation ?? 0}:${
    recovery.kind === 'sync-chat' ? `chat:${recovery.chatGuid}` : recovery.kind
  }`;
  if (pendingRealtimeRecoveries.has(key)) return;
  pendingRealtimeRecoveries.add(key);
  void Promise.resolve()
    .then(async () => {
      if (context && !context.isCurrent()) return;
      if (recovery.kind === 'sync-chat') {
        await ensureChatSynced(recovery.chatGuid);
      } else {
        // Explicit durable recovery must not use the reconnect throttle: short-lived receipts can
        // expire before a delayed retry, and full sync is what rehydrates chat read watermarks.
        // startSync still coalesces concurrent work for the same account generation.
        await startSync();
      }
    })
    .catch((error: unknown) => {
      if (!context || context.isCurrent()) {
        logger.warn('[incomingEvents] recovery task failed', {
          kind: recovery.kind,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    })
    .finally(() => pendingRealtimeRecoveries.delete(key));
}

function realtimeIntakeLocked(): boolean {
  return effectivelyLocked(useLockStore.getState(), false);
}

/** Reject locked intake and credential-bearing URL rotations before encrypted persistence. */
function canPersistRealtimeEvent(event: NormalizedEvent): boolean {
  if (realtimeIntakeLocked()) {
    logger.debug('[realtime] ignored private event while App Lock is active', {
      event: event.type,
    });
    return false;
  }
  if (event.type !== 'new-server') return true;
  const current = strictServerOrigin(useSessionStore.getState().origin);
  const next = strictServerOrigin(event.url);
  if (current && next === current) return true;
  logger.warn('[realtime] rejected untrusted new-server event before durable persistence');
  return false;
}

// One realtime sink, shared by the socket and the dev/FCM transports so behavior is
// identical regardless of how the event arrived. Outer layer routes ephemeral typing
// events to UI state; inner layer writes the DB (source of truth) then notifies.
let realtimeSinkInstance: EventSink | null = null;
function realtimeSink(db: AppDatabase): EventSink {
  realtimeSinkInstance ??= new ServerUrlEventSink(
    new RcsAlertEventSink(
      new FaceTimeEventSink(
        new TypingEventSink(
          new GroupEventSideEffectSink(
            new NotifyingEventSink(
              new DbEventSink(
                db,
                (messageId) => autoDownloadMessageAttachments(db, messageId),
                async (context) => {
                  if (!context?.isCurrent()) return;
                  const attachmentCacheScope = createAttachmentCacheAccountScope(context);
                  await attachmentCacheCoordinator.retireInactiveEntries(db, {
                    scope: attachmentCacheScope,
                  });
                  await attachmentCacheCoordinator.drainDueRetirements(db, {
                    scope: attachmentCacheScope,
                  });
                },
                (chatGuid, context) =>
                  requestRealtimeRecovery(
                    chatGuid ? { kind: 'sync-chat', chatGuid } : { kind: 'sync-account' },
                    context,
                  ),
              ),
              db,
              buildMessageIntents,
              async (intent, context) => {
                if (context && !context.isCurrent()) return;
                // Honor the global "Message Notifications" toggle (message-kind only; calls/reminders
                // still post). Gated here (not in the pure buildMessageIntents) so the Node tests don't
                // pull the kv-backed store — and the DB is still written regardless.
                if (
                  intent.kind === 'message' &&
                  !(await prepareMessageNotificationSettings(context))
                ) {
                  return;
                }
                const featureSettings = useFeatureSettingsStore.getState();
                if (
                  intent.kind === 'message' &&
                  !shouldPresentMessageNotification(featureSettings)
                ) {
                  return;
                }
                // "Filter Unknown Senders": a chat with no contact-matched participant notifies
                // silently (DB/badge only) when the filter is on — parity with the old app's muted
                // unknown-sender notifications. Same gating layer as the toggle above.
                if (
                  intent.kind === 'message' &&
                  useFeatureSettingsStore.getState().filterUnknownSenders
                ) {
                  // Fail OPEN: if the known-sender lookup rejects (a DB read hiccup), still post the
                  // notification rather than silently swallowing it as an unhandled rejection — a
                  // dropped alert is worse than an occasional unfiltered one. The DB row is already
                  // written regardless (this gate only decides whether to raise the notification).
                  let knownSender = true;
                  try {
                    knownSender = await chatHasKnownSender(db, intent.chatGuid);
                  } catch (e) {
                    logger.warn('[notify] known-sender check failed — notifying anyway', e);
                  }
                  if (!knownSender) return;
                  if (context && !context.isCurrent()) return;
                  await postNotificationSafely(intent, context);
                  return;
                }
                await postNotificationSafely(intent, context);
              },
            ),
            // Chat-background changed/removed group event → refetch the synced wallpaper. Injected
            // (not run inside DbEventSink) because it's a network + DB side effect. Change-detects
            // internally, so calling it on ingestion — before the channel visibly syncs — is safe.
            // Wallpaper transfer outlives the durable-event attempt. Omit that short-lived context
            // so ensureSyncedBackground captures a fresh account-generation lease of its own.
            (guid) => ensureSyncedBackground(http, db, guid),
          ),
          (chatGuid, display) => useTypingStore.getState().setTyping(chatGuid, display),
        ),
        (c) => useFaceTimeStore.getState().ring(c),
        (uuid) => useFaceTimeStore.getState().dismissIncoming(uuid),
      ),
      (alertType) => useRcsHealthStore.getState().setAlert(alertType),
    ),
    (url) => applyNewServerUrl(url),
  );
  return realtimeSinkInstance;
}

// One normalizer/sink chain per account generation. Durable receipts, rather than EventRouter's
// legacy in-memory set, own cross-transport deduplication and process-death recovery.
let sharedRouterInstance: EventRouter | null = null;
function sharedRouter(db: AppDatabase): EventRouter {
  sharedRouterInstance ??= new EventRouter(realtimeSink(db));
  return sharedRouterInstance;
}

interface RealtimeRuntime {
  readonly db: AppDatabase;
  readonly generation: number;
  readonly dispatcher: DurableRealtimeDispatcher;
  unsubscribeInvalidation: () => void;
}

let realtimeRuntimeInstance: RealtimeRuntime | null = null;
// A headless bundle starts false. Foreground lifecycle calls below are the sole owner of this bit,
// so a killed/background FCM wake may drain immediately but never keeps the process alive on a
// dormant retry timer.
let realtimeForegroundActive = false;
let realtimeLifecycleEpoch = 0;
let fallbackOccurrenceSequence = 0;
const fallbackOccurrenceNamespace = Crypto.randomUUID();

function resetRealtimeRuntime(expected?: RealtimeRuntime): void {
  const current = realtimeRuntimeInstance;
  if (!current || (expected && current !== expected)) return;
  realtimeRuntimeInstance = null;
  current.unsubscribeInvalidation();
  current.dispatcher.dispose();
  realtimeSinkInstance = null;
  sharedRouterInstance = null;
}

function getRealtimeRuntime(
  db: AppDatabase,
  context: EventDeliveryContext,
): RealtimeRuntime | null {
  if (!context.isCurrent()) return null;
  const existing = realtimeRuntimeInstance;
  if (existing?.db === db && existing.generation === context.generation) return existing;
  resetRealtimeRuntime();

  const router = sharedRouter(db);
  const canDrainPrivateQueue = () => !realtimeIntakeLocked();
  const drain = new IncomingEventDrain(db, router, expoDigestBackend, {
    makeLeaseToken: () => Crypto.randomUUID(),
    canDrain: canDrainPrivateQueue,
    canScheduleWake: () => realtimeForegroundActive && canDrainPrivateQueue(),
    onPermanentFailure: (_eventName, deliveryContext) =>
      requestRealtimeRecovery({ kind: 'sync-account' }, deliveryContext),
  });
  const dispatcher = new DurableRealtimeDispatcher(db, expoDigestBackend, drain, {
    makeTransportOccurrenceId: (source) =>
      `${source}:${fallbackOccurrenceNamespace}:${++fallbackOccurrenceSequence}`,
    // `isDevServer()` safely handles runtimes (such as plain Node tests) where `__DEV__` does not
    // exist, and narrows the opt-in to the exact fixture session instead of every debug session.
    allowDevPersistWithoutDrain: isDevServer(),
    canPersist: canPersistRealtimeEvent,
    requestRecovery: (recovery, _reason, deliveryContext) =>
      requestRealtimeRecovery(recovery, deliveryContext),
  });
  const runtime: RealtimeRuntime = {
    db,
    generation: context.generation,
    dispatcher,
    unsubscribeInvalidation: () => undefined,
  };
  realtimeRuntimeInstance = runtime;
  runtime.unsubscribeInvalidation = subscribeRealtimeGenerationInvalidation(
    context.generation,
    () => resetRealtimeRuntime(runtime),
  );
  return context.isCurrent() && realtimeRuntimeInstance === runtime ? runtime : null;
}

async function dispatchWithContext(
  eventName: string,
  rawData: unknown,
  source: EventSource,
  context: EventDeliveryContext,
  occurrence?: EventOccurrenceMetadata,
  receivedAt?: number,
): Promise<void> {
  if (!context.isCurrent() || realtimeIntakeLocked()) return;
  const db = await ensureDatabase();
  if (!context.isCurrent() || realtimeIntakeLocked()) return;
  await getRealtimeRuntime(db, context)?.dispatcher.handle(
    eventName,
    rawData,
    source,
    context,
    occurrence,
    receivedAt,
  );
}

/** Persist a raw event before routing any DB, UI, network, or notification effect. */
export async function dispatchRealtimeEvent(
  eventName: string,
  rawData: unknown,
  source: EventSource,
  context?: EventDeliveryContext,
  occurrence?: EventOccurrenceMetadata,
): Promise<void> {
  const receivedAt = occurrence?.receivedAt ?? Date.now();
  if ((context && !context.isCurrent()) || realtimeIntakeLocked()) return;
  const captured = captureIncomingEvent(eventName, rawData);
  if (!captured) {
    logger.debug('[incomingEvents] dropped invalid realtime event', { event: eventName, source });
    return;
  }
  const capturedOccurrence = occurrence
    ? {
        serverEventId: occurrence.serverEventId,
        transportOccurrenceId: occurrence.transportOccurrenceId,
      }
    : undefined;
  // A supplied lease proves which account owns the callback, but it does not prove that teardown
  // is waiting for this particular dispatch. Adopt it into the common drain here so every public
  // caller—including a retained DEV/UI callback—has the same admission and revocation contract.
  const result = context
    ? await runTrackedRealtimeWork(context, (lease) =>
        dispatchWithContext(
          captured.eventName,
          captured.rawData,
          source,
          lease,
          capturedOccurrence,
          receivedAt,
        ),
      )
    : await runTrackedRealtimeDelivery((lease) =>
        dispatchWithContext(
          captured.eventName,
          captured.rawData,
          source,
          lease,
          capturedOccurrence,
          receivedAt,
        ),
      );
  if (result === 'paused') {
    logger.debug('[realtime] event delivery paused during account transition', { source });
  }
}

/** Payload-free counters returned only by the DEV process-death proof seam. */
export interface DevIncomingEventQueueHealth {
  readonly pending: number;
  readonly due: number;
  readonly leased: number;
  readonly dbAppliedPending: number;
  readonly completed: number;
  readonly poisoned: number;
}

/** One-way proof gate: once account, fixture identity, or App Lock fails, it never re-opens. */
function createDevProofContext(context: EventDeliveryContext): EventDeliveryContext | null {
  let revoked = false;
  const proofContext: EventDeliveryContext = {
    generation: context.generation,
    isCurrent: () => {
      if (revoked) return false;
      const allowed = context.isCurrent() && isDevServer() && !realtimeIntakeLocked();
      if (!allowed) revoked = true;
      return allowed;
    },
  };
  return proofContext.isCurrent() ? proofContext : null;
}

async function readDevIncomingEventQueueHealth(
  db: AppDatabase,
): Promise<DevIncomingEventQueueHealth> {
  const health = await getIncomingEventQueueHealth(db, Date.now());
  return {
    pending: health.pending,
    due: health.due,
    leased: health.leased,
    dbAppliedPending: health.dbAppliedPending,
    completed: health.completed,
    poisoned: health.poisoned,
  };
}

/**
 * DEV-only fault seam: persist and claim one fixture event through the production
 * encoder/repository but do not run its handler. Production builds return null before opening the
 * DB. Leaving the bounded lease active models a process dying after it has taken ownership.
 */
export async function devPersistRealtimeEventWithoutDrain(
  eventName: string,
  rawData: unknown,
  context: EventDeliveryContext,
  occurrence: EventOccurrenceMetadata,
): Promise<DevIncomingEventQueueHealth | null> {
  const proofContext = createDevProofContext(context);
  if (!proofContext) return null;
  const receivedAt = Date.now();
  const captured = captureIncomingEvent(eventName, rawData);
  if (!captured) return null;
  const capturedOccurrence = {
    serverEventId: occurrence.serverEventId,
    transportOccurrenceId: occurrence.transportOccurrenceId,
  };
  const db = await ensureDatabase();
  if (!proofContext.isCurrent()) return null;
  const before = await readDevIncomingEventQueueHealth(db);
  // A proof must never delay, reorder, or hide genuine unfinished work—even in a DEV build.
  if (!proofContext.isCurrent() || before.pending !== 0) return null;
  const runtime = getRealtimeRuntime(db, proofContext);
  const leaseToken = `dev-proof:${Crypto.randomUUID()}`;
  const persisted = await runtime?.dispatcher.persistWithoutDrainForDev(
    captured.eventName,
    captured.rawData,
    'dev',
    proofContext,
    capturedOccurrence,
    leaseToken,
    receivedAt,
  );
  if (!persisted || !proofContext.isCurrent()) return null;
  if (
    persisted.claim.id !== persisted.queueId ||
    persisted.claim.leaseToken !== leaseToken ||
    persisted.claim.source !== 'dev' ||
    persisted.claim.attempts !== 1
  ) {
    throw new Error('DEV process-death proof claimed an unexpected queue row');
  }
  if (!proofContext.isCurrent()) return null;
  const health = await readDevIncomingEventQueueHealth(db);
  return proofContext.isCurrent() ? health : null;
}

/** Resume persisted DEV proof work after relaunch; never exposes envelope payloads or identities. */
export async function devResumePersistedRealtimeEvents(
  context: EventDeliveryContext,
): Promise<DevIncomingEventQueueHealth | null> {
  const proofContext = createDevProofContext(context);
  if (!proofContext) return null;
  const db = await ensureDatabase();
  if (!proofContext.isCurrent()) return null;
  const runtime = getRealtimeRuntime(db, proofContext);
  if (!runtime) return null;
  await runtime.dispatcher.resume(proofContext);
  if (!proofContext.isCurrent()) return null;
  const health = await readDevIncomingEventQueueHealth(db);
  return proofContext.isCurrent() ? health : null;
}

/** DEV-only direct intake seam used by fixture buttons; no retained mutable dispatch callback. */
export const devPush = {
  async inject(
    eventName: string,
    rawData: unknown,
    context?: EventDeliveryContext,
    occurrence?: EventOccurrenceMetadata,
  ): Promise<void> {
    await dispatchRealtimeEvent(eventName, rawData, 'dev', context, occurrence);
  },
};

// Reconnect-escalation URL rediscovery: when the socket's capped retries are exhausted, ask
// whether the server URL rotated while the socket was down. Today the one source is the session
// store — `applyNewServerUrl` (a `new-server` event, possibly delivered over FCM while the socket
// was dead) has already persisted the rotated origin there; a future Firebase-RTDB lookup can be
// appended as another source without touching the socket.
const refreshServerUrl = createServerUrlResolver([
  { name: 'session', get: () => useSessionStore.getState().origin },
]);

/** Connect the live socket and route its events into the DB. */
export async function startRealtime(options: StartRealtimeOptions = {}): Promise<void> {
  realtimeForegroundActive = true;
  const lifecycleEpoch = ++realtimeLifecycleEpoch;
  const db = await ensureDatabase();
  // AppState can background/lock the app while the DB open is suspended. A stale startup must not
  // reconnect a socket after pauseRealtime already closed foreground intake.
  if (
    !realtimeForegroundActive ||
    lifecycleEpoch !== realtimeLifecycleEpoch ||
    realtimeIntakeLocked()
  ) {
    return;
  }
  // Capture AFTER the async DB open: a Disconnect while it was opening must be observed here.
  // From this point through `connect` there is no await, so origin/password/mode/headers are one
  // coherent identity rather than four live reads from a possibly changing session.
  const transport = http.snapshotTransport();
  if (!transport.origin || !transport.password) return;
  const accountLease = captureRealtimeDeliveryLease();
  if (!accountLease.isCurrent()) return;
  const runtime = getRealtimeRuntime(db, accountLease);
  if (!runtime) return;
  socket?.disconnect();
  // Socket and FCM now enter the same durable dispatcher; SQLite receipts own dedup/replay.
  socket = new SocketService(dispatchRealtimeEvent);
  // Keep the socket in the SAME auth mode as REST: header/auth-payload by default,
  // `?guid=` query against a stock server that only reads the legacy param.
  socket.connect(transport.origin, transport.password, {
    headers: { ...transport.headers },
    legacyQueryAuth: transport.authMode === 'legacy-query',
    refreshUrl: refreshServerUrl,
  });
  // Recover any row left pending by a prior process death before waiting for another callback.
  void runTrackedRealtimeDelivery((lease) => runtime.dispatcher.resume(lease)).catch(
    (error: unknown) => {
      if (accountLease.isCurrent()) {
        logger.warn('[incomingEvents] startup drain failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    },
  );
  // Auto-resume HTTP sync when the server becomes reachable again after a drop. The socket's own
  // reconnect covers the happy path, but for users who lose connectivity often (and whose websocket
  // frequently can't re-establish) this lightweight ping-on-a-timer is what actually brings sync
  // back without a manual pull. `ping` is non-retrying, so it detects "down" fast.
  startReachabilityWatch(() => serverApi.ping(http), maybeResumeSync);
  // ONE-TIME: requesting notification permission (notifee + FCM) launches the system permission
  // dialog, and that dialog itself fires an AppState change → the foreground `resumeRealtime()`
  // listener → `startRealtime()` again. Doing it on EVERY (re)connect created an INFINITE
  // permission-request loop the first time the app foregrounded (the UI froze; logcat showed
  // GrantPermissionsActivity launched tens of thousands of times). Request it once.
  if (!realtimeOneTimeSetupDone) {
    realtimeOneTimeSetupDone = true;
    void requestNotificationPermission()
      .then((granted) => {
        if (!granted) {
          reportRealtimeStartupIssue(options, {
            stage: 'notifications',
            level: 'degraded',
            code: 'notification-permission-denied',
            userMessage: 'Notifications are disabled; open Gator to see new messages.',
          });
        }
      })
      .catch((error) => {
        logger.warn('[notify] notification permission request failed', error);
        reportRealtimeStartupIssue(options, {
          stage: 'notifications',
          level: 'degraded',
          code: 'notification-permission-unavailable',
          userMessage: 'Notifications are unavailable; open Gator to see new messages.',
        });
      });
  }
  // Register this device's FCM token on EVERY (re)connect — NOT once. The server de-dupes by token
  // (register-device collapses duplicate rows), so this is idempotent and cheap, and it is the only
  // thing that keeps push alive across the cases a one-shot registration silently broke: a transient
  // failure at first boot (server briefly unreachable → no token → zero pushes all session), a
  // reconnect to a DIFFERENT server after `forget()` (new server never learned the token), and an
  // FCM token rotation that landed while disconnected. Firebase is dynamically imported to keep it
  // out of the test/static graph (a no-op until FCM is enabled).
  if (FCM_ENABLED) {
    void import('./notifications/fcmMessaging')
      .then(async (module) => {
        const result = await module.registerFcmToken();
        if (result === 'failed') {
          reportRealtimeStartupIssue(options, {
            stage: 'fcm',
            level: 'degraded',
            code: 'fcm-token-registration-failed',
            userMessage: 'Push updates are unavailable; live socket updates still work.',
          });
        }
      })
      .catch((error) => {
        logger.warn('[fcm] foreground registration setup failed', error);
        reportRealtimeStartupIssue(options, {
          stage: 'fcm',
          level: 'degraded',
          code: 'fcm-registration-unavailable',
          userMessage: 'Push updates are unavailable; live socket updates still work.',
        });
      });
  }
}

/**
 * Foreground/background lifecycle for the live socket.
 *
 * Android freezes the JS thread + the socket while the app is backgrounded, so on resume the
 * socket can be silently stale — the `updated-message` (Delivered) and `new-message` events then
 * limp in over slow FCM instead of the fast socket. Tearing the socket down on background makes
 * the resume a deterministic fresh reconnect (rather than waiting for socket.io to notice the dead
 * connection via a late ping-timeout). Wired to AppState in `app/(app)/_layout.tsx`.
 */
export function pauseRealtime(): void {
  realtimeForegroundActive = false;
  realtimeLifecycleEpoch += 1;
  socket?.disconnect();
  socket = null;
}

/**
 * On foreground: reconnect the socket if it isn't currently connected, and ALWAYS pull anything
 * missed while backgrounded over HTTP (fast + deterministic) instead of waiting on the socket
 * handshake or FCM. `maybeResumeSync` is coalesced/throttled, so a quick app-switch is cheap.
 */
export async function resumeRealtime(): Promise<void> {
  realtimeForegroundActive = true;
  realtimeLifecycleEpoch += 1;
  const { origin, password } = useSessionStore.getState();
  if (!origin || !password) return;
  if (!socket || !socket.connected) await startRealtime();
  if (!realtimeForegroundActive || realtimeIntakeLocked()) return;
  // Even a healthy socket does not imply the prior process finished its durable queue.
  await runTrackedRealtimeDelivery(async (lease) => {
    const db = await ensureDatabase();
    if (!lease.isCurrent()) return;
    await getRealtimeRuntime(db, lease)?.dispatcher.resume(lease);
  });
  maybeResumeSync();
}

/**
 * Contain the server's untrusted `new-server` event.
 *
 * A cross-origin event cannot safely re-point an Authorization password on its own: the transport
 * carrying the event is not proof that a different host is the same server. Until the foreground
 * approval + password-reconfirmation half of RT-01A exists, accept only canonical spellings of the
 * origin already trusted by the user. Every foreign host, port, or cleartext downgrade is ignored
 * before persistence, HTTP, or socket work. This intentionally trades automatic tunnel rotation
 * for credential safety; the user can still reconnect through the explicit setup flow.
 */
export async function applyNewServerUrl(url: string): Promise<void> {
  const current = strictServerOrigin(useSessionStore.getState().origin);
  const next = strictServerOrigin(url);
  if (!current || !next) {
    logger.warn('[realtime] ignoring malformed new-server origin');
    return;
  }
  if (next !== current) {
    logger.warn(
      '[realtime] ignoring cross-origin new-server event until foreground approval is available',
    );
    return;
  }
}
