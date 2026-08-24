import type { EventDeliveryContext, EventSink, EventSource, NormalizedEvent } from '@core/realtime';

/**
 * Decorates an inner EventSink: handles the server's `new-server` event (its public URL rotated,
 * e.g. a zrok tunnel) by invoking the injected `onNewUrl` handler, and delegates everything else.
 * Kept pure (the approval handoff is injected) so it's unit-testable. Public intake intercepts
 * rotation before SQLite; this decorator is the final defense if an internal dispatcher sees one.
 */
export class ServerUrlEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly onNewUrl: (
      url: string,
      context?: EventDeliveryContext,
    ) => void | Promise<void>,
  ) {}

  async onEvent(
    event: NormalizedEvent,
    source: EventSource,
    context?: EventDeliveryContext,
  ): Promise<void> {
    if (context && !context.isCurrent()) return;
    if (event.type === 'new-server') {
      await this.onNewUrl(event.url, context);
      return;
    }
    await this.inner.onEvent(event, source, context);
  }
}
