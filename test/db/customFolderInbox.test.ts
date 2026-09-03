import { Chat, Message } from '@core/models';
import {
  createCustomFolder,
  listCustomFolderInboxPageWithinTransaction,
  replaceCustomFolderMembership,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { createTestDb } from '../support/testDb';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

interface SeedMessage {
  guid: string;
  text: string;
  date: number;
  associatedMessageType?: string;
  dateRetracted?: number;
  dateDeleted?: number;
}

async function seedChat(
  t: TestDb,
  guid: string,
  options: {
    displayName?: string;
    participant?: string;
    archived?: boolean;
    pinned?: boolean;
    messages: SeedMessage[];
  },
): Promise<void> {
  const participant = options.participant ?? `${guid}@example.test`;
  const handles = await upsertHandles(t.db, [{ address: participant }]);
  const chatIds = await upsertChats(
    t.db,
    [
      Chat.parse({
        guid,
        displayName: options.displayName ?? null,
        style: 45,
        isArchived: options.archived ?? false,
        isPinned: options.pinned ?? false,
        participants: [{ address: participant }],
      }),
    ],
    handles,
  );
  const chatId = chatIds.get(guid)!;
  await upsertMessages(
    t.db,
    options.messages.map((message) =>
      Message.parse({
        guid: message.guid,
        text: message.text,
        dateCreated: message.date,
        originalROWID: message.date,
        isFromMe: false,
        handle: { address: participant },
        associatedMessageType: message.associatedMessageType ?? null,
        dateRetracted: message.dateRetracted ?? null,
      }),
    ),
    () => chatId,
    handles,
  );
  for (const message of options.messages) {
    if (message.dateDeleted != null) {
      t.raw
        .prepare('UPDATE messages SET date_deleted = ? WHERE guid = ?')
        .run(message.dateDeleted, message.guid);
    }
  }
}

function loadFolderPage(t: TestDb, folderId: number, limit: number, searchText = '') {
  return withDbTransaction(t.db, (context) =>
    listCustomFolderInboxPageWithinTransaction(context, folderId, limit, searchText),
  );
}

describe('listCustomFolderInboxPageWithinTransaction', () => {
  it('keeps durable membership counts while paging every visible member in inbox order', async () => {
    const t = await createTestDb();
    await seedChat(t, 'pinned-second', {
      pinned: true,
      messages: [{ guid: 'pinned-second-message', text: 'second pin', date: 900 }],
    });
    await seedChat(t, 'pinned-first', {
      pinned: true,
      messages: [{ guid: 'pinned-first-message', text: 'first pin', date: 100 }],
    });
    await seedChat(t, 'archived-newest', {
      archived: true,
      messages: [{ guid: 'archived-message', text: 'archived', date: 800 }],
    });
    await seedChat(t, 'active-older', {
      messages: [{ guid: 'active-message', text: 'active', date: 700 }],
    });
    await seedChat(t, 'locally-hidden', {
      messages: [{ guid: 'hidden-message', text: 'hidden', date: 600 }],
    });
    t.raw.prepare("UPDATE chats SET pin_order = 0 WHERE guid = 'pinned-first'").run();
    t.raw.prepare("UPDATE chats SET pin_order = 1 WHERE guid = 'pinned-second'").run();
    t.raw.prepare("UPDATE chats SET deleted_at = 600 WHERE guid = 'locally-hidden'").run();

    const folder = await createCustomFolder(t.db, 'Trips');
    await replaceCustomFolderMembership(t.db, folder.id, [
      'pinned-first',
      'pinned-second',
      'archived-newest',
      'active-older',
      'locally-hidden',
      'temporarily-absent',
    ]);

    const firstPage = await loadFolderPage(t, folder.id, 3);
    expect(firstPage).toMatchObject({
      folder: { id: folder.id, name: 'Trips', chatCount: 6 },
      availableCount: 4,
      matchingCount: 4,
      hasMore: true,
    });
    expect(firstPage!.rows.map((row) => row.guid)).toEqual([
      'pinned-first',
      'pinned-second',
      'archived-newest',
    ]);

    const completePage = await loadFolderPage(t, folder.id, 4);
    expect(completePage).toMatchObject({ availableCount: 4, matchingCount: 4, hasMore: false });
    expect(completePage!.rows.map((row) => row.guid)).toEqual([
      'pinned-first',
      'pinned-second',
      'archived-newest',
      'active-older',
    ]);
    await expect(loadFolderPage(t, folder.id + 1, 10)).resolves.toBeNull();
  });

  it('unions folder identity and message matches once while excluding nonmember, hidden, and ineligible rows', async () => {
    const t = await createTestDb();
    await seedChat(t, 'identity-and-message', {
      displayName: 'Board',
      pinned: true,
      messages: [{ guid: 'identity-message', text: 'Cedar agenda', date: 100 }],
    });
    t.raw
      .prepare("UPDATE chats SET custom_name = 'Cedar Board', pin_order = 0 WHERE guid = ?")
      .run('identity-and-message');
    await seedChat(t, 'participant-only', {
      displayName: 'Road trip',
      participant: 'cedar.contact@example.test',
      messages: [{ guid: 'participant-message', text: 'hello', date: 500 }],
    });
    await seedChat(t, 'message-only', {
      displayName: 'Launch room',
      messages: [{ guid: 'message-match', text: 'Cedar launch notes', date: 600 }],
    });
    await seedChat(t, 'deleted-message-only', {
      displayName: 'Deleted content',
      messages: [{ guid: 'deleted-match', text: 'Cedar deleted', date: 300, dateDeleted: 900 }],
    });
    await seedChat(t, 'retracted-message-only', {
      displayName: 'Retracted content',
      messages: [
        { guid: 'retracted-match', text: 'Cedar retracted', date: 250, dateRetracted: 900 },
      ],
    });
    await seedChat(t, 'overlay-message-only', {
      displayName: 'Reaction content',
      messages: [
        { guid: 'overlay-match', text: 'Cedar reaction', date: 200, associatedMessageType: 'love' },
      ],
    });
    await seedChat(t, 'hidden-title-match', {
      displayName: 'Cedar hidden',
      messages: [{ guid: 'hidden-title-message', text: 'ordinary', date: 150 }],
    });
    t.raw.prepare("UPDATE chats SET deleted_at = 150 WHERE guid = 'hidden-title-match'").run();
    await seedChat(t, 'nonmember-match', {
      displayName: 'Cedar outsider',
      messages: [{ guid: 'nonmember-message', text: 'Cedar outside', date: 1_000 }],
    });

    const folder = await createCustomFolder(t.db, 'Cedar work');
    await replaceCustomFolderMembership(t.db, folder.id, [
      'identity-and-message',
      'participant-only',
      'message-only',
      'deleted-message-only',
      'retracted-message-only',
      'overlay-message-only',
      'hidden-title-match',
      'temporarily-absent',
    ]);

    const firstPage = await loadFolderPage(t, folder.id, 2, '  CeDaR  ');
    expect(firstPage).toMatchObject({
      folder: { chatCount: 8 },
      availableCount: 6,
      matchingCount: 3,
      hasMore: true,
    });
    expect(firstPage!.rows.map((row) => row.guid)).toEqual([
      'identity-and-message',
      'message-only',
    ]);

    const completePage = await loadFolderPage(t, folder.id, 10, 'cedar');
    expect(completePage).toMatchObject({ matchingCount: 3, hasMore: false });
    expect(completePage!.rows.map((row) => row.guid)).toEqual([
      'identity-and-message',
      'message-only',
      'participant-only',
    ]);

    const oneCharacterFallsBackToBrowse = await loadFolderPage(t, folder.id, 2, ' c ');
    expect(oneCharacterFallsBackToBrowse).toMatchObject({ matchingCount: 6, hasMore: true });
  });
});
