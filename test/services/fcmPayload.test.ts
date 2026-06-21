import { EventRouter, type EventSink, type NormalizedEvent } from '@core/realtime';
import { parseFcmData } from '@/services/notifications/fcmPayload';

function collector() {
  const events: NormalizedEvent[] = [];
  const sink: EventSink = { onEvent: (event) => void events.push(event) };
  return { events, sink };
}

describe('parseFcmData', () => {
  it('reads the event name from `type` and the body from the nested `data` key', () => {
    const { eventName, body } = parseFcmData({ type: 'new-message', data: '{"guid":"m1"}' });
    expect(eventName).toBe('new-message');
    expect(body).toBe('{"guid":"m1"}');
  });

  it('falls back to the whole data map when there is no nested `data` key (legacy)', () => {
    const map = { type: 'typing-indicator', chatGuid: 'c1' };
    const { eventName, body } = parseFcmData(map);
    expect(eventName).toBe('typing-indicator');
    expect(body).toBe(map);
  });

  it('handles a missing data map', () => {
    expect(parseFcmData(undefined)).toEqual({ eventName: '', body: undefined, encrypted: false });
  });

  it('flags an encrypted (legacy-AES) payload so it is skipped, not silently dropped', () => {
    expect(parseFcmData({ type: 'new-message', data: 'AES…', encrypted: 'true' }).encrypted).toBe(
      true,
    );
    expect(parseFcmData({ type: 'new-message', data: '{"guid":"m1"}' }).encrypted).toBe(false);
  });

  // Regression: the body used to be read from a non-existent top-level `payload` key,
  // so the whole envelope was dispatched and every push was dropped by schema validation.
  it('routes a real server-shaped FCM new-message envelope end-to-end', async () => {
    const { events, sink } = collector();
    const router = new EventRouter(sink);
    const fcm = {
      type: 'new-message',
      data: JSON.stringify({ guid: 'srv-1', text: 'hello from FCM' }),
      encrypted: 'false',
      encoding: 'json',
    };
    const { eventName, body } = parseFcmData(fcm);
    const out = await router.handle(eventName, body, 'fcm');
    expect(out?.type).toBe('new-message');
    expect(events).toHaveLength(1);
    if (out?.type === 'new-message') {
      expect(out.message.guid).toBe('srv-1');
      expect(out.message.text).toBe('hello from FCM');
    }
  });

  it('the OLD behavior — dispatching the whole envelope — would NOT route (guid is nested)', async () => {
    const { sink } = collector();
    const router = new EventRouter(sink);
    const fcm = { type: 'new-message', data: JSON.stringify({ guid: 'srv-2' }) };
    // Pre-fix bug: the entire data map was dispatched; guid lives under `.data`, not top level.
    const out = await router.handle('new-message', fcm, 'fcm');
    expect(out).toBeNull();
  });
});
