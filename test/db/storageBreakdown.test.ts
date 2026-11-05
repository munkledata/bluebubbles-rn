import { Chat, Message } from '@core/models';
import { getStorageBreakdown, upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
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

function cacheFile(t: Db, path: string, bytes: number): void {
  t.raw
    .prepare('INSERT INTO attachment_cache_entries (path, bytes, last_used_at) VALUES (?, ?, 1)')
    .run(path, bytes);
}

function attachTo(t: Db, n: number, guid: string, localPath: string): void {
  const id = (
    t.raw.prepare('SELECT id FROM messages WHERE guid = ?').get(`msg-${n}`) as { id: number }
  ).id;
  t.raw
    .prepare(
      'INSERT INTO attachments (guid, message_id, mime_type, local_path) VALUES (?, ?, ?, ?)',
    )
    .run(guid, id, 'image/jpeg', localPath);
}

describe('getStorageBreakdown', () => {
  it('totals every cached file and ranks chats by the space their files use', async () => {
    const t = await createTestDb();
    const a = await chatWithMessage(t, 1);
    const b = await chatWithMessage(t, 2);
    cacheFile(t, 'file:///cache/a1.jpg', 1_000);
    cacheFile(t, 'file:///cache/a2.jpg', 3_000);
    cacheFile(t, 'file:///cache/b1.jpg', 2_000);
    cacheFile(t, 'file:///cache/shared.jpg', 500);
    cacheFile(t, 'file:///cache/wallpaper.jpg', 7_000); // used by no message
    attachTo(t, 1, 'att-a1', 'file:///cache/a1.jpg');
    attachTo(t, 1, 'att-a2', 'file:///cache/a2.jpg');
    attachTo(t, 1, 'att-a3', 'file:///cache/a2.jpg'); // same file twice in one chat: counted once
    attachTo(t, 2, 'att-b1', 'file:///cache/b1.jpg');
    attachTo(t, 1, 'att-s1', 'file:///cache/shared.jpg');
    attachTo(t, 2, 'att-s2', 'file:///cache/shared.jpg'); // shared by both chats

    expect(await getStorageBreakdown(t.db)).toEqual({
      totalFiles: 5,
      totalBytes: 13_500,
      topChats: [
        { chatGuid: a, files: 3, bytes: 4_500 },
        { chatGuid: b, files: 2, bytes: 2_500 },
      ],
      otherFiles: 1,
      otherBytes: 7_000,
    });
  });

  it('honours the top-chat limit and is empty with nothing cached', async () => {
    const t = await createTestDb();
    expect(await getStorageBreakdown(t.db)).toEqual({
      totalFiles: 0,
      totalBytes: 0,
      topChats: [],
      otherFiles: 0,
      otherBytes: 0,
    });
    for (let n = 1; n <= 3; n += 1) {
      await chatWithMessage(t, n);
      cacheFile(t, `file:///cache/${n}.jpg`, n * 100);
      attachTo(t, n, `att-${n}`, `file:///cache/${n}.jpg`);
    }
    const top = (await getStorageBreakdown(t.db, 2)).topChats;
    expect(top.map((c) => c.bytes)).toEqual([300, 200]);
  });
});
