import type { EventSink, EventSource, NormalizedEvent, NotificationIntent } from '@core/realtime';
import type { AppDatabase } from '@db/types';

/**
 * Decorates an inner EventSink (the DB sink): writes the DB first (the source of
 * truth), then derives notification intents from the persisted event and hands
 * them to `notify`. Keeping the DB write authoritative means a notification only
 * fires for an event that actually landed. Both the socket transport and the
 * (dev / future FCM) transports share one instance, so notifications behave
 * identically regardless of how the event arrived.
 */
export class NotifyingEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly db: AppDatabase,
    private readonly buildIntents: (
      db: AppDatabase,
      event: NormalizedEvent,
    ) => Promise<NotificationIntent[]>,
    private readonly notify: (intent: NotificationIntent) => void,
  ) {}

  async onEvent(event: NormalizedEvent, source: EventSource): Promise<void> {
    await this.inner.onEvent(event, source);
    const intents = await this.buildIntents(this.db, event);
    for (const intent of intents) this.notify(intent);
  }
}
