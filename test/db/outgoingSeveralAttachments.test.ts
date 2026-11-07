/**
 * Several files sent as one iMessage (fix plan step 4, part 2): one optimistic message owns every
 * file in pick order, the server's copy pairs each real attachment with the temp row of the same
 * file, and the retry rebuild never re-sends part of such a message.
 */
import type Database from 'better-sqlite3';
import { Attachment, Chat } from '@core/models';
import {
  getChatIdByGuid,
  type InsertOutgoingAttachmentArgs,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import type { ReadDb } from '@db/types';
import { createTestDb } from '../support/testDb';
import {
  applyServerSendError,
  insertOutgoingAttachment,
  upsertAttachments,
} from '../support/repositoryWrappers';

async function seedChat(db: ReadDb, guid = 'iMessage;-;+15550100'): Promise<number> {
  const hm = await upsertHandles(db, [{ address: '+15550100' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: '+15550100' }] })], hm);
  return (await getChatIdByGuid(db, guid))!;
}

const CHAT = 'iMessage;-;+15550100';

function file(index: number, name: string, bytes: number) {
  return {
    attachmentGuid: `temp-m-${index}-att`,
    localPath: `file:///cache/${name}`,
    mimeType: name.endsWith('.mov') ? 'video/quicktime' : 'image/jpeg',
    transferName: name,
    totalBytes: bytes,
  };
}

function severalArgs(
  chatId: number,
  names: [string, number][],
  extra: Partial<InsertOutgoingAttachmentArgs> = {},
): InsertOutgoingAttachmentArgs & { chatId: number } {
  const [first, ...rest] = names.map(([name, bytes], index) => file(index, name, bytes));
  return {
    tempGuid: 'temp-m',
    chatId,
    chatGuid: CHAT,
    ...first!,
    now: 1,
    imessageAttachmentV1: true,
    additionalFiles: rest,
    ...extra,
  };
}

function rows(raw: Database.Database, messageGuid = 'temp-m') {
  return raw
    .prepare(
      `SELECT a.guid, a.local_path AS localPath FROM attachments a
       JOIN messages m ON m.id = a.message_id WHERE m.guid = ? ORDER BY a.id ASC`,
    )
    .all(messageGuid) as { guid: string; localPath: string | null }[];
}

function messageId(raw: Database.Database, guid = 'temp-m'): number {
  return (raw.prepare('SELECT id FROM messages WHERE guid = ?').get(guid) as { id: number }).id;
}

function real(guid: string, transferName?: string, totalBytes?: number) {
  return Attachment.parse({ guid, mimeType: 'image/jpeg', transferName, totalBytes });
}

describe('one optimistic message with several files', () => {
  it('writes one message, every file in pick order, and one one-shot queue row', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    await insertOutgoingAttachment(
      db,
      severalArgs(
        chatId,
        [
          ['a.jpg', 10],
          ['b.jpg', 20],
          ['c.mov', 30],
        ],
        { text: 'trip' },
      ),
    );

    expect(rows(raw)).toEqual([
      { guid: 'temp-m-0-att', localPath: 'file:///cache/a.jpg' },
      { guid: 'temp-m-1-att', localPath: 'file:///cache/b.jpg' },
      { guid: 'temp-m-2-att', localPath: 'file:///cache/c.mov' },
    ]);
    expect(
      raw
        .prepare(
          'SELECT text, has_attachments AS has, part_count AS parts FROM messages WHERE guid = ?',
        )
        .get('temp-m'),
    ).toEqual({ text: 'trip', has: 1, parts: 4 });
    const queue = raw
      .prepare('SELECT kind, payload FROM outgoing_queue WHERE temp_guid = ?')
      .all('temp-m') as { kind: string; payload: string }[];
    expect(queue).toHaveLength(1);
    expect(queue[0]!.kind).toBe('attachment');
    expect(JSON.parse(queue[0]!.payload)).toEqual({
      attachmentGuid: 'temp-m-0-att',
      localPath: 'file:///cache/a.jpg',
      text: 'trip',
      imessageAttachmentV1: true,
      attachmentGuids: ['temp-m-0-att', 'temp-m-1-att', 'temp-m-2-att'],
    });
  });

  it('counts parts without a caption, and leaves a one-file send exactly as before', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    await insertOutgoingAttachment(
      db,
      severalArgs(chatId, [
        ['a.jpg', 10],
        ['b.jpg', 20],
      ]),
    );
    expect(
      raw.prepare("SELECT part_count AS parts FROM messages WHERE guid = 'temp-m'").get(),
    ).toEqual({
      parts: 2,
    });

    for (const [tempGuid, text, parts] of [
      ['temp-one', undefined, null],
      ['temp-one-caption', 'hi', 2],
    ] as const) {
      await insertOutgoingAttachment(db, {
        tempGuid,
        attachmentGuid: `${tempGuid}-att`,
        chatId,
        chatGuid: CHAT,
        localPath: `file:///cache/${tempGuid}.jpg`,
        mimeType: 'image/jpeg',
        transferName: `${tempGuid}.jpg`,
        totalBytes: 5,
        now: 2,
        text,
        imessageAttachmentV1: true,
      });
      expect(
        raw.prepare('SELECT part_count AS parts FROM messages WHERE guid = ?').get(tempGuid),
      ).toEqual({
        parts,
      });
      expect(rows(raw, tempGuid)).toHaveLength(1);
      const payload = JSON.parse(
        (
          raw.prepare('SELECT payload FROM outgoing_queue WHERE temp_guid = ?').get(tempGuid) as {
            payload: string;
          }
        ).payload,
      );
      expect(payload).not.toHaveProperty('attachmentGuids');
      expect(payload.attachmentGuid).toBe(`${tempGuid}-att`);
    }
  });

  it.each([
    ['without the one-shot iMessage marker', { imessageAttachmentV1: undefined }],
    ['as a reply', { selectedMessageGuid: 'parent-guid' }],
    ['with eleven files', {}],
    ['with a repeated attachment guid', {}],
  ])('writes nothing %s', async (label, extra) => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    const names: [string, number][] =
      label === 'with eleven files'
        ? Array.from({ length: 11 }, (_, index) => [`p${index}.jpg`, index + 1])
        : [
            ['a.jpg', 10],
            ['b.jpg', 20],
          ];
    const args = severalArgs(chatId, names, extra);
    if (label === 'with a repeated attachment guid') {
      args.additionalFiles = [
        { ...args.additionalFiles![0]!, attachmentGuid: args.attachmentGuid },
      ];
    }
    const failure = await insertOutgoingAttachment(db, args).then(
      () => null,
      (error: unknown) => error,
    );
    // The writer's own refusal, not a later constraint failure, stops each case.
    const chain: unknown[] = [];
    for (let error = failure; error instanceof Error && chain.length < 4; error = error.cause) {
      chain.push(error.message);
    }
    expect(chain).toContain('Several files need one bounded one-shot iMessage without a reply.');
    expect(raw.prepare("SELECT id FROM messages WHERE guid = 'temp-m'").get()).toBeUndefined();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM outgoing_queue').get()).toEqual({ n: 0 });
  });
});

describe("the server's copy pairs each file with its own draft row", () => {
  async function sent(names: [string, number][]) {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    await insertOutgoingAttachment(db, severalArgs(chatId, names));
    return { db, raw, id: messageId(raw) };
  }

  it('matches by name and size whatever order the server lists them in', async () => {
    const { db, raw, id } = await sent([
      ['a.jpg', 10],
      ['b.jpg', 20],
      ['c.mov', 30],
    ]);
    await upsertAttachments(db, [
      { att: real('real-c', 'c.mov', 30), messageId: id },
      { att: real('real-a', 'a.jpg', 10), messageId: id },
      { att: real('real-b', 'b.jpg', 20), messageId: id },
    ]);
    expect(rows(raw)).toEqual([
      { guid: 'real-a', localPath: 'file:///cache/a.jpg' },
      { guid: 'real-b', localPath: 'file:///cache/b.jpg' },
      { guid: 'real-c', localPath: 'file:///cache/c.mov' },
    ]);
  });

  it('never guesses by order when the server reports other names and no part numbers', async () => {
    const { db, raw, id } = await sent([
      ['a.jpg', 10],
      ['b.jpg', 20],
    ]);
    await upsertAttachments(db, [
      { att: real('real-1', 'IMG_0001.JPG', 11), messageId: id },
      { att: real('real-2'), messageId: id },
    ]);
    // Both drafts keep their local files; the real files get rows of their own.
    expect(rows(raw)).toEqual([
      { guid: 'temp-m-0-att', localPath: 'file:///cache/a.jpg' },
      { guid: 'temp-m-1-att', localPath: 'file:///cache/b.jpg' },
      { guid: 'real-1', localPath: null },
      { guid: 'real-2', localPath: null },
    ]);
  });

  describe('with the part numbers the server reports', () => {
    // The shape sendImageMessage gives a several-file draft: file 0 is `<temp>-att`, file n is
    // `<temp>-<n>-att`.
    const T = 'temp-0123456789abcdef';
    async function sentHeics(names: [string, number][]) {
      const { db, raw } = await createTestDb();
      const chatId = await seedChat(db);
      const [first, ...rest] = names.map(([name, bytes], index) => ({
        attachmentGuid: index === 0 ? `${T}-att` : `${T}-${index}-att`,
        localPath: `file:///cache/${name}`,
        mimeType: 'image/heic',
        transferName: name,
        totalBytes: bytes,
      }));
      await insertOutgoingAttachment(db, {
        tempGuid: T,
        chatId,
        chatGuid: CHAT,
        ...first!,
        now: 1,
        imessageAttachmentV1: true,
        additionalFiles: rest,
      });
      return { db, raw, id: messageId(raw, T) };
    }
    function storeTopology(raw: Database.Database, id: number, owners: [string, number][]) {
      const topology = {
        complete: true,
        originalPartIndexes: owners.map(([, part]) => part),
        currentParts: owners.map(([guid, part]) => ({
          index: part,
          kind: 'attachment',
          attachmentGuids: [guid],
        })),
        attachmentOwnership: owners.map(([guid, part]) => ({
          attachmentGuid: guid,
          partIndex: part,
        })),
      };
      raw
        .prepare('UPDATE messages SET message_part_topology = ? WHERE id = ?')
        .run(JSON.stringify(topology), id);
    }
    // The server converted both HEICs to JPEG (new names and sizes) and lists them in reverse.
    const converted = (id: number) => [
      { att: real('real-2', 'IMG_0002.jpeg', 1_400), messageId: id },
      { att: real('real-1', 'IMG_0001.jpeg', 1_500), messageId: id },
    ];

    it('pairs each converted file with its own draft whatever order the server lists them in', async () => {
      const { db, raw, id } = await sentHeics([
        ['IMG_0001.heic', 3_000],
        ['IMG_0002.heic', 2_900],
      ]);
      storeTopology(raw, id, [
        ['real-1', 0],
        ['real-2', 1],
      ]);
      await upsertAttachments(db, converted(id));
      expect(rows(raw, T)).toEqual([
        { guid: 'real-1', localPath: 'file:///cache/IMG_0001.heic' },
        { guid: 'real-2', localPath: 'file:///cache/IMG_0002.heic' },
      ]);
    });

    it('settles drafts left unpaired once a later copy carries the part numbers', async () => {
      const { db, raw, id } = await sentHeics([
        ['IMG_0001.heic', 3_000],
        ['IMG_0002.heic', 2_900],
      ]);
      await upsertAttachments(db, converted(id));
      expect(rows(raw, T).map((row) => row.guid)).toEqual([
        `${T}-att`,
        `${T}-1-att`,
        'real-2',
        'real-1',
      ]);
      storeTopology(raw, id, [
        ['real-1', 0],
        ['real-2', 1],
      ]);
      await upsertAttachments(db, converted(id));
      // Each draft met its own real row and was dropped: no file shows twice.
      expect(rows(raw, T).map((row) => row.guid)).toEqual(['real-2', 'real-1']);
    });

    it('keeps a waiting draft when a later copy lists only a file that is already paired', async () => {
      const { db, raw, id } = await sentHeics([
        ['IMG_0001.heic', 3_000],
        ['IMG_0002.heic', 2_900],
        ['IMG_0003.heic', 2_800],
      ]);
      storeTopology(raw, id, [
        ['real-1', 0],
        ['real-2', 1],
        ['real-3', 2],
      ]);
      await upsertAttachments(db, [
        { att: real('real-1', 'IMG_0001.jpeg', 1_500), messageId: id },
        { att: real('real-2', 'IMG_0002.jpeg', 1_400), messageId: id },
      ]);
      // A copy listing only the first file again must not take the third file's draft.
      await upsertAttachments(db, [{ att: real('real-1', 'IMG_0001.jpeg', 1_500), messageId: id }]);
      expect(rows(raw, T)).toEqual([
        { guid: 'real-1', localPath: 'file:///cache/IMG_0001.heic' },
        { guid: 'real-2', localPath: 'file:///cache/IMG_0002.heic' },
        { guid: `${T}-2-att`, localPath: 'file:///cache/IMG_0003.heic' },
      ]);
      await upsertAttachments(db, [{ att: real('real-3', 'IMG_0003.jpeg', 1_300), messageId: id }]);
      expect(rows(raw, T)).toEqual([
        { guid: 'real-1', localPath: 'file:///cache/IMG_0001.heic' },
        { guid: 'real-2', localPath: 'file:///cache/IMG_0002.heic' },
        { guid: 'real-3', localPath: 'file:///cache/IMG_0003.heic' },
      ]);
    });

    it('ignores part numbers that do not start at 0 and pairs by name and size instead', async () => {
      const { db, raw, id } = await sentHeics([
        ['a.heic', 10],
        ['b.heic', 20],
      ]);
      // Numbered from 1, as if text came first: that proves nothing about pick order.
      storeTopology(raw, id, [
        ['real-a', 1],
        ['real-b', 2],
      ]);
      await upsertAttachments(db, [
        { att: real('real-b', 'b.heic', 20), messageId: id },
        { att: real('real-a', 'a.heic', 10), messageId: id },
      ]);
      expect(rows(raw, T)).toEqual([
        { guid: 'real-a', localPath: 'file:///cache/a.heic' },
        { guid: 'real-b', localPath: 'file:///cache/b.heic' },
      ]);
    });
  });

  it('pairs the same name and size in order, including identical repeats', async () => {
    const { db, raw, id } = await sent([
      ['same.jpg', 10],
      ['unique.mov', 30],
      ['same.jpg', 10],
    ]);
    await upsertAttachments(db, [
      { att: real('real-same-1', 'same.jpg', 10), messageId: id },
      { att: real('real-same-2', 'same.jpg', 10), messageId: id },
      { att: real('real-unique', 'unique.mov', 30), messageId: id },
    ]);
    expect(rows(raw)).toEqual([
      { guid: 'real-same-1', localPath: 'file:///cache/same.jpg' },
      { guid: 'real-unique', localPath: 'file:///cache/unique.mov' },
      { guid: 'real-same-2', localPath: 'file:///cache/same.jpg' },
    ]);
  });

  it('keeps the one-file behaviour: a single draft takes the only real file whatever its name', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-m',
      attachmentGuid: 'temp-m-att',
      chatId,
      chatGuid: CHAT,
      localPath: 'file:///cache/pic.jpg',
      mimeType: 'image/jpeg',
      transferName: 'pic.jpg',
      totalBytes: 10,
      now: 1,
    });
    await upsertAttachments(db, [
      { att: real('real-only', 'renamed.jpg', 99), messageId: messageId(raw) },
    ]);
    expect(rows(raw)).toEqual([{ guid: 'real-only', localPath: 'file:///cache/pic.jpg' }]);
  });

  it('pairs two messages in one batch separately, even with the same file names', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    for (const tempGuid of ['temp-m', 'temp-n']) {
      await insertOutgoingAttachment(db, {
        ...severalArgs(chatId, [
          ['x.jpg', 10],
          ['y.jpg', 20],
        ]),
        tempGuid,
        attachmentGuid: `${tempGuid}-0-att`,
        localPath: `file:///cache/${tempGuid}-x.jpg`,
        additionalFiles: [
          {
            ...file(1, 'y.jpg', 20),
            attachmentGuid: `${tempGuid}-1-att`,
            localPath: `file:///cache/${tempGuid}-y.jpg`,
          },
        ],
      });
    }
    const m = messageId(raw, 'temp-m');
    const n = messageId(raw, 'temp-n');
    await upsertAttachments(db, [
      { att: real('real-mx', 'x.jpg', 10), messageId: m },
      { att: real('real-my', 'y.jpg', 20), messageId: m },
      { att: real('real-nx', 'x.jpg', 10), messageId: n },
      { att: real('real-ny', 'y.jpg', 20), messageId: n },
    ]);
    expect(rows(raw, 'temp-m')).toEqual([
      { guid: 'real-mx', localPath: 'file:///cache/temp-m-x.jpg' },
      { guid: 'real-my', localPath: 'file:///cache/temp-m-y.jpg' },
    ]);
    expect(rows(raw, 'temp-n')).toEqual([
      { guid: 'real-nx', localPath: 'file:///cache/temp-n-x.jpg' },
      { guid: 'real-ny', localPath: 'file:///cache/temp-n-y.jpg' },
    ]);
  });

  it('never pairs a draft with itself or with a refresh of another draft', async () => {
    const { db, raw, id } = await sent([
      ['a.jpg', 10],
      ['b.jpg', 20],
    ]);
    // A refresh of draft a (its own guid) arrives with the real b under another name.
    await upsertAttachments(db, [
      {
        att: Attachment.parse({
          guid: 'temp-m-0-att',
          mimeType: 'image/jpeg',
          transferName: 'a.jpg',
          totalBytes: 10,
        }),
        messageId: id,
      },
      { att: real('real-b', 'IMG_0002.JPG', 21), messageId: id },
    ]);
    expect(rows(raw)).toEqual([
      { guid: 'temp-m-0-att', localPath: 'file:///cache/a.jpg' },
      { guid: 'real-b', localPath: 'file:///cache/b.jpg' },
    ]);
  });

  it('drops only the draft whose real file already exists and re-points the others', async () => {
    const { db, raw, id } = await sent([
      ['a.jpg', 10],
      ['b.jpg', 20],
    ]);
    raw
      .prepare('INSERT INTO attachments (guid, message_id, mime_type) VALUES (?, ?, ?)')
      .run('real-a', id, 'image/jpeg');
    await upsertAttachments(db, [
      { att: real('real-a', 'a.jpg', 10), messageId: id },
      { att: real('real-b', 'b.jpg', 20), messageId: id },
    ]);
    // a's draft is dropped (its real row exists already); b's draft becomes real-b in place.
    expect(rows(raw)).toEqual([
      { guid: 'real-b', localPath: 'file:///cache/b.jpg' },
      { guid: 'real-a', localPath: null },
    ]);
  });

  it("never pairs a draft with another message's file, and leaves an extra draft in place", async () => {
    const { db, raw, id } = await sent([
      ['a.jpg', 10],
      ['b.jpg', 20],
    ]);
    const otherChatId = await seedChat(db, 'iMessage;-;+15550199');
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-other',
      attachmentGuid: 'temp-other-att',
      chatId: otherChatId,
      chatGuid: 'iMessage;-;+15550199',
      localPath: 'file:///cache/other.jpg',
      mimeType: 'image/jpeg',
      transferName: 'a.jpg',
      totalBytes: 10,
      now: 1,
    });
    await upsertAttachments(db, [{ att: real('real-a', 'a.jpg', 10), messageId: id }]);
    expect(rows(raw)).toEqual([
      { guid: 'real-a', localPath: 'file:///cache/a.jpg' },
      { guid: 'temp-m-1-att', localPath: 'file:///cache/b.jpg' },
    ]);
    expect(rows(raw, 'temp-other')).toEqual([
      { guid: 'temp-other-att', localPath: 'file:///cache/other.jpg' },
    ]);
  });
});

describe('the retry rebuild after a server send error', () => {
  it('never re-sends part of a several-file message, while one file still rebuilds', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    await insertOutgoingAttachment(
      db,
      severalArgs(chatId, [
        ['a.jpg', 10],
        ['b.jpg', 20],
      ]),
    );
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-one',
      attachmentGuid: 'temp-one-att',
      chatId,
      chatGuid: CHAT,
      localPath: 'file:///cache/one.jpg',
      mimeType: 'image/jpeg',
      transferName: 'one.jpg',
      totalBytes: 5,
      now: 1,
    });
    // The ack consumed both queue rows before a retryable server failure arrived.
    raw
      .prepare("UPDATE messages SET send_state = 'sent' WHERE guid IN ('temp-m', 'temp-one')")
      .run();
    raw.prepare('DELETE FROM outgoing_queue').run();

    await applyServerSendError(db, 'temp-m', 502, 5_000_000, true);
    await applyServerSendError(db, 'temp-one', 502, 5_000_000, true);

    const queued = raw.prepare('SELECT temp_guid AS guid FROM outgoing_queue').all();
    expect(queued).toEqual([{ guid: 'temp-one' }]);
    expect(
      raw.prepare("SELECT send_state AS s, error AS e FROM messages WHERE guid = 'temp-m'").get(),
    ).toEqual({ s: 'error', e: 502 });
  });
});
