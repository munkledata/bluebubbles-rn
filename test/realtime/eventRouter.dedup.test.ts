import { EventRouter, type EventSink, type NormalizedEvent } from '@core/realtime';

function collector() {
  const events: NormalizedEvent[] = [];
  const sink: EventSink = { onEvent: (e) => void events.push(e) };
  return { events, sink };
}

describe('EventRouter dedup-by-GUID', () => {
  it('processes a message guid once across redeliveries (socket + fcm)', async () => {
    const { events, sink } = collector();
    const router = new EventRouter(sink);
    const msg = { guid: 'dup1', text: 'hi', dateCreated: 1 };
    const a = await router.handle('new-message', msg, 'socket');
    const b = await router.handle('new-message', msg, 'fcm');
    expect(a?.type).toBe('new-message');
    expect(b).toBeNull(); // duplicate delivery skipped
    expect(events).toHaveLength(1);
  });

  it('processes distinct guids', async () => {
    const { events, sink } = collector();
    const router = new EventRouter(sink);
    await router.handle('new-message', { guid: 'a', dateCreated: 1 }, 'socket');
    await router.handle('new-message', { guid: 'b', dateCreated: 1 }, 'socket');
    expect(events).toHaveLength(2);
  });

  it('keys dedup by event type, so new + updated for one guid both run', async () => {
    const { events, sink } = collector();
    const router = new EventRouter(sink);
    await router.handle('new-message', { guid: 'x', dateCreated: 1 }, 'socket');
    await router.handle('updated-message', { guid: 'x', dateCreated: 2 }, 'socket');
    expect(events).toHaveLength(2);
  });

  it('does NOT dedup updated-message: two updates for one guid (different dateRead) both reach the sink', async () => {
    const { events, sink } = collector();
    const router = new EventRouter(sink);
    // A message receives a stream of updates (delivered → read → edited …), each with a
    // different timestamp; deduping by guid would drop everything after the first.
    const a = await router.handle('updated-message', { guid: 'u', dateRead: 0 }, 'socket');
    const b = await router.handle('updated-message', { guid: 'u', dateRead: 1234 }, 'socket');
    expect(a?.type).toBe('updated-message');
    expect(b?.type).toBe('updated-message'); // NOT dropped as a "duplicate"
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.type === 'updated-message' ? e.message.dateRead : null))).toEqual([
      0, 1234,
    ]);
  });
});
