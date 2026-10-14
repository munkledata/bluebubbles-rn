/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
let activeDb: unknown = {};

jest.mock('@db/database', () => ({ getDatabase: () => activeDb }));
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@/services/download/expoFetcher', () => ({
  expoFetcher: () => ({ exists: () => false, download: jest.fn() }),
}));
jest.mock('@utils/isDev', () => ({ isDevServer: () => true }));

import { ServerInfo } from '@core/models';
import type { AttachmentRow } from '@db/repositories';
import { download, downloadWithClient, setAttachmentFetcher } from '@/services/download';
import {
  AttachmentFetchError,
  type AttachmentFetchRequest,
} from '@/services/download/downloadService';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { useDownloadStore } from '@state/downloadStore';
import { useSessionStore } from '@state/sessionStore';

const EPOCH_A = `gpe1_${'A'.repeat(43)}`;
const EPOCH_B = `gpe1_${'B'.repeat(42)}A`;
const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const attachmentGuid = (epoch: string): string =>
  `rcs-media-g1.${epoch}.${encoded('message-a')}.${encoded('media-a')}`;

function info(epoch: string) {
  return ServerInfo.parse({
    version: '2.0.0',
    rcs: true,
    supports_rcs_epoch_qualified_ids: true,
    rcs_provider_epoch: epoch,
  });
}

function attachment(guid: string): AttachmentRow {
  return {
    id: 1,
    guid,
    messageId: 1,
    mimeType: 'image/jpeg',
    transferName: 'photo.jpg',
    totalBytes: 1_000,
    height: null,
    width: null,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: null,
    service: 'RCS',
  };
}

describe('RCS provider-epoch attachment fetch admission', () => {
  const previousSession = useSessionStore.getState();

  beforeEach(() => {
    activeDb = {};
    useSessionStore.getState().connected('https://server.test', 'password', info(EPOCH_A));
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  afterAll(() => {
    useSessionStore.setState(previousSession);
  });

  it('rejects legacy and stale RCS media before a fetcher or database effect', async () => {
    const fetch = jest.fn();
    setAttachmentFetcher({ exists: () => false, download: fetch });

    for (const guid of ['rcs-media-legacy', attachmentGuid(EPOCH_B)]) {
      await expect(
        download(attachment(guid), 'manual', captureRealtimeDeliveryLease()),
      ).resolves.toBeNull();
    }

    expect(fetch).not.toHaveBeenCalled();
  });

  describe('a background owner (a killed-app push)', () => {
    beforeEach(() => {
      // A killed-app process never runs the foreground bootstrap, so it holds no server info.
      useSessionStore.setState({ serverInfo: null });
      useDownloadStore.getState().reset();
    });

    it('fetches current RCS media only when the owner confirms the pairing', async () => {
      const fetch = jest.fn(async () => {
        throw new AttachmentFetchError('missing');
      });
      setAttachmentFetcher({ exists: () => false, download: fetch });
      const photo = attachment(attachmentGuid(EPOCH_A));

      await expect(
        downloadWithClient({} as never, photo, 'automatic', captureRealtimeDeliveryLease()),
      ).resolves.toBeNull();
      expect(fetch).not.toHaveBeenCalled();

      await expect(
        downloadWithClient(
          {} as never,
          photo,
          'automatic',
          captureRealtimeDeliveryLease(),
          undefined,
          undefined,
          { acceptsRcsAttachment: (guid) => guid === photo.guid },
        ),
      ).resolves.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('leaves no failed mark when a quiet attempt fails, so an opened chat retries itself', async () => {
      const fetch = jest.fn(async () => {
        throw new AttachmentFetchError('missing');
      });
      setAttachmentFetcher({ exists: () => false, download: fetch });
      const photo = attachment(attachmentGuid(EPOCH_A));
      const accepts = { acceptsRcsAttachment: () => true };

      await downloadWithClient(
        {} as never,
        photo,
        'automatic',
        captureRealtimeDeliveryLease(),
        undefined,
        undefined,
        { ...accepts, quietFailure: true },
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(useDownloadStore.getState().status[photo.guid]).toBeUndefined();

      await downloadWithClient(
        {} as never,
        photo,
        'automatic',
        captureRealtimeDeliveryLease(),
        undefined,
        undefined,
        accepts,
      );
      expect(useDownloadStore.getState().status[photo.guid]).toBe('error');
    });

    it('leaves no spinner behind when the quiet owner stops mid-transfer', async () => {
      jest.useFakeTimers();
      let fetchStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        fetchStarted = resolve;
      });
      setAttachmentFetcher({
        exists: () => false,
        download: async (_guid, _name, _progress, _service, _generation, limits) => {
          if (!limits) throw new Error('expected bounded fetch request');
          fetchStarted();
          return new Promise<never>((_resolve, reject) => {
            limits.signal.addEventListener(
              'abort',
              () => reject(new AttachmentFetchError('cancelled')),
              { once: true },
            );
          });
        },
      });
      const photo = attachment(attachmentGuid(EPOCH_A));
      const delivery = captureRealtimeDeliveryLease();
      // A killed-app owner's bounded lifetime ends while its transfer is still running.
      let ownerCurrent = true;
      const lease = {
        generation: delivery.generation,
        isCurrent: () => ownerCurrent && delivery.isCurrent(),
      };

      const task = downloadWithClient(
        {} as never,
        photo,
        'automatic',
        lease,
        undefined,
        undefined,
        {
          acceptsRcsAttachment: () => true,
          quietFailure: true,
        },
      );
      await started;
      expect(useDownloadStore.getState().status[photo.guid]).toBe('downloading');
      ownerCurrent = false;
      await jest.advanceTimersByTimeAsync(101);

      await expect(task).resolves.toBeNull();
      expect(useDownloadStore.getState().status[photo.guid]).toBeUndefined();
    });

    it('leaves the photo to a retry the user already started', async () => {
      jest.useFakeTimers();
      // The user is in the app and tapped the photo, so the foreground session holds the pairing.
      useSessionStore.getState().connected('https://server.test', 'password', info(EPOCH_A));
      const fetch = jest.fn(async () => {
        throw new AttachmentFetchError('missing');
      });
      setAttachmentFetcher({ exists: () => false, download: fetch });
      const photo = attachment(attachmentGuid(EPOCH_A));

      // The tap fails for now, so its RCS retry waits for the next try and keeps the spinner.
      await expect(download(photo, 'manual', captureRealtimeDeliveryLease())).resolves.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(useDownloadStore.getState().status[photo.guid]).toBe('downloading');

      // A background push download for the same photo must not cancel that retry.
      await expect(
        downloadWithClient(
          {} as never,
          photo,
          'automatic',
          captureRealtimeDeliveryLease(),
          undefined,
          undefined,
          { acceptsRcsAttachment: () => true, quietFailure: true },
        ),
      ).resolves.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(useDownloadStore.getState().status[photo.guid]).toBe('downloading');

      // The user's retries still run, and their final failure is the one the bubble shows.
      await jest.advanceTimersByTimeAsync(2500 + 6000 + 12000);
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(useDownloadStore.getState().status[photo.guid]).toBe('error');
    });

    it('never clears the next account’s entry after a Disconnect', async () => {
      jest.useFakeTimers();
      let fetchStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        fetchStarted = resolve;
      });
      setAttachmentFetcher({
        exists: () => false,
        download: async (_guid, _name, _progress, _service, _generation, limits) => {
          if (!limits) throw new Error('expected bounded fetch request');
          fetchStarted();
          return new Promise<never>((_resolve, reject) => {
            limits.signal.addEventListener(
              'abort',
              () => reject(new AttachmentFetchError('cancelled')),
              { once: true },
            );
          });
        },
      });
      const photo = attachment(attachmentGuid(EPOCH_A));
      const task = downloadWithClient(
        {} as never,
        photo,
        'automatic',
        captureRealtimeDeliveryLease(),
        undefined,
        undefined,
        { acceptsRcsAttachment: () => true, quietFailure: true },
      );
      await started;

      // Disconnect retires the account and resets download state; the next session starts again.
      await pauseRealtimeDeliveries();
      useDownloadStore.getState().reset();
      resumeRealtimeDeliveries();
      useDownloadStore.getState().start(photo.guid);
      await jest.advanceTimersByTimeAsync(101);

      await expect(task).resolves.toBeNull();
      expect(useDownloadStore.getState().status[photo.guid]).toBe('downloading');
    });
  });

  it('aborts a current RCS media fetch when the provider epoch rotates', async () => {
    jest.useFakeTimers();
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const fetch = jest.fn(
      async (
        _guid: string,
        _name: string,
        _progress: unknown,
        _service: unknown,
        _generation: unknown,
        limits?: AttachmentFetchRequest,
      ) => {
        if (!limits) throw new Error('expected bounded fetch request');
        fetchStarted();
        return new Promise<never>((_resolve, reject) => {
          limits.signal.addEventListener(
            'abort',
            () => reject(new AttachmentFetchError('cancelled')),
            { once: true },
          );
        });
      },
    );
    setAttachmentFetcher({ exists: () => false, download: fetch });

    const task = download(
      attachment(attachmentGuid(EPOCH_A)),
      'manual',
      captureRealtimeDeliveryLease(),
    );
    await started;

    const state = useSessionStore.getState();
    expect(
      state.setServerInfoForTransport(state.origin!, state.transportRevision, info(EPOCH_B)),
    ).toBe(true);
    await jest.advanceTimersByTimeAsync(101);

    await expect(task).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
