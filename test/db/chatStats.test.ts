import { Chat, Message } from '@core/models';
import { getChatStats, upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import { createTestDb } from '../support/testDb';

type Db = Awaited<ReturnType<typeof createTestDb>>;
const ADDRESS = '+15551234567';

async function seed(t: Db, guid: string) {
  const handles = await upsertHandles(t.db, [{ address: ADDRESS }]);
  const map = await upsertChats(
    t.db,
    [Chat.parse({ guid, style: 45, participants: [{ address: ADDRESS }] })],
    handles,
  );
  const chatId = map.get(guid)!;
  const add = (items: Parameters<typeof Message.parse>[0][]) =>
    upsertMessages(
      t.db,
      items.map((m) => Message.parse(m)),
      () => chatId,
      handles,
    );
  return { chatId, add };
}

function attach(t: Db, messageGuid: string, guid: string, mimeType: string | null, extra = '') {
  const id = (
    t.raw.prepare('SELECT id FROM messages WHERE guid = ?').get(messageGuid) as { id: number }
  ).id;
  t.raw
    .prepare(
      `INSERT INTO attachments (guid, message_id, mime_type, transfer_name${extra ? `, ${extra}` : ''})
       VALUES (?, ?, ?, ?${extra ? ', 1' : ''})`,
    )
    .run(guid, id, mimeType, `${guid}.bin`);
}

describe('getChatStats', () => {
  it('counts only visible messages and real user files, sorted like the media lists', async () => {
    const t = await createTestDb();
    const { add } = await seed(t, 'iMessage;-;+15551234567');
    const msg = (guid: string, date: number, fromMe = false, more = {}) => ({
      guid,
      text: 'hi',
      isFromMe: fromMe,
      dateCreated: date,
      originalROWID: date,
      handle: fromMe ? null : { address: ADDRESS },
      ...more,
    });
    await add([
      msg('m1', 1_000),
      msg('m2', 2_000, true),
      msg('m3', 3_000, true),
      msg('m4', 4_000),
      // Excluded: a reaction, a group event, a deleted message.
      msg('r1', 5_000, false, { associatedMessageType: 'love', associatedMessageGuid: 'p:0/m1' }),
      msg('g1', 6_000, false, { itemType: 1, groupActionType: 0 }),
      msg('d1', 500),
    ]);
    t.raw.prepare('UPDATE messages SET date_deleted = 9999 WHERE guid = ?').run('d1');

    attach(t, 'm1', 'a1', 'image/jpeg');
    attach(t, 'm1', 'a2', 'IMAGE/PNG');
    attach(t, 'm2', 'a3', 'video/quicktime');
    attach(t, 'm3', 'a4', 'application/pdf');
    attach(t, 'm3', 'a5', null);
    attach(t, 'm4', 's1', 'image/png', 'is_sticker'); // sticker: excluded
    attach(t, 'm4', 'h1', 'image/png', 'hide_attachment'); // hidden: excluded
    attach(t, 'd1', 'x1', 'image/png'); // on a deleted message: excluded

    expect(await getChatStats(t.db, 'iMessage;-;+15551234567')).toEqual({
      sent: 2,
      received: 2,
      photos: 2,
      videos: 1,
      otherFiles: 2,
      firstMessageAt: 1_000,
    });
  });

  it('is all zeros for an empty or unknown chat', async () => {
    const t = await createTestDb();
    await seed(t, 'iMessage;-;+15551234567');
    const empty = {
      sent: 0,
      received: 0,
      photos: 0,
      videos: 0,
      otherFiles: 0,
      firstMessageAt: null,
    };
    expect(await getChatStats(t.db, 'iMessage;-;+15551234567')).toEqual(empty);
    expect(await getChatStats(t.db, 'iMessage;-;nobody')).toEqual(empty);
  });

  it("never counts another chat's messages", async () => {
    const t = await createTestDb();
    const a = await seed(t, 'iMessage;-;+15551234567');
    await a.add([
      {
        guid: 'only-a',
        text: 'x',
        isFromMe: true,
        dateCreated: 1,
        originalROWID: 1,
        handle: null,
      },
    ]);
    const handles = await upsertHandles(t.db, [{ address: '+15557654321' }]);
    await upsertChats(
      t.db,
      [
        Chat.parse({
          guid: 'iMessage;-;+15557654321',
          style: 45,
          participants: [{ address: '+15557654321' }],
        }),
      ],
      handles,
    );
    expect((await getChatStats(t.db, 'iMessage;-;+15557654321')).sent).toBe(0);
  });
});
