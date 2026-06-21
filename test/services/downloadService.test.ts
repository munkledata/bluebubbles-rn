import { Attachment, Chat, Message } from '@core/models';
import { getAttachmentByGuid, upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { ensureDownloaded, type AttachmentFetcher } from '@/services/download/downloadService';
import { createTestDb } from '../support/testDb';

async function seedAttachment(db: AppDatabase, guid: string) {
  const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@x.com' }] })],
    handles,
  );
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: `m-${guid}`,
        dateCreated: 100,
        hasAttachments: true,
        handle: { address: 'a@x.com' },
        attachments: [Attachment.parse({ guid, mimeType: 'image/jpeg', transferName: 'x.jpg' })],
      }),
    ],
    () => map.get('c1')!,
    handles,
  );
}

describe('ensureDownloaded', () => {
  it('downloads, persists localPath, and fires no second fetch when present', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'd1');
    let calls = 0;
    const fetcher: AttachmentFetcher = {
      exists: (p) => p != null,
      download: async () => {
        calls += 1;
        return 'file:///docs/d1.jpg';
      },
    };

    const path = await ensureDownloaded(db, fetcher, {
      guid: 'd1',
      transferName: 'x.jpg',
      localPath: null,
    });
    expect(path).toBe('file:///docs/d1.jpg');
    expect((await getAttachmentByGuid(db, 'd1'))?.localPath).toBe('file:///docs/d1.jpg');

    // Already downloaded → no new fetch.
    const again = await ensureDownloaded(db, fetcher, {
      guid: 'd1',
      transferName: 'x.jpg',
      localPath: 'file:///docs/d1.jpg',
    });
    expect(again).toBe('file:///docs/d1.jpg');
    expect(calls).toBe(1);
  });

  it('dedupes concurrent downloads of the same guid', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'd2');
    let calls = 0;
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return 'file:///docs/d2.jpg';
      },
    };
    const [a, b] = await Promise.all([
      ensureDownloaded(db, fetcher, { guid: 'd2', transferName: 'x', localPath: null }),
      ensureDownloaded(db, fetcher, { guid: 'd2', transferName: 'x', localPath: null }),
    ]);
    expect(a).toBe('file:///docs/d2.jpg');
    expect(b).toBe('file:///docs/d2.jpg');
    expect(calls).toBe(1); // single fetch
  });

  it('forwards byte progress from the fetcher to the caller onProgress', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'dp');
    const seen: Array<[number, number]> = [];
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: async (_g, _n, onProgress) => {
        onProgress?.(50, 100);
        onProgress?.(100, 100);
        return 'file:///docs/dp.jpg';
      },
    };
    await ensureDownloaded(
      db,
      fetcher,
      { guid: 'dp', transferName: 'x', localPath: null },
      (loaded, total) => seen.push([loaded, total]),
    );
    expect(seen).toEqual([
      [50, 100],
      [100, 100],
    ]);
  });

  it('returns null on fetch failure (no localPath written)', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'd3');
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: async () => {
        throw new Error('network');
      },
    };
    expect(
      await ensureDownloaded(db, fetcher, { guid: 'd3', transferName: 'x', localPath: null }),
    ).toBeNull();
    expect((await getAttachmentByGuid(db, 'd3'))?.localPath).toBeNull();
  });
});
