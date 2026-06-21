import type { EventSink, EventSource, NormalizedEvent } from '@core/realtime';

/**
 * Decorates an inner EventSink: handles ephemeral `typing-indicator` events by
 * updating UI state (never the DB / no notification), and delegates everything else.
 * Outermost in the realtime pipeline so a typing event short-circuits before the DB
 * sink (which intentionally drops it). `onTyping` is injected (the typing store's
 * setter) so this stays pure and unit-testable.
 */
export class TypingEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly onTyping: (chatGuid: string, display: boolean) => void,
  ) {}

  async onEvent(event: NormalizedEvent, source: EventSource): Promise<void> {
    if (event.type === 'typing-indicator') {
      const guid = event.payload.chatGuid ?? event.payload.guid;
      if (guid) this.onTyping(guid, event.payload.display);
      return;
    }
    await this.inner.onEvent(event, source);
  }
}
