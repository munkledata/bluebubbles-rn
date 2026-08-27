import {
  CORE_BOOT_STAGES,
  OPTIONAL_BOOT_STAGES,
  initialBootState,
  transitionBoot,
  type BootFailure,
  type BootIssue,
  type BootStage,
  type BootState,
  type CoreBootStage,
} from './bootStateMachine';

export interface BootStageContext {
  readonly runId: number;
  /** Invalidation is advisory: adapters must also guard any post-await commit they own. */
  readonly signal: AbortSignal;
  /** Aborts on either whole-run invalidation or this stage's configured deadline. */
  readonly stageSignal: AbortSignal;
  /** Publish one allow-listed degraded/diagnostic issue for this exact run. */
  reportIssue(issue: BootIssue): void;
  /**
   * Register run-owned cleanup immediately after acquiring a resource or opening admission.
   * Cleanup runs once, in reverse order, on failure/invalidation; late registration runs at once.
   * The returned function unregisters cleanup after an adapter safely releases the resource itself.
   */
  registerDisposer(disposer: BootRunDisposer): () => void;
}

export type BootRunDisposer = () => void | Promise<void>;

export type BootSessionOutcome<TSession extends object> =
  { readonly kind: 'connected'; readonly session: TSession } | { readonly kind: 'setup' };

export interface BootStageAdapters<TSession extends object = Record<string, unknown>> {
  lock(context: BootStageContext): Promise<'unlocked' | 'locked'>;
  /** The returned value stays private to this run and is never copied into public BootState. */
  session(context: BootStageContext): Promise<BootSessionOutcome<TSession>>;
  database(context: BootStageContext, session: TSession): Promise<void>;
  settings(context: BootStageContext, session: TSession): Promise<void>;
  activate(context: BootStageContext, session: TSession): Promise<void>;
}

interface BootFailureClassificationBase {
  readonly code: string;
  /** Safe user copy only; the raw caught value never enters state. */
  readonly userMessage: string;
}

export type BootFailureClassification =
  | (BootFailureClassificationBase & {
      readonly kind: 'retryable';
      readonly failClosed: boolean;
    })
  | (BootFailureClassificationBase & { readonly kind: 'fatal'; readonly failClosed: true });

export interface BootCoordinatorOptions<TSession extends object = Record<string, unknown>> {
  readonly adapters: BootStageAdapters<TSession>;
  /** Runtime auth/session schema guard. TypeScript types alone disappear in production JS. */
  validateSession(value: unknown): value is TSession;
  classifyFailure(stage: CoreBootStage, error: unknown): BootFailureClassification;
  /** Optional hard deadline per core stage. Timeout aborts only that stage's adapter signal. */
  readonly stageTimeoutMs?: Partial<Record<CoreBootStage, number>>;
  /** Listener failures are isolated from boot; this hook must also be best-effort. */
  onListenerError?(error: unknown): void | Promise<void>;
  /** Disposer failures are isolated from the original boot outcome and receive no credentials. */
  onCleanupError?(error: unknown): void | Promise<void>;
}

export type BootCoordinatorListener = (state: BootState) => void | Promise<void>;

export interface BootCoordinator {
  getState(): BootState;
  subscribe(listener: BootCoordinatorListener): () => void;
  /** Concurrent calls during one active run receive this exact same Promise object. */
  start(): Promise<BootState>;
  /** Resume a locked run. The caller must pass the run id rendered by that lock screen. */
  unlock(runId: number): Promise<BootState>;
  /** Retry only the matching retryable failure. */
  retry(runId: number): Promise<BootState>;
  /** Retire one matching run synchronously and ignore all of its later settlements. */
  invalidate(runId: number): BootState;
  /** Report a safe optional/core issue under the reducer's run and stage rules. */
  reportIssue(runId: number, issue: BootIssue): BootState;
  /** Retire only the exact issue whose runtime remediation has been positively confirmed. */
  resolveIssue(runId: number, stage: BootStage, code: string): BootState;
}

export const BOOT_CLASSIFIER_FAILURE_CODE = 'boot-classifier-failed';
export const BOOT_CLASSIFIER_FAILURE_MESSAGE =
  'Gator could not finish starting safely. Restart the app and try again.';

/** Private operational detail for classifiers; public state receives only their allow-listed copy. */
export class BootStageTimeoutError extends Error {
  constructor(
    readonly stage: CoreBootStage,
    readonly timeoutMs: number,
  ) {
    super(`Boot stage ${stage} exceeded its ${timeoutMs}ms deadline.`);
    this.name = 'BootStageTimeoutError';
  }
}

type NormalizedStageOutcome = 'completed' | 'locked' | 'setup';
type StageSettlement =
  | { readonly kind: 'outcome'; readonly outcome: NormalizedStageOutcome }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'stopped' };

type RunSession<TSession extends object> =
  { readonly kind: 'empty' } | { readonly kind: 'connected'; readonly value: TSession };

interface ActiveBootRun<TSession extends object> {
  readonly runId: number;
  readonly controller: AbortController;
  readonly stopped: Promise<void>;
  readonly requestStop: () => void;
  readonly unlockRequested: Promise<void>;
  readonly requestUnlock: () => void;
  session: RunSession<TSession>;
  readonly disposers: Array<{ readonly token: symbol; readonly dispose: BootRunDisposer }>;
  cleanupPromise: Promise<void> | null;
  cleanupStarted: boolean;
  retired: boolean;
  terminalState?: BootState;
}

function deferredSignal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createRun<TSession extends object>(runId: number): ActiveBootRun<TSession> {
  const stopped = deferredSignal();
  const unlock = deferredSignal();
  return {
    runId,
    controller: new AbortController(),
    stopped: stopped.promise,
    requestStop: stopped.resolve,
    unlockRequested: unlock.promise,
    requestUnlock: unlock.resolve,
    session: { kind: 'empty' },
    disposers: [],
    cleanupPromise: null,
    cleanupStarted: false,
    retired: false,
  };
}

function fallbackFailure(stage: CoreBootStage): BootFailure {
  return {
    stage,
    kind: 'fatal',
    failClosed: true,
    code: BOOT_CLASSIFIER_FAILURE_CODE,
    userMessage: BOOT_CLASSIFIER_FAILURE_MESSAGE,
  };
}

const BOOT_STAGES = new Set<string>([...CORE_BOOT_STAGES, ...OPTIONAL_BOOT_STAGES]);

function normalizeIssue(value: unknown): BootIssue | null {
  try {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;
    const stage = candidate.stage;
    const level = candidate.level;
    const code = candidate.code;
    const userMessage = candidate.userMessage;
    if (
      typeof stage !== 'string' ||
      !BOOT_STAGES.has(stage) ||
      (level !== 'degraded' && level !== 'diagnostic') ||
      typeof code !== 'string' ||
      !code.trim() ||
      (userMessage !== undefined && (typeof userMessage !== 'string' || !userMessage.trim()))
    ) {
      return null;
    }
    const safeIssue: BootIssue = {
      stage: stage as BootStage,
      level,
      code,
      ...(userMessage === undefined ? {} : { userMessage }),
    };
    return safeIssue;
  } catch {
    return null;
  }
}

function normalizeClassification(stage: CoreBootStage, value: unknown): BootFailure | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind;
  const failClosed = candidate.failClosed;
  const code = candidate.code;
  const userMessage = candidate.userMessage;
  if (
    typeof code !== 'string' ||
    !code.trim() ||
    typeof userMessage !== 'string' ||
    !userMessage.trim()
  ) {
    return null;
  }
  if (kind === 'fatal' && failClosed === true) {
    return { stage, kind, failClosed, code, userMessage };
  }
  if (kind === 'retryable' && typeof failClosed === 'boolean') {
    return { stage, kind, failClosed, code, userMessage };
  }
  return null;
}

class BootAdapterContractError extends Error {
  constructor(stage: CoreBootStage) {
    super(`boot adapter returned an invalid ${stage} outcome`);
    this.name = 'BootAdapterContractError';
  }
}

class BootCoordinatorImpl<TSession extends object> implements BootCoordinator {
  private state: BootState = initialBootState();
  private readonly listeners = new Set<BootCoordinatorListener>();
  private readonly stageTimeoutMs: Partial<Record<CoreBootStage, number>>;
  private cleanupBarrier: Promise<void> = Promise.resolve();
  #activeRun: ActiveBootRun<TSession> | null = null;
  private inFlight: Promise<BootState> | null = null;

  constructor(private readonly options: BootCoordinatorOptions<TSession>) {
    this.stageTimeoutMs = { ...options.stageTimeoutMs };
    for (const stage of CORE_BOOT_STAGES) {
      const timeoutMs = this.stageTimeoutMs[stage];
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
        throw new RangeError(`Boot stage ${stage} timeout must be a positive safe integer.`);
      }
    }
  }

  getState(): BootState {
    return this.state;
  }

  subscribe(listener: BootCoordinatorListener): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  start(): Promise<BootState> {
    if (this.inFlight) return this.inFlight;
    const next = transitionBoot(this.state, { type: 'start' });
    if (next === this.state || next.status !== 'loading') return Promise.resolve(this.state);
    return this.launch(next);
  }

  unlock(runId: number): Promise<BootState> {
    if (
      this.state.status !== 'locked' ||
      this.state.runId !== runId ||
      !this.#activeRun ||
      this.#activeRun.runId !== runId ||
      !this.inFlight
    ) {
      return Promise.resolve(this.state);
    }
    this.#activeRun.requestUnlock();
    return this.inFlight;
  }

  retry(runId: number): Promise<BootState> {
    if (this.state.runId !== runId || this.state.status !== 'failed') {
      return this.inFlight ?? Promise.resolve(this.state);
    }
    const next = transitionBoot(this.state, { type: 'retry', runId });
    if (next === this.state || next.status !== 'loading') {
      return this.inFlight ?? Promise.resolve(this.state);
    }
    return this.launch(next);
  }

  invalidate(runId: number): BootState {
    if (this.state.runId !== runId) return this.state;
    const next = transitionBoot(this.state, { type: 'invalidate', runId });
    if (next === this.state) return this.state;

    const retired = this.#activeRun?.runId === runId ? this.#activeRun : null;
    if (retired) {
      // Linearize ownership first. Abort listeners may reject synchronously/microtask-fast, but by
      // then both state and run identity already say this work is retired.
      retired.retired = true;
      retired.terminalState = next;
      retired.session = { kind: 'empty' };
    }
    this.state = next;
    if (this.#activeRun === retired) this.#activeRun = null;
    this.inFlight = null;
    retired?.requestStop();
    retired?.controller.abort();
    if (retired) this.enqueueCleanup(retired);
    this.notify(next);
    return this.state;
  }

  reportIssue(runId: number, issue: BootIssue): BootState {
    const safeIssue = normalizeIssue(issue);
    return safeIssue
      ? this.publish(transitionBoot(this.state, { type: 'issue', runId, issue: safeIssue }))
      : this.state;
  }

  resolveIssue(runId: number, stage: BootStage, code: string): BootState {
    if (!BOOT_STAGES.has(stage) || typeof code !== 'string' || !code.trim()) return this.state;
    return this.publish(transitionBoot(this.state, { type: 'issue-resolved', runId, stage, code }));
  }

  /**
   * Publish Promise ownership before state listeners run. A listener that re-enters `start()` must
   * see and receive this run, never create a sibling before the first adapter even starts.
   */
  private launch(next: Extract<BootState, { status: 'loading' }>): Promise<BootState> {
    const previous = this.#activeRun;
    if (previous) {
      previous.retired = true;
      previous.terminalState ??= this.state;
      previous.session = { kind: 'empty' };
    }

    const run = createRun<TSession>(next.runId);
    const cleanupBarrier = this.cleanupBarrier;
    const pending = Promise.resolve().then(async () => {
      await cleanupBarrier;
      return this.ownsRun(run) ? this.drive(run) : this.stoppedState(run);
    });
    let tracked!: Promise<BootState>;
    tracked = pending.then(
      (result) => {
        this.releaseOwnedPromise(tracked);
        return result;
      },
      () => {
        // `drive` contains every adapter/classifier/listener failure. This is a final defensive
        // boundary for a coordinator bug, and still must not create an unhandled boot rejection.
        const result = this.failUnexpectedly(run);
        this.releaseOwnedPromise(tracked);
        return result;
      },
    );
    this.#activeRun = run;
    this.inFlight = tracked;
    this.publish(next);
    // AbortSignal listeners run synchronously. Install the successor first so an old adapter that
    // re-enters start/retry from its abort callback receives this canonical run and Promise.
    previous?.requestStop();
    previous?.controller.abort();
    return tracked;
  }

  private releaseOwnedPromise(promise: Promise<BootState>): void {
    if (this.inFlight === promise) this.inFlight = null;
  }

  private ownsRun(run: ActiveBootRun<TSession>): boolean {
    return (
      !run.retired &&
      !run.controller.signal.aborted &&
      this.#activeRun === run &&
      this.state.runId === run.runId
    );
  }

  private ownsStage(run: ActiveBootRun<TSession>, stage: CoreBootStage): boolean {
    return this.ownsRun(run) && this.state.status === 'loading' && this.state.stage === stage;
  }

  private stoppedState(run: ActiveBootRun<TSession>): BootState {
    return run.terminalState ?? this.state;
  }

  private async drive(run: ActiveBootRun<TSession>): Promise<BootState> {
    while (this.ownsRun(run)) {
      if (this.state.status !== 'loading') return this.state;
      const stage = this.state.stage;
      const settlement = await this.settleStage(run, stage);
      if (settlement.kind === 'stopped' || !this.ownsStage(run, stage)) {
        return this.stoppedState(run);
      }

      if (settlement.kind === 'error') {
        // Release the run-owned credential before any injected classifier executes. The
        // classifier receives only stage+error and must never inspect a live session through this
        // coordinator while deciding which safe public copy to return.
        run.session = { kind: 'empty' };
        const failure =
          settlement.error instanceof BootAdapterContractError
            ? fallbackFailure(stage)
            : this.classify(stage, settlement.error);
        await this.cleanupRun(run);
        if (!this.ownsStage(run, stage)) return this.stoppedState(run);
        const failed = this.publish(
          transitionBoot(this.state, { type: 'failed', runId: run.runId, failure }),
        );
        return this.ownsRun(run) ? failed : this.stoppedState(run);
      }

      if (settlement.outcome === 'locked') {
        const locked = this.publish(
          transitionBoot(this.state, { type: 'lock-required', runId: run.runId }),
        );
        if (locked.status !== 'locked' || !this.ownsRun(run)) return this.stoppedState(run);

        const wake = await Promise.race([
          run.unlockRequested.then(() => 'unlock' as const),
          run.stopped.then(() => 'stopped' as const),
        ]);
        const resumedState = this.getState();
        if (wake === 'stopped' || !this.ownsRun(run) || resumedState.status !== 'locked') {
          return this.stoppedState(run);
        }
        this.publish(transitionBoot(this.state, { type: 'unlock-completed', runId: run.runId }));
        continue;
      }

      if (settlement.outcome === 'setup') {
        run.session = { kind: 'empty' };
        const setup = this.publish(
          transitionBoot(this.state, { type: 'setup-ready', runId: run.runId }),
        );
        return this.ownsRun(run) ? setup : this.stoppedState(run);
      }

      if (stage === 'activate') run.session = { kind: 'empty' };
      const advanced = this.publish(
        transitionBoot(this.state, { type: 'stage-completed', runId: run.runId, stage }),
      );
      if (!this.ownsRun(run)) return this.stoppedState(run);
      if (advanced.status === 'ready' || advanced.status === 'failed') return advanced;
    }
    return this.stoppedState(run);
  }

  private async settleStage(
    run: ActiveBootRun<TSession>,
    stage: CoreBootStage,
  ): Promise<StageSettlement> {
    const stageController = new AbortController();
    const abortStage = (): void => stageController.abort();
    if (run.controller.signal.aborted) abortStage();
    else run.controller.signal.addEventListener('abort', abortStage, { once: true });

    // Attach both branches before racing stop so an adapter that ignores AbortSignal and rejects
    // much later is still consumed rather than becoming an unhandled rejection.
    const operation = this.invokeStage(run, stage, stageController.signal).then<
      StageSettlement,
      StageSettlement
    >(
      (outcome) => ({ kind: 'outcome', outcome }),
      (error: unknown) => ({ kind: 'error', error }),
    );
    const settlements: Promise<StageSettlement>[] = [
      operation,
      run.stopped.then(() => ({ kind: 'stopped' as const })),
    ];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = this.stageTimeoutMs[stage];
    if (timeoutMs !== undefined) {
      settlements.push(
        new Promise<StageSettlement>((resolve) => {
          timeout = setTimeout(() => {
            // Resolve the canonical timeout first. An adapter may reject synchronously from its
            // abort listener; queueing this settlement first keeps classification deterministic.
            resolve({ kind: 'error', error: new BootStageTimeoutError(stage, timeoutMs) });
            stageController.abort();
          }, timeoutMs);
        }),
      );
    }

    try {
      return await Promise.race(settlements);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      run.controller.signal.removeEventListener('abort', abortStage);
    }
  }

  private async invokeStage(
    run: ActiveBootRun<TSession>,
    stage: CoreBootStage,
    signal: AbortSignal,
  ): Promise<NormalizedStageOutcome> {
    const context: BootStageContext = {
      runId: run.runId,
      signal: run.controller.signal,
      stageSignal: signal,
      reportIssue: (issue) => {
        this.reportIssue(run.runId, issue);
      },
      registerDisposer: (disposer) => this.registerDisposer(run, disposer),
    };
    switch (stage) {
      case 'lock': {
        const outcome = await this.options.adapters.lock(context);
        if (outcome === 'locked') return 'locked';
        if (outcome === 'unlocked') return 'completed';
        throw new BootAdapterContractError(stage);
      }
      case 'session': {
        const outcome = await this.options.adapters.session(context);
        // Invalidation can win while the session adapter is suspended. Do not even read a late
        // password-bearing result, let alone repopulate the retired run slot that invalidate just
        // cleared. The outer settlement ownership check will return the run's terminal state.
        if (!this.ownsStage(run, stage)) return 'completed';
        if (!outcome || typeof outcome !== 'object') {
          throw new BootAdapterContractError(stage);
        }
        const candidate = outcome as Record<string, unknown>;

        let kind: unknown;
        try {
          kind = candidate.kind;
        } catch {
          throw new BootAdapterContractError(stage);
        }
        // A getter/Proxy trap may synchronously invalidate or replace this run. In that case do
        // not inspect any later property, especially the password-bearing session value.
        if (!this.ownsStage(run, stage)) return 'completed';
        if (kind === 'setup') {
          run.session = { kind: 'empty' };
          return 'setup';
        }
        if (kind !== 'connected') throw new BootAdapterContractError(stage);

        let hasSession: boolean;
        try {
          hasSession = Object.prototype.hasOwnProperty.call(candidate, 'session');
        } catch {
          throw new BootAdapterContractError(stage);
        }
        if (!this.ownsStage(run, stage)) return 'completed';
        if (!hasSession) throw new BootAdapterContractError(stage);

        let session: unknown;
        try {
          session = candidate.session;
        } catch {
          throw new BootAdapterContractError(stage);
        }
        if (!this.ownsStage(run, stage)) return 'completed';

        let validatedSession: TSession | null = null;
        try {
          if (this.options.validateSession(session) === true) validatedSession = session;
        } catch {
          throw new BootAdapterContractError(stage);
        }
        // The injected validator may synchronously invalidate/re-enter. Check after it and
        // immediately before retaining the exact run-owned value.
        if (!this.ownsStage(run, stage)) return 'completed';
        if (!validatedSession) throw new BootAdapterContractError(stage);

        run.session = { kind: 'connected', value: validatedSession };
        return 'completed';
      }
      case 'database': {
        const session = this.requireSession(run, stage);
        await this.options.adapters.database(context, session);
        return 'completed';
      }
      case 'settings': {
        const session = this.requireSession(run, stage);
        await this.options.adapters.settings(context, session);
        return 'completed';
      }
      case 'activate': {
        const session = this.requireSession(run, stage);
        await this.options.adapters.activate(context, session);
        return 'completed';
      }
    }
  }

  private requireSession(run: ActiveBootRun<TSession>, stage: CoreBootStage): TSession {
    if (run.session.kind !== 'connected') throw new BootAdapterContractError(stage);
    return run.session.value;
  }

  private classify(stage: CoreBootStage, error: unknown): BootFailure {
    try {
      const classified = this.options.classifyFailure(stage, error);
      return normalizeClassification(stage, classified) ?? fallbackFailure(stage);
    } catch {
      return fallbackFailure(stage);
    }
  }

  private failUnexpectedly(run: ActiveBootRun<TSession>): BootState {
    if (!this.ownsRun(run) || this.state.status !== 'loading') return this.stoppedState(run);
    run.session = { kind: 'empty' };
    this.enqueueCleanup(run);
    const failure = fallbackFailure(this.state.stage);
    return this.publish(transitionBoot(this.state, { type: 'failed', runId: run.runId, failure }));
  }

  private publish(next: BootState): BootState {
    if (next === this.state) return this.state;
    this.state = next;
    this.notify(next);
    return this.state;
  }

  private notify(state: BootState): void {
    for (const listener of [...this.listeners]) {
      // A prior listener may have synchronously retried/invalidated and recursively emitted the
      // newer state. Never resume this older emission afterwards and paint stale UI over it.
      if (this.state !== state) break;
      try {
        const result = listener(state);
        if (result && typeof result.then === 'function') {
          void Promise.resolve(result).catch((error: unknown) => this.reportListenerError(error));
        }
      } catch (error) {
        this.reportListenerError(error);
      }
    }
  }

  private reportListenerError(error: unknown): void {
    try {
      const result = this.options.onListenerError?.(error);
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Observability is best-effort and must not become a second boot failure.
    }
  }

  private registerDisposer(run: ActiveBootRun<TSession>, disposer: BootRunDisposer): () => void {
    if (typeof disposer !== 'function') throw new TypeError('Boot disposer must be a function.');
    const token = Symbol('boot-disposer');
    if (run.retired || run.cleanupStarted) {
      this.invokeDisposer(disposer);
      return () => undefined;
    }
    run.disposers.push({ token, dispose: disposer });
    let registered = true;
    return () => {
      if (!registered || run.cleanupStarted) return;
      registered = false;
      const index = run.disposers.findIndex((entry) => entry.token === token);
      if (index >= 0) run.disposers.splice(index, 1);
    };
  }

  private cleanupRun(run: ActiveBootRun<TSession>): Promise<void> {
    if (run.cleanupPromise) return run.cleanupPromise;
    run.cleanupStarted = true;
    const disposers = run.disposers.splice(0).reverse();
    run.cleanupPromise = (async () => {
      for (const entry of disposers) {
        try {
          await entry.dispose();
        } catch (error) {
          this.reportCleanupError(error);
        }
      }
    })();
    return run.cleanupPromise;
  }

  private enqueueCleanup(run: ActiveBootRun<TSession>): void {
    const cleanup = this.cleanupRun(run);
    this.cleanupBarrier = Promise.all([this.cleanupBarrier, cleanup]).then(() => undefined);
  }

  private invokeDisposer(disposer: BootRunDisposer): void {
    try {
      const result = disposer();
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch((error: unknown) => this.reportCleanupError(error));
      }
    } catch (error) {
      this.reportCleanupError(error);
    }
  }

  private reportCleanupError(error: unknown): void {
    try {
      const result = this.options.onCleanupError?.(error);
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Cleanup observability is best-effort and must never poison the barrier.
    }
  }
}

export function createBootCoordinator<TSession extends object>(
  options: BootCoordinatorOptions<TSession>,
): BootCoordinator {
  return new BootCoordinatorImpl(options);
}
