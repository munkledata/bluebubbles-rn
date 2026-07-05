import type { EventSink, EventSource, NormalizedEvent } from '@core/realtime';

/**
 * Decorates an inner EventSink: handles the Gator RCS bridge's `rcs-alert` health events by
 * recording the alert (via the injected `onAlert`, the RCS-health store setter) so the Server
 * Health screen can surface a phone-offline / disconnected state, then delegates everything else.
 * UI-only — RCS alerts never touch the DB or post a notification, so this short-circuits before the
 * DB/notify sinks (like `TypingEventSink`). Pure + injected → unit-testable.
 */
export class RcsAlertEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly onAlert: (alertType: string | null | undefined) => void,
  ) {}

  async onEvent(event: NormalizedEvent, source: EventSource): Promise<void> {
    if (event.type === 'rcs-alert') {
      this.onAlert(event.payload.alertType);
      return;
    }
    await this.inner.onEvent(event, source);
  }
}
