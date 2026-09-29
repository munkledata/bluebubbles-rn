import { classifyRcsEventAdmission, type RcsProviderServerInfo } from '@core/rcs';
import type { EventDeliveryContext, EventSink, EventSource, NormalizedEvent } from '@core/realtime';
import { IncomingEventDependencyPendingError } from './incomingEventErrors';

/** Reject stale/malformed RCS events before any inner DB, UI, notification, network, or native sink. */
export class RcsProviderEpochEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly getServerInfo: () => RcsProviderServerInfo | null | undefined,
  ) {}

  onEvent(
    event: NormalizedEvent,
    source: EventSource,
    context?: EventDeliveryContext,
  ): void | Promise<void> {
    const admission = classifyRcsEventAdmission(this.getServerInfo(), event);
    if (admission === 'stale') return;
    if (admission === 'unavailable') {
      if (context?.durableEvent) throw new IncomingEventDependencyPendingError();
      return;
    }
    if (!context) return this.inner.onEvent(event, source, context);

    // Account generation does not change when Google is re-paired on the same server session.
    // Wrap the delivery lease so every inner post-commit layer (notifications, UI publication,
    // group repair) observes provider rotation as a one-way revocation too.
    let revoked = false;
    const providerAdmissionIsCurrent = (): boolean => {
      if (revoked) return false;
      const live = classifyRcsEventAdmission(this.getServerInfo(), event);
      const current = admission === 'current' ? live === 'current' : live === 'non-rcs';
      if (!current) revoked = true;
      return current;
    };
    const providerContext: EventDeliveryContext = {
      ...context,
      isProviderCurrent: providerAdmissionIsCurrent,
      isCurrent: () => {
        if (revoked || !context.isCurrent()) {
          revoked = true;
          return false;
        }
        return providerAdmissionIsCurrent();
      },
    };
    return this.inner.onEvent(event, source, providerContext);
  }
}
