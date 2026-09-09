import { serverApi } from '@core/api';
import type { IncomingEventConflictRecovery } from '@core/realtime';
import type { AppDatabase } from '@db/types';
import { subscribeRealtimeGenerationInvalidation } from '../realtime/deliveryCoordinator';
import { runTrackedSync } from '../syncControl';
import {
  httpSyncApi,
  incrementalSync,
  syncAllChats,
  syncChatMessages,
  syncDeletedMessages,
  syncSingleChat,
} from '../sync';
import { resolveAuthorizedRealtimeTransport } from './authorizedRealtimeTransport';

export const REALTIME_PREREQUISITE_RECOVERY_BUDGET_MS = 20_000;
export const REALTIME_PREREQUISITE_CHAT_RECOVERY_BUDGET_MS = 8_000;
export const REALTIME_PREREQUISITE_ACCOUNT_MAX_PAGES = 4;
export const REALTIME_PREREQUISITE_DELETION_MAX_PAGES = 5;
export const REALTIME_PREREQUISITE_CHAT_MAX_MESSAGES = 500;

export type RealtimePrerequisiteRecoveryOutcome =
  'recovered' | 'unavailable' | 'stale' | 'timed-out';

export interface RealtimePrerequisiteRecoveryOptions {
  readonly budgetMs?: number;
  /** Live policy gate, including App Lock, checked before every request/write continuation. */
  readonly isAllowed?: () => boolean;
  /** Optional policy subscription used to abort an in-flight native request immediately. */
  readonly subscribeInvalidation?: (invalidate: () => void) => () => void;
  readonly scheduleTimeout?: (task: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Repair one durable incoming-event prerequisite without consulting foreground session state.
 *
 * The complete authorization/network/write path is serialized with other sync owners and bounded
 * below RNFB's 60-second native headless-task timeout. Every engine write receives the exact
 * task-local transport lease as a commit guard; the outer abort also stops an HTTP retry wait.
 */
export async function recoverRealtimePrerequisite(
  db: AppDatabase,
  recovery: IncomingEventConflictRecovery,
  expectedAccountGeneration: number,
  options: RealtimePrerequisiteRecoveryOptions = {},
): Promise<RealtimePrerequisiteRecoveryOutcome> {
  if (recovery.kind === 'none') return 'unavailable';
  // A read-status receipt expires after 15 seconds because it carries no server boundary. Leave
  // enough of that window for its exact five-second dependency retry; account/deletion repair has
  // a longer-lived receipt and may use more of RNFB's native headless-task budget.
  const budgetMs =
    options.budgetMs ??
    (recovery.kind === 'sync-chat'
      ? REALTIME_PREREQUISITE_CHAT_RECOVERY_BUDGET_MS
      : REALTIME_PREREQUISITE_RECOVERY_BUDGET_MS);
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) {
    throw new RangeError('Realtime prerequisite recovery budget must be a positive integer.');
  }

  const controller = new AbortController();
  const schedule = options.scheduleTimeout ?? ((task, delayMs) => setTimeout(task, delayMs));
  const cancel = options.cancelTimeout ?? clearTimeout;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let outcome: RealtimePrerequisiteRecoveryOutcome = 'unavailable';
  let invalidated = false;
  let resolveInvalidation!: (outcome: RealtimePrerequisiteRecoveryOutcome) => void;
  const invalidation = new Promise<RealtimePrerequisiteRecoveryOutcome>((resolve) => {
    resolveInvalidation = resolve;
  });
  const invalidate = (): void => {
    if (invalidated) return;
    invalidated = true;
    controller.abort();
    resolveInvalidation('stale');
  };
  // Register both revocation paths before the first await or network task publication.
  const releaseGenerationInvalidation = subscribeRealtimeGenerationInvalidation(
    expectedAccountGeneration,
    invalidate,
  );
  const releasePolicyInvalidation =
    options.subscribeInvalidation?.(invalidate) ?? (() => undefined);
  const policyAllows = (): boolean => options.isAllowed?.() ?? true;

  if (invalidated || !policyAllows()) {
    invalidate();
    releasePolicyInvalidation();
    releaseGenerationInvalidation();
    return 'stale';
  }

  const operation = runTrackedSync(async () => {
    if (controller.signal.aborted || !policyAllows()) {
      outcome = 'stale';
      return;
    }
    const transport = await resolveAuthorizedRealtimeTransport(expectedAccountGeneration);
    if (!transport) return;
    const stopped = (): boolean =>
      controller.signal.aborted || !policyAllows() || !transport.lease.isCurrent();
    if (stopped()) {
      outcome = 'stale';
      return;
    }

    const api = httpSyncApi(transport.http);
    if (recovery.kind === 'sync-chat') {
      const refreshed = await syncSingleChat(db, api, recovery.chatGuid, {
        shouldAbort: stopped,
        signal: controller.signal,
      });
      if (!refreshed || stopped()) {
        outcome = stopped() ? 'stale' : 'unavailable';
        return;
      }
      await syncChatMessages(db, api, recovery.chatGuid, {
        maxMessages: REALTIME_PREREQUISITE_CHAT_MAX_MESSAGES,
        shouldAbort: stopped,
        signal: controller.signal,
      });
    } else {
      const info = await serverApi.serverInfo(transport.http, controller.signal);
      if (stopped()) {
        outcome = 'stale';
        return;
      }
      if (recovery.kind === 'sync-account') {
        await syncAllChats(db, api, 200, stopped, controller.signal);
        if (stopped()) {
          outcome = 'stale';
          return;
        }
        await incrementalSync(db, api, {
          serverVersion: info.server_version ?? '',
          maxPages: REALTIME_PREREQUISITE_ACCOUNT_MAX_PAGES,
          shouldAbort: stopped,
          signal: controller.signal,
        });
      }
      if (stopped()) {
        outcome = 'stale';
        return;
      }
      await syncDeletedMessages(db, api, {
        supported: info.supports_message_deleted === true,
        maxPages: REALTIME_PREREQUISITE_DELETION_MAX_PAGES,
        shouldAbort: stopped,
        signal: controller.signal,
      });
    }

    outcome = stopped() ? 'stale' : 'recovered';
  });

  const timeout = new Promise<RealtimePrerequisiteRecoveryOutcome>((resolve) => {
    timeoutHandle = schedule(() => {
      controller.abort();
      resolve('timed-out');
    }, budgetMs);
  });

  try {
    return await Promise.race([operation.then(() => outcome), timeout, invalidation]);
  } finally {
    if (timeoutHandle != null) cancel(timeoutHandle);
    releasePolicyInvalidation();
    releaseGenerationInvalidation();
  }
}
