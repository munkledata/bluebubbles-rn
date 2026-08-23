import { FCM_ENABLED } from '@core/realtime';
import { logger } from '@core/secure';
import { DB_DRIVER_CONTRACT_INTERNAL_FAILURE, runDbDriverSelfTest } from '@db/database';
import { checkDeviceIntegrity } from '@native/deviceIntegrity';
import { useLockStore } from '@state/lockStore';
import { registerBackgroundSync } from '../background/backgroundSync';
import {
  activateForegroundBootSession,
  ForegroundBootOperationalError,
  ForegroundBootSupersededError,
  hydrateForegroundBootSettings,
  inspectForegroundBootSession,
  isForegroundBootAttempt,
  openForegroundBootDatabase,
  type ForegroundBootAttempt,
} from '../bootstrap';
import { runCryptoSelfTest } from '../clients';
import { initErrorReporting } from '../errors';
import { InvalidAppLockSettingError, hydrateLock } from '../lock';
import { initPersistentLogs } from '../logging/fileLogSink';
import { startFcm } from '../notifications/fcmMessaging';
import { clearShareShortcuts } from '../shortcuts/shareShortcuts';
import {
  BootStageTimeoutError,
  createBootCoordinator,
  type BootFailureClassification,
  type BootStageContext,
} from './bootCoordinator';
import type { BootIssue, BootStage, BootState, CoreBootStage } from './bootStateMachine';
import {
  installForegroundBootInvalidator,
  installForegroundBootIssueReporter,
  installForegroundBootRestarter,
} from './foregroundBootInvalidation';
import { startDevDbRelaunchContractIfRequested } from './devDbRelaunchContract';

const LOCK_TIMEOUT_MS = 10_000;
const SESSION_TIMEOUT_MS = 10_000;
const DATABASE_TIMEOUT_MS = 30_000;
const SETTINGS_TIMEOUT_MS = 15_000;
const ACTIVATE_TIMEOUT_MS = 60_000;

const RETRY_MESSAGES: Record<CoreBootStage, string> = {
  lock: 'Gator could not read the App Lock setting. Try again.',
  session: 'Gator could not safely read the saved connection. Try again.',
  database: 'Gator could not open your encrypted messages. Try again.',
  settings: 'Gator could not safely load privacy and sync settings. Try again.',
  activate: 'Gator could not finish restoring the saved connection. Try again.',
};

function classifyForegroundBootFailure(
  stage: CoreBootStage,
  error: unknown,
): BootFailureClassification {
  if (error instanceof ForegroundBootSupersededError) {
    return {
      kind: 'retryable',
      failClosed: true,
      code: 'foreground-boot-superseded',
      userMessage: 'Startup was replaced by a newer account action.',
    };
  }
  if (error instanceof InvalidAppLockSettingError) {
    return {
      kind: 'fatal',
      failClosed: true,
      code: 'invalid-app-lock-setting',
      userMessage:
        'Gator found an invalid App Lock setting. Reinstall or clear app data to continue.',
    };
  }
  if (error instanceof ForegroundBootOperationalError) {
    return {
      kind: 'retryable',
      failClosed: true,
      code: error.code,
      userMessage: error.userMessage,
    };
  }
  if (error instanceof BootStageTimeoutError && stage === 'database') {
    // `ensureDatabase` deliberately retains a non-settling first open so a second SQLCipher
    // connection cannot race its migrations. Only a process restart can safely replace it.
    return {
      kind: 'fatal',
      failClosed: true,
      code: 'database-timeout',
      userMessage:
        'Gator could not finish opening your encrypted messages. Fully close and reopen Gator to try again.',
    };
  }
  if (error instanceof BootStageTimeoutError) {
    return {
      kind: 'retryable',
      failClosed: true,
      code: `${stage}-timeout`,
      userMessage: `${RETRY_MESSAGES[stage]} The startup step took too long.`,
    };
  }
  return {
    kind: 'retryable',
    failClosed: true,
    code: `${stage}-failed`,
    userMessage: RETRY_MESSAGES[stage],
  };
}

async function lockStage(context: BootStageContext): Promise<'locked' | 'unlocked'> {
  await hydrateLock({ shouldCommit: () => !context.stageSignal.aborted });
  if (context.stageSignal.aborted) throw new ForegroundBootSupersededError();
  return useLockStore.getState().locked ? 'locked' : 'unlocked';
}

const coordinator = createBootCoordinator<ForegroundBootAttempt>({
  adapters: {
    lock: lockStage,
    session: inspectForegroundBootSession,
    database: openForegroundBootDatabase,
    settings: hydrateForegroundBootSettings,
    activate: activateForegroundBootSession,
  },
  validateSession: isForegroundBootAttempt,
  classifyFailure: classifyForegroundBootFailure,
  stageTimeoutMs: {
    lock: LOCK_TIMEOUT_MS,
    session: SESSION_TIMEOUT_MS,
    database: DATABASE_TIMEOUT_MS,
    settings: SETTINGS_TIMEOUT_MS,
    activate: ACTIVATE_TIMEOUT_MS,
  },
  onListenerError: (error) => logger.warn('[boot] foreground state listener failed', error),
  onCleanupError: (error) => logger.warn('[boot] foreground cleanup failed', error),
});

coordinator.subscribe((state) => {
  if (state.status === 'failed' && state.failure.code === 'foreground-boot-superseded') {
    coordinator.invalidate(state.runId);
    void startForegroundBoot();
  }
});

installForegroundBootInvalidator(() => {
  const state = coordinator.getState();
  if (state.status !== 'idle') coordinator.invalidate(state.runId);
});
installForegroundBootRestarter(() => {
  void startForegroundBoot();
});
installForegroundBootIssueReporter((issue) => {
  const state = coordinator.getState();
  if (state.status !== 'idle' && state.status !== 'failed') {
    coordinator.reportIssue(state.runId, issue);
  }
});

let processWorkStarted = false;
const processIssues = new Map<BootStage, BootIssue>();

function replayProcessIssues(): void {
  const state = coordinator.getState();
  if (state.status === 'idle' || state.status === 'failed') return;
  for (const issue of processIssues.values()) coordinator.reportIssue(state.runId, issue);
}

function reportOptionalFailure(
  stage: BootStage,
  code: string,
  userMessage: string | undefined,
  error?: unknown,
): void {
  if (error !== undefined) logger.warn(`[boot] optional ${stage} setup failed`, error);
  const issue: BootIssue = {
    stage,
    level: userMessage ? 'degraded' : 'diagnostic',
    code,
    ...(userMessage ? { userMessage } : {}),
  };
  const previous = processIssues.get(stage);
  if (!previous || (previous.level === 'diagnostic' && issue.level === 'degraded')) {
    processIssues.set(stage, issue);
  }
  // Process setup belongs to the process, not whichever boot generation happened to start it.
  // If that generation has already failed, start/retry replays this retained safe issue.
  replayProcessIssues();
}

function startProcessWork(): void {
  if (processWorkStarted) return;
  processWorkStarted = true;

  if (!clearShareShortcuts()) {
    reportOptionalFailure(
      'shortcut-cleanup',
      'legacy-shortcut-cleanup-unavailable',
      'Older Direct Share suggestions could not be cleared automatically.',
    );
  }
  try {
    initErrorReporting();
  } catch (error) {
    reportOptionalFailure('error-reporting', 'error-reporting-init-failed', undefined, error);
  }
  void initPersistentLogs().catch((error) =>
    reportOptionalFailure(
      'persistent-logs',
      'persistent-log-init-failed',
      'Older App Logs could not be removed safely. Open Settings → App Logs and tap Clear.',
      error,
    ),
  );
  void checkDeviceIntegrity().catch((error) =>
    reportOptionalFailure('device-integrity', 'device-integrity-check-failed', undefined, error),
  );
  void registerBackgroundSync()
    .then((result) => {
      if (result === 'registered') return;
      reportOptionalFailure(
        'background-task',
        result === 'unavailable'
          ? 'background-task-unavailable'
          : 'background-task-register-failed',
        'Background catch-up is unavailable; open Gator to refresh messages.',
      );
    })
    .catch((error) =>
      reportOptionalFailure(
        'background-task',
        'background-task-register-failed',
        'Background catch-up is unavailable; open Gator to refresh messages.',
        error,
      ),
    );
  if (FCM_ENABLED) {
    void startFcm()
      .then((result) => {
        if (result === 'failed') {
          reportOptionalFailure(
            'fcm',
            'foreground-fcm-start-failed',
            'Push updates are unavailable; live socket updates still work.',
          );
        }
      })
      .catch((error) =>
        reportOptionalFailure(
          'fcm',
          'foreground-fcm-start-failed',
          'Push updates are unavailable; live socket updates still work.',
          error,
        ),
      );
  }
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    void runCryptoSelfTest()
      .then((result) => logger.info('[crypto] self-test', result))
      .catch((error) =>
        reportOptionalFailure('dev-self-tests', 'crypto-self-test-failed', undefined, error),
      );
    void runDbDriverSelfTest().then(
      (result) => logger.info(`GATOR_DB_CONTRACT_V3 ${JSON.stringify(result)}`),
      () =>
        logger.info(`GATOR_DB_CONTRACT_V3 ${JSON.stringify(DB_DRIVER_CONTRACT_INTERNAL_FAILURE)}`),
    );
  }
}

/** Start the one process-owned foreground run and return the coordinator's exact shared Promise. */
export function startForegroundBoot(): Promise<BootState> {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    const relaunchContract = startDevDbRelaunchContractIfRequested();
    if (relaunchContract) return relaunchContract;
  }
  const run = coordinator.start();
  startProcessWork();
  replayProcessIssues();
  return run;
}

export function retryForegroundBoot(runId: number): Promise<BootState> {
  const run = coordinator.retry(runId);
  replayProcessIssues();
  return run;
}

export function unlockForegroundBoot(runId: number): Promise<BootState> {
  return coordinator.unlock(runId);
}

/** Retire only the exact foreground run whose UI authority was revoked. */
export function invalidateForegroundBootRun(runId: number): BootState {
  return coordinator.invalidate(runId);
}

export function getForegroundBootSnapshot(): BootState {
  return coordinator.getState();
}

export function subscribeForegroundBoot(listener: () => void): () => void {
  return coordinator.subscribe(() => listener());
}
