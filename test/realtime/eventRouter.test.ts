import { SERVER_EVENTS, type ServerEventName } from '@core/config';
import { EventRouter, type EventSink, type NormalizedEvent } from '@core/realtime';

function collector() {
  const events: { event: NormalizedEvent; source: string }[] = [];
  const sink: EventSink = { onEvent: (event, source) => void events.push({ event, source }) };
  return { events, sink };
}

/**
 * A minimal payload that MUST normalize for every event name the app advertises to the server.
 *
 * Typed as an exhaustive `Record<ServerEventName, …>` on purpose: adding a name to SERVER_EVENTS
 * without adding it here is a compile error, and adding it here without a `normalize()` case makes
 * the table-driven test below fail at runtime. That pairing is the regression guard — `test-notification`
 * shipped as a constant with no normalize case once already, so the server reported "sent" while the
 * router silently dropped every one of them (`default: return null`).
 */
const MINIMAL_PAYLOAD: Record<ServerEventName, unknown> = {
  'new-message': { guid: 'tbl-new-1', text: 'hi' },
  'updated-message': { guid: 'tbl-upd-1', dateDelivered: 1700000000000 },
  'message-deleted': { guid: 'tbl-del-1' },
  'typing-indicator': { chatGuid: 'tbl-c1', display: true },
  'chat-read-status-changed': { chatGuid: 'tbl-c1', read: true },
  'group-name-change': { chats: [] },
  'participant-added': { chats: [] },
  'participant-removed': { chats: [] },
  'participant-left': { chats: [] },
  'ft-call-status-changed': { uuid: 'tbl-ft-1', status_id: 6 },
  'incoming-facetime': { uuid: 'tbl-ft-2', status_id: 4, address: '+15551234567' },
  'imessage-aliases-removed': { aliases: ['someone@example.com'] },
  'message-send-error': { tempGuid: 'tbl-temp-1', error: 'bridge failed' },
  'new-server': 'https://rotated.example.com',
  'rcs-alert': { kind: 'alert', alertType: 'GAIA_LOGGED_OUT' },
  'rcs-bridge-down': { title: 'RCS down', body: 'reauth needed', reason: 'COOKIES_EXPIRED' },
  'test-notification': { title: 'Gator', body: 'Push works' },
};

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

  it('normalizes an rcs-alert and forwards its alertType to the sink', async () => {
    const { events } = collector();
    const router = new EventRouter({
      onEvent: (event) => void events.push({ event, source: 's' }),
    });
    const out = await router.handle(
      'rcs-alert',
      { kind: 'alert', alertType: 'GAIA_LOGGED_OUT' },
      'socket',
    );
    expect(out?.type).toBe('rcs-alert');
    if (out?.type === 'rcs-alert') expect(out.payload.alertType).toBe('GAIA_LOGGED_OUT');
    expect(events).toHaveLength(1);
  });

  it('normalizes a message-deleted event and forwards its guid + chatGuid + dateDeleted', async () => {
    const { events, sink } = collector();
    const router = new EventRouter(sink);
    const out = await router.handle(
      'message-deleted',
      { guid: 'del-1', chatGuid: 'iMessage;-;+1555', dateDeleted: 1700000000000 },
      'socket',
    );
    expect(out?.type).toBe('message-deleted');
    if (out?.type === 'message-deleted') {
      expect(out.payload.guid).toBe('del-1');
      expect(out.payload.chatGuid).toBe('iMessage;-;+1555');
      expect(out.payload.dateDeleted).toBe(1700000000000);
    }
    expect(events).toHaveLength(1);
  });

  it('tolerates a message-deleted with only a guid (chatGuid/dateDeleted absent → null)', async () => {
    const { sink } = collector();
    const router = new EventRouter(sink);
    const out = await router.handle('message-deleted', { guid: 'del-2' }, 'fcm');
    expect(out?.type).toBe('message-deleted');
    if (out?.type === 'message-deleted') {
      expect(out.payload.guid).toBe('del-2');
      // An absent `.nullish()` key stays undefined; epochMillis coerces an absent date to null (not
      // NaN). The sink handles both (chatGuid is unused; dateDeleted ?? now()).
      expect(out.payload.chatGuid).toBeUndefined();
      expect(out.payload.dateDeleted).toBeNull();
    }
  });

  it('drops a guid-less message-deleted (nothing to tombstone)', async () => {
    const { events, sink } = collector();
    const router = new EventRouter(sink);
    expect(await router.handle('message-deleted', { dateDeleted: 1 }, 'socket')).toBeNull();
    expect(events).toHaveLength(0);
  });

  describe('every SERVER_EVENTS name has a normalize() case', () => {
    it('covers the whole constant list (no name is silently unhandled)', () => {
      // Sanity: the table below is what the per-event cases iterate. If SERVER_EVENTS grows and the
      // table doesn't, tsc already fails — this asserts it at runtime too, so a `skipLibCheck`-style
      // escape can't hide a gap.
      expect(Object.keys(MINIMAL_PAYLOAD).sort()).toEqual([...SERVER_EVENTS].sort());
    });

    it.each([...SERVER_EVENTS])('normalizes %s and forwards it to the sink', async (name) => {
      const { events, sink } = collector();
      const router = new EventRouter(sink);
      const out = await router.handle(name, MINIMAL_PAYLOAD[name], 'socket');
      // A missing `case` in EventRouter.normalize falls through to `default: return null`, which
      // drops the event entirely — no DB write, no notification, no error anywhere.
      expect(out).not.toBeNull();
      expect(out?.type).toBe(name);
      expect(events).toHaveLength(1);
      expect(events[0]?.event.type).toBe(name);
    });
  });
});
