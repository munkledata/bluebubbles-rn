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
import { download, setAttachmentFetcher } from '@/services/download';
import {
  AttachmentFetchError,
  type AttachmentFetchRequest,
} from '@/services/download/downloadService';
import { captureRealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
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
