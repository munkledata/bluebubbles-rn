import {
  IncomingEventCodecError,
  type DigestBackend,
  type EventDeliveryContext,
  type EventSource,
  type NormalizedEvent,
  type NormalizedEventDeliveryResult,
  verifyAndParseIncomingEvent,
} from '@core/realtime';
import { logger } from '@core/secure';
import {
  INCOMING_EVENT_LEASE_MS,
  INCOMING_EVENT_MAX_CLAIM_BATCH,
  claimIncomingEvents,
  completeIncomingEvent,
  failIncomingEvent,
  getNextIncomingEventWakeAt,
  markIncomingEventDbAppliedWithinTransaction,
  poisonIncomingEvent,
  type ClaimedIncomingEvent,
  type IncomingEventClaimIdentity,
} from '@db/repositories';
import { DbCommitGuardRejectedError } from '@db/transaction';
import type { AppDatabase } from '@db/types';

export interface NormalizedIncomingEventHandler {
  handleNormalized(
    event: NormalizedEvent,
    source: EventSource,
    context?: EventDeliveryContext,
  ): Promise<NormalizedEventDeliveryResult>;
}

export interface IncomingEventDrainOptions {
  readonly now?: () => number;
  readonly makeLeaseToken: () => string;
  /** One flight is bounded; a yielded continuation handles any remaining due rows. */
  readonly maxEventsPerFlight?: number;
  readonly scheduleContinuation?: (task: () => void) => void;
  /** Dynamic security/lifecycle gate included in every claim, delivery, and completion guard. */
  readonly canDrain?: () => boolean;
  readonly canScheduleWake?: () => boolean;
  readonly scheduleWake?: (task: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelWake?: (handle: ReturnType<typeof setTimeout>) => void;
  readonly deliveryTimeoutMs?: number;
  readonly scheduleDeliveryTimeout?: (
    task: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly cancelDeliveryTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  readonly onPermanentFailure?: (
    eventName: string,
    context?: EventDeliveryContext,
  ) => void | Promise<void>;
}

type ClaimOutcome = 'settled' | 'stale';

export const INCOMING_EVENT_DELIVERY_TIMEOUT_MS = 90_000;

class IncomingEventDeliveryTimeoutError extends Error {
  constructor() {
    super('incoming event delivery exceeded its deadline');
    this.name = 'IncomingEventDeliveryTimeoutError';
  }
}

/**
 * Single-flight, claim-one durable incoming-event worker.
 *
 * Claiming one row at a time prevents a slow native notification from consuming another row's
 * 120-second lease before its turn. Each flight is bounded and yields before scheduling more work;
 * a killed headless process can stop at any point because every unfinished row remains durable.
 */
export class IncomingEventDrain {
  private flight: Promise<void> | null = null;
  private wakeRequested = false;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly maxEventsPerFlight: number;
  private readonly scheduleContinuation: (task: () => void) => void;
  private readonly deliveryTimeoutMs: number;

  constructor(
    private readonly db: AppDatabase,
    private readonly handler: NormalizedIncomingEventHandler,
    private readonly digest: DigestBackend,
    private readonly options: IncomingEventDrainOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.maxEventsPerFlight = Math.min(
      INCOMING_EVENT_MAX_CLAIM_BATCH,
      Math.max(1, options.maxEventsPerFlight ?? INCOMING_EVENT_MAX_CLAIM_BATCH),
    );
    this.scheduleContinuation = options.scheduleContinuation ?? ((task) => setTimeout(task, 0));
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? INCOMING_EVENT_DELIVERY_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.deliveryTimeoutMs) ||
      this.deliveryTimeoutMs < 1 ||
      this.deliveryTimeoutMs >= INCOMING_EVENT_LEASE_MS
    ) {
      throw new RangeError('deliveryTimeoutMs must be a positive integer shorter than the lease');
    }
  }

  /** Stop future/continued flights. An already-admitted flight still obeys its account guard. */
  dispose(): void {
    this.stopped = true;
    this.cancelWakeTimer();
  }

  /** Join the current account flight or start one synchronously. */
  kick(context?: EventDeliveryContext): Promise<void> {
    if (this.stopped || this.options.canDrain?.() === false || (context && !context.isCurrent())) {
      return Promise.resolve();
    }
    if (this.flight) {
      // Intake can commit immediately after the flight's final empty claim. Remember the wake so
      // that race cannot strand a newly-enqueued row until another app lifecycle event.
      this.wakeRequested = true;
      return this.flight;
    }
    this.cancelWakeTimer();
    this.wakeRequested = false;

    let reachedLimit = false;
    let currentFlight!: Promise<void>;
    currentFlight = this.drainFlight(context)
      .then((result) => {
        reachedLimit = result;
      })
      .finally(() => {
        if (this.flight !== currentFlight) return;
        this.flight = null;
        const continueImmediately = reachedLimit || this.wakeRequested;
        this.wakeRequested = false;
        if (
          !continueImmediately ||
          this.stopped ||
          this.options.canDrain?.() === false ||
          this.options.canScheduleWake?.() === false ||
          (context && !context.isCurrent())
        ) {
          return;
        }
        this.scheduleContinuation(() => {
          void this.kick(context).catch((error: unknown) => {
            logger.warn('[incomingEvents] continued drain failed', {
              errorName: error instanceof Error ? error.name : 'UnknownError',
            });
          });
        });
      });
    this.flight = currentFlight;
    return currentFlight;
  }

  private async drainFlight(context?: EventDeliveryContext): Promise<boolean> {
    // App Lock may engage while verification, the handler, or a DB transaction is awaiting. Once
    // observed closed, this flight remains revoked even if the app later unlocks; a fresh kick owns
    // the eventual retry instead of reviving an old native/DB continuation.
    let flightRevoked = false;
    const guard = (): boolean => {
      if (flightRevoked) return false;
      const allowed =
        !this.stopped && this.options.canDrain?.() !== false && (!context || context.isCurrent());
      if (!allowed) flightRevoked = true;
      return allowed;
    };
    for (let processed = 0; processed < this.maxEventsPerFlight; processed += 1) {
      if (!guard()) return false;
      let claims: ClaimedIncomingEvent[];
      try {
        claims = await claimIncomingEvents(
          this.db,
          { clock: this.now, limit: 1, leaseToken: this.options.makeLeaseToken() },
          guard,
        );
      } catch (error) {
        if (error instanceof DbCommitGuardRejectedError && !guard()) return false;
        throw error;
      }
      const claim = claims[0];
      if (!claim) {
        await this.armNextWake(context, guard);
        return false;
      }
      const outcome = await this.processClaim(claim, context, guard);
      if (outcome === 'stale') return false;
    }
    return true;
  }

  private async armNextWake(
    context: EventDeliveryContext | undefined,
    guard: () => boolean,
  ): Promise<void> {
    if (!guard() || this.options.canScheduleWake?.() === false) {
      return;
    }
    const now = this.now();
    const wakeAt = await getNextIncomingEventWakeAt(this.db, now);
    if (wakeAt == null || !guard() || this.options.canScheduleWake?.() === false) {
      return;
    }
    this.cancelWakeTimer();
    const schedule = this.options.scheduleWake ?? ((task, delayMs) => setTimeout(task, delayMs));
    this.wakeTimer = schedule(
      () => {
        this.wakeTimer = null;
        if (!guard() || this.options.canScheduleWake?.() === false) {
          return;
        }
        void this.kick(context).catch((error: unknown) => {
          logger.warn('[incomingEvents] scheduled drain failed', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
        });
      },
      Math.max(0, wakeAt - this.now()),
    );
  }

  private cancelWakeTimer(): void {
    if (this.wakeTimer == null) return;
    (this.options.cancelWake ?? clearTimeout)(this.wakeTimer);
    this.wakeTimer = null;
  }

  private async processClaim(
    claim: ClaimedIncomingEvent,
    context: EventDeliveryContext | undefined,
    guard: () => boolean,
  ): Promise<ClaimOutcome> {
    const identity = exactClaim(claim);
    let event: NormalizedEvent;
    try {
      event = await verifyAndParseIncomingEvent(claim, this.digest);
    } catch (error) {
      if (!guard()) return 'stale';
      if (isPermanentCodecFailure(error)) {
        const poisoned = await poisonIncomingEvent(
          this.db,
          { ...identity, errorCode: `codec-${error.code}` },
          guard,
          this.now,
        );
        if (poisoned) await this.reportPermanentFailure(claim.eventName, guard, context);
        return 'settled';
      }
      const failure = await failIncomingEvent(
        this.db,
        { ...identity, errorCode: 'codec-unavailable' },
        guard,
        this.now,
      );
      if (failure.status === 'poisoned') {
        await this.reportPermanentFailure(claim.eventName, guard, context);
      }
      return 'settled';
    }

    const delivery = durableContext(context, claim, this.now, guard);
    try {
      const result = await this.deliverWithDeadline(
        event,
        claim.source,
        delivery.context,
        delivery.revoke,
      );
      if (result === 'stale' || !guard()) {
        delivery.revoke();
        return 'stale';
      }
      const completed = await completeIncomingEvent(this.db, identity, guard, this.now);
      if (!completed) {
        logger.warn('[incomingEvents] completion lost its claim fence', {
          event: claim.eventName,
        });
      }
    } catch (error) {
      // A rejected/timed-out attempt must lose authority before its row is made retryable. Its
      // underlying promise may still settle later, but every guarded DB/native continuation now
      // observes a stale delivery instead of racing the next claim.
      delivery.revoke();
      if (!guard()) return 'stale';
      const failure = await failIncomingEvent(
        this.db,
        {
          ...identity,
          errorCode:
            error instanceof IncomingEventDeliveryTimeoutError
              ? 'delivery-timeout'
              : 'delivery-failed',
        },
        guard,
        this.now,
      );
      if (failure.status === 'poisoned') {
        await this.reportPermanentFailure(claim.eventName, guard, context);
      }
      logger.warn('[incomingEvents] claimed delivery failed', {
        event: claim.eventName,
        outcome: failure.status,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      // The checkpoint capability belongs only to this claimed attempt. Successful settlement must
      // revoke it too, so a detached continuation cannot join and roll back an unrelated owner.
      delivery.revoke();
    }
    return 'settled';
  }

  private async deliverWithDeadline(
    event: NormalizedEvent,
    source: EventSource,
    context: EventDeliveryContext,
    revoke: () => void,
  ): Promise<NormalizedEventDeliveryResult> {
    const schedule =
      this.options.scheduleDeliveryTimeout ?? ((task, delayMs) => setTimeout(task, delayMs));
    const cancel = this.options.cancelDeliveryTimeout ?? clearTimeout;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = schedule(() => {
        revoke();
        reject(new IncomingEventDeliveryTimeoutError());
      }, this.deliveryTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.handler.handleNormalized(event, source, context)),
        timeout,
      ]);
    } finally {
      if (timeoutHandle != null) cancel(timeoutHandle);
    }
  }

  private async reportPermanentFailure(
    eventName: string,
    isCurrent: () => boolean,
    context?: EventDeliveryContext,
  ): Promise<void> {
    if (!isCurrent()) return;
    const recoveryContext: EventDeliveryContext = {
      generation: context?.generation ?? 0,
      isCurrent,
    };
    try {
      await this.options.onPermanentFailure?.(eventName, recoveryContext);
    } catch (error) {
      logger.warn('[incomingEvents] permanent-failure recovery request failed', {
        event: eventName,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
}

function exactClaim(claim: ClaimedIncomingEvent): IncomingEventClaimIdentity {
  return {
    id: claim.id,
    leaseToken: claim.leaseToken,
    claimVersion: claim.claimVersion,
  };
}

function durableContext(
  context: EventDeliveryContext | undefined,
  claim: ClaimedIncomingEvent,
  now: () => number,
  guard: () => boolean,
): { readonly context: EventDeliveryContext; readonly revoke: () => void } {
  const identity = exactClaim(claim);
  let active = true;
  const attemptGuard = (): boolean => {
    if (!active) return false;
    if (!guard()) {
      active = false;
      return false;
    }
    return true;
  };
  return {
    context: {
      generation: context?.generation ?? 0,
      isCurrent: attemptGuard,
      durableEvent: {
        dbAppliedAt: claim.dbAppliedAt,
        markDbAppliedWithinTransaction: (transactionContext) =>
          markIncomingEventDbAppliedWithinTransaction(
            transactionContext,
            { ...identity, now: now() },
            attemptGuard,
          ),
      },
    },
    revoke: () => {
      active = false;
    },
  };
}

function isPermanentCodecFailure(error: unknown): error is IncomingEventCodecError {
  return error instanceof IncomingEventCodecError && error.code !== 'digest-failure';
}
