/* eslint-disable import/first -- install native/ESM boundary mocks before loading the service */
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));

import type { UrlPreviewResult } from '@core/api/endpoints/urlPreviews';
import { getUrlPreview, type UrlPreviewRow } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import {
  isUrlPreviewCacheFresh,
  URL_PREVIEW_MAX_ACTIVE,
  URL_PREVIEW_MAX_QUEUED,
  UrlPreviewLoader,
  type UrlPreviewLoaderDependencies,
  type UrlPreviewSessionIdentity,
} from '@/services/urlPreviewLoader';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';
/* eslint-enable import/first */

const INPUT_URL = 'https://example.com/original';
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function preview(url = INPUT_URL): UrlPreviewResult {
  return {
    url,
    title: '  Example title  ',
    description: '  Example description  ',
    siteName: '  Example  ',
    imageDataUrl: PNG_DATA_URL,
  };
}

function row(overrides: Partial<UrlPreviewRow> = {}): UrlPreviewRow {
  return {
    url: INPUT_URL,
    title: 'Example title',
    description: null,
    imageUrl: null,
    siteName: null,
    fetchedAt: 1_000,
    error: 0,
    ...overrides,
  };
}

function createHarness() {
  const db = {} as AppDatabase;
  let accountEpoch = 7;
  let transportRevision = 11;
  let realtimeGeneration = 3;
  let accepting = true;
  let currentTime = 2_000;
  const invalidationListeners = new Set<() => void>();
  const transportInvalidationListeners = new Set<() => void>();

  const captureSessionIdentity = jest.fn((): UrlPreviewSessionIdentity => ({
    accountEpoch,
    transportRevision,
  }));
  const captureLease = jest.fn(() => {
    const generation = realtimeGeneration;
    return {
      generation,
      isCurrent: () => accepting && generation === realtimeGeneration,
    };
  });
  const subscribeInvalidation = jest.fn((generation: number, listener: () => void) => {
    if (!accepting || generation !== realtimeGeneration) {
      listener();
      return () => undefined;
    }
    invalidationListeners.add(listener);
    return () => invalidationListeners.delete(listener);
  });
  const subscribeTransportInvalidation = jest.fn(
    (identity: UrlPreviewSessionIdentity, listener: () => void) => {
      if (
        identity.accountEpoch !== accountEpoch ||
        identity.transportRevision !== transportRevision
      ) {
        listener();
        return () => undefined;
      }
      transportInvalidationListeners.add(listener);
      return () => transportInvalidationListeners.delete(listener);
    },
  );
  const fetchPreview = jest.fn(
    async (url: string, _signal: AbortSignal): Promise<UrlPreviewResult> => preview(url),
  );
  const captureTransport = jest.fn(() => {
    const revision = transportRevision;
    return {
      key: `transport-${revision}`,
      isCurrent: () => revision === transportRevision,
      fetch: fetchPreview,
    };
  });
  const readPreview = jest.fn(
    async (_db: AppDatabase, _url: string): Promise<UrlPreviewRow | null> => null,
  );
  const writePreview = jest.fn(
    async (
      ..._args: Parameters<NonNullable<UrlPreviewLoaderDependencies['writePreview']>>
    ): Promise<void> => undefined,
  );
  const getDatabase = jest.fn(() => db);
  const dependencies: UrlPreviewLoaderDependencies = {
    captureSessionIdentity,
    captureLease,
    subscribeInvalidation,
    subscribeTransportInvalidation,
    captureTransport,
    getDatabase,
    readPreview,
    runTrackedWork: async (lease, task) => {
      if (!lease.isCurrent()) return 'paused';
      await task(lease);
      return 'delivered';
    },
    writePreview,
    now: () => currentTime,
  };

  return {
    db,
    loader: new UrlPreviewLoader(dependencies),
    captureLease,
    captureTransport,
    subscribeTransportInvalidation,
    getDatabase,
    fetchPreview,
    readPreview,
    writePreview,
    identity: (): UrlPreviewSessionIdentity => ({ accountEpoch, transportRevision }),
    retireAccount: (): void => {
      accepting = false;
      accountEpoch += 1;
      transportRevision += 1;
      realtimeGeneration += 1;
      for (const listener of [...invalidationListeners]) listener();
      invalidationListeners.clear();
    },
    resumeAccount: (): void => {
      accepting = true;
    },
    rotateTransport: (): void => {
      transportRevision += 1;
      for (const listener of [...transportInvalidationListeners]) listener();
      transportInvalidationListeners.clear();
    },
    setNow: (now: number): void => {
      currentTime = now;
    },
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('UrlPreviewLoader', () => {
  it('skips unsafe URLs before cache, transport, or network work', async () => {
    const h = createHarness();

    await expect(h.loader.load('https://user:secret@example.com/private')).resolves.toBe('skipped');
    expect(h.captureLease).not.toHaveBeenCalled();
    expect(h.captureTransport).not.toHaveBeenCalled();
    expect(h.readPreview).not.toHaveBeenCalled();
    expect(h.fetchPreview).not.toHaveBeenCalled();
    expect(h.writePreview).not.toHaveBeenCalled();
  });

  it('does not capture a replacement database when transport invalidates during registration', async () => {
    const h = createHarness();
    h.subscribeTransportInvalidation.mockImplementationOnce((_identity, listener) => {
      listener();
      return () => undefined;
    });

    await expect(h.loader.load(INPUT_URL)).resolves.toBe('skipped');
    expect(h.getDatabase).not.toHaveBeenCalled();
    expect(h.readPreview).not.toHaveBeenCalled();
    expect(h.fetchPreview).not.toHaveBeenCalled();
    expect(h.writePreview).not.toHaveBeenCalled();
  });

  it('reads the cache before automatically fetching and stores the input URL with the data image', async () => {
    const h = createHarness();
    const cacheRead = deferred<UrlPreviewRow | null>();
    h.readPreview.mockReturnValueOnce(cacheRead.promise);

    const cached = h.loader.readAndLoadForSession(INPUT_URL, h.identity());
    expect(h.readPreview).toHaveBeenCalledWith(h.db, INPUT_URL);
    expect(h.fetchPreview).not.toHaveBeenCalled();

    cacheRead.resolve(null);
    await expect(cached).resolves.toBeNull();
    await nextTurn();

    expect(h.fetchPreview).toHaveBeenCalledWith(INPUT_URL, expect.any(AbortSignal));
    expect(h.writePreview).toHaveBeenCalledWith(
      h.db,
      INPUT_URL,
      {
        title: 'Example title',
        description: 'Example description',
        siteName: 'Example',
        imageUrl: PNG_DATA_URL,
      },
      2_000,
      expect.any(Function),
    );
  });

  it('coalesces the exact URL for the same account and pinned transport', async () => {
    const h = createHarness();
    const response = deferred<UrlPreviewResult>();
    h.fetchPreview.mockReturnValue(response.promise);

    const first = h.loader.load(INPUT_URL);
    const second = h.loader.load(INPUT_URL);
    expect(second).toBe(first);
    await nextTurn();
    expect(h.fetchPreview).toHaveBeenCalledTimes(1);

    response.resolve(preview());
    await expect(first).resolves.toBe('stored');
    expect(h.writePreview).toHaveBeenCalledTimes(1);
  });

  it('caps network work at two active requests and rejects a 65th queued request', async () => {
    const h = createHarness();
    const release = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    h.fetchPreview.mockImplementation(async (url) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await release.promise;
      active -= 1;
      return preview(url);
    });

    const admitted = URL_PREVIEW_MAX_ACTIVE + URL_PREVIEW_MAX_QUEUED;
    const requests = Array.from({ length: admitted + 1 }, (_, index) =>
      h.loader.load(`https://example.com/${index}`),
    );

    await expect(requests[admitted]).resolves.toBe('queue_full');
    await nextTurn();
    expect(h.fetchPreview).toHaveBeenCalledTimes(URL_PREVIEW_MAX_ACTIVE);
    expect(maximumActive).toBe(URL_PREVIEW_MAX_ACTIVE);

    release.resolve();
    await expect(Promise.all(requests.slice(0, admitted))).resolves.toEqual(
      Array.from({ length: admitted }, () => 'stored'),
    );
    expect(maximumActive).toBe(URL_PREVIEW_MAX_ACTIVE);
    expect(h.fetchPreview).toHaveBeenCalledTimes(admitted);

    await expect(h.loader.load(`https://example.com/${admitted}`)).resolves.toBe('stored');
    expect(h.fetchPreview).toHaveBeenCalledTimes(admitted + 1);
  });

  it('removes queued account work on invalidation and admits the replacement account', async () => {
    const h = createHarness();
    const release = deferred<void>();
    h.fetchPreview.mockImplementation(async (url) => {
      await release.promise;
      return preview(url);
    });

    const active = [
      h.loader.load('https://example.com/active-a'),
      h.loader.load('https://example.com/active-b'),
    ];
    const queuedUrl = 'https://example.com/queued';
    const queued = h.loader.load(queuedUrl);
    await nextTurn();
    expect(h.fetchPreview).toHaveBeenCalledTimes(URL_PREVIEW_MAX_ACTIVE);

    h.retireAccount();
    await expect(queued).resolves.toBe('stale');
    expect(h.fetchPreview).not.toHaveBeenCalledWith(queuedUrl, expect.any(AbortSignal));

    h.resumeAccount();
    release.resolve();
    await expect(Promise.all(active)).resolves.toEqual(['stale', 'stale']);
    await expect(h.loader.load(queuedUrl)).resolves.toBe('stored');
    expect(h.fetchPreview).toHaveBeenCalledWith(queuedUrl, expect.any(AbortSignal));
  });

  it('does not adopt account B while account A cache read is still pending', async () => {
    const h = createHarness();
    const cacheRead = deferred<UrlPreviewRow | null>();
    h.readPreview.mockReturnValueOnce(cacheRead.promise);
    const pending = h.loader.readAndLoadForSession(INPUT_URL, h.identity());

    h.retireAccount();
    h.resumeAccount();
    cacheRead.resolve(null);

    await expect(pending).resolves.toBeNull();
    expect(h.fetchPreview).not.toHaveBeenCalled();
    expect(h.writePreview).not.toHaveBeenCalled();
  });

  it('rejects an already-stale render identity before reading, fetching, or writing', async () => {
    const h = createHarness();
    const expectedAccountA = h.identity();
    h.retireAccount();
    h.resumeAccount();
    h.captureLease.mockClear();
    h.captureTransport.mockClear();

    await expect(h.loader.readAndLoadForSession(INPUT_URL, expectedAccountA)).resolves.toBeNull();
    expect(h.captureLease).not.toHaveBeenCalled();
    expect(h.captureTransport).not.toHaveBeenCalled();
    expect(h.readPreview).not.toHaveBeenCalled();
    expect(h.fetchPreview).not.toHaveBeenCalled();
    expect(h.writePreview).not.toHaveBeenCalled();
  });

  it('aborts and drops an account-invalidated result without a positive or negative write', async () => {
    const h = createHarness();
    const response = deferred<UrlPreviewResult>();
    h.fetchPreview.mockReturnValue(response.promise);
    const pending = h.loader.load(INPUT_URL);
    await nextTurn();
    const signal = h.fetchPreview.mock.calls[0]?.[1];

    h.retireAccount();
    response.resolve(preview());

    await expect(pending).resolves.toBe('stale');
    expect(signal?.aborted).toBe(true);
    expect(h.writePreview).not.toHaveBeenCalled();
  });

  it('does not store a negative entry when the pinned transport changes before failure', async () => {
    const h = createHarness();
    const response = deferred<UrlPreviewResult>();
    h.fetchPreview.mockReturnValue(response.promise);
    const pending = h.loader.load(INPUT_URL);
    await nextTurn();
    const signal = h.fetchPreview.mock.calls[0]?.[1];

    h.rotateTransport();
    response.reject(new Error('old transport failed'));

    await expect(pending).resolves.toBe('stale');
    expect(signal?.aborted).toBe(true);
    expect(h.writePreview).not.toHaveBeenCalled();
  });

  it('stores a bounded negative entry for a current failure', async () => {
    const h = createHarness();
    h.fetchPreview.mockRejectedValue(new Error('offline'));

    await expect(h.loader.load(INPUT_URL)).resolves.toBe('negative');
    expect(h.writePreview).toHaveBeenCalledWith(
      h.db,
      INPUT_URL,
      { error: true },
      2_000,
      expect.any(Function),
    );
  });

  it('treats description-only server metadata as a positive preview', async () => {
    const h = createHarness();
    h.fetchPreview.mockResolvedValue({
      url: INPUT_URL,
      title: null,
      description: 'Description only',
      siteName: null,
      imageDataUrl: null,
    });

    await expect(h.loader.load(INPUT_URL)).resolves.toBe('stored');
    expect(h.writePreview).toHaveBeenCalledWith(
      h.db,
      INPUT_URL,
      { description: 'Description only' },
      2_000,
      expect.any(Function),
    );
  });

  it('does not display an expired success while its replacement loads', async () => {
    const h = createHarness();
    const response = deferred<UrlPreviewResult>();
    const day = 24 * 60 * 60 * 1_000;
    h.setNow(day + 1_000);
    h.readPreview.mockResolvedValue(row({ fetchedAt: 1_000 }));
    h.fetchPreview.mockReturnValue(response.promise);

    await expect(h.loader.readAndLoadForSession(INPUT_URL, h.identity())).resolves.toBeNull();
    await nextTurn();
    expect(h.fetchPreview).toHaveBeenCalledTimes(1);

    response.resolve(preview());
    await nextTurn();
  });
});

describe('isUrlPreviewCacheFresh', () => {
  it('uses 24 hours for success and 15 minutes for failures, excluding the exact boundary', () => {
    const day = 24 * 60 * 60 * 1_000;
    const retry = 15 * 60 * 1_000;
    expect(isUrlPreviewCacheFresh(row(), 1_000 + day - 1)).toBe(true);
    expect(isUrlPreviewCacheFresh(row(), 1_000 + day)).toBe(false);
    expect(isUrlPreviewCacheFresh(row({ error: 1 }), 1_000 + retry - 1)).toBe(true);
    expect(isUrlPreviewCacheFresh(row({ error: 1 }), 1_000 + retry)).toBe(false);
    expect(
      isUrlPreviewCacheFresh(
        row({ title: null, description: 'Description only', siteName: null }),
        1_001,
      ),
    ).toBe(true);
  });
});

/**
 * Every test above injects runTrackedWork/writePreview. Production omits both, so its commit runs
 * through the real realtime work tracker and the repository transaction (review M216).
 */
describe('UrlPreviewLoader production commit path', () => {
  async function productionLoader() {
    const { db } = await createTestDb();
    const fetchPreview = jest.fn(
      async (url: string, _signal: AbortSignal): Promise<UrlPreviewResult> => preview(url),
    );
    const loader = new UrlPreviewLoader({
      captureSessionIdentity: () => ({ accountEpoch: 1, transportRevision: 1 }),
      captureLease: captureRealtimeDeliveryLease,
      subscribeInvalidation: subscribeRealtimeGenerationInvalidation,
      subscribeTransportInvalidation: () => () => undefined,
      captureTransport: () => ({ key: 'transport-1', isCurrent: () => true, fetch: fetchPreview }),
      getDatabase: () => db,
      readPreview: getUrlPreview,
      now: () => 5_000,
    });
    return { db, loader, fetchPreview };
  }

  it('stores a fetched preview through the real tracked transaction', async () => {
    const { db, loader } = await productionLoader();

    await expect(loader.load(INPUT_URL)).resolves.toBe('stored');

    await expect(getUrlPreview(db, INPUT_URL)).resolves.toMatchObject({
      url: INPUT_URL,
      title: 'Example title',
      description: 'Example description',
      siteName: 'Example',
      fetchedAt: 5_000,
      error: 0,
    });
  });

  it('writes nothing once Disconnect has paused realtime work', async () => {
    const { db, loader, fetchPreview } = await productionLoader();
    const fetched = deferred<UrlPreviewResult>();
    fetchPreview.mockImplementationOnce(() => fetched.promise);
    try {
      const outcome = loader.load(INPUT_URL);
      for (let turn = 0; turn < 20 && fetchPreview.mock.calls.length === 0; turn += 1) {
        await nextTurn();
      }
      expect(fetchPreview).toHaveBeenCalledTimes(1);

      await pauseRealtimeDeliveries();
      fetched.resolve(preview());

      await expect(outcome).resolves.toBe('stale');
      await expect(getUrlPreview(db, INPUT_URL)).resolves.toBeNull();
    } finally {
      resumeRealtimeDeliveries();
    }
  });
});
