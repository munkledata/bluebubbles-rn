import { Chat, Message } from '@core/models';
import {
  getChatDownloadedFilesSummary,
  listChatOnlyAttachmentCachePaths,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { createTestDb } from '../support/testDb';

type Db = Awaited<ReturnType<typeof createTestDb>>;

async function chatWithMessage(t: Db, n: number): Promise<string> {
  const address = `+1555000000${n}`;
  const guid = `iMessage;-;${address}`;
  const handles = await upsertHandles(t.db, [{ address }]);
  const map = await upsertChats(
    t.db,
    [Chat.parse({ guid, style: 45, participants: [{ address }] })],
    handles,
  );
  await upsertMessages(
    t.db,
    [
      Message.parse({
        guid: `msg-${n}`,
        text: 'x',
        isFromMe: false,
        dateCreated: n,
        originalROWID: n,
        handle: { address },
      }),
    ],
    () => map.get(guid)!,
    handles,
  );
  return guid;
}

function cacheFile(t: Db, path: string, bytes: number, lastUsedAt = 1): void {
  t.raw
    .prepare('INSERT INTO attachment_cache_entries (path, bytes, last_used_at) VALUES (?, ?, ?)')
    .run(path, bytes, lastUsedAt);
}

function attach(t: Db, messageGuid: string | null, guid: string, localPath: string): void {
  const id =
    messageGuid == null
      ? null
      : (t.raw.prepare('SELECT id FROM messages WHERE guid = ?').get(messageGuid) as { id: number })
          .id;
  t.raw
    .prepare(
      'INSERT INTO attachments (guid, message_id, mime_type, local_path) VALUES (?, ?, ?, ?)',
    )
    .run(guid, id, 'image/jpeg', localPath);
}

describe('listChatOnlyAttachmentCachePaths', () => {
  it('lists only files nobody else uses, oldest use first, and summarises what it keeps', async () => {
    const t = await createTestDb();
    const a = await chatWithMessage(t, 1);
    const b = await chatWithMessage(t, 2);
    cacheFile(t, 'file:///c/a-new.jpg', 100, 50);
    cacheFile(t, 'file:///c/a-old.jpg', 200, 10);
    cacheFile(t, 'file:///c/a-twice.jpg', 300, 30);
    cacheFile(t, 'file:///c/shared.jpg', 400, 5);
    cacheFile(t, 'file:///c/orphan-row.jpg', 500, 5);
    cacheFile(t, 'file:///c/retiring.jpg', 600, 5);
    cacheFile(t, 'file:///c/b.jpg', 700, 5);
    attach(t, 'msg-1', 'a1', 'file:///c/a-new.jpg');
    attach(t, 'msg-1', 'a2', 'file:///c/a-old.jpg');
    attach(t, 'msg-1', 'a3', 'file:///c/a-twice.jpg');
    attach(t, 'msg-1', 'a4', 'file:///c/a-twice.jpg'); // twice in the same chat: still only A's
    attach(t, 'msg-1', 's1', 'file:///c/shared.jpg');
    attach(t, 'msg-2', 's2', 'file:///c/shared.jpg'); // chat B uses it too: kept
    attach(t, 'msg-1', 'o1', 'file:///c/orphan-row.jpg');
    attach(t, null, 'o2', 'file:///c/orphan-row.jpg'); // a row with no message: kept
    attach(t, 'msg-1', 'r1', 'file:///c/retiring.jpg');
    t.raw // already being deleted
      .prepare("UPDATE attachment_cache_entries SET state = 'retiring' WHERE path = ?")
      .run('file:///c/retiring.jpg');
    attach(t, 'msg-2', 'b1', 'file:///c/b.jpg');

    expect(await listChatOnlyAttachmentCachePaths(t.db, a)).toEqual([
      'file:///c/a-old.jpg',
      'file:///c/a-twice.jpg',
      'file:///c/a-new.jpg',
    ]);
    expect(await listChatOnlyAttachmentCachePaths(t.db, a, 2)).toHaveLength(2);
    expect(await getChatDownloadedFilesSummary(t.db, a)).toEqual({
      files: 3,
      bytes: 600,
      keptFiles: 2,
    });
    expect(await listChatOnlyAttachmentCachePaths(t.db, b)).toEqual(['file:///c/b.jpg']);
  });

  it('leaves out a file waiting for its automatic Photos copy', async () => {
    const t = await createTestDb();
    const a = await chatWithMessage(t, 1);
    cacheFile(t, 'file:///c/export.jpg', 100);
    cacheFile(t, 'file:///c/plain.jpg', 100);
    attach(t, 'msg-1', 'e1', 'file:///c/export.jpg');
    attach(t, 'msg-1', 'p1', 'file:///c/plain.jpg');
    t.raw.prepare('UPDATE attachments SET total_bytes = 100').run();
    const now = Date.now();
    t.raw
      .prepare(
        `INSERT INTO attachment_media_exports (attachment_guid, destination, created_at, expires_at)
         VALUES ('e1', 'gallery', ?, ?)`,
      )
      .run(now, now + 86_400_000);
    expect(await listChatOnlyAttachmentCachePaths(t.db, a)).toEqual(['file:///c/plain.jpg']);
    // The confirmation promises exactly what the removal will take.
    expect(await getChatDownloadedFilesSummary(t.db, a)).toEqual({
      files: 1,
      bytes: 100,
      keptFiles: 1,
    });
  });

  it('keeps a file that a deleted message in another chat still points at', async () => {
    const t = await createTestDb();
    const a = await chatWithMessage(t, 1);
    await chatWithMessage(t, 2);
    cacheFile(t, 'file:///c/deleted-elsewhere.jpg', 100);
    cacheFile(t, 'file:///c/mine.jpg', 100);
    attach(t, 'msg-1', 'x1', 'file:///c/deleted-elsewhere.jpg');
    attach(t, 'msg-2', 'x2', 'file:///c/deleted-elsewhere.jpg');
    t.raw.prepare('UPDATE messages SET date_deleted = 99 WHERE guid = ?').run('msg-2');
    attach(t, 'msg-1', 'z1', 'file:///c/mine.jpg');
    expect(await listChatOnlyAttachmentCachePaths(t.db, a)).toEqual(['file:///c/mine.jpg']);
    expect((await getChatDownloadedFilesSummary(t.db, a)).keptFiles).toBe(1);
  });

  it('is empty for an unknown chat or a bad request', async () => {
    const t = await createTestDb();
    await chatWithMessage(t, 1);
    cacheFile(t, 'file:///c/a.jpg', 100);
    attach(t, 'msg-1', 'a1', 'file:///c/a.jpg');
    expect(await listChatOnlyAttachmentCachePaths(t.db, 'nobody')).toEqual([]);
    expect(await listChatOnlyAttachmentCachePaths(t.db, '')).toEqual([]);
    expect(await listChatOnlyAttachmentCachePaths(t.db, 'iMessage;-;+15550000001', 0)).toEqual([]);
    expect(await getChatDownloadedFilesSummary(t.db, 'nobody')).toEqual({
      files: 0,
      bytes: 0,
      keptFiles: 0,
    });
  });
});
