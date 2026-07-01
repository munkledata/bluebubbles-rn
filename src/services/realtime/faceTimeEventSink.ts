import type { EventSink, EventSource, NormalizedEvent } from '@core/realtime';

/**
 * Foreground in-app FaceTime overlay driver. An incoming-facetime / status-4 event rings
 * the in-app overlay (via injected setters); a status-6 'ended' dismisses it. Every event
 * is still delegated to the inner sink, so the DB write + the Notifee notification
 * (downstream `NotifyingEventSink`) still run — a backgrounded/killed app rings via Notifee;
 * this only ADDS the foreground overlay. Pure + injected, like `TypingEventSink`.
 *
 * A headless FCM wake has no React tree, so the `ring`/`dismiss` setters mutate a store no
 * component observes (harmless no-op) while Notifee owns background delivery.
 */
export class FaceTimeEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly onRing: (c: { uuid: string; callerName: string; isAudio: boolean }) => void,
    private readonly onEnded: (uuid: string) => void,
  ) {}

  async onEvent(event: NormalizedEvent, source: EventSource): Promise<void> {
    if (event.type === 'incoming-facetime') {
      const { uuid, caller, address, is_audio } = event.payload;
      if (uuid) {
        this.onRing({
          uuid,
          callerName: caller ?? address ?? 'Unknown caller',
          isAudio: is_audio ?? false,
        });
      }
    } else if (event.type === 'ft-call-status-changed') {
      const { uuid, status_id, address, handle, is_audio } = event.payload;
      if (uuid && status_id === 4) {
        this.onRing({
          uuid,
          callerName: address ?? handle?.address ?? 'Unknown caller',
          isAudio: is_audio ?? false,
        });
      } else if (uuid && status_id === 6) {
        this.onEnded(uuid);
      }
    }
    // Always delegate so the DB sink + Notifee notification still run (background ring).
    await this.inner.onEvent(event, source);
  }
}
