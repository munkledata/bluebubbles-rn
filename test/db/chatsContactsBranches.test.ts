/**
 * Branch top-ups for the chats + contacts repositories: `persistServerChat`,
 * `findChatByParticipantAddresses` (incl. the phone-normalize branch), the local read/unread
 * markers (`setChatUnreadLocal`, `markAllChatsReadLocal`), the server-avatar helpers, and
 * `searchContactAddresses`'s corrupt-JSON tolerance. Real in-memory DB (createTestDb).
 */
import { Chat, Message } from '@core/models';
import {
  findChatByParticipantAddresses,
  getChatIdByGuid,
  getChatParticipants,
  handleMapKey,
  handlesNeedingAvatar,
  markAllChatsReadLocal,
  persistServerChat,
  searchContactAddresses,
  setChatUnreadLocal,
  setHandleServerAvatar,
  setLastReadMessageGuid,
  upsertChats,
  upsertContacts,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { createTestDb } from '../support/testDb';

describe('persistServerChat + findChatByParticipantAddresses', () => {
  it('persists a server chat with its participant links', async () => {
    const { db } = await createTestDb();
    await persistServerChat(
      db,
      Chat.parse({
        guid: 'g1',
        style: 43,
        participants: [{ address: '+15551112222' }, { address: 'craig@apple.com' }],
      }),
    );
    const members = (await getChatParticipants(db, 'g1')).map((m) => m.address).sort();
    expect(members).toEqual(['+15551112222', 'craig@apple.com']);
  });

  it('matches an existing chat by a phone-normalized, order-independent participant set', async () => {
    const { db } = await createTestDb();
    await persistServerChat(
      db,
      Chat.parse({
        guid: 'g1',
        style: 43,
        participants: [{ address: '+15551112222' }, { address: 'craig@apple.com' }],
      }),
    );
    // Different formatting + case + order — still the same set.
    expect(await findChatByParticipantAddresses(db, ['Craig@Apple.com', '+1 (555) 111-2222'])).toBe(
      'g1',
    );
  });

  it('returns null for an empty address list and for a non-matching set', async () => {
    const { db } = await createTestDb();
    await persistServerChat(
      db,
      Chat.parse({ guid: 'g1', style: 43, participants: [{ address: '+15551112222' }] }),
    );
    expect(await findChatByParticipantAddresses(db, [])).toBeNull();
    expect(await findChatByParticipantAddresses(db, ['+19998887777'])).toBeNull();
  });
});

describe('local read / unread markers', () => {
  async function seedChatWithMessage() {
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: '+15551112222' }]);
    const map = await upsertChats(
      db,
      [Chat.parse({ guid: 'g1', style: 43, participants: [{ address: '+15551112222' }] })],
      handles,
    );
    const chatId = map.get('g1')!;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'm1',
          text: 'hi',
          isFromMe: false,
          dateCreated: 1000,
          originalROWID: 1,
          handle: { address: '+15551112222' },
        }),
      ],
      () => chatId,
      handles,
    );
    return { db, raw };
  }

  const readGuid = (raw: import('better-sqlite3').Database) =>
    (
      raw.prepare("SELECT last_read_message_guid g FROM chats WHERE guid='g1'").get() as {
        g: string | null;
      }
    ).g;

  it('setChatUnreadLocal clears the read marker; markAllChatsReadLocal re-points it at the newest', async () => {
    const { db, raw } = await seedChatWithMessage();

    await setLastReadMessageGuid(db, 'g1', 'm1');
    expect(readGuid(raw)).toBe('m1');

    await setChatUnreadLocal(db, 'g1');
    expect(readGuid(raw)).toBeNull();

    await markAllChatsReadLocal(db);
    expect(readGuid(raw)).toBe('m1'); // newest (only) message
  });

  it('markAllChatsReadLocal marks the newest RECEIVED message, never a pending outgoing one', async () => {
    // An outgoing message is usually the newest row in its chat and carries a TEMPORARY guid that
    // gets rewritten when the send reconciles — a marker pointing at it resolves to nothing, and
    // the chat springs back to bold with its entire history unread. A send that failed offline
    // keeps that temp guid indefinitely, so one stuck send anywhere is enough.
    const { db, raw } = await seedChatWithMessage();
    const chatId = (await getChatIdByGuid(db, 'g1'))!;
    const handles = await upsertHandles(db, [{ address: '+15551112222' }]);
    await upsertMessages(
      db,
      [Message.parse({ guid: 'temp-stuck', text: 'oops', isFromMe: true, dateCreated: 5000 })],
      () => chatId,
      handles,
    );

    await markAllChatsReadLocal(db);

    expect(readGuid(raw)).toBe('m1'); // the received message, not temp-stuck
  });

  it('markAllChatsReadLocal leaves an outgoing-only chat alone instead of NULLing its marker', async () => {
    // The outer guard is narrowed the same way as the subquery: with no received message there is
    // nothing to point at, and writing NULL would mean "never read" — the same everything-unread
    // outcome, arrived at from the other direction.
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: '+15551112222' }]);
    const map = await upsertChats(
      db,
      [Chat.parse({ guid: 'g1', style: 43, participants: [{ address: '+15551112222' }] })],
      handles,
    );
    await upsertMessages(
      db,
      [Message.parse({ guid: 'temp-only', text: 'hi', isFromMe: true, dateCreated: 1000 })],
      () => map.get('g1')!,
      handles,
    );
    await setLastReadMessageGuid(db, 'g1', 'previous');

    await markAllChatsReadLocal(db);

    expect(readGuid(raw)).toBe('previous');
  });

  it('markAllChatsReadLocal also retires a deliberate "Mark as Unread"', async () => {
    const { db, raw } = await seedChatWithMessage();
    await setChatUnreadLocal(db, 'g1', 4000);

    await markAllChatsReadLocal(db);

    expect(readGuid(raw)).toBe('m1');
    expect(
      (raw.prepare("SELECT marked_unread_at t FROM chats WHERE guid='g1'").get() as { t: number })
        .t,
    ).toBeNull();
  });
});

describe('server-avatar helpers', () => {
  it('handlesNeedingAvatar lists photo-less handles; setHandleServerAvatar fills one', async () => {
    const { db } = await createTestDb();
    const ids = await upsertHandles(db, [{ address: '+15551112222' }]);
    const handleId = ids.get(handleMapKey({ address: '+15551112222' }))!;

    let needing = await handlesNeedingAvatar(db);
    expect(needing.map((h) => h.address)).toContain('+15551112222');

    await setHandleServerAvatar(db, handleId, 'file:///doc/a.img');
    needing = await handlesNeedingAvatar(db);
    expect(needing).toHaveLength(0);
    expect(await getChatIdByGuid(db, 'nope')).toBeNull(); // (unrelated null-guid path)
  });
});

describe('searchContactAddresses corrupt-JSON tolerance', () => {
  it('skips a field whose stored JSON is invalid instead of throwing', async () => {
    const { db, raw } = await createTestDb();
    await upsertContacts(db, [
      {
        sourceId: 's1',
        displayName: 'Bad Data',
        givenName: null,
        familyName: null,
        phones: [],
        emails: ['a@b.com'],
        avatar: null,
      },
    ]);
    // Corrupt the phones JSON directly — the parse() helper must swallow it.
    raw.prepare("UPDATE contacts SET phones='{not json' WHERE source_id='s1'").run();

    const out = await searchContactAddresses(db, '');
    expect(out).toEqual([{ name: 'Bad Data', address: 'a@b.com' }]);
  });
});
