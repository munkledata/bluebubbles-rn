import {
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';

/** Stop the effect tail 40 seconds after receipt; RNFB's 60-second task retains cleanup margin. */
export const REALTIME_HEADLESS_EFFECT_WINDOW_MS = 40_000;
export const REALTIME_HEADLESS_EFFECT_CANCEL_GRACE_MS = 2_000;

export type RealtimeHeadlessEffectOutcome = 'completed' | 'deadline' | 'account-changed';

export type RealtimeHeadlessEffectLifetime = RealtimeDeliveryLease;

interface RealtimeHeadlessEffectCollectionOptions {
  /** Absolute callback deadline captured before the native FCM callback's first await. */
  readonly deadlineAt: number;
  readonly now?: () => number;
  readonly cancelGraceMs?: number;
  readonly scheduleTimeout?: (task: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  readonly subscribeInvalidation?: (generation: number, invalidate: () => void) => () => void;
}

export interface RealtimeHeadlessEffectCollection {
  /** Stop accepting effects, then run and await the queued set within its absolute effect window. */
  close(): Promise<RealtimeHeadlessEffectOutcome>;
}

export type RealtimeHeadlessEffectAdoption<T> =
  | { readonly status: 'adopted'; readonly task: Promise<T | undefined> }
  | { readonly status: 'rejected' }
  | { readonly status: 'absent' };

const activeCollections = new Set<HeadlessEffectCollection>();

interface QueuedHeadlessEffect {
  readonly factory: (lifetime: RealtimeHeadlessEffectLifetime) => Promise<unknown>;
  readonly task: Promise<unknown | undefined>;
  readonly resolve: (value: unknown | undefined) => void;
  readonly reject: (reason: unknown) => void;
  started: boolean;
  settled: boolean;
}

class HeadlessEffectCollection implements RealtimeHeadlessEffectCollection {
  private accepting = true;
  private current = true;
  private stopReason: Exclude<RealtimeHeadlessEffectOutcome, 'completed'> | null = null;
  private readonly effects = new Map<string, QueuedHeadlessEffect>();
  private readonly now: () => number;
  private readonly cancelGraceMs: number;
  private readonly scheduleTimeout: (
    task: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly cancelTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly stopped: Promise<Exclude<RealtimeHeadlessEffectOutcome, 'completed'>>;
  private resolveStopped!: (reason: Exclude<RealtimeHeadlessEffectOutcome, 'completed'>) => void;
  private releaseInvalidation: () => void = () => undefined;
  private closeTask: Promise<RealtimeHeadlessEffectOutcome> | null = null;

  constructor(
    private readonly owner: RealtimeDeliveryLease,
    private readonly options: RealtimeHeadlessEffectCollectionOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.cancelGraceMs = options.cancelGraceMs ?? REALTIME_HEADLESS_EFFECT_CANCEL_GRACE_MS;
    this.scheduleTimeout =
      options.scheduleTimeout ?? ((task, delayMs) => setTimeout(task, delayMs));
    this.cancelTimeout = options.cancelTimeout ?? clearTimeout;
    if (!Number.isFinite(options.deadlineAt) || options.deadlineAt < 0) {
      throw new RangeError('headless effect deadline must be a non-negative finite timestamp');
    }
    if (!Number.isSafeInteger(this.cancelGraceMs) || this.cancelGraceMs < 0) {
      throw new RangeError('headless effect cancellation grace must be a non-negative integer');
    }

    this.stopped = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
    activeCollections.add(this);
    const subscribe = options.subscribeInvalidation ?? subscribeRealtimeGenerationInvalidation;
    this.releaseInvalidation = subscribe(owner.generation, () => this.stop('account-changed'));
    if (!owner.isCurrent()) this.stop('account-changed');
  }

  get generation(): number {
    return this.owner.generation;
  }

  canAdopt(): boolean {
    return this.accepting && this.isCurrent();
  }

  adopt<T>(
    key: string,
    effect: (lifetime: RealtimeHeadlessEffectLifetime) => Promise<T>,
  ): Promise<T | undefined> | null {
    if (!this.canAdopt()) return null;
    const existing = this.effects.get(key);
    if (existing) return existing.task as Promise<T | undefined>;

    let resolve!: (value: unknown | undefined) => void;
    let reject!: (reason: unknown) => void;
    const task = new Promise<unknown | undefined>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    this.effects.set(key, {
      factory: effect,
      task,
      resolve,
      reject,
      started: false,
      settled: false,
    });
    return task as Promise<T | undefined>;
  }

  close(): Promise<RealtimeHeadlessEffectOutcome> {
    this.closeTask ??= this.closeOnce();
    return this.closeTask;
  }

  private isCurrent(): boolean {
    if (!this.current) return false;
    if (!this.owner.isCurrent()) {
      this.stop('account-changed');
      return false;
    }
    if (this.now() >= this.options.deadlineAt) {
      this.stop('deadline');
      return false;
    }
    return true;
  }

  private stop(reason: Exclude<RealtimeHeadlessEffectOutcome, 'completed'>): void {
    if (!this.current) return;
    this.current = false;
    this.stopReason = reason;
    this.settleUnstartedEffects();
    this.resolveStopped(reason);
  }

  private finish(): void {
    this.accepting = false;
    this.current = false;
    this.settleUnstartedEffects();
    activeCollections.delete(this);
    this.releaseInvalidation();
  }

  private settleUnstartedEffects(): void {
    for (const effect of this.effects.values()) {
      if (effect.started || effect.settled) continue;
      effect.settled = true;
      effect.resolve(undefined);
    }
  }

  private async runQueuedEffects(lifetime: RealtimeHeadlessEffectLifetime): Promise<void> {
    // Sequential execution prevents a multi-event durable drain from starting a burst of native
    // downloads at once. Duplicate message revisions share one keyed task inside this collection.
    for (const effect of this.effects.values()) {
      if (effect.settled) continue;
      if (!this.isCurrent()) {
        this.settleUnstartedEffects();
        return;
      }
      effect.started = true;
      try {
        const value = await effect.factory(lifetime);
        effect.settled = true;
        effect.resolve(value);
      } catch (error) {
        effect.settled = true;
        effect.reject(error);
      }
    }
  }

  private async closeOnce(): Promise<RealtimeHeadlessEffectOutcome> {
    this.accepting = false;
    activeCollections.delete(this);
    if (!this.isCurrent()) {
      const outcome = this.stopReason ?? 'account-changed';
      this.finish();
      return outcome;
    }
    if (this.effects.size === 0) {
      this.finish();
      return 'completed';
    }

    const lifetime: RealtimeHeadlessEffectLifetime = Object.freeze({
      generation: this.owner.generation,
      isCurrent: () => this.isCurrent(),
    });
    let deadlineHandle: ReturnType<typeof setTimeout> | null = null;
    const remainingMs = Math.max(0, this.options.deadlineAt - this.now());
    deadlineHandle = this.scheduleTimeout(() => this.stop('deadline'), remainingMs);
    const settled = this.runQueuedEffects(lifetime).then(() => 'completed' as const);

    let outcome: RealtimeHeadlessEffectOutcome;
    try {
      outcome = this.stopReason ?? (await Promise.race([settled, this.stopped]));
      if (outcome !== 'completed') {
        this.stop(outcome);
        if (this.cancelGraceMs > 0) {
          let graceHandle: ReturnType<typeof setTimeout> | null = null;
          const grace = new Promise<void>((resolve) => {
            graceHandle = this.scheduleTimeout(resolve, this.cancelGraceMs);
          });
          await Promise.race([settled, grace]);
          if (graceHandle != null) this.cancelTimeout(graceHandle);
        }
      }
      return outcome;
    } finally {
      if (deadlineHandle != null) this.cancelTimeout(deadlineHandle);
      this.finish();
    }
  }
}

/** Begin the collection before dispatching one background FCM delivery. */
export function beginRealtimeHeadlessEffectCollection(
  owner: RealtimeDeliveryLease,
  options: RealtimeHeadlessEffectCollectionOptions,
): RealtimeHeadlessEffectCollection {
  return new HeadlessEffectCollection(owner, options);
}

/**
 * Queue one already-committed FCM side effect under the active native callback, if there is one.
 * It starts only when dispatch/presentation closes the collection. Foreground FCM and socket
 * delivery have no collection and retain their detached behavior.
 */
export function adoptRealtimeHeadlessEffect<T>(
  generation: number,
  key: string,
  effect: (lifetime: RealtimeHeadlessEffectLifetime) => Promise<T>,
): RealtimeHeadlessEffectAdoption<T> {
  let owner: HeadlessEffectCollection | null = null;
  for (const collection of activeCollections) {
    if (collection.generation === generation) owner = collection;
  }
  if (!owner) return { status: 'absent' };
  const task = owner.adopt(key, effect);
  return task ? { status: 'adopted', task } : { status: 'rejected' };
}
