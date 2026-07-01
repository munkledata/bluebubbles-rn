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
    expect(parseFcmData(undefined)).toEqual({
      eventName: '',
      body: undefined,
      encrypted: false,
      encryptionType: '',
    });
  });

  it('flags an encrypted payload + surfaces its scheme so the caller can decrypt or skip', () => {
    const enc = parseFcmData({
      type: 'new-message',
      data: 'base64frame',
      encrypted: 'true',
      encryptionType: 'AEAD_GCM_V1',
    });
    expect(enc.encrypted).toBe(true);
    expect(enc.encryptionType).toBe('AEAD_GCM_V1');
    // The base64 frame is passed through as the body (not JSON) for the caller to decrypt.
    expect(enc.body).toBe('base64frame');

    const plain = parseFcmData({ type: 'new-message', data: '{"guid":"m1"}' });
    expect(plain.encrypted).toBe(false);
    expect(plain.encryptionType).toBe('');
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

  it('F-1: hoists a top-level envelope `chatGuid` into the body so the chats-less fallback works', async () => {
    // The server carries chatGuid as a sibling of type/data when it didn't embed chats[].
    const fcm = {
      type: 'new-message',
      data: JSON.stringify({ guid: 'srv-3', text: 'hi' }),
      chatGuid: 'cFallback',
    };
    const { body } = parseFcmData(fcm);
    expect(typeof body).toBe('string');
    const parsed = JSON.parse(body as string) as { guid: string; chatGuid?: string };
    expect(parsed.chatGuid).toBe('cFallback'); // folded into the message body

    // …and it round-trips through the router into a parsed message carrying chatGuid.
    const { events, sink } = collector();
    const router = new EventRouter(sink);
    const out = await router.handle('new-message', body, 'fcm');
    if (out?.type === 'new-message') {
      expect(out.message.chatGuid).toBe('cFallback');
    }
    expect(events).toHaveLength(1);
  });

  it('F-1: does NOT override a chatGuid the body already carries', () => {
    const fcm = {
      type: 'new-message',
      data: JSON.stringify({ guid: 'srv-4', chatGuid: 'cInner' }),
      chatGuid: 'cEnvelope',
    };
    const { body } = parseFcmData(fcm);
    const parsed = JSON.parse(body as string) as { chatGuid?: string };
    expect(parsed.chatGuid).toBe('cInner');
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
