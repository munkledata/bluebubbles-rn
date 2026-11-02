/**
 * videoPoster (src/ui/attachments/videoPoster.ts): a chat full of large videos once made one native
 * player per bubble at the same time and crashed with an OutOfMemoryError. Posters now come from a
 * queue that keeps at most one short-lived player alive, released before the next is created.
 */
const mockEvents: string[] = [];
const mockPending: Array<(ok: boolean) => void> = [];
let mockLive = 0;
let mockMaxLive = 0;

jest.mock('expo-video', () => ({
  createVideoPlayer: (source: string) => {
    mockLive += 1;
    mockMaxLive = Math.max(mockMaxLive, mockLive);
    mockEvents.push(`create ${source}`);
    return {
      generateThumbnailsAsync: () =>
        new Promise((resolve, reject) => {
          mockPending.push((ok) =>
            ok
              ? resolve([{ width: 600, height: 338, requestedTime: 0, actualTime: 0 }])
              : reject(new Error('unsupported codec')),
          );
        }),
      release: () => {
        mockLive -= 1;
        mockEvents.push(`release ${source}`);
      },
    };
  },
}));

import { cachedVideoPoster, requestVideoPoster } from '@ui/attachments/videoPoster';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('requestVideoPoster', () => {
  it('makes posters one at a time and releases each player before the next is created', async () => {
    const a = requestVideoPoster('att-a', '/a.mp4');
    const b = requestVideoPoster('att-b', '/b.mov');
    const c = requestVideoPoster('att-c', '/c.mp4');
    await flush();
    expect(mockEvents).toEqual(['create /a.mp4']);

    mockPending.shift()!(true);
    await flush();
    // A failed poster must not stall the queue behind it.
    mockPending.shift()!(false);
    await flush();
    mockPending.shift()!(true);

    await expect(a).resolves.toMatchObject({ width: 600 });
    await expect(b).resolves.toBeNull();
    await expect(c).resolves.toMatchObject({ width: 600 });
    expect(mockEvents).toEqual([
      'create /a.mp4',
      'release /a.mp4',
      'create /b.mov',
      'release /b.mov',
      'create /c.mp4',
      'release /c.mp4',
    ]);
    expect(mockMaxLive).toBe(1);
    expect(mockLive).toBe(0);
  });

  it('reuses a cached poster without creating another player', async () => {
    mockEvents.length = 0;
    expect(cachedVideoPoster('att-a')).toMatchObject({ width: 600 });
    await expect(requestVideoPoster('att-a', '/a.mp4')).resolves.toMatchObject({ width: 600 });
    expect(mockEvents).toEqual([]);
    expect(cachedVideoPoster('att-b')).toBeUndefined();
  });
});
