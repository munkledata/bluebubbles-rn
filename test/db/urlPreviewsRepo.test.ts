import { getUrlPreview, setUrlPreview } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { createTestDb } from '../support/testDb';

const URL = 'https://example.com/article';

describe('url preview cache repository', () => {
  it('returns null for a URL that was never cached', async () => {
    const t = await createTestDb();
    expect(await getUrlPreview(t.db, URL)).toBeNull();
  });

  it('stores and reads back a full preview', async () => {
    const t = await createTestDb();
    await setUrlPreview(
      t.db,
      URL,
      {
        title: 'Title',
        description: 'Desc',
        imageUrl: 'https://example.com/og.png',
        siteName: 'Example',
      },
      1_000,
    );
    expect(await getUrlPreview(t.db, URL)).toEqual({
      url: URL,
      title: 'Title',
      description: 'Desc',
      imageUrl: 'https://example.com/og.png',
      siteName: 'Example',
      fetchedAt: 1_000,
      error: 0,
    });
  });

  it('defaults omitted fields to null and error to 0', async () => {
    const t = await createTestDb();
    await setUrlPreview(t.db, URL, { title: 'Only title' }, 5);
    expect(await getUrlPreview(t.db, URL)).toEqual({
      url: URL,
      title: 'Only title',
      description: null,
      imageUrl: null,
      siteName: null,
      fetchedAt: 5,
      error: 0,
    });
  });

  it('records a failed fetch as error=1 so the UI can skip re-fetching', async () => {
    const t = await createTestDb();
    await setUrlPreview(t.db, URL, { error: true }, 42);
    expect(await getUrlPreview(t.db, URL)).toMatchObject({ error: 1, fetchedAt: 42, title: null });
  });

  it('upserts on conflict: a re-fetch fully replaces the cached row (stale fields cleared)', async () => {
    const t = await createTestDb();
    await setUrlPreview(t.db, URL, { title: 'Old', description: 'Old desc', error: true }, 1);
    await setUrlPreview(t.db, URL, { title: 'New' }, 2);
    expect(await getUrlPreview(t.db, URL)).toEqual({
      url: URL,
      title: 'New',
      description: null, // the stale description must NOT survive the upsert
      imageUrl: null,
      siteName: null,
      fetchedAt: 2,
      error: 0, // a later success clears the error flag
    });
  });

  it('caches per-URL — a different URL is a different row', async () => {
    const t = await createTestDb();
    await setUrlPreview(t.db, URL, { title: 'A' }, 1);
    await setUrlPreview(t.db, 'https://other.example', { title: 'B' }, 1);
    expect((await getUrlPreview(t.db, URL))?.title).toBe('A');
    expect((await getUrlPreview(t.db, 'https://other.example'))?.title).toBe('B');
  });

  it('queues an upsert behind a rolling-back neighbour instead of joining it', async () => {
    const t = await createTestDb();
    await setUrlPreview(t.db, URL, { title: 'Old' }, 1);

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(t.db, async () => {
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    const update = setUrlPreview(t.db, URL, { title: 'New' }, 2);
    await Promise.resolve();
    expect(
      (t.raw.prepare('SELECT title FROM url_previews WHERE url = ?').get(URL) as { title: string })
        .title,
    ).toBe('Old');

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await update;
    expect(await getUrlPreview(t.db, URL)).toMatchObject({ title: 'New', fetchedAt: 2 });
  });
});
