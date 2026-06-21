import { EventRouter, type EventSink, type NormalizedEvent } from '@core/realtime';

function collector() {
  const events: { event: NormalizedEvent; source: string }[] = [];
  const sink: EventSink = { onEvent: (event, source) => void events.push({ event, source }) };
  return { events, sink };
}

describe('EventRouter', () => {
  it('normalizes new-message and forwards to the sink', async () => {
    const { events, sink } = collector();
    const router = new EventRouter(sink);
    const out = await router.handle(
      'new-message',
      { guid: 'm1', text: 'hi', dateCreated: 1700000000000 },
      'socket',
    );
    expect(out?.type).toBe('new-message');
    expect(events).toHaveLength(1);
    if (out?.type === 'new-message') expect(out.message.guid).toBe('m1');
  });

  it('unwraps FCM data delivered as a JSON string', async () => {
    const { sink } = collector();
    const router = new EventRouter(sink);
    const json = JSON.stringify({ guid: 'm2', text: 'fcm' });
    const out = await router.handle('new-message', json, 'fcm');
    expect(out?.type).toBe('new-message');
    if (out?.type === 'new-message') expect(out.message.guid).toBe('m2');
  });

  it('coerces string timestamps in message payloads', async () => {
    const { sink } = collector();
    const router = new EventRouter(sink);
    const out = await router.handle(
      'new-message',
      { guid: 'm3', dateCreated: '1700000000000' },
      'socket',
    );
    if (out?.type === 'new-message') expect(out.message.dateCreated).toBe(1700000000000);
  });

  it('routes typing-indicator and read-status events', async () => {
    const { sink } = collector();
    const router = new EventRouter(sink);
    expect(
      (await router.handle('typing-indicator', { chatGuid: 'c1', display: true }, 'socket'))?.type,
    ).toBe('typing-indicator');
    expect(
      (await router.handle('chat-read-status-changed', { chatGuid: 'c1', read: true }, 'socket'))
        ?.type,
    ).toBe('chat-read-status-changed');
  });

  it('returns null for unknown events and does not call the sink', async () => {
    const { events, sink } = collector();
    const router = new EventRouter(sink);
    expect(await router.handle('not-a-real-event', {}, 'socket')).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('returns null for invalid payloads (no guid)', async () => {
    const { sink } = collector();
    const router = new EventRouter(sink);
    expect(await router.handle('new-message', { text: 'no guid' }, 'socket')).toBeNull();
  });
});
