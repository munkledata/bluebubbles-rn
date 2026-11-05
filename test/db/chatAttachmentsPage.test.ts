import { Attachment, Chat, Message } from '@core/models';
import {
  listChatAttachmentsPage,
  listChatLinksPage,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

const ADDRESS = 'pages@x.com';
const CHAT = 'pages-chat';

async function seed(db: AppDatabase, messages: Record<string, unknown>[]) {
  const handles = await upsertHandles(db, [{ address: ADDRESS }]);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: CHAT, participants: [{ address: ADDRESS }] })],
    handles,
  );
  const chatId = chats.get(CHAT)!;
  await upsertMessages(
    db,
    messages.map((m) => Message.parse({ handle: { address: ADDRESS }, ...m })),
    () => chatId,
    handles,
  );
}

function withFile(guid: string, date: number, mimeType: string | null, extra = {}) {
  return {
    guid: `msg-${guid}`,
    dateCreated: date,
    hasAttachments: true,
    attachments: [Attachment.parse({ guid, mimeType, transferName: `${guid}.bin`, ...extra })],
  };
}

describe('listChatAttachmentsPage', () => {
  it('puts every visible file in exactly one tab, newest first, with its message', async () => {
    const { db } = await createTestDb();
    await seed(db, [
      withFile('jpeg', 100, 'image/jpeg'),
      withFile('upper-png', 200, 'IMAGE/PNG'),
      withFile('mp4', 300, 'video/mp4'),
      withFile('upper-mov', 400, 'VIDEO/QUICKTIME'),
      withFile('tiff', 500, 'image/tiff'), // not drawn inline, so it is a file
      withFile('pdf', 600, 'application/pdf'),
      withFile('none', 700, null),
      withFile('sticker', 800, 'image/png', { isSticker: true }),
      withFile('hidden', 900, 'image/png', { hideAttachment: true }),
    ]);

    const guids = async (kind: 'photo' | 'video' | 'document') =>
      (await listChatAttachmentsPage(db, CHAT, kind)).items.map((r) => r.guid);
    expect(await guids('photo')).toEqual(['upper-png', 'jpeg']);
    expect(await guids('video')).toEqual(['upper-mov', 'mp4']);
    expect(await guids('document')).toEqual(['none', 'pdf', 'tiff']);

    const [photo] = (await listChatAttachmentsPage(db, CHAT, 'photo')).items;
    expect(photo).toMatchObject({ messageGuid: 'msg-upper-png', dateCreated: 200 });
  });

  it('grows a 50-row prefix and refuses odd limits or an unknown chat', async () => {
    const { db } = await createTestDb();
    await seed(
      db,
      Array.from({ length: 51 }, (_, i) => withFile(`p${i}`, 1_000 + i, 'image/jpeg')),
    );
    const first = await listChatAttachmentsPage(db, CHAT, 'photo');
    const second = await listChatAttachmentsPage(db, CHAT, 'photo', 100);
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(51);
    expect(second.hasMore).toBe(false);
    expect(second.items.slice(0, 50).map((r) => r.guid)).toEqual(first.items.map((r) => r.guid));
    const empty = { items: [], hasMore: false };
    await expect(listChatAttachmentsPage(db, CHAT, 'photo', 51)).resolves.toEqual(empty);
    await expect(listChatAttachmentsPage(db, 'nobody', 'photo')).resolves.toEqual(empty);
  });
});

describe('listChatLinksPage', () => {
  const text = (guid: string, date: number, body: string) => ({
    guid,
    dateCreated: date,
    text: body,
  });

  it('lists each URL once at its newest message and skips reactions and non-links', async () => {
    const { db } = await createTestDb();
    await seed(db, [
      text('old-a', 100, 'see https://a.example/x'),
      text('b', 200, 'and https://b.example'),
      text('not-a-link', 300, 'http is a protocol'),
      text('new-a', 400, 'again https://a.example/x'),
      {
        ...text('reaction', 500, 'Loved “https://c.example”'),
        associatedMessageType: 'love',
        associatedMessageGuid: 'p:0/b',
      },
    ]);
    expect(await listChatLinksPage(db, CHAT)).toEqual({
      items: [
        { url: 'https://a.example/x', messageGuid: 'new-a', dateCreated: 400 },
        { url: 'https://b.example', messageGuid: 'b', dateCreated: 200 },
      ],
      hasMore: false,
    });
  });

  it('pages by candidate message, so a page of repeats still says more remain', async () => {
    const { db } = await createTestDb();
    await seed(db, [
      text('oldest', 1, 'first https://old.example'),
      ...Array.from({ length: 50 }, (_, i) => text(`dup-${i}`, 100 + i, 'https://same.example')),
    ]);
    const first = await listChatLinksPage(db, CHAT);
    expect(first.items.map((l) => l.url)).toEqual(['https://same.example']);
    expect(first.hasMore).toBe(true);
    const second = await listChatLinksPage(db, CHAT, 100);
    expect(second.items.map((l) => l.url)).toEqual(['https://same.example', 'https://old.example']);
    expect(second.hasMore).toBe(false);
  });
});
