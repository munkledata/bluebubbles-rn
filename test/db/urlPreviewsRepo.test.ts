import {
  getUrlPreview,
  setUrlPreview,
  URL_PREVIEW_CACHE_MAX_BYTES,
  URL_PREVIEW_CACHE_MAX_ENTRIES,
  URL_PREVIEW_NEGATIVE_TTL_MS,
  URL_PREVIEW_SUCCESS_TTL_MS,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import { createTestDb } from '../support/testDb';

const URL = 'https://example.com/article';
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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
        imageUrl: PNG_DATA_URL,
        siteName: 'Example',
      },
      1_000,
    );
    expect(await getUrlPreview(t.db, URL)).toEqual({
      url: URL,
      title: 'Title',
      description: 'Desc',
      imageUrl: PNG_DATA_URL,
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

  it('preserves a legacy failed-fetch marker for non-rendering', async () => {
    const t = await createTestDb();
    await setUrlPreview(t.db, URL, { error: true }, 42);
    expect(await getUrlPreview(t.db, URL)).toMatchObject({ error: 1, fetchedAt: 42, title: null });
  });

  it('drops remote and unsupported image URLs at the cache boundary', async () => {
    const t = await createTestDb();
    await setUrlPreview(
      t.db,
      URL,
      {
        title: 'Remote image',
        imageUrl: 'https://cdn.example.com/og.png',
      },
      1,
    );
    expect((await getUrlPreview(t.db, URL))?.imageUrl).toBeNull();

    await setUrlPreview(
      t.db,
      URL,
      {
        title: 'GIF image',
        imageUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
      },
      2,
    );
    expect((await getUrlPreview(t.db, URL))?.imageUrl).toBeNull();
  });

  it('upserts on conflict: a later cache write fully replaces stale fields', async () => {
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

  it('rejects a revoked commit guard before publishing a row', async () => {
    const t = await createTestDb();
    await expect(
      setUrlPreview(t.db, URL, { title: 'Stale account' }, 1, () => false),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(await getUrlPreview(t.db, URL)).toBeNull();
  });

  it('keeps at most 128 newest cache entries in the publishing transaction', async () => {
    const t = await createTestDb();
    const seed = t.raw.prepare(
      `INSERT INTO url_previews
         (url, title, description, image_url, site_name, fetched_at, error)
       VALUES (?, ?, NULL, NULL, NULL, ?, 0)`,
    );
    const now = URL_PREVIEW_SUCCESS_TTL_MS + 10_000;
    const insertSeeds = t.raw.transaction(() => {
      for (let index = 0; index < URL_PREVIEW_CACHE_MAX_ENTRIES; index += 1) {
        seed.run(`https://seed.example/${index}`, `Seed ${index}`, now - index - 1);
      }
    });
    insertSeeds();

    await setUrlPreview(t.db, URL, { title: 'Newest' }, now);

    const count = t.raw.prepare('SELECT COUNT(*) AS count FROM url_previews').get() as {
      count: number;
    };
    expect(count.count).toBe(URL_PREVIEW_CACHE_MAX_ENTRIES);
    expect(await getUrlPreview(t.db, URL)).toMatchObject({ title: 'Newest' });
    expect(await getUrlPreview(t.db, 'https://seed.example/127')).toBeNull();
  });

  it('measures UTF-8/blob bytes and prunes the oldest rows below 16 MiB', async () => {
    const t = await createTestDb();
    const seed = t.raw.prepare(
      `INSERT INTO url_previews
         (url, title, description, image_url, site_name, fetched_at, error)
       VALUES (?, 'Large', ?, NULL, NULL, ?, 0)`,
    );
    const oneMiBOfUtf8 = '😀'.repeat(256 * 1024);
    const now = URL_PREVIEW_SUCCESS_TTL_MS + 20_000;
    const insertSeeds = t.raw.transaction(() => {
      for (let index = 0; index < 17; index += 1) {
        seed.run(`https://large.example/${index}`, oneMiBOfUtf8, now - index - 1);
      }
    });
    insertSeeds();

    await setUrlPreview(t.db, URL, { title: 'Newest' }, now);

    const measured = t.raw
      .prepare(
        `SELECT COUNT(*) AS count,
          SUM(
            COALESCE(length(CAST(url AS BLOB)), 0)
            + COALESCE(length(CAST(title AS BLOB)), 0)
            + COALESCE(length(CAST(description AS BLOB)), 0)
            + COALESCE(length(CAST(image_url AS BLOB)), 0)
            + COALESCE(length(CAST(site_name AS BLOB)), 0)
          ) AS bytes
        FROM url_previews`,
      )
      .get() as { count: number; bytes: number };
    expect(measured.bytes).toBeLessThanOrEqual(URL_PREVIEW_CACHE_MAX_BYTES);
    expect(measured.count).toBeLessThan(18);
    expect(await getUrlPreview(t.db, URL)).toMatchObject({ title: 'Newest' });
  });

  it('prunes positive and negative rows at their exact TTL boundaries', async () => {
    const t = await createTestDb();
    const now = URL_PREVIEW_SUCCESS_TTL_MS + 50_000;
    const insert = t.raw.prepare(
      `INSERT INTO url_previews
         (url, title, description, image_url, site_name, fetched_at, error)
       VALUES (?, ?, NULL, NULL, NULL, ?, ?)`,
    );
    insert.run(
      'https://stale-positive.example',
      'Old success',
      now - URL_PREVIEW_SUCCESS_TTL_MS,
      0,
    );
    insert.run('https://stale-negative.example', null, now - URL_PREVIEW_NEGATIVE_TTL_MS, 1);
    insert.run('https://fresh.example', 'Fresh', now - URL_PREVIEW_SUCCESS_TTL_MS + 1, 0);

    await setUrlPreview(t.db, URL, { title: 'Trigger' }, now);

    expect(await getUrlPreview(t.db, 'https://stale-positive.example')).toBeNull();
    expect(await getUrlPreview(t.db, 'https://stale-negative.example')).toBeNull();
    expect(await getUrlPreview(t.db, 'https://fresh.example')).toMatchObject({ title: 'Fresh' });
  });
});
