import { classifyServerRotation } from '@core/config';
import type { RealtimeDeliveryLease } from './deliveryCoordinator';
import { subscribeRealtimeGenerationInvalidation } from './deliveryCoordinator';

export interface ServerRotationRequest {
  readonly id: number;
  readonly currentOrigin: string;
  readonly candidateOrigin: string;
  readonly sessionEpoch: number;
  readonly deliveryGeneration: number;
  readonly requiresCleartextApproval: boolean;
}

export type ServerRotationOfferResult =
  | 'offered'
  | 'already-pending'
  | 'same-origin'
  | 'downgrade-rejected'
  | 'invalid'
  | 'not-foreground';

interface PendingServerRotation {
  readonly request: ServerRotationRequest;
  readonly isCurrent: () => boolean;
  unsubscribeInvalidation: () => void;
}

type InvalidationSubscriber = (generation: number, listener: () => void) => () => void;

/**
 * One-slot, process-memory-only handoff from authenticated realtime intake to foreground UI.
 *
 * The unapproved proposal never enters SQLite, SecureStore, route state, or the generic dialog
 * queue. The account-generation subscription retires it synchronously on Disconnect, while the
 * injected live guard also covers backgrounding, App Lock, session epoch, and expected origin.
 */
export class ServerRotationCoordinator {
  private pending: PendingServerRotation | null = null;
  /** Claimed proposal hidden from UI but still reserving the one rotation slot. */
  private inProgress: PendingServerRotation | null = null;
  private nextId = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly subscribeInvalidation: InvalidationSubscriber = subscribeRealtimeGenerationInvalidation,
  ) {}

  readonly getSnapshot = (): ServerRotationRequest | null => this.pending?.request ?? null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  offer(
    rawCandidate: string,
    currentOrigin: string | null,
    sessionEpoch: number,
    lease: RealtimeDeliveryLease,
    isCurrent: () => boolean,
  ): ServerRotationOfferResult {
    const classification = classifyServerRotation(currentOrigin, rawCandidate);
    if (classification.kind === 'invalid') return 'invalid';
    if (classification.kind === 'same-origin') return 'same-origin';
    if (classification.kind === 'downgrade') return 'downgrade-rejected';
    if (!lease.isCurrent() || !isCurrent()) return 'not-foreground';
    if (this.inProgress) return 'already-pending';

    const existing = this.pending;
    if (existing) {
      if (!existing.isCurrent()) this.retire(existing);
      else return 'already-pending';
    }

    const pending: PendingServerRotation = {
      request: Object.freeze({
        id: ++this.nextId,
        currentOrigin: classification.currentOrigin,
        candidateOrigin: classification.candidateOrigin,
        sessionEpoch,
        deliveryGeneration: lease.generation,
        requiresCleartextApproval: classification.requiresCleartextApproval,
      }),
      isCurrent: () => lease.isCurrent() && isCurrent(),
      unsubscribeInvalidation: () => undefined,
    };
    this.pending = pending;
    pending.unsubscribeInvalidation = this.subscribeInvalidation(lease.generation, () => {
      this.retire(pending);
    });
    if (this.pending !== pending || !pending.isCurrent()) {
      this.retire(pending);
      return 'not-foreground';
    }
    this.emit();
    return 'offered';
  }

  /** Return a request only while its original account/foreground authority still owns it. */
  current(requestId: number): ServerRotationRequest | null {
    const pending = this.pending;
    if (!pending || pending.request.id !== requestId) return null;
    if (!pending.isCurrent()) {
      this.retire(pending);
      return null;
    }
    return pending.request;
  }

  /** Hide a validated proposal while retaining the exclusive slot for its durable commit. */
  claim(requestId: number): ServerRotationRequest | null {
    const request = this.current(requestId);
    const pending = this.pending;
    if (!request || !pending || pending.request !== request) return null;
    if (this.inProgress) return null;
    this.pending = null;
    this.inProgress = pending;
    this.emit();
    return request;
  }

  /** Release the exclusive slot after the claimed operation reaches every terminal path. */
  finish(requestId: number): void {
    const inProgress = this.inProgress;
    if (!inProgress || inProgress.request.id !== requestId) return;
    this.retire(inProgress);
  }

  cancel(requestId?: number): void {
    const pending = this.pending;
    if (!pending || (requestId !== undefined && pending.request.id !== requestId)) return;
    this.retire(pending);
  }

  private retire(expected: PendingServerRotation): void {
    if (this.pending === expected) this.pending = null;
    else if (this.inProgress === expected) this.inProgress = null;
    else return;
    expected.unsubscribeInvalidation();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const serverRotationCoordinator = new ServerRotationCoordinator();
