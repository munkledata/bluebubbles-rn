import { Chat, Message } from '@core/models';
import {
  getMessagePreviewByGuid,
  getVisibleAttachmentByGuid,
  listAttachmentsByMessageIds,
  listChatAttachmentsByKind,
  listChatImageAttachmentsByAttachmentGuid,
  listChatsForInbox,
  listMessagesWithSenders,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { interactiveMessageLabel } from '@utils';
import { createTestDb } from '../support/testDb';

const HANDWRITING = 'com.apple.Handwriting.HandwritingProvider';

async function seedChat(db: AppDatabase): Promise<number> {
  const handles = await upsertHandles(db, [{ address: 'a@example.com' }]);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: 'chat-balloon', participants: [{ address: 'a@example.com' }] })],
    handles,
  );
  return chats.get('chat-balloon')!;
}

describe('balloon bundle identity persistence', () => {
  it('round-trips into every preview and never re-exposes a hydrated plugin attachment', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db);

    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'balloon-message',
          dateCreated: 100,
          balloonBundleId: HANDWRITING,
          // Lean events can omit hideAttachment. The owning balloon id must still keep this
          // extension image and its private description out of every user-facing media surface.
          attachments: [
            {
              guid: 'plugin-payload',
              mimeType: 'image/jpeg',
              totalBytes: 1_000,
              emojiImageShortDescription: 'private extension payload description',
            },
          ],
        }),
      ],
      () => chatId,
      new Map(),
    );

    let row = (await listMessagesWithSenders(db, chatId))[0]!;
    expect(row).toMatchObject({
      balloonBundleId: HANDWRITING,
      hasVisibleAttachments: 0,
      attachmentDescription: null,
    });
    await expect(getMessagePreviewByGuid(db, row.guid)).resolves.toMatchObject({
      balloonBundleId: HANDWRITING,
      hasVisibleAttachments: 0,
      attachmentDescription: null,
    });
    await expect(listChatsForInbox(db)).resolves.toEqual([
      expect.objectContaining({
        lastBalloonBundleId: HANDWRITING,
        lastHasVisibleAttachments: 0,
        lastAttachmentDescription: null,
      }),
    ]);
    await expect(
      listAttachmentsByMessageIds(db, [row.id], undefined, { excludePluginPayloads: true }),
    ).resolves.toEqual(new Map());
    await expect(getVisibleAttachmentByGuid(db, 'plugin-payload')).resolves.toBeNull();
    await expect(listChatImageAttachmentsByAttachmentGuid(db, 'plugin-payload')).resolves.toEqual({
      items: [],
      index: -1,
    });
    await expect(listChatAttachmentsByKind(db, 'chat-balloon')).resolves.toMatchObject({
      photos: [],
      videos: [],
      documents: [],
    });

    // A full sync learns that the notification-shaped attachment was hidden. A later lean update
    // may omit both fields, so both the message identity and hidden bit are monotonic.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'balloon-message',
          dateCreated: 100,
          dateRead: 200,
          attachments: [{ guid: 'plugin-payload', hideAttachment: true }],
        }),
      ],
      () => chatId,
      new Map(),
    );
    row = (await listMessagesWithSenders(db, chatId))[0]!;
    expect(row.balloonBundleId).toBe(HANDWRITING);
    const attachments = await listAttachmentsByMessageIds(db, [row.id]);
    expect(attachments.get(row.id)?.[0]?.hideAttachment).toBe(1);

    const malformed = Message.parse({
      guid: 'malformed-balloon',
      balloonBundleId: 'private-raw-id-'.repeat(40),
    });
    expect(malformed.balloonBundleId).not.toContain('private-raw-id');
    expect(interactiveMessageLabel(malformed.balloonBundleId)).toBe('Interactive message');

    // SQLite length(TEXT) treats U+0000 specially. Normalizing it before persistence proves the
    // model and the bounded database column agree instead of failing only at INSERT time.
    const nulIdentifier = Message.parse({
      guid: 'nul-balloon',
      dateCreated: 50,
      balloonBundleId: 'private\0raw-id',
    });
    expect(nulIdentifier.balloonBundleId).not.toContain('private');
    await expect(
      upsertMessages(db, [nulIdentifier], () => chatId, new Map()),
    ).resolves.toBeDefined();
    await expect(getMessagePreviewByGuid(db, 'nul-balloon')).resolves.toMatchObject({
      balloonBundleId: expect.any(String),
    });
  });
});
