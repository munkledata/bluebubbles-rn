import { Attachment, Chat, Message } from '@core/models';
import {
  listChatAttachmentsByKind,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seed(db: AppDatabase): Promise<number> {
  const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@x.com' }] })],
    handles,
  );
  const chatId = map.get('c1')!;
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'm-photo',
        dateCreated: 100,
        hasAttachments: true,
        handle: { address: 'a@x.com' },
        attachments: [
          Attachment.parse({ guid: 'a-photo', mimeType: 'image/jpeg', transferName: 'p.jpg' }),
        ],
      }),
      Message.parse({
        guid: 'm-video',
        dateCreated: 200,
        hasAttachments: true,
        handle: { address: 'a@x.com' },
        attachments: [
          Attachment.parse({ guid: 'a-video', mimeType: 'video/mp4', transferName: 'v.mp4' }),
        ],
      }),
      Message.parse({
        guid: 'm-doc',
        dateCreated: 300,
        hasAttachments: true,
        handle: { address: 'a@x.com' },
        attachments: [
          Attachment.parse({ guid: 'a-doc', mimeType: 'application/pdf', transferName: 'd.pdf' }),
        ],
      }),
      Message.parse({
        guid: 'm-sticker',
        dateCreated: 350,
        hasAttachments: true,
        handle: { address: 'a@x.com' },
        attachments: [
          Attachment.parse({ guid: 'a-sticker', mimeType: 'image/png', isSticker: true }),
        ],
      }),
      Message.parse({
        guid: 'm-hidden',
        dateCreated: 360,
        hasAttachments: true,
        handle: { address: 'a@x.com' },
        // A rich-link/plugin-payload attachment (URL preview) — hidden, never a real file.
        attachments: [
          Attachment.parse({
            guid: 'a-hidden',
            mimeType: 'application/octet-stream',
            transferName: 'x.pluginPayloadAttachment',
            hideAttachment: true,
          }),
        ],
      }),
      Message.parse({
        guid: 'm-link1',
        text: 'check https://example.com/a out',
        dateCreated: 400,
        handle: { address: 'a@x.com' },
      }),
      Message.parse({
        guid: 'm-link2',
        text: 'and https://example.com/a again (dup)',
        dateCreated: 500,
        handle: { address: 'a@x.com' },
      }),
      Message.parse({
        guid: 'm-link3',
        text: 'a fresh one https://other.test/path',
        dateCreated: 600,
        handle: { address: 'a@x.com' },
      }),
      Message.parse({
        guid: 'm-plain',
        text: 'no link here',
        dateCreated: 700,
        handle: { address: 'a@x.com' },
      }),
    ],
    () => chatId,
    handles,
  );
  return chatId;
}

describe('listChatAttachmentsByKind (2.1)', () => {
  it('buckets attachments by media kind and excludes stickers + hidden attachments', async () => {
    const { db } = await createTestDb();
    await seed(db);

    const media = await listChatAttachmentsByKind(db, 'c1');

    expect(media.photos.map((a) => a.guid)).toEqual(['a-photo']);
    expect(media.videos.map((a) => a.guid)).toEqual(['a-video']);
    expect(media.documents.map((a) => a.guid)).toEqual(['a-doc']);
    // The sticker is not surfaced as a photo.
    expect(media.photos.some((a) => a.guid === 'a-sticker')).toBe(false);
    // The hidden rich-link payload is not surfaced as a document.
    expect(media.documents.some((a) => a.guid === 'a-hidden')).toBe(false);
  });

  it('extracts links from message text, newest-first, deduped by url', async () => {
    const { db } = await createTestDb();
    await seed(db);

    const media = await listChatAttachmentsByKind(db, 'c1');

    // newest-first: other.test (600) before example.com (the 500 dup collapses into one).
    expect(media.links.map((l) => l.url)).toEqual([
      'https://other.test/path',
      'https://example.com/a',
    ]);
    expect(media.links[1]!.messageGuid).toBe('m-link2'); // most-recent occurrence wins
  });

  it('returns empty buckets for a chat with no media', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'b@x.com' }]);
    await upsertChats(
      db,
      [Chat.parse({ guid: 'empty', participants: [{ address: 'b@x.com' }] })],
      handles,
    );

    const media = await listChatAttachmentsByKind(db, 'empty');

    expect(media).toEqual({ photos: [], videos: [], documents: [], links: [] });
  });
});
