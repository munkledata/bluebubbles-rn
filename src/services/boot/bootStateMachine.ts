/**
 * Pure foreground-boot lifecycle.
 *
 * This reducer owns core-gate order and stale-run rejection only. Optional stages are diagnostic
 * labels, not an ordered pipeline. It deliberately imports no React, React Native, Expo, Zustand,
 * database, network, or logging code; later adapters will translate real work into these events.
 * Keeping effects out makes every transition runnable in Node tests.
 */

export const CORE_BOOT_STAGES = ['lock', 'session', 'database', 'settings', 'activate'] as const;
export type CoreBootStage = (typeof CORE_BOOT_STAGES)[number];

export const OPTIONAL_BOOT_STAGES = [
  'shortcut-cleanup',
  'persistent-logs',
  'error-reporting',
  'device-integrity',
  'dev-self-tests',
  'background-task',
  'fcm',
  'notifications',
  'attachment-cache',
  'sync',
  'realtime',
] as const;
export type OptionalBootStage = (typeof OPTIONAL_BOOT_STAGES)[number];
export type BootStage = CoreBootStage | OptionalBootStage;

export interface BootIssue {
  readonly stage: BootStage;
  readonly level: 'degraded' | 'diagnostic';
  /** Stable, non-secret identifier suitable for deduplication and telemetry. */
  readonly code: string;
  /** Already-safe copy for later UI; never place a raw native/network error here. */
  readonly userMessage?: string;
}

interface BootFailureBase {
  readonly stage: CoreBootStage;
  readonly code: string;
  readonly userMessage: string;
}

/** `failClosed` is classification metadata for later adapters/UI; fatal boot failures must close. */
export type BootFailure =
  | (BootFailureBase & { readonly kind: 'retryable'; readonly failClosed: boolean })
  | (BootFailureBase & { readonly kind: 'fatal'; readonly failClosed: true });

interface BootStateBase {
  readonly runId: number;
  readonly issues: readonly BootIssue[];
}

export type BootState =
  | (BootStateBase & { readonly status: 'idle' })
  | (BootStateBase & { readonly status: 'loading'; readonly stage: CoreBootStage })
  | (BootStateBase & { readonly status: 'locked' })
  | (BootStateBase & {
      readonly status: 'ready';
      readonly mode: 'setup' | 'connected';
    })
  | (BootStateBase & { readonly status: 'failed'; readonly failure: BootFailure });

export type BootEvent =
  | { readonly type: 'start' }
  | { readonly type: 'stage-completed'; readonly runId: number; readonly stage: CoreBootStage }
  | { readonly type: 'lock-required'; readonly runId: number }
  | { readonly type: 'unlock-completed'; readonly runId: number }
  | { readonly type: 'setup-ready'; readonly runId: number }
  | { readonly type: 'issue'; readonly runId: number; readonly issue: BootIssue }
  | { readonly type: 'failed'; readonly runId: number; readonly failure: BootFailure }
  | { readonly type: 'retry'; readonly runId: number }
  | { readonly type: 'invalidate'; readonly runId: number };

const NEXT_CORE_STAGE = {
  lock: 'session',
  session: 'database',
  database: 'settings',
  settings: 'activate',
  activate: null,
} as const satisfies Record<CoreBootStage, CoreBootStage | null>;

export function initialBootState(): BootState {
  return { status: 'idle', runId: 0, issues: [] };
}

function loading(runId: number, stage: CoreBootStage, issues: readonly BootIssue[]): BootState {
  return { status: 'loading', runId, stage, issues };
}

function isCoreStage(stage: BootStage): stage is CoreBootStage {
  return (CORE_BOOT_STAGES as readonly BootStage[]).includes(stage);
}

function issueBelongsToState(state: BootState, issue: BootIssue): boolean {
  if (state.status === 'idle' || state.status === 'failed') return false;
  if (!isCoreStage(issue.stage)) return true;
  if (state.status === 'loading') return issue.stage === state.stage;
  return state.status === 'locked' && issue.stage === 'lock';
}

/**
 * Retain at most one issue per stage. A later degraded issue may replace a diagnostic one, but a
 * noisy stage cannot consume every slot or churn equal-priority messages on each callback.
 */
function retainIssue(state: BootState, issue: BootIssue): BootState {
  if (!issueBelongsToState(state, issue)) return state;
  const index = state.issues.findIndex((current) => current.stage === issue.stage);
  if (index < 0) return { ...state, issues: [...state.issues, issue] };

  const current = state.issues[index];
  if (!current) return state;
  const upgradesSeverity = current.level === 'diagnostic' && issue.level === 'degraded';
  const enrichesSameIssue =
    current.code === issue.code &&
    current.userMessage === undefined &&
    issue.userMessage !== undefined;
  if (!upgradesSeverity && !enrichesSameIssue) return state;

  const issues = [...state.issues];
  issues[index] = upgradesSeverity
    ? { ...issue, userMessage: issue.userMessage ?? current.userMessage }
    : { ...current, userMessage: issue.userMessage };
  return { ...state, issues };
}

/**
 * Apply one boot event. Every stale, duplicate, or out-of-order core event is an identity-stable
 * no-op. Never replace an active state with `initialBootState()` while its work can still settle;
 * dispatch `invalidate` first so the next `start` gets a non-reused run id.
 */
export function transitionBoot(state: BootState, event: BootEvent): BootState {
  if (event.type === 'start') {
    return state.status === 'idle' ? loading(state.runId + 1, 'lock', []) : state;
  }

  if (event.runId !== state.runId) return state;
  if (event.type === 'invalidate') {
    return state.status === 'idle' ? state : { status: 'idle', runId: state.runId, issues: [] };
  }
  if (event.type === 'issue') return retainIssue(state, event.issue);

  if (state.status === 'loading') {
    if (event.type === 'lock-required' && state.stage === 'lock') {
      return { status: 'locked', runId: state.runId, issues: state.issues };
    }
    if (event.type === 'setup-ready' && state.stage === 'session') {
      return { status: 'ready', runId: state.runId, mode: 'setup', issues: state.issues };
    }
    if (event.type === 'failed' && event.failure.stage === state.stage) {
      return {
        status: 'failed',
        runId: state.runId,
        failure: event.failure,
        issues: state.issues,
      };
    }
    if (event.type === 'stage-completed' && event.stage === state.stage) {
      const next = NEXT_CORE_STAGE[state.stage];
      return next
        ? loading(state.runId, next, state.issues)
        : { status: 'ready', runId: state.runId, mode: 'connected', issues: state.issues };
    }
    return state;
  }

  if (state.status === 'locked') {
    return event.type === 'unlock-completed'
      ? loading(state.runId, 'session', state.issues)
      : state;
  }

  if (state.status === 'failed') {
    return event.type === 'retry' && state.failure.kind === 'retryable'
      ? loading(state.runId + 1, 'lock', [])
      : state;
  }

  return state;
}
