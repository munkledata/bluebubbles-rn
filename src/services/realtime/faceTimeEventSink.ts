import type { EventDeliveryContext, EventSink, EventSource, NormalizedEvent } from '@core/realtime';

/**
 * Current-release retirement boundary for helper-originated FaceTime events. Drop them before
 * they can reach UI state, the database, or notifications. A future FaceTime helper is a separate
 * feature and must replace this boundary only after its own security and product review.
 */
export class FaceTimeEventSink implements EventSink {
  constructor(private readonly inner: EventSink) {}

  async onEvent(
    event: NormalizedEvent,
    source: EventSource,
    context?: EventDeliveryContext,
  ): Promise<void> {
    if (context && !context.isCurrent()) return;
    const isFaceTimeEvent =
      event.type === 'incoming-facetime' || event.type === 'ft-call-status-changed';
    if (isFaceTimeEvent) return;

    await this.inner.onEvent(event, source, context);
  }
}
