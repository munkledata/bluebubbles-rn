import type { EventSink, EventSource, NormalizedEvent } from '@core/realtime';

/**
 * Decorates an inner EventSink: handles the server's `new-server` event (its public URL rotated,
 * e.g. a zrok tunnel) by invoking the injected `onNewUrl` handler, and delegates everything else.
 * Kept pure (the reconnect logic is injected) so it's unit-testable. Outermost in the pipeline so
 * a URL rotation is applied before the DB/notification sinks run for the same event.
 */
export class ServerUrlEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly onNewUrl: (url: string) => void,
  ) {}

  async onEvent(event: NormalizedEvent, source: EventSource): Promise<void> {
    if (event.type === 'new-server') {
      this.onNewUrl(event.url);
      return;
    }
    await this.inner.onEvent(event, source);
  }
}
