import {
  IncomingEventCodecError,
  encodeIncomingEvent,
  snapshotIncomingEvent,
  type DigestBackend,
  type EventDeliveryContext,
  type EventOccurrenceMetadata,
  type EventSource,
  type IncomingEventConflictRecovery,
  type NormalizedEvent,
} from '@core/realtime';
import { logger } from '@core/secure';
import {
  enqueueAndClaimIncomingEventIfQueueEmpty,
  enqueueIncomingEvent,
  type ClaimedIncomingEvent,
  type EnqueueIncomingEventResult,
} from '@db/repositories';
import { DbCommitGuardRejectedError } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { IncomingEventDrain } from './incomingEventDrain';

export interface DurableRealtimeDispatcherOptions {
  readonly now?: () => number;
  readonly makeTransportOccurrenceId: (source: EventSource) => string;
  /** Explicit composition-root opt-in for the DEV process-death proof seam. Defaults closed. */
  readonly allowDevPersistWithoutDrain?: boolean;
  /** Security/feature eligibility that must reject before encrypted persistence. */
  readonly canPersist?: (event: NormalizedEvent) => boolean;
  readonly requestRecovery?: (
    recovery: IncomingEventConflictRecovery,
    reason: 'key-conflict' | 'intake-poisoned' | 'duplicate-poisoned' | 'truncated-payload',
    context?: EventDeliveryContext,
  ) => void | Promise<void>;
}

type Admission = {
  readonly event: NormalizedEvent;
  readonly source: EventSource;
  readonly context?: EventDeliveryContext;
  /** Same one-way security/account gate that owned persistence, retained through recovery. */
  readonly isCurrent: () => boolean;
  readonly result: EnqueueIncomingEventResult;
  readonly devClaim?: ClaimedIncomingEvent;
  readonly conflictRecovery: IncomingEventConflictRecovery;
  readonly identityQuality: 'exact' | 'content-revision' | 'best-effort';
};

export interface DevPersistedIncomingEvent {
  readonly event: NormalizedEvent;
  readonly queueId: number;
  readonly claim: ClaimedIncomingEvent;
}

/**
 * One durable-before-effect intake boundary shared by socket, unlocked FCM, and dev injection.
 *
 * Admission is reserved synchronously and encode->enqueue runs in that order. This matters because
 * SHA-256 is async: without the sequencer, callback 2 can insert first and SQLite ids would reverse
 * the local FIFO observed by the claim query.
 */
export class DurableRealtimeDispatcher {
  private intakeTail: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly now: () => number;

  constructor(
    private readonly db: AppDatabase,
    private readonly digest: DigestBackend,
    private readonly drain: IncomingEventDrain,
    private readonly options: DurableRealtimeDispatcherOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  dispose(): void {
    this.stopped = true;
    this.drain.dispose();
  }

  /** Kick persisted crash recovery without admitting a new transport event. */
  resume(context?: EventDeliveryContext): Promise<void> {
    if (this.stopped || (context && !context.isCurrent())) return Promise.resolve();
    return this.drain.kick(context);
  }

  handle(
    eventName: string,
    rawData: unknown,
    source: EventSource,
    context?: EventDeliveryContext,
    occurrence?: EventOccurrenceMetadata,
    receivedAt = this.now(),
  ): Promise<NormalizedEvent | null> {
    return this.queuePersistence(
      eventName,
      rawData,
      source,
      context,
      occurrence,
      undefined,
      receivedAt,
    ).then((persisted) => this.finishAdmission(persisted));
  }

  /**
   * DEV fault injection only: commit one unique harmless fixture envelope but deliberately do not
   * kick the drain. The composition root must opt in explicitly; production/default instances
   * return null before normalization, hashing, or DB access.
   */
  persistWithoutDrainForDev(
    eventName: string,
    rawData: unknown,
    source: EventSource,
    context?: EventDeliveryContext,
    occurrence?: EventOccurrenceMetadata,
    leaseToken?: string,
    receivedAt = this.now(),
  ): Promise<DevPersistedIncomingEvent | null> {
    if (this.options.allowDevPersistWithoutDrain !== true || source !== 'dev' || !leaseToken) {
      return Promise.resolve(null);
    }
    return this.queuePersistence(
      eventName,
      rawData,
      source,
      context,
      occurrence,
      leaseToken,
      receivedAt,
    ).then((admission) => {
      if (
        !admission ||
        !admission.isCurrent() ||
        admission.result.status !== 'enqueued' ||
        !admission.devClaim
      ) {
        return null;
      }
      return {
        event: admission.event,
        queueId: admission.result.id,
        claim: admission.devClaim,
      };
    });
  }

  private queuePersistence(
    eventName: string,
    rawData: unknown,
    source: EventSource,
    context?: EventDeliveryContext,
    occurrence?: EventOccurrenceMetadata,
    devLeaseToken?: string,
    receivedAt = this.now(),
  ): Promise<Admission | null> {
    // Claim a FIFO slot before the first await. The tail itself never rejects, so one bad envelope
    // cannot poison every later transport callback.
    const previous = this.intakeTail;
    let release = (): void => {};
    this.intakeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Native/socket callers retain their callback objects. Validate and deep-snapshot now, before
    // waiting on `previous`, so later caller mutation cannot rewrite this admission's identity,
    // ordering key, or eventual effect.
    let event: NormalizedEvent | null = null;
    let snapshotError: unknown;
    try {
      event = snapshotIncomingEvent(eventName, rawData);
    } catch (error) {
      snapshotError = error;
    }
    const capturedOccurrence = occurrence
      ? {
          serverEventId: occurrence.serverEventId,
          transportOccurrenceId: occurrence.transportOccurrenceId,
        }
      : undefined;
    const admission = (async () => {
      await previous;
      try {
        if (snapshotError !== undefined) throw snapshotError;
        if (!event) {
          logger.debug('[incomingEvents] dropped invalid realtime event', {
            event: eventName,
            source,
          });
          return null;
        }
        return await this.persist(
          event,
          source,
          receivedAt,
          context,
          capturedOccurrence,
          devLeaseToken,
        );
      } finally {
        // The FIFO protects only normalization/hash/persistence. Required effects may be slow, but
        // the single-flight drain already serializes their delivery; keeping this slot until those
        // effects finish would prevent later callbacks from becoming durable in the meantime.
        release();
      }
    })();
    return admission;
  }

  private async persist(
    event: NormalizedEvent,
    source: EventSource,
    receivedAt: number,
    context?: EventDeliveryContext,
    occurrence?: EventOccurrenceMetadata,
    devLeaseToken?: string,
  ): Promise<Admission | null> {
    if (this.stopped || (context && !context.isCurrent())) return null;
    // Security eligibility is dynamic (App Lock can engage while SHA-256 or the write mutex is
    // pending). Once any check rejects this admission it stays revoked, even if the gate later
    // re-opens, so one transport callback cannot disappear behind the lock and then resume.
    let admissionRevoked = false;
    const guard = (): boolean => {
      if (admissionRevoked) return false;
      const allowed =
        !this.stopped &&
        (!context || context.isCurrent()) &&
        (!this.options.canPersist || this.options.canPersist(event));
      if (!allowed) admissionRevoked = true;
      return allowed;
    };
    if (!guard()) return null;

    let encoded;
    try {
      encoded = await encodeIncomingEvent(
        event,
        {
          source,
          receivedAt,
          serverEventId: occurrence?.serverEventId,
          transportOccurrenceId:
            occurrence?.transportOccurrenceId ?? this.options.makeTransportOccurrenceId(source),
        },
        this.digest,
      );
    } catch (error) {
      // Validation/hash failure happens before persistence and before every effect. Keep logs free
      // of the raw payload and identifiers; the transport owner decides whether to surface it.
      logger.warn('[incomingEvents] envelope encoding failed', {
        event: event.type,
        code: error instanceof IncomingEventCodecError ? error.code : 'unknown',
      });
      throw error;
    }
    // Encoding awaits the digest backend. Re-check after it, then keep the same dynamic gate on
    // the enqueue transaction so a lock transition while waiting for BEGIN also rolls back.
    if (!guard()) return null;

    let result;
    let devClaim: ClaimedIncomingEvent | undefined;
    try {
      if (devLeaseToken) {
        const atomic = await enqueueAndClaimIncomingEventIfQueueEmpty(
          this.db,
          encoded.envelope,
          { now: receivedAt, clock: this.now, leaseToken: devLeaseToken },
          guard,
        );
        if (atomic.status !== 'claimed') return null;
        result = atomic.result;
        devClaim = atomic.claim;
      } else {
        result = await enqueueIncomingEvent(this.db, encoded.envelope, guard, this.now);
      }
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError && !guard()) return null;
      throw error;
    }
    if (!guard()) return null;

    return {
      event,
      source,
      context,
      isCurrent: guard,
      result,
      devClaim,
      conflictRecovery: encoded.conflictRecovery,
      identityQuality: encoded.identityQuality,
    };
  }

  private async finishAdmission(admission: Admission | null): Promise<NormalizedEvent | null> {
    if (!admission) return null;
    const { event, source, context, isCurrent, result, conflictRecovery, identityQuality } =
      admission;
    if (!isCurrent()) return null;

    switch (result.status) {
      case 'enqueued':
        await this.drain.kick(context);
        if (!isCurrent()) return null;
        if (event.type === 'new-message' && event.message.textTruncated === true) {
          await this.requestRecovery(conflictRecovery, 'truncated-payload', isCurrent, context);
        }
        return event;
      case 'duplicate':
        // Intake maintenance can make unrelated older work due even when this exact receipt is
        // terminal, so every authenticated callback is also a bounded wake opportunity.
        await this.drain.kick(context);
        if (!isCurrent()) return null;
        if (result.state === 'poisoned') {
          // The original process can die after committing a poison receipt but before its recovery
          // callback runs. An exact provider redelivery is the next durable chance to request it.
          await this.requestRecovery(conflictRecovery, 'duplicate-poisoned', isCurrent, context);
        }
        return null;
      case 'key-conflict':
        // First copy wins. Never route or overwrite a conflicting full/capped variant; process the
        // retained row once. The real server deliberately serializes socket messages richly and
        // FCM messages leanly, so those expected cross-transport hydration variants share semantic
        // identity while retaining different payload digests. They are not corruption and must not
        // turn every delivery/read receipt into a full-account sync.
        await this.drain.kick(context);
        if (!isCurrent()) return null;
        if (
          (event.type === 'new-message' || event.type === 'updated-message') &&
          source !== result.existingSource &&
          result.existingState !== 'poisoned'
        ) {
          logger.debug('[incomingEvents] retained first cross-transport message variant', {
            event: event.type,
            source,
            identityQuality,
          });
        } else {
          await this.requestRecovery(conflictRecovery, 'key-conflict', isCurrent, context);
          logger.warn('[incomingEvents] event-key payload conflict; retained first copy', {
            event: event.type,
            source,
            identityQuality,
          });
        }
        return null;
      case 'poisoned':
        await this.drain.kick(context);
        if (!isCurrent()) return null;
        await this.requestRecovery(conflictRecovery, 'intake-poisoned', isCurrent, context);
        logger.warn('[incomingEvents] intake refused an event', {
          event: event.type,
          reason: result.reason,
        });
        return null;
    }
  }

  private async requestRecovery(
    recovery: IncomingEventConflictRecovery,
    reason: 'key-conflict' | 'intake-poisoned' | 'duplicate-poisoned' | 'truncated-payload',
    isCurrent: () => boolean,
    context?: EventDeliveryContext,
  ): Promise<void> {
    if (recovery.kind === 'none' || !isCurrent()) return;
    const recoveryContext: EventDeliveryContext = {
      generation: context?.generation ?? 0,
      isCurrent,
    };
    try {
      await this.options.requestRecovery?.(recovery, reason, recoveryContext);
    } catch (error) {
      logger.warn('[incomingEvents] recovery request failed', {
        kind: recovery.kind,
        reason,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
}
