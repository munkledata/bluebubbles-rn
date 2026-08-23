import type { EventDeliveryContext, EventSink, EventSource, NormalizedEvent } from '@core/realtime';

/**
 * Decorates an inner EventSink: handles the server's `new-server` event (its public URL rotated,
 * e.g. a zrok tunnel) by invoking the injected `onNewUrl` handler, and delegates everything else.
 * Kept pure (the reconnect logic is injected) so it's unit-testable. Outermost in the pipeline so
 * a URL rotation is applied before the DB/notification sinks run for the same event.
 */
export class ServerUrlEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly onNewUrl: (url: string) => void | Promise<void>,
  ) {}

  async onEvent(
    event: NormalizedEvent,
    source: EventSource,
    context?: EventDeliveryContext,
  ): Promise<void> {
    if (context && !context.isCurrent()) return;
    if (event.type === 'new-server') {
      await this.onNewUrl(event.url);
      return;
    }
    await this.inner.onEvent(event, source, context);
  }
}
