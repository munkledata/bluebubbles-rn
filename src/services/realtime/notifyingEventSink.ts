import type {
  EventDeliveryContext,
  EventSink,
  EventSource,
  NormalizedEvent,
  NotificationIntent,
} from '@core/realtime';
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
    private readonly notify: (
      intent: NotificationIntent,
      context?: EventDeliveryContext,
    ) => void | Promise<void>,
  ) {}

  async onEvent(
    event: NormalizedEvent,
    source: EventSource,
    context?: EventDeliveryContext,
  ): Promise<void> {
    await this.inner.onEvent(event, source, context);
    if (context && !context.isCurrent()) return;
    const intents = await this.buildIntents(this.db, event);
    // Keep presentation work inside the event's lifetime. Account teardown can then drain either
    // transport before wiping, rather than a late native post resurrecting private OS state after
    // cancellation.
    for (const intent of intents) {
      if (context && !context.isCurrent()) return;
      await this.notify(intent, context);
    }
  }
}
