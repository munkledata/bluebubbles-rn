/**
 * Copying shared files into app-private cache (src/services/share/materializeShare.ts).
 *
 * The load-bearing assertion here is the POST-COPY STAT: expo-file-system's SAF branch resolves
 * without writing anything when a provider reports no display name, so "copyAsync resolved" is not
 * proof the file exists. Trusting it would stage a phantom attachment that only fails at send time.
 */
import { materializeSharedFiles, pruneShareCache } from '@/services/share/materializeShare';
import type { ShareFileIO } from '@/services/share/materializeShare';
import type { ShareSource } from '@/services/share/shareIntentPayload';

const NOW = 1_700_000_000_000;
const ROOT = 'file:///cache/shared-in/';

function source(over: Partial<ShareSource> = {}): ShareSource {
  return {
    sourceUri: 'content://x/1',
    fileName: 'bill.pdf',
    mimeType: 'application/pdf',
    reportedSize: 999,
    alreadyLocal: false,
    ...over,
  };
}

/** A fake filesystem: `copy` records into `disk`, `stat` reads it back. */
function fakeIo(over: Partial<ShareFileIO> = {}): ShareFileIO & { disk: Map<string, number> } {
  const disk = new Map<string, number>();
  const io: ShareFileIO & { disk: Map<string, number> } = {
    disk,
    makeDir: jest.fn(async () => {}),
    copy: jest.fn(async (_from: string, to: string) => {
      disk.set(to, 4096);
    }),
    stat: jest.fn(async (uri: string) => ({
      exists: disk.has(uri),
      size: disk.get(uri) ?? 0,
    })),
    listDir: jest.fn(async () => []),
    remove: jest.fn(async (uri: string) => {
      disk.delete(uri);
    }),
    ...over,
  };
  return io;
}

describe('materializeSharedFiles', () => {
  it('copies each source into a per-share batch directory', async () => {
    const io = fakeIo();
    const res = await materializeSharedFiles({
      sources: [source(), source({ fileName: 'photo.jpg', mimeType: 'image/jpeg' })],
      cacheRoot: ROOT,
      io,
      now: NOW,
    });

    expect(res.failed).toBe(0);
    expect(res.files).toEqual([
      { uri: `${ROOT}${NOW}/bill.pdf`, name: 'bill.pdf', mimeType: 'application/pdf', size: 4096 },
      { uri: `${ROOT}${NOW}/photo.jpg`, name: 'photo.jpg', mimeType: 'image/jpeg', size: 4096 },
    ]);
    // One batch dir for the whole share, not one per file.
    expect(io.makeDir).toHaveBeenCalledTimes(1);
    expect(io.makeDir).toHaveBeenCalledWith(`${ROOT}${NOW}/`);
  });

  it('uses the STAT size, not the size the provider claimed', async () => {
    const io = fakeIo();
    const res = await materializeSharedFiles({
      sources: [source({ reportedSize: 12345678 })],
      cacheRoot: ROOT,
      io,
      now: NOW,
    });
    expect(res.files[0]?.size).toBe(4096);
  });

  it('DROPS a file when the copy resolves but nothing landed (the silent SAF no-op)', async () => {
    const io = fakeIo({ copy: jest.fn(async () => {}) }); // resolves, writes nothing
    const res = await materializeSharedFiles({
      sources: [source()],
      cacheRoot: ROOT,
      io,
      now: NOW,
    });
    expect(res.files).toEqual([]);
    expect(res.failed).toBe(1);
  });

  it('drops a file that copies as zero bytes', async () => {
    const io = fakeIo();
    io.copy = jest.fn(async (_from: string, to: string) => {
      io.disk.set(to, 0);
    });
    const res = await materializeSharedFiles({
      sources: [source()],
      cacheRoot: ROOT,
      io,
      now: NOW,
    });
    expect(res).toEqual({ files: [], failed: 1 });
  });

  it('keeps the rest of the batch when one file fails', async () => {
    const io = fakeIo();
    io.copy = jest.fn(async (from: string, to: string) => {
      if (from === 'content://bad') throw new Error("Location isn't readable.");
      io.disk.set(to, 4096);
    });
    const res = await materializeSharedFiles({
      sources: [
        source({ sourceUri: 'content://bad', fileName: 'bad.pdf' }),
        source({ sourceUri: 'content://good', fileName: 'good.pdf' }),
      ],
      cacheRoot: ROOT,
      io,
      now: NOW,
    });
    expect(res.failed).toBe(1);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]?.name).toBe('good.pdf');
  });

  it('never rejects when the IO layer throws', async () => {
    const io = fakeIo({
      makeDir: jest.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(
      materializeSharedFiles({ sources: [source()], cacheRoot: ROOT, io, now: NOW }),
    ).resolves.toEqual({ files: [], failed: 1 });
  });

  it('de-duplicates identical filenames within one share', async () => {
    const io = fakeIo();
    const res = await materializeSharedFiles({
      sources: [source(), source()],
      cacheRoot: ROOT,
      io,
      now: NOW,
    });
    expect(res.files.map((f) => f.uri)).toEqual([
      `${ROOT}${NOW}/bill.pdf`,
      `${ROOT}${NOW}/bill-1.pdf`,
    ]);
  });

  it('reuses an already-local file without copying it', async () => {
    const io = fakeIo();
    io.disk.set('file:///cache/IMG_1.jpg', 2048);
    const res = await materializeSharedFiles({
      sources: [
        source({
          sourceUri: 'file:///cache/IMG_1.jpg',
          fileName: 'IMG_1.jpg',
          mimeType: 'image/jpeg',
          alreadyLocal: true,
        }),
      ],
      cacheRoot: ROOT,
      io,
      now: NOW,
    });
    expect(io.copy).not.toHaveBeenCalled();
    expect(io.makeDir).not.toHaveBeenCalled();
    expect(res.files[0]).toEqual({
      uri: 'file:///cache/IMG_1.jpg',
      name: 'IMG_1.jpg',
      mimeType: 'image/jpeg',
      size: 2048,
    });
  });

  it('fails an already-local file that has gone missing', async () => {
    const io = fakeIo();
    const res = await materializeSharedFiles({
      sources: [source({ sourceUri: 'file:///cache/gone.jpg', alreadyLocal: true })],
      cacheRoot: ROOT,
      io,
      now: NOW,
    });
    expect(res).toEqual({ files: [], failed: 1 });
  });

  it('does nothing for an empty source list', async () => {
    const io = fakeIo();
    await expect(
      materializeSharedFiles({ sources: [], cacheRoot: ROOT, io, now: NOW }),
    ).resolves.toEqual({ files: [], failed: 0 });
    expect(io.makeDir).not.toHaveBeenCalled();
  });
});

describe('pruneShareCache', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('removes stale batches, keeps fresh ones, and sweeps non-timestamp entries', async () => {
    const io = fakeIo({
      listDir: jest.fn(async () => [String(NOW - 25 * 60 * 60 * 1000), String(NOW - 1000), 'junk']),
    });
    const removed = await pruneShareCache({ cacheRoot: ROOT, io, now: NOW, maxAgeMs: DAY });
    expect(removed).toBe(2);
    expect(io.remove).toHaveBeenCalledWith(`${ROOT}${NOW - 25 * 60 * 60 * 1000}`);
    expect(io.remove).toHaveBeenCalledWith(`${ROOT}junk`);
    expect(io.remove).not.toHaveBeenCalledWith(`${ROOT}${NOW - 1000}`);
  });

  it('returns 0 and does not throw when the directory is unreadable', async () => {
    const io = fakeIo({
      listDir: jest.fn(async () => {
        throw new Error('ENOENT');
      }),
    });
    await expect(pruneShareCache({ cacheRoot: ROOT, io, now: NOW })).resolves.toBe(0);
  });
});
