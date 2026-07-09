import { EventRouter, type NotificationIntent } from '@core/realtime';
import { buildMessageIntents } from '@/services/notifications/intents';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { NotifyingEventSink } from '@/services/realtime/notifyingEventSink';
import { setChatMute, upsertContacts } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

function wire(db: AppDatabase) {
  const intents: NotificationIntent[] = [];
  const sink = new NotifyingEventSink(new DbEventSink(db), db, buildMessageIntents, (i) =>
    intents.push(i),
  );
  return { intents, router: new EventRouter(sink) };
}

describe('NotifyingEventSink + buildMessageIntents', () => {
  it('emits a message intent for an inbound message (title/sender from data)', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      {
        guid: 'n1',
        text: 'yo',
        dateCreated: 1700000000000,
        handle: { address: 'bob@x.com', displayName: 'Bob' },
        chats: [{ guid: 'cN', displayName: 'Bob', participants: [{ address: 'bob@x.com' }] }],
      },
      'socket',
    );
    expect(intents).toHaveLength(1);
    const i = intents[0]!;
    expect(i.kind).toBe('message');
    if (i.kind === 'message') {
      expect(i.chatGuid).toBe('cN');
      expect(i.body).toBe('yo');
      expect(i.senderName).toBe('Bob');
      expect(i.isGroup).toBe(false);
    }
  });

  it('shows an attachment label (not a U+FFFC box) for an attachment-only message', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    // Attachment messages carry the object-replacement char as placeholder text — the
    // notification must not render it as a bare box.
    await router.handle(
      'new-message',
      {
        guid: 'att1',
        text: '\uFFFC',
        dateCreated: 1700000000002,
        handle: { address: 'bob@x.com', displayName: 'Bob' },
        chats: [{ guid: 'cAtt', displayName: 'Bob', participants: [{ address: 'bob@x.com' }] }],
      },
      'socket',
    );
    const i = intents[0]!;
    expect(i.kind).toBe('message');
    if (i.kind === 'message') expect(i.body).toBe('📎 Attachment');
  });

  it('strips a U+FFFC placeholder but keeps a real caption', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      {
        guid: 'att2',
        text: '\uFFFCcheck this out',
        dateCreated: 1700000000003,
        handle: { address: 'bob@x.com', displayName: 'Bob' },
        chats: [{ guid: 'cAtt2', displayName: 'Bob', participants: [{ address: 'bob@x.com' }] }],
      },
      'socket',
    );
    const i = intents[0]!;
    if (i.kind === 'message') expect(i.body).toBe('check this out');
  });

  it('uses the contact-matched name (not the bare address) when the event carries no displayName', async () => {
    const { db } = await createTestDb();
    // A device contact is synced for this number, but the inbound event has NO handle
    // displayName (the server doesn't know the device contact) — the notification must
    // still show the contact name, matching the in-app UI.
    await upsertContacts(db, [
      {
        sourceId: 'c-mom',
        displayName: 'Mom',
        givenName: null,
        familyName: null,
        phones: ['+15551234567'],
        emails: [],
        avatar: null,
      },
    ]);
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      {
        guid: 'n2',
        text: 'hi',
        dateCreated: 1700000000001,
        handle: { address: '+15551234567' }, // no displayName from the server
        chats: [{ guid: 'cMom', participants: [{ address: '+15551234567' }] }],
      },
      'socket',
    );
    const i = intents[0]!;
    expect(i.kind).toBe('message');
    if (i.kind === 'message') {
      expect(i.senderName).toBe('Mom');
      expect(i.chatTitle).toBe('Mom'); // 1:1 title falls back to the (contact) sender name
    }
  });

  it('does not notify for a muted chat (honors mute_type)', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    const msg = (guid: string, text: string) => ({
      guid,
      text,
      dateCreated: guid === 'm1' ? 1 : 2,
      handle: { address: 'bob@x.com', displayName: 'Bob' },
      chats: [{ guid: 'cMute', displayName: 'Bob', participants: [{ address: 'bob@x.com' }] }],
    });
    // The first inbound message creates the chat and notifies as usual.
    await router.handle('new-message', msg('m1', 'hi'), 'socket');
    expect(intents).toHaveLength(1);
    // Once muted, a further inbound message must NOT raise a new notification.
    await setChatMute(db, 'cMute', 'mute');
    await router.handle('new-message', msg('m2', 'still there?'), 'socket');
    expect(intents).toHaveLength(1);
  });

  it('does not notify for our own messages', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      { guid: 'mine', text: 'sent', isFromMe: true, dateCreated: 1, chats: [{ guid: 'cMe' }] },
      'socket',
    );
    expect(intents).toHaveLength(0);
  });

  it('emits a cancel intent on remote read', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      {
        guid: 's1',
        dateCreated: 1,
        handle: { address: 'a@b.com' },
        chats: [{ guid: 'cC', participants: [{ address: 'a@b.com' }] }],
      },
      'socket',
    );
    intents.length = 0;
    await router.handle('chat-read-status-changed', { chatGuid: 'cC', read: true }, 'socket');
    expect(intents).toEqual([{ kind: 'cancel', chatGuid: 'cC' }]);
  });

  it('emits an alias-removed intent when iMessage aliases are deregistered (F-6)', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'imessage-aliases-removed',
      { aliases: ['me@icloud.com', '+15551234567'] },
      'socket',
    );
    expect(intents).toEqual([
      { kind: 'alias-removed', aliases: ['me@icloud.com', '+15551234567'] },
    ]);
  });

  it('drops an aliases-removed event with no aliases', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle('imessage-aliases-removed', { aliases: [] }, 'socket');
    expect(intents).toHaveLength(0);
  });

  it('emits an rcs-bridge-down status intent from the server-supplied title/body', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'rcs-bridge-down',
      { title: 'RCS bridge down', body: 'Re-authenticate on the server.', reason: 'GAIA_LOGGED_OUT' },
      'fcm',
    );
    expect(intents).toEqual([
      { kind: 'rcs-bridge-down', title: 'RCS bridge down', body: 'Re-authenticate on the server.' },
    ]);
  });

  it('falls back to default copy when the bridge-down push omits title/body', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle('rcs-bridge-down', { reason: 'PHONE_NOT_RESPONDING' }, 'fcm');
    expect(intents).toHaveLength(1);
    expect(intents[0]?.kind).toBe('rcs-bridge-down');
  });
});
