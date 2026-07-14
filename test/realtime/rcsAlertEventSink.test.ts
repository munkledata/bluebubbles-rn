import type { EventSink, NormalizedEvent } from '@core/realtime';
import { RcsAlertEventSink } from '@/services/realtime/rcsAlertEventSink';

const ev = (e: unknown): NormalizedEvent => e as NormalizedEvent;

describe('RcsAlertEventSink', () => {
  it('records the alertType and short-circuits the inner sink (UI-only, no DB/notify)', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const onAlert = jest.fn();
    await new RcsAlertEventSink(inner, onAlert).onEvent(
      ev({ type: 'rcs-alert', payload: { alertType: 'PHONE_NOT_RESPONDING' } }),
      'socket',
    );
    expect(onAlert).toHaveBeenCalledWith('PHONE_NOT_RESPONDING');
    expect(inner.onEvent).not.toHaveBeenCalled();
  });

  it('passes a missing alertType through so the store can coerce it', async () => {
    const onAlert = jest.fn();
    await new RcsAlertEventSink({ onEvent: jest.fn() }, onAlert).onEvent(
      ev({ type: 'rcs-alert', payload: {} }),
      'socket',
    );
    expect(onAlert).toHaveBeenCalledWith(undefined);
  });

  it('delegates non-alert events to the inner sink untouched', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const onAlert = jest.fn();
    const event = ev({ type: 'typing-indicator', payload: { chatGuid: 'c1', display: true } });
    await new RcsAlertEventSink(inner, onAlert).onEvent(event, 'fcm');
    expect(inner.onEvent).toHaveBeenCalledWith(event, 'fcm');
    expect(onAlert).not.toHaveBeenCalled();
  });
});
