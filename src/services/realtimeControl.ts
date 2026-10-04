import * as Crypto from 'expo-crypto';
import { serverApi } from '@core/api';
import { strictServerOrigin } from '@core/config';
import { inspectCredentialUpgradeJournal, logger } from '@core/secure';
import {
  admitsCurrentRcsEvent,
  classifyRcsEventAdmission,
  currentRcsProviderEpoch,
} from '@core/rcs';
import {
  captureIncomingEvent,
  snapshotIncomingEvent,
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
import {
  chatHasKnownSender,
  getChatGuidByMessageGuid,
  getIncomingEventQueueHealth,
  INCOMING_EVENT_DEPENDENCY_RETRY_MS,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useLockStore } from '@state/lockStore';
import { useRcsHealthStore } from '@state/rcsHealthStore';
import { sessionAccessors, useSessionStore } from '@state/sessionStore';
import { useTransportHealthStore } from '@state/transportHealthStore';
import { useTypingStore } from '@state/typingStore';
import { isDevServer } from '@utils/isDev';
import { accountRevocationMarker, candidateClient, http, vault } from './clients';
import {
  persistServerConnection,
  validateServerConnection,
  type ConnectResult,
} from './connection';
import { ensureSyncedBackgroundForRealtimeEvent } from './backgrounds/realtimeSyncedBackground';
import {
  recoverRealtimePrerequisite,
  type RealtimePrerequisiteRecoveryOutcome,
} from './background/realtimePrerequisiteRecovery';
import { adoptRealtimeHeadlessEffect } from './background/realtimeHeadlessEffects';
import { resolveAuthorizedLockedFcmV3Transport } from './background/authorizedRealtimeTransport';
import { ensureDatabase } from './databaseControl';
import { maybeResumeSync } from './syncControl';
import { autoDownloadMessageAttachmentsForRealtimeEvent } from './download/autoDownloadAttachments';
import { presentAutoDownloadOutcome } from './presentationAdapter';
import { createAttachmentCacheAccountScope } from './download/attachmentCacheAccountScope';
import { attachmentCacheCoordinator } from './download/attachmentCacheCoordinator';
import {
  probeReachabilityNow,
  startReachabilityWatch,
  stopReachabilityWatch,
} from './reachability';
import { startDeviceNetworkWatch, stopDeviceNetworkWatch } from './networkReachability';
import { buildMessageIntents } from './notifications/intents';
import { getNotificationPermissionState, postNotification } from './notifications/notifeeService';
import { effectivelyLocked } from './notifications/lockGate';
import { DbEventSink } from './realtime/dbEventSink';
import { expoDigestBackend } from './realtime/expoDigestBackend';
import { GroupEventSideEffectSink } from './realtime/groupEventSideEffectSink';
import { NotifyingEventSink } from './realtime/notifyingEventSink';
import { TypingEventSink } from './realtime/typingEventSink';
import { FaceTimeEventSink } from './realtime/faceTimeEventSink';
import { ServerUrlEventSink } from './realtime/serverUrlEventSink';
import { RcsAlertEventSink } from './realtime/rcsAlertEventSink';
import { RcsProviderEpochEventSink } from './realtime/rcsProviderEpochEventSink';
import { SocketService } from './realtime/socketService';
import { IncomingEventDrain } from './realtime/incomingEventDrain';
import { DurableRealtimeDispatcher } from './realtime/incomingEventDispatcher';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeDelivery,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import { serverRotationCoordinator } from './realtime/serverRotationCoordinator';
import {
  approveServerRotation,
  type ServerRotationApprovalResult,
} from './realtime/serverRotationExecutor';

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
let stopSocketLifecycleObservation: (() => void) | null = null;
// Guards the one-time, non-prompting notification-access check so a denied grant produces one
// recovery hint per process instead of a toast on every foreground reconnect.
let realtimeOneTimeSetupDone = false;

export interface RealtimeStartupIssue {
  readonly stage: 'notifications' | 'fcm';
  readonly level: 'degraded';
  readonly code: string;
  readonly userMessage: string;
}

interface StartRealtimeOptions {
  readonly reportIssue?: (issue: RealtimeStartupIssue) => void;
  /** Internal: let a foreground resume reuse its exact intent rather than superseding itself. */
  readonly foregroundIntentEpoch?: number;
  /** Internal: the caller already awaited the shared credential-upgrade operation. */
  readonly credentialRecoveryAlreadySettled?: boolean;
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
    stopSocketLifecycleObservation?.();
    stopSocketLifecycleObservation = null;
    resetRealtimeRuntime();
  }
}

/** A native disconnect may throw after SocketService has already revoked its callbacks/secrets. */
function retireForegroundSocket(): void {
  const retiring = socket;
  socket = null;
  try {
    retiring?.disconnect();
  } catch (error) {
    logger.warn('[socket] foreground retirement failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

interface RealtimeRecoveryJob {
  readonly key: string;
  readonly db: AppDatabase;
  readonly generation: number;
  readonly task: Promise<RealtimePrerequisiteRecoveryOutcome>;
  references: number;
  settled: boolean;
}

interface RealtimeRecoveryCollector {
  readonly db: AppDatabase;
  readonly generation: number;
  readonly owner: EventDeliveryContext;
  readonly jobs: Set<RealtimeRecoveryJob>;
  readonly dependencyJobs: Set<RealtimeRecoveryJob>;
  readonly dependencyDue: Promise<boolean>[];
  dependencyRequestsAwaitingDeferral: number;
  waitOnlyDependencyDeferred: boolean;
}

const pendingRealtimeRecoveries = new Map<AppDatabase, Map<string, RealtimeRecoveryJob>>();
const activeRealtimeRecoveryCollectors = new Set<RealtimeRecoveryCollector>();
const REALTIME_RECOVERY_RETRY_DRAIN_BUDGET_MS = 20_000;

function recoveryKey(
  recovery: Exclude<IncomingEventConflictRecovery, { readonly kind: 'none' }>,
  generation: number,
): string {
  return `${generation}:${
    recovery.kind === 'sync-chat' ? `chat:${recovery.chatGuid}` : recovery.kind
  }`;
}

function retireRealtimeRecoveryJob(job: RealtimeRecoveryJob): void {
  if (!job.settled || job.references !== 0) return;
  const jobs = pendingRealtimeRecoveries.get(job.db);
  if (jobs?.get(job.key) !== job) return;
  jobs.delete(job.key);
  if (jobs.size === 0) pendingRealtimeRecoveries.delete(job.db);
}

/**
 * Start task-local prerequisite recovery immediately. An active FCM delivery adopts the job into
 * its own native lifetime; foreground/socket delivery can rely on IncomingEventDrain's wake timer.
 */
function requestRealtimeRecovery(
  db: AppDatabase,
  recovery: IncomingEventConflictRecovery,
  context?: EventDeliveryContext,
  dependencyRetry = false,
): void {
  if (recovery.kind === 'none' || !context?.isCurrent()) return;
  const generation = context.generation;
  const key = recoveryKey(recovery, generation);
  let jobs = pendingRealtimeRecoveries.get(db);
  if (!jobs) {
    jobs = new Map<string, RealtimeRecoveryJob>();
    pendingRealtimeRecoveries.set(db, jobs);
  }

  let job = jobs.get(key);
  if (!job) {
    const accountLease = captureRealtimeDeliveryLease();
    if (
      accountLease.generation !== generation ||
      !accountLease.isCurrent() ||
      realtimeIntakeLocked()
    ) {
      return;
    }
    let created!: RealtimeRecoveryJob;
    const task = recoverRealtimePrerequisite(db, recovery, generation, {
      isAllowed: () => context.isCurrent() && accountLease.isCurrent() && !realtimeIntakeLocked(),
      subscribeInvalidation: (invalidate) => {
        const unsubscribeLock = useLockStore.subscribe((state) => {
          if (effectivelyLocked(state, false)) invalidate();
        });
        const abortFromCallback = (): void => invalidate();
        context.signal?.addEventListener('abort', abortFromCallback, { once: true });
        if (context.signal?.aborted) abortFromCallback();
        return () => {
          context.signal?.removeEventListener('abort', abortFromCallback);
          unsubscribeLock();
        };
      },
    })
      .catch((error: unknown): RealtimePrerequisiteRecoveryOutcome => {
        logger.warn('[incomingEvents] recovery task failed', {
          kind: recovery.kind,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        return 'unavailable';
      })
      .finally(() => {
        created.settled = true;
        retireRealtimeRecoveryJob(created);
      });
    created = {
      key,
      db,
      generation,
      task,
      references: 0,
      settled: false,
    };
    jobs.set(key, created);
    job = created;
  }

  for (const collector of activeRealtimeRecoveryCollectors) {
    if (collector.db !== db || collector.generation !== generation) continue;
    if (!collector.jobs.has(job)) {
      collector.jobs.add(job);
      job.references += 1;
    }
    if (dependencyRetry) {
      collector.dependencyJobs.add(job);
      collector.dependencyRequestsAwaitingDeferral += 1;
    }
  }
}

function beginRealtimeRecoveryCollector(
  db: AppDatabase,
  owner: EventDeliveryContext,
): RealtimeRecoveryCollector {
  const collector: RealtimeRecoveryCollector = {
    db,
    generation: owner.generation,
    owner,
    jobs: new Set(),
    dependencyJobs: new Set(),
    dependencyDue: [],
    dependencyRequestsAwaitingDeferral: 0,
    waitOnlyDependencyDeferred: false,
  };
  activeRealtimeRecoveryCollectors.add(collector);
  return collector;
}

function noteRealtimeDependencyDeferred(db: AppDatabase, context?: EventDeliveryContext): void {
  if (!context?.isCurrent()) return;
  for (const collector of activeRealtimeRecoveryCollectors) {
    if (collector.db !== db || collector.generation !== context.generation) continue;
    // Start from the actual DB settlement, not from the end of a possibly multi-row drain flight.
    collector.dependencyDue.push(waitForRealtimeDependencyRetry(collector.generation));
    if (collector.dependencyRequestsAwaitingDeferral > 0) {
      collector.dependencyRequestsAwaitingDeferral -= 1;
    } else {
      collector.waitOnlyDependencyDeferred = true;
    }
  }
}

/** Wait the repository's exact dependency backoff, cancelling immediately on account retirement. */
async function waitForRealtimeDependencyRetry(generation: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let releaseInvalidation = (): void => undefined;
    const finish = (current: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle != null) clearTimeout(timeoutHandle);
      releaseInvalidation();
      resolve(current);
    };
    releaseInvalidation = subscribeRealtimeGenerationInvalidation(generation, () => finish(false));
    if (settled) return;
    timeoutHandle = setTimeout(() => finish(true), INCOMING_EVENT_DEPENDENCY_RETRY_MS);
  });
}

async function resumeRecoveredRealtimeEvents(
  runtime: RealtimeRuntime,
  generation: number,
  callbackOwner: EventDeliveryContext,
): Promise<void> {
  const accountLease = captureRealtimeDeliveryLease();
  if (
    !callbackOwner.isCurrent() ||
    accountLease.generation !== generation ||
    !accountLease.isCurrent() ||
    realtimeRuntimeInstance !== runtime
  ) {
    return;
  }

  let ownsAttempt = true;
  let timedOut = false;
  let cancelled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let cancelAttempt!: () => void;
  const invalidation = new Promise<void>((resolve) => {
    cancelAttempt = () => {
      cancelled = true;
      ownsAttempt = false;
      resolve();
    };
  });
  const releaseInvalidation = subscribeRealtimeGenerationInvalidation(generation, cancelAttempt);
  const abortFromCallback = (): void => cancelAttempt();
  callbackOwner.signal?.addEventListener('abort', abortFromCallback, { once: true });
  if (callbackOwner.signal?.aborted) abortFromCallback();
  const retryContext: EventDeliveryContext = {
    generation,
    signal: callbackOwner.signal,
    isCurrent: () =>
      ownsAttempt &&
      callbackOwner.isCurrent() &&
      accountLease.isCurrent() &&
      realtimeRuntimeInstance === runtime,
  };
  const resume = runtime.dispatcher.resume(retryContext).catch((error: unknown) => {
    if (retryContext.isCurrent()) {
      logger.warn('[incomingEvents] recovered-event retry failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  });
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      ownsAttempt = false;
      resolve();
    }, REALTIME_RECOVERY_RETRY_DRAIN_BUDGET_MS);
  });

  try {
    await Promise.race([resume, timeout, invalidation]);
  } finally {
    ownsAttempt = false;
    if (timeoutHandle != null) clearTimeout(timeoutHandle);
    callbackOwner.signal?.removeEventListener('abort', abortFromCallback);
    releaseInvalidation();
  }
  if (timedOut && !cancelled && accountLease.isCurrent()) {
    logger.warn('[incomingEvents] recovered-event retry exceeded its headless budget');
  }
}

async function finishRealtimeRecoveryCollector(
  collector: RealtimeRecoveryCollector,
  runtime: RealtimeRuntime,
): Promise<void> {
  // Stop accepting new jobs before the retry. A retry of the same FIFO head reuses the retained
  // settled job without recursively opening another recovery/retry loop.
  activeRealtimeRecoveryCollectors.delete(collector);
  const jobs = [...collector.jobs];
  try {
    // These clocks started at each successful DB deferral. Waiting here therefore produces
    // max(recovery completion, actual defer+5s), not recovery duration plus another five seconds.
    const dependencyDue =
      collector.dependencyDue.length > 0
        ? Promise.all(collector.dependencyDue).then((current) => current.every(Boolean))
        : Promise.resolve(false);
    const [entries, retryIsCurrent] = await Promise.all([
      Promise.all(jobs.map(async (job) => [job, await job.task] as const)),
      dependencyDue,
    ]);
    const outcomes = new Map<RealtimeRecoveryJob, RealtimePrerequisiteRecoveryOutcome>(entries);
    const recoveredDependency =
      collector.waitOnlyDependencyDeferred ||
      [...collector.dependencyJobs].some((job) => outcomes.get(job) === 'recovered');
    if (!recoveredDependency || !retryIsCurrent || !collector.owner.isCurrent()) return;
    await resumeRecoveredRealtimeEvents(runtime, collector.generation, collector.owner);
  } finally {
    for (const job of jobs) {
      job.references -= 1;
      retireRealtimeRecoveryJob(job);
    }
  }
}

function realtimeIntakeLocked(): boolean {
  return effectivelyLocked(useLockStore.getState(), false);
}

/** Reject locked intake and keep every credential-bearing URL rotation out of SQLite. */
function canPersistRealtimeEvent(event: NormalizedEvent): boolean {
  if (realtimeIntakeLocked()) {
    logger.debug('[realtime] ignored private event while App Lock is active', {
      event: event.type,
    });
    return false;
  }
  if (classifyRcsEventAdmission(sessionAccessors.getServerInfo(), event) === 'stale') return false;
  if (event.type !== 'new-server') return true;
  logger.warn('[realtime] kept new-server event out of durable persistence');
  return false;
}

// One realtime sink, shared by the socket and the dev/FCM transports so behavior is
// identical regardless of how the event arrived. Outer layer routes ephemeral typing
// events to UI state; inner layer writes the DB (source of truth) then notifies.
let realtimeSinkInstance: EventSink | null = null;
function realtimeSink(db: AppDatabase, accountGeneration: number): EventSink {
  realtimeSinkInstance ??= new RcsProviderEpochEventSink(
    new ServerUrlEventSink(
      new RcsAlertEventSink(
        new FaceTimeEventSink(
          new TypingEventSink(
            new GroupEventSideEffectSink(
              new NotifyingEventSink(
                new DbEventSink(
                  db,
                  async (messageId, source, context) => {
                    // The durable receipt itself can settle while a deliberately adopted download
                    // continues. Retain only the provider identity from that receipt, and latch its
                    // first revocation so an A -> B -> A re-pair cannot reopen native/network work.
                    let providerRevoked = false;
                    const providerIsCurrent = (): boolean => {
                      if (providerRevoked) return false;
                      const current = context?.isProviderCurrent?.() ?? true;
                      if (!current) providerRevoked = true;
                      return current;
                    };
                    if (source === 'fcm' && context) {
                      if (context.generation !== accountGeneration) return;
                      const adoption = adoptRealtimeHeadlessEffect(
                        accountGeneration,
                        `auto-download:${messageId}`,
                        async (lifetime) => {
                          const effectIsCurrent = (): boolean =>
                            lifetime.isCurrent() && !realtimeIntakeLocked() && providerIsCurrent();
                          if (!effectIsCurrent()) return;
                          const outcome = await autoDownloadMessageAttachmentsForRealtimeEvent(
                            db,
                            messageId,
                            accountGeneration,
                            {
                              isEffectCurrent: effectIsCurrent,
                              // expo-media-library exposes no abort signal. Keep a killed-process
                              // owner strictly bounded by persisting only the app-cache copy.
                              allowExternalMediaSave: false,
                            },
                          );
                          if (effectIsCurrent()) presentAutoDownloadOutcome(outcome);
                        },
                      );
                      if (adoption.status === 'adopted') {
                        await adoption.task;
                        return;
                      }
                      // A matching callback exists but has expired/revoked. Never escape its bound by
                      // capturing a fresh detached lease; a later foreground/manual path can fetch.
                      if (adoption.status === 'rejected') return;
                      // The collection can already have closed and disappeared before this late DB
                      // continuation reaches adoption. Recheck its originating callback authority
                      // before the ordinary detached fallback captures a fresh account lease.
                      if (!context.isCurrent()) return;
                    }
                    const lease = captureRealtimeDeliveryLease();
                    const effectIsCurrent = (): boolean =>
                      lease.isCurrent() &&
                      lease.generation === accountGeneration &&
                      providerIsCurrent();
                    if (!effectIsCurrent()) return;
                    const outcome = await autoDownloadMessageAttachmentsForRealtimeEvent(
                      db,
                      messageId,
                      accountGeneration,
                      { isEffectCurrent: effectIsCurrent },
                    );
                    if (effectIsCurrent()) presentAutoDownloadOutcome(outcome);
                  },
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
                      db,
                      chatGuid ? { kind: 'sync-chat', chatGuid } : { kind: 'sync-account' },
                      context,
                      true,
                    ),
                  () => sessionAccessors.getServerInfo(),
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
              // Wallpaper transfer outlives the durable-event attempt. The dedicated entry point
              // captures a fresh account lease and pins either the connected foreground transport or
              // the authorized durable tuple used by a killed-process FCM wake.
              (guid, accountGeneration) =>
                ensureSyncedBackgroundForRealtimeEvent(db, guid, accountGeneration),
              async (messageGuid, chatGuid) =>
                (await getChatGuidByMessageGuid(db, messageGuid)) === chatGuid,
            ),
            (chatGuid, display) => useTypingStore.getState().setTyping(chatGuid, display),
          ),
        ),
        (alertType) => useRcsHealthStore.getState().setAlert(alertType),
      ),
      (url, context) => applyNewServerUrl(url, context),
    ),
    () => sessionAccessors.getServerInfo(),
  );
  return realtimeSinkInstance;
}

// One normalizer/sink chain per account generation. Durable receipts, rather than EventRouter's
// legacy in-memory set, own cross-transport deduplication and process-death recovery.
let sharedRouterInstance: EventRouter | null = null;
function sharedRouter(db: AppDatabase, accountGeneration: number): EventRouter {
  sharedRouterInstance ??= new EventRouter(realtimeSink(db, accountGeneration));
  return sharedRouterInstance;
}

interface RealtimeRuntime {
  readonly db: AppDatabase;
  readonly generation: number;
  readonly dispatcher: DurableRealtimeDispatcher;
  unsubscribeInvalidation: () => void;
}

let realtimeRuntimeInstance: RealtimeRuntime | null = null;
// A headless bundle starts with neither desired nor active foreground work. Credential adoption may
// temporarily stop the transport while preserving `desired`; a real AppState/App Lock pause clears
// both so an older async recovery can never reopen the socket afterward.
let realtimeForegroundDesired = false;
let realtimeForegroundIntentEpoch = 0;
let realtimeForegroundActive = false;
let realtimeLifecycleEpoch = 0;
let fallbackOccurrenceSequence = 0;
let fallbackOccurrenceNamespace: string | null = null;

function getFallbackOccurrenceNamespace(): string {
  fallbackOccurrenceNamespace ??= Crypto.randomUUID();
  return fallbackOccurrenceNamespace;
}

function claimRealtimeForegroundIntent(): number {
  realtimeForegroundDesired = true;
  realtimeForegroundIntentEpoch += 1;
  return realtimeForegroundIntentEpoch;
}

function ownsRealtimeForegroundIntent(expectedEpoch: number): boolean {
  return realtimeForegroundDesired && realtimeForegroundIntentEpoch === expectedEpoch;
}

interface TransportHealthOwner {
  readonly accountLease: RealtimeDeliveryLease;
  readonly realtimeLifecycleEpoch: number;
  readonly transportGeneration: number;
}

function beginTransportHealthLifecycle(): number {
  try {
    return useTransportHealthStore.getState().beginLifecycle();
  } catch (error) {
    logger.warn('[transport] begin-state observer failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return useTransportHealthStore.getState().generation;
  }
}

function ownsTransportHealth(owner: TransportHealthOwner): boolean {
  return (
    realtimeForegroundActive &&
    owner.realtimeLifecycleEpoch === realtimeLifecycleEpoch &&
    owner.accountLease.isCurrent() &&
    !realtimeIntakeLocked() &&
    useTransportHealthStore.getState().generation === owner.transportGeneration
  );
}

function publishTransportHealth(
  owner: TransportHealthOwner,
  surface: 'socket' | 'server' | 'network',
  publish: () => void,
): boolean {
  if (!ownsTransportHealth(owner)) return false;
  try {
    publish();
    return ownsTransportHealth(owner);
  } catch (error) {
    logger.warn('[transport] state observer failed', {
      surface,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return false;
  }
}

function pauseTransportHealth(): void {
  try {
    useTransportHealthStore.getState().pause();
  } catch (error) {
    logger.warn('[transport] pause-state observer failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

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

  const router = sharedRouter(db, context.generation);
  const canDrainPrivateQueue = () => !realtimeIntakeLocked();
  const drain = new IncomingEventDrain(db, router, expoDigestBackend, {
    makeLeaseToken: () => Crypto.randomUUID(),
    canDrain: canDrainPrivateQueue,
    canScheduleWake: () => realtimeForegroundActive && canDrainPrivateQueue(),
    onDependencyDeferred: (deliveryContext) => noteRealtimeDependencyDeferred(db, deliveryContext),
    onPermanentFailure: (_eventName, deliveryContext) =>
      requestRealtimeRecovery(db, { kind: 'sync-account' }, deliveryContext),
  });
  const dispatcher = new DurableRealtimeDispatcher(db, expoDigestBackend, drain, {
    makeTransportOccurrenceId: (source) =>
      `${source}:${getFallbackOccurrenceNamespace()}:${++fallbackOccurrenceSequence}`,
    // `isDevServer()` safely handles runtimes (such as plain Node tests) where `__DEV__` does not
    // exist, and narrows the opt-in to the exact fixture session instead of every debug session.
    allowDevPersistWithoutDrain: isDevServer(),
    // This seam is callable only through persistAuthenticatedLockedFcmV3Event below, after the
    // FCM layer has authenticated the complete V3 identity and supplied a lock-bound context.
    allowLockedFcmV3PersistWithoutDrain: true,
    canPersist: canPersistRealtimeEvent,
    requestRecovery: (recovery, _reason, deliveryContext) =>
      requestRealtimeRecovery(db, recovery, deliveryContext),
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
  const runtime = getRealtimeRuntime(db, context);
  if (!runtime) return;
  const recoveryCollector = source === 'fcm' ? beginRealtimeRecoveryCollector(db, context) : null;
  try {
    await runtime.dispatcher.handle(eventName, rawData, source, context, occurrence, receivedAt);
  } finally {
    if (recoveryCollector) {
      await finishRealtimeRecoveryCollector(recoveryCollector, runtime);
    }
  }
}

/**
 * Persist one authenticated V3 push while App Lock is still effective, without claiming or
 * draining it. Opening SQLCipher here is a deliberately narrow exception: this path writes only
 * the canonical encrypted-at-rest queue envelope and performs no router, recovery, sync, or native
 * notification effect. Ordinary unlock/realtime startup later resumes the same durable queue.
 */
export async function persistAuthenticatedLockedFcmV3Event(
  eventName: string,
  rawData: unknown,
  context: EventDeliveryContext,
  occurrence: EventOccurrenceMetadata,
): Promise<'enqueued' | 'not-enqueued'> {
  if (
    !context.isCurrent() ||
    !occurrence.serverEventId?.startsWith('fcm3:') ||
    occurrence.authenticatedExpiresAt === undefined
  ) {
    return 'not-enqueued';
  }
  const captured = captureIncomingEvent(eventName, rawData);
  if (!captured || captured.eventName === 'new-server') return 'not-enqueued';
  const normalized = snapshotIncomingEvent(captured.eventName, captured.rawData);
  if (!normalized) return 'not-enqueued';
  const transport = await resolveAuthorizedLockedFcmV3Transport(context);
  if (!transport || !context.isCurrent() || !transport.lease.isCurrent()) return 'not-enqueued';
  const initialProviderAdmission = classifyRcsEventAdmission(undefined, normalized);
  let providerInfo: Awaited<ReturnType<typeof serverApi.serverInfo>> | undefined;
  if (initialProviderAdmission === 'unavailable') {
    try {
      providerInfo = await serverApi.serverInfo(transport.http, context.signal);
    } catch {
      return 'not-enqueued';
    }
    if (
      !context.isCurrent() ||
      !transport.lease.isCurrent() ||
      !admitsCurrentRcsEvent(providerInfo, normalized)
    ) {
      return 'not-enqueued';
    }
  }
  const capturedProviderEpoch = currentRcsProviderEpoch(providerInfo);
  const lockedAdmissionIsCurrent = (event: NormalizedEvent): boolean => {
    const eventNeedsProviderAuthority =
      classifyRcsEventAdmission(undefined, event) === 'unavailable';
    if (!eventNeedsProviderAuthority) {
      return context.isCurrent() && transport.lease.isCurrent();
    }
    const liveInfo = sessionAccessors.getServerInfo();
    const liveEpoch = currentRcsProviderEpoch(liveInfo);
    return (
      context.isCurrent() &&
      transport.lease.isCurrent() &&
      providerInfo != null &&
      (liveInfo == null || liveEpoch === capturedProviderEpoch) &&
      admitsCurrentRcsEvent(providerInfo, event)
    );
  };
  const capturedOccurrence: EventOccurrenceMetadata = {
    serverEventId: occurrence.serverEventId,
    transportOccurrenceId: occurrence.transportOccurrenceId,
    receivedAt: occurrence.receivedAt,
    authenticatedExpiresAt: occurrence.authenticatedExpiresAt,
  };
  const receivedAt = capturedOccurrence.receivedAt ?? Date.now();
  const db = await ensureDatabase();
  if (!lockedAdmissionIsCurrent(normalized)) return 'not-enqueued';
  const runtime = getRealtimeRuntime(db, context);
  const result = await runtime?.dispatcher.persistLockedFcmV3WithoutDrain(
    captured.eventName,
    captured.rawData,
    context,
    capturedOccurrence,
    receivedAt,
    lockedAdmissionIsCurrent,
  );
  return lockedAdmissionIsCurrent(normalized) && result?.status === 'enqueued'
    ? 'enqueued'
    : 'not-enqueued';
}

/**
 * Persist ordinary realtime events before effects. `new-server` is the deliberate ephemeral
 * exception: validate it and offer foreground approval without ever placing it in SQLite.
 */
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
        authenticatedExpiresAt: occurrence.authenticatedExpiresAt,
      }
    : undefined;
  const normalized = snapshotIncomingEvent(captured.eventName, captured.rawData);
  // Rotation consent is deliberately ephemeral: validate + offer it before opening SQLite, and
  // never put the candidate into the durable incoming-event queue. The coordinator binds the
  // dormant prompt to this account generation without holding teardown open while the user reads.
  if (normalized?.type === 'new-server') {
    if (source === 'fcm' && occurrence?.serverEventId?.startsWith('fcm3:')) {
      logger.warn('[incomingEvents] rejected V3 FCM server rotation');
      return;
    }
    await applyNewServerUrl(normalized.url, context);
    return;
  }
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

/** Connect the live socket and route its events into the DB. */
export async function startRealtime(options: StartRealtimeOptions = {}): Promise<void> {
  // Publish foreground intent before the first await. A background/App Lock pause during credential
  // recovery clears it synchronously and must win over this older startup.
  const foregroundIntentEpoch = options.foregroundIntentEpoch ?? claimRealtimeForegroundIntent();
  if (!ownsRealtimeForegroundIntent(foregroundIntentEpoch) || realtimeIntakeLocked()) return;
  if (!options.credentialRecoveryAlreadySettled) {
    // Recover credential adoption before opening a socket or scheduling ordinary FCM registration.
    // A resume joins an existing operation, so no newer foreground owner can pass this boundary
    // while credential custody is still changing.
    await import('./credentialUpgrade')
      .then((module) => module.resumeScopedCredentialUpgrade({ restartRealtime: false }))
      .then((outcome) => {
        if (outcome.kind === 'quarantined') {
          logger.warn('[credential-upgrade] realtime startup is using quarantined recovery state', {
            reason: outcome.reason,
          });
        }
      })
      .catch((error) => {
        logger.warn('[credential-upgrade] reconnect recovery failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      });
  }
  if (!ownsRealtimeForegroundIntent(foregroundIntentEpoch) || realtimeIntakeLocked()) return;
  realtimeForegroundActive = true;
  const lifecycleEpoch = ++realtimeLifecycleEpoch;
  const db = await ensureDatabase();
  // AppState can background/lock the app while the DB open is suspended. A stale startup must not
  // reconnect a socket after pauseRealtime already closed foreground intake.
  if (
    !realtimeForegroundActive ||
    !ownsRealtimeForegroundIntent(foregroundIntentEpoch) ||
    lifecycleEpoch !== realtimeLifecycleEpoch ||
    realtimeIntakeLocked()
  ) {
    return;
  }
  // Capture AFTER the async DB open: a Disconnect while it was opening must be observed here.
  // From this point through `connect` there is no await, so origin/password/headers are one
  // coherent identity rather than separate live reads from a possibly changing session.
  const transport = http.snapshotTransport();
  if (!transport.origin || !transport.password) return;
  const accountLease = captureRealtimeDeliveryLease();
  if (!accountLease.isCurrent()) return;
  const runtime = getRealtimeRuntime(db, accountLease);
  if (!runtime) return;
  socket?.disconnect();
  // Socket and FCM now enter the same durable dispatcher; SQLite receipts own dedup/replay.
  socket = new SocketService(dispatchRealtimeEvent);
  // Keep the socket on the same captured account identity as REST. The password is carried in the
  // Socket.IO auth payload; the matching Bearer header remains available to the handshake request.
  socket.connect(transport.origin, transport.password, {
    headers: { ...transport.headers },
  });
  // The durable-ingress constructor/connect sequence above is security-certified. Transport
  // presentation observes the opened socket afterward and owns its own generation fence.
  stopSocketLifecycleObservation?.();
  stopSocketLifecycleObservation = null;
  stopReachabilityWatch();
  stopDeviceNetworkWatch();
  const activeSocket = socket;
  const transportGeneration = beginTransportHealthLifecycle();
  const transportOwner: TransportHealthOwner = {
    accountLease,
    realtimeLifecycleEpoch: lifecycleEpoch,
    transportGeneration,
  };
  // A synchronous Zustand observer can pause, lock, or replace the account. The certified socket
  // open is synchronous, so pause retires it before any native callback can publish.
  if (!ownsTransportHealth(transportOwner)) return;
  const stopLifecycleObservation = activeSocket.observeLifecycle(({ phase, recovered }) => {
    const published = publishTransportHealth(transportOwner, 'socket', () => {
      useTransportHealthStore.getState().setSocketState(transportGeneration, phase);
    });
    if (published && phase === 'connected' && recovered) maybeResumeSync();
  });
  if (!ownsTransportHealth(transportOwner)) {
    stopLifecycleObservation();
    return;
  }
  stopSocketLifecycleObservation = stopLifecycleObservation;
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
  startReachabilityWatch((signal) => serverApi.ping(http, signal), {
    onStateChange: (state) => {
      publishTransportHealth(transportOwner, 'server', () => {
        useTransportHealthStore.getState().setServerState(transportGeneration, state);
      });
    },
    onRecovered: () => {
      if (ownsTransportHealth(transportOwner)) maybeResumeSync();
    },
  });
  startDeviceNetworkWatch((state) => {
    if (!ownsTransportHealth(transportOwner)) return;
    const previous = useTransportHealthStore.getState().network;
    const published = publishTransportHealth(transportOwner, 'network', () => {
      useTransportHealthStore.getState().setNetworkState(transportGeneration, state);
    });
    if (published && previous === 'offline' && state === 'online') probeReachabilityNow();
  });
  // ONE-TIME, READ ONLY: realtime startup must never surprise-launch Android's permission prompt.
  // Fresh setup explains the choice on /permissions, and Settings retains recovery for existing
  // installs. This check only surfaces the current state; it cannot change OS permission state.
  if (!realtimeOneTimeSetupDone) {
    realtimeOneTimeSetupDone = true;
    void getNotificationPermissionState()
      .then((permission) => {
        if (permission !== 'granted') {
          reportRealtimeStartupIssue(options, {
            stage: 'notifications',
            level: 'degraded',
            code:
              permission === 'not-determined'
                ? 'notification-permission-not-requested'
                : 'notification-permission-denied',
            userMessage:
              permission === 'not-determined'
                ? 'Notifications are off. Enable them during setup or in Settings.'
                : 'Notifications are disabled. Open Settings to enable them.',
          });
        }
      })
      .catch((error) => {
        logger.warn('[notify] notification permission check failed', error);
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
            userMessage: 'Push updates are unavailable. Check Live Updates in Settings.',
          });
        }
      })
      .catch((error) => {
        logger.warn('[fcm] foreground registration setup failed', error);
        reportRealtimeStartupIssue(options, {
          stage: 'fcm',
          level: 'degraded',
          code: 'fcm-registration-unavailable',
          userMessage: 'Push updates are unavailable. Check Live Updates in Settings.',
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
function pauseRealtimeTransport(): void {
  realtimeForegroundActive = false;
  realtimeLifecycleEpoch += 1;
  serverRotationCoordinator.cancel();
  pauseTransportHealth();
  stopReachabilityWatch();
  stopDeviceNetworkWatch();
  stopSocketLifecycleObservation?.();
  stopSocketLifecycleObservation = null;
  retireForegroundSocket();
}

/** A real background/App Lock pause revokes the foreground intent as well as its transport. */
export function pauseRealtime(): void {
  realtimeForegroundDesired = false;
  realtimeForegroundIntentEpoch += 1;
  pauseRealtimeTransport();
}

/** Credential adoption stops the old transport without impersonating an AppState background. */
export function pauseRealtimeForCredentialUpgrade(): void {
  pauseRealtimeTransport();
}

/**
 * On foreground: reconnect the socket if it isn't currently connected, and ALWAYS pull anything
 * missed while backgrounded over HTTP (fast + deterministic) instead of waiting on the socket
 * handshake or FCM. `maybeResumeSync` is coalesced/throttled, so a quick app-switch is cheap.
 */
async function resumeDesiredRealtime(
  foregroundIntentEpoch: number,
  options: { readonly credentialRecoveryAlreadySettled?: boolean } = {},
): Promise<void> {
  if (!ownsRealtimeForegroundIntent(foregroundIntentEpoch) || realtimeIntakeLocked()) return;
  if (!options.credentialRecoveryAlreadySettled) {
    await import('./credentialUpgrade')
      .then((module) => module.resumeScopedCredentialUpgrade({ restartRealtime: false }))
      .catch((error) => {
        logger.warn('[credential-upgrade] foreground recovery failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      });
  }
  // Credential recovery may deliberately pause the old transport while it owns the journal. Only
  // reopen it if no real background/App Lock pause revoked the foreground request in the meantime.
  if (!ownsRealtimeForegroundIntent(foregroundIntentEpoch) || realtimeIntakeLocked()) return;
  realtimeForegroundActive = true;
  const { origin, password } = useSessionStore.getState();
  if (!origin || !password) return;
  // Do not invalidate a healthy foreground owner's callbacks merely because another `active`
  // notification arrived (for example, after dismissing a system permission dialog). A genuine
  // restart enters startRealtime(), which advances the epoch and replaces every observer itself.
  if (!socket || !socket.connected) {
    await startRealtime({ foregroundIntentEpoch, credentialRecoveryAlreadySettled: true });
    if (!ownsRealtimeForegroundIntent(foregroundIntentEpoch) || realtimeIntakeLocked()) return;
  }
  if (
    !realtimeForegroundActive ||
    !ownsRealtimeForegroundIntent(foregroundIntentEpoch) ||
    realtimeIntakeLocked()
  ) {
    return;
  }
  // Even a healthy socket does not imply the prior process finished its durable queue.
  await runTrackedRealtimeDelivery(async (lease) => {
    if (!ownsRealtimeForegroundIntent(foregroundIntentEpoch) || realtimeIntakeLocked()) return;
    const db = await ensureDatabase();
    if (
      !lease.isCurrent() ||
      !ownsRealtimeForegroundIntent(foregroundIntentEpoch) ||
      realtimeIntakeLocked()
    ) {
      return;
    }
    await getRealtimeRuntime(db, lease)?.dispatcher.resume(lease);
  });
  if (!ownsRealtimeForegroundIntent(foregroundIntentEpoch) || realtimeIntakeLocked()) return;
  maybeResumeSync();
}

export async function resumeRealtime(): Promise<void> {
  const foregroundIntentEpoch = claimRealtimeForegroundIntent();
  await resumeDesiredRealtime(foregroundIntentEpoch);
}

/** Resume an internally-paused credential transition only while foreground intent still exists. */
export async function resumeRealtimeAfterCredentialUpgrade(): Promise<void> {
  await resumeDesiredRealtime(realtimeForegroundIntentEpoch, {
    credentialRecoveryAlreadySettled: true,
  });
}

/**
 * Validate and, only with live foreground authority, offer an untrusted `new-server` event.
 *
 * The event itself never persists and never contacts the candidate. Same-origin spellings are a
 * no-op; malformed input and HTTPS-to-HTTP downgrades are rejected. A foreign eligible origin gets
 * one process-memory-only prompt tied to the exact session epoch and realtime generation.
 */
export async function applyNewServerUrl(
  url: string,
  context?: EventDeliveryContext,
): Promise<void> {
  const session = useSessionStore.getState();
  const current = strictServerOrigin(session.origin);
  const lease = context ?? captureRealtimeDeliveryLease();
  const expectedEpoch = session.epoch;
  const isCurrentForegroundSession = (): boolean => {
    const latest = useSessionStore.getState();
    return (
      realtimeForegroundActive &&
      !realtimeIntakeLocked() &&
      lease.isCurrent() &&
      latest.status === 'connected' &&
      !!latest.password &&
      latest.epoch === expectedEpoch &&
      strictServerOrigin(latest.origin) === current
    );
  };
  let credentialUpgrade;
  try {
    credentialUpgrade = inspectCredentialUpgradeJournal(await vault.get('serverCredentialUpgrade'));
  } catch {
    logger.warn(
      '[realtime] server rotation blocked because credential-upgrade state is unavailable',
    );
    return;
  }
  if (!isCurrentForegroundSession()) return;
  if (credentialUpgrade.kind !== 'absent') {
    logger.warn('[realtime] server rotation blocked while credential adoption is unresolved');
    return;
  }
  const result = serverRotationCoordinator.offer(
    url,
    current,
    expectedEpoch,
    lease,
    isCurrentForegroundSession,
  );
  if (result === 'invalid') {
    logger.warn('[realtime] ignoring malformed new-server origin');
    return;
  }
  if (result === 'downgrade-rejected') {
    logger.warn('[realtime] rejected cleartext new-server downgrade');
  } else if (result === 'offered') {
    logger.info('[realtime] server change is awaiting foreground approval');
  }
}

function cancelledRotationResult(): ConnectResult {
  return {
    ok: false,
    kind: 'cancelled',
    message: 'Connection attempt was cancelled.',
  };
}

/** User-confirmed half of RT-01A; called only by the protected foreground prompt host. */
export async function approveNewServerUrl(
  requestId: number,
  enteredPassword: string,
  cleartextApproved: boolean,
): Promise<ServerRotationApprovalResult> {
  return approveServerRotation(requestId, enteredPassword, cleartextApproved, {
    coordinator: serverRotationCoordinator,
    getSession: () => {
      const { origin, password, epoch } = useSessionStore.getState();
      return { origin, password, epoch };
    },
    captureLease: captureRealtimeDeliveryLease,
    validateCandidate: (origin, password, isCurrent) => {
      const client = candidateClient(origin, password);
      return validateServerConnection({
        fetchServerInfo: () => serverApi.serverInfo(client),
        isAttemptCurrent: isCurrent,
      });
    },
    persistCandidate: async (origin, password, info, lease, isCurrent) => {
      let result: ConnectResult = cancelledRotationResult();
      const delivery = await runTrackedRealtimeWork(lease, async (activeLease) => {
        const commitCurrent = (): boolean => activeLease.isCurrent() && isCurrent();
        result = await persistServerConnection(origin, password, info, {
          vault,
          revocationMarker: accountRevocationMarker,
          isAttemptCurrent: commitCurrent,
        });
      });
      return delivery === 'paused' ? cancelledRotationResult() : result;
    },
    publishCandidate: (origin, info) => {
      socket?.disconnect();
      socket = null;
      useSessionStore.getState().rotateOrigin(origin, info);
    },
    reconnect: async (_lease, isCurrent) => {
      if (!isCurrent() || !realtimeForegroundActive || realtimeIntakeLocked()) return;
      await startRealtime();
      if (isCurrent()) maybeResumeSync();
    },
  });
}

/**
 * User-requested foreground retry. Replace only the live socket against its already-approved
 * transport, then immediately re-run the existing server probe. Authentication and the durable
 * realtime runtime are deliberately untouched.
 */
export function retryRealtimeConnection(): boolean {
  if (!realtimeForegroundActive || realtimeIntakeLocked()) return false;
  const session = useSessionStore.getState();
  const activeSocket = socket;
  const health = useTransportHealthStore.getState();
  if (
    session.status !== 'connected' ||
    !session.origin ||
    !session.password ||
    !activeSocket ||
    !health.active
  ) {
    return false;
  }

  const transportGeneration = health.generation;
  if (!activeSocket.retryConnection()) return false;
  if (
    !realtimeForegroundActive ||
    activeSocket !== socket ||
    realtimeIntakeLocked() ||
    useTransportHealthStore.getState().generation !== transportGeneration
  ) {
    return false;
  }

  try {
    // Clear the prior attempt's HTTP result so an online retry presents as connecting instead of
    // continuing to display stale offline/error state while the fresh probes are in flight.
    useTransportHealthStore.getState().retry(transportGeneration);
  } catch (error) {
    logger.warn('[transport] retry-state observer failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  probeReachabilityNow();
  return true;
}
