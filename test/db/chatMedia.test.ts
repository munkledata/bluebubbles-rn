import { Attachment, Chat, Message } from '@core/models';
import {
  listChatAttachmentsByKind,
  listChatDocumentAttachmentsPage,
  listChatImageAttachmentsByAttachmentGuid,
  updateAttachmentLocalPath,
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

describe('listChatDocumentAttachmentsPage (FEAT-07A)', () => {
  it('grows a stable 50-row prefix, orders null dates last, and refreshes local paths', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'docs@x.com' }]);
    const chats = await upsertChats(
      db,
      [Chat.parse({ guid: 'docs-chat', participants: [{ address: 'docs@x.com' }] })],
      handles,
    );
    const chatId = chats.get('docs-chat')!;
    const documentMessages = Array.from({ length: 52 }, (_, index) =>
      Message.parse({
        guid: `doc-message-${index}`,
        dateCreated: index === 0 ? null : index >= 50 ? 5_000 : index * 100,
        hasAttachments: true,
        handle: { address: 'docs@x.com' },
        attachments: [
          Attachment.parse({
            guid: `doc-attachment-${index}`,
            mimeType: 'application/pdf',
            transferName: `document-${index}.pdf`,
            totalBytes: index + 100,
          }),
        ],
      }),
    );
    await upsertMessages(db, documentMessages, () => chatId, handles);

    const first = await listChatDocumentAttachmentsPage(db, 'docs-chat');
    const second = await listChatDocumentAttachmentsPage(db, 'docs-chat', 100);

    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(52);
    expect(second.hasMore).toBe(false);
    expect(second.items.slice(0, 50).map((row) => row.guid)).toEqual(
      first.items.map((row) => row.guid),
    );
    expect(second.items.slice(0, 2).map((row) => row.guid)).toEqual([
      'doc-attachment-51',
      'doc-attachment-50',
    ]);
    expect(second.items.at(-1)?.guid).toBe('doc-attachment-0');

    await updateAttachmentLocalPath(db, 'doc-attachment-25', 'file:///documents/25.pdf');
    const refreshed = await listChatDocumentAttachmentsPage(db, 'docs-chat', 100);
    expect(refreshed.items.find((row) => row.guid === 'doc-attachment-25')?.localPath).toBe(
      'file:///documents/25.pdf',
    );
    await expect(listChatDocumentAttachmentsPage(db, 'docs-chat', 51)).resolves.toEqual({
      items: [],
      hasMore: false,
    });
  });

  it('finds an old document behind a photo-heavy strip and excludes private or deleted rows', async () => {
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'mixed@x.com' }]);
    const chats = await upsertChats(
      db,
      [
        Chat.parse({ guid: 'mixed-chat', participants: [{ address: 'mixed@x.com' }] }),
        Chat.parse({ guid: 'hidden-chat', participants: [{ address: 'mixed@x.com' }] }),
      ],
      handles,
    );
    const mixedChatId = chats.get('mixed-chat')!;
    const hiddenChatId = chats.get('hidden-chat')!;
    const photos = Array.from({ length: 241 }, (_, index) =>
      Message.parse({
        guid: `recent-photo-message-${index}`,
        dateCreated: index + 100,
        hasAttachments: true,
        handle: { address: 'mixed@x.com' },
        attachments: [
          Attachment.parse({
            guid: `recent-photo-${index}`,
            mimeType: 'image/jpeg',
            transferName: `photo-${index}.jpg`,
          }),
        ],
      }),
    );
    const documents = [
      ['visible', null, false, false],
      ['sticker', 'application/pdf', true, false],
      ['hidden', 'application/pdf', false, true],
      ['plugin', 'application/pdf', false, false],
      ['deleted', 'application/pdf', false, false],
      ['retracted', 'application/pdf', false, false],
      ['video', 'video/mp4', false, false],
      ['uppercase-image', 'IMAGE/JPEG', false, false],
    ] as const;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'old-document-message',
          dateCreated: 1,
          hasAttachments: true,
          handle: { address: 'mixed@x.com' },
          attachments: [
            Attachment.parse({
              guid: 'old-document',
              mimeType: 'application/pdf',
              transferName: 'old.pdf',
            }),
          ],
        }),
        ...photos,
        ...documents.map(([name, mimeType, isSticker, hideAttachment], index) =>
          Message.parse({
            guid: `${name}-document-message`,
            dateCreated: 1_000 + index,
            hasAttachments: true,
            handle: { address: 'mixed@x.com' },
            attachments: [
              Attachment.parse({
                guid: `${name}-document`,
                mimeType,
                transferName: `${name}.bin`,
                isSticker,
                hideAttachment,
              }),
            ],
          }),
        ),
      ],
      () => mixedChatId,
      handles,
    );
    raw
      .prepare("UPDATE messages SET balloon_bundle_id = 'private.plugin' WHERE guid = ?")
      .run('plugin-document-message');
    raw
      .prepare('UPDATE messages SET date_deleted = 2000 WHERE guid = ?')
      .run('deleted-document-message');
    raw
      .prepare('UPDATE messages SET date_retracted = 2000 WHERE guid = ?')
      .run('retracted-document-message');
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'hidden-chat-document-message',
          dateCreated: 10,
          hasAttachments: true,
          handle: { address: 'mixed@x.com' },
          attachments: [
            Attachment.parse({ guid: 'hidden-chat-document', mimeType: 'application/pdf' }),
          ],
        }),
        Message.parse({
          guid: 'hidden-chat-null-date-document-message',
          dateCreated: null,
          hasAttachments: true,
          handle: { address: 'mixed@x.com' },
          attachments: [
            Attachment.parse({
              guid: 'hidden-chat-null-date-document',
              mimeType: 'application/pdf',
            }),
          ],
        }),
        Message.parse({
          guid: 'visible-after-chat-delete-document-message',
          dateCreated: 30,
          hasAttachments: true,
          handle: { address: 'mixed@x.com' },
          attachments: [
            Attachment.parse({
              guid: 'visible-after-chat-delete-document',
              mimeType: 'application/pdf',
            }),
          ],
        }),
      ],
      () => hiddenChatId,
      handles,
    );
    raw.prepare('UPDATE chats SET deleted_at = 20 WHERE guid = ?').run('hidden-chat');

    const strip = await listChatAttachmentsByKind(db, 'mixed-chat');
    const page = await listChatDocumentAttachmentsPage(db, 'mixed-chat');

    // The legacy mixed strip classifies MIME values case-sensitively; the dedicated explorer owns
    // the stricter normalized exclusion so an uppercase image never appears as a document there.
    expect(strip.documents.map((row) => row.guid)).toEqual([
      'uppercase-image-document',
      'visible-document',
    ]);
    expect(page.items.map((row) => row.guid)).toEqual(['visible-document', 'old-document']);
    const revivedChatPage = await listChatDocumentAttachmentsPage(db, 'hidden-chat');
    expect(revivedChatPage.items.map((row) => row.guid)).toEqual([
      'visible-after-chat-delete-document',
    ]);
    expect(revivedChatPage.hasMore).toBe(false);
  });
});

describe('listChatImageAttachmentsByAttachmentGuid (fullscreen carousel)', () => {
  async function seedImages(db: AppDatabase): Promise<void> {
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
          guid: 'm1',
          dateCreated: 100,
          hasAttachments: true,
          handle: { address: 'a@x.com' },
          attachments: [Attachment.parse({ guid: 'img-1', mimeType: 'image/jpeg' })],
        }),
        Message.parse({
          guid: 'm2',
          dateCreated: 200,
          hasAttachments: true,
          handle: { address: 'a@x.com' },
          attachments: [Attachment.parse({ guid: 'img-2', mimeType: 'image/png' })],
        }),
        Message.parse({
          guid: 'm3',
          dateCreated: 300,
          hasAttachments: true,
          handle: { address: 'a@x.com' },
          attachments: [Attachment.parse({ guid: 'img-3', mimeType: 'image/heic' })],
        }),
        // A video is NOT part of the image carousel.
        Message.parse({
          guid: 'mv',
          dateCreated: 250,
          hasAttachments: true,
          handle: { address: 'a@x.com' },
          attachments: [Attachment.parse({ guid: 'vid-1', mimeType: 'video/mp4' })],
        }),
      ],
      () => chatId,
      handles,
    );
  }

  it('lists all chat images chronologically with the tapped one indexed, excluding video', async () => {
    const { db } = await createTestDb();
    await seedImages(db);

    const g = await listChatImageAttachmentsByAttachmentGuid(db, 'img-2');
    expect(g.items.map((a) => a.guid)).toEqual(['img-1', 'img-2', 'img-3']); // chronological
    expect(g.index).toBe(1); // the tapped photo
    expect(g.items.some((a) => a.guid === 'vid-1')).toBe(false); // video excluded
  });
});
