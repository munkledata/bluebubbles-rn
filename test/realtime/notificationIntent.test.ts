import {
  EventRouter,
  type EventDeliveryContext,
  type EventSink,
  type NotificationIntent,
} from '@core/realtime';
import { buildMessageIntents } from '@/services/notifications/intents';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { NotifyingEventSink } from '@/services/realtime/notifyingEventSink';
import { setChatMute, upsertContacts } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

function wire(db: AppDatabase) {
  const intents: NotificationIntent[] = [];
  const sink = new NotifyingEventSink(new DbEventSink(db), db, buildMessageIntents, (i) => {
    intents.push(i);
  });
  return { intents, router: new EventRouter(sink) };
}

describe('NotifyingEventSink + buildMessageIntents', () => {
  it('does not present an intent when Disconnect invalidates the generation during derivation', async () => {
    let current = true;
    const context: EventDeliveryContext = { generation: 9, isCurrent: () => current };
    const inner: EventSink = { onEvent: jest.fn(async () => undefined) };
    const build = jest.fn(async () => {
      current = false;
      return [{ kind: 'test' } as unknown as NotificationIntent];
    });
    const notify = jest.fn(async () => undefined);
    const sink = new NotifyingEventSink(inner, {} as AppDatabase, build, notify);

    await sink.onEvent(
      { type: 'imessage-aliases-removed', payload: { aliases: [] } },
      'socket',
      context,
    );

    expect(inner.onEvent).toHaveBeenCalledWith(
      { type: 'imessage-aliases-removed', payload: { aliases: [] } },
      'socket',
      context,
    );
    expect(build).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps the event in flight until asynchronous notification presentation settles', async () => {
    const { db } = await createTestDb();
    let release!: () => void;
    const presentation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notify = jest.fn(() => presentation);
    const sink = new NotifyingEventSink(new DbEventSink(db), db, buildMessageIntents, notify);
    const router = new EventRouter(sink);
    const context: EventDeliveryContext = { generation: 3, isCurrent: () => true };
    let finished = false;

    const handled = router
      .handle(
        'new-message',
        {
          guid: 'tracked-notification',
          text: 'wait for native presentation',
          dateCreated: 1,
          handle: { address: 'a@b.com' },
          chats: [{ guid: 'cTracked', participants: [{ address: 'a@b.com' }] }],
        },
        'fcm',
        context,
      )
      .then(() => {
        finished = true;
      });
    for (let i = 0; i < 20 && notify.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.any(Object), context);
    expect(finished).toBe(false);

    release();
    await handled;
    expect(finished).toBe(true);
  });

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

  it('does not resurrect a notification after the message was read before presentation retry', async () => {
    const { db } = await createTestDb();
    const { router } = wire(db);
    const event = await router.handle(
      'new-message',
      {
        guid: 'read-before-retry',
        text: 'already seen',
        dateCreated: 100,
        handle: { address: 'reader@x.com' },
        chats: [{ guid: 'cReadRetry', participants: [{ address: 'reader@x.com' }] }],
      },
      'socket',
    );
    await router.handle(
      'chat-read-status-changed',
      { chatGuid: 'cReadRetry', read: true },
      'socket',
    );

    expect(await buildMessageIntents(db, event!)).toEqual([]);
  });

  it('does not resurrect a notification after the message was deleted before presentation retry', async () => {
    const { db } = await createTestDb();
    const { router } = wire(db);
    const event = await router.handle(
      'new-message',
      {
        guid: 'deleted-before-retry',
        text: 'gone now',
        dateCreated: 200,
        handle: { address: 'deleter@x.com' },
        chats: [{ guid: 'cDeleteRetry', participants: [{ address: 'deleter@x.com' }] }],
      },
      'socket',
    );
    await router.handle(
      'message-deleted',
      { guid: 'deleted-before-retry', chatGuid: 'cDeleteRetry', dateDeleted: 300 },
      'socket',
    );

    expect(await buildMessageIntents(db, event!)).toEqual([]);
  });

  it.each([
    ['payload chat guid', { guid: 'delete-cancel-with-chat', chatGuid: 'cDeleteCancel' }],
    ['row-resolved chat guid', { guid: 'delete-cancel-without-chat' }],
    [
      'row owner instead of stale payload metadata',
      { guid: 'delete-cancel-stale-chat', chatGuid: 'cWrong' },
    ],
  ])('withdraws an existing notification after deletion using the %s', async (_label, deletion) => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      {
        guid: deletion.guid,
        text: 'remove this notification',
        dateCreated: 250,
        handle: { address: 'delete@x.com' },
        chats: [{ guid: 'cDeleteCancel', participants: [{ address: 'delete@x.com' }] }],
      },
      'socket',
    );
    expect(intents.at(-1)?.kind).toBe('message');
    intents.length = 0;

    await router.handle('message-deleted', { ...deletion, dateDeleted: 300 }, 'socket');

    expect(intents).toEqual([
      {
        kind: 'message-withdraw',
        chatGuid: 'cDeleteCancel',
        messageGuid: deletion.guid,
      },
    ]);
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
        attachments: [{ guid: 'att1-image', mimeType: 'image/jpeg' }],
      },
      'socket',
    );
    const i = intents[0]!;
    expect(i.kind).toBe('message');
    // No Genmoji description present → the generic label is the deliberate fallback (a Genmoji
    // attachment WOULD supply a description; see the Genmoji cases below).
    if (i.kind === 'message') expect(i.body).toBe('📎 Attachment');
  });

  it('uses the Genmoji description as the body for an attachment-only Genmoji message', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      {
        guid: 'gm1',
        text: '\uFFFC', // attachment placeholder only — no real caption
        dateCreated: 1700000000010,
        handle: { address: 'bob@x.com', displayName: 'Bob' },
        chats: [{ guid: 'cGen', displayName: 'Bob', participants: [{ address: 'bob@x.com' }] }],
        attachments: [
          {
            guid: 'gm-att',
            mimeType: 'image/png',
            emojiImageContentIdentifier: 'gm-xyz',
            emojiImageShortDescription: 'a smiling cat wearing a top hat',
          },
        ],
      },
      'socket',
    );
    const i = intents[0]!;
    expect(i.kind).toBe('message');
    // Ordinary unlocked notifications use this detailed Genmoji body. App Lock presentation is a
    // separate policy covered in notifeeService.test, which asserts the fixed generic notice.
    if (i.kind === 'message') expect(i.body).toBe('a smiling cat wearing a top hat');
  });

  it('prefers a real caption over the Genmoji description (description is only the fallback)', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      {
        guid: 'gm2',
        text: '\uFFFClook at this',
        dateCreated: 1700000000011,
        handle: { address: 'bob@x.com', displayName: 'Bob' },
        chats: [{ guid: 'cGen2', displayName: 'Bob', participants: [{ address: 'bob@x.com' }] }],
        attachments: [
          {
            guid: 'gm-att2',
            mimeType: 'image/png',
            emojiImageContentIdentifier: 'gm-xyz',
            emojiImageShortDescription: 'a smiling cat wearing a top hat',
          },
        ],
      },
      'socket',
    );
    const i = intents[0]!;
    if (i.kind === 'message') expect(i.body).toBe('look at this');
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

  it("carries the sender's contact photo so the expanded notification shows it (not a placeholder)", async () => {
    const { db } = await createTestDb();
    await upsertContacts(db, [
      {
        sourceId: 'c-dad',
        displayName: 'Dad',
        givenName: null,
        familyName: null,
        phones: ['+15559876543'],
        emails: [],
        avatar: 'file:///contacts/dad.png',
      },
    ]);
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      {
        guid: 'n3',
        text: 'call me',
        dateCreated: 1700000000002,
        handle: { address: '+15559876543' },
        chats: [{ guid: 'cDad', participants: [{ address: '+15559876543' }] }],
      },
      'socket',
    );
    const i = intents[0]!;
    expect(i.kind).toBe('message');
    if (i.kind === 'message') {
      expect(i.avatarUri).toBe('file:///contacts/dad.png');
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

  it('does not raise a message notice for our own message and only withdraws a prior failure notice', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      { guid: 'mine', text: 'sent', isFromMe: true, dateCreated: 1, chats: [{ guid: 'cMe' }] },
      'socket',
    );
    expect(intents).toEqual([
      { kind: 'send-failure-cancel', chatGuid: 'cMe', messageGuid: 'mine' },
    ]);
  });

  it('derives a generic failed-send intent only after the server error is committed to the DB', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      {
        guid: 'outgoing-server-error',
        text: 'PRIVATE_MESSAGE_BODY_CANARY',
        isFromMe: true,
        dateCreated: 1,
        chats: [{ guid: 'private-server-chat-guid' }],
      },
      'socket',
    );
    intents.length = 0;

    await router.handle(
      'message-send-error',
      {
        tempGuid: 'missing-first-candidate',
        guid: 'outgoing-server-error',
        error: 22,
        errorMessage: 'PRIVATE_SERVER_ERROR_DETAIL_CANARY',
      },
      'socket',
    );

    expect(intents).toEqual([
      {
        kind: 'send-failure',
        chatGuid: 'private-server-chat-guid',
        messageGuid: 'outgoing-server-error',
      },
    ]);
    expect(JSON.stringify(intents)).not.toMatch(
      /PRIVATE_MESSAGE_BODY_CANARY|PRIVATE_SERVER_ERROR_DETAIL_CANARY/,
    );
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

  it('withdraws only the unsent message line (updated-message with dateRetracted)', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    // Seed the chat with an inbound message (creates the chat + its notify intent).
    await router.handle(
      'new-message',
      {
        guid: 'u1',
        text: 'oops',
        dateCreated: 1,
        handle: { address: 'a@b.com' },
        chats: [{ guid: 'cU', participants: [{ address: 'a@b.com' }] }],
      },
      'socket',
    );
    intents.length = 0;
    // The sender unsends it → real FCM carries a LEAN updated-message with no chats/chatGuid.
    // The sink + intent builder recover the owner from the existing message row and withdraw the
    // per-chat notification.
    await router.handle(
      'updated-message',
      {
        guid: 'u1',
        text: null,
        dateRetracted: 1700000000000,
        dateCreated: 1,
      },
      'fcm',
    );
    expect(intents).toEqual([{ kind: 'message-withdraw', chatGuid: 'cU', messageGuid: 'u1' }]);
  });

  it('does NOT touch notifications for an ordinary updated-message (edit / receipt, no dateRetracted)', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      {
        guid: 'u2',
        text: 'hi',
        dateCreated: 1,
        handle: { address: 'a@b.com' },
        chats: [{ guid: 'cU2', participants: [{ address: 'a@b.com' }] }],
      },
      'socket',
    );
    intents.length = 0;
    // An edit / delivery update (no dateRetracted) must produce NO intent — neither a new
    // notification nor a cancel.
    await router.handle(
      'updated-message',
      {
        guid: 'u2',
        text: 'hi (edited)',
        dateEdited: 1700000000000,
        dateCreated: 1,
        handle: { address: 'a@b.com' },
        chats: [{ guid: 'cU2', participants: [{ address: 'a@b.com' }] }],
      },
      'socket',
    );
    expect(intents).toHaveLength(0);
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
      {
        title: 'RCS bridge down',
        body: 'Re-authenticate on the server.',
        reason: 'GAIA_LOGGED_OUT',
      },
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

/**
 * REGRESSION: `test-notification` (the server's "Send Test Notification" button) had no entry in
 * SERVER_EVENTS and no `normalize()` case, so the router dropped it at `default: return null`.
 * The server reported `sent: N, failed: 0` while the device showed nothing — the one end-to-end
 * probe of the push chain could only ever produce a false negative.
 */
describe('buildMessageIntents — test-notification (server push self-test)', () => {
  it('emits a status intent from the server-supplied title/body', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'test-notification',
      { title: 'Gator', body: 'Test notification from your Gator server 🐊' },
      'fcm',
    );
    expect(intents).toEqual([
      {
        kind: 'test-notification',
        title: 'Gator',
        body: 'Test notification from your Gator server 🐊',
      },
    ]);
  });

  it('falls back to default copy when the push omits title/body', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle('test-notification', {}, 'fcm');
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: 'test-notification', title: 'Gator' });
  });

  it('is delivered over the socket too, not just FCM', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle('test-notification', { title: 'T', body: 'B' }, 'socket');
    expect(intents).toEqual([{ kind: 'test-notification', title: 'T', body: 'B' }]);
  });
});
