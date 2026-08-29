/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
/**
 * autoDownloadMessageAttachments (src/services/download/autoDownloadAttachments.ts): the ingestion
 * -path auto-download orchestration. The native pieces it lazily imports (the download fetcher +
 * expo-media-library) are mocked; assertions cover the gating (flag off / non-image) and the
 * download → album-save → typed presentation outcome flow. Node project (no real natives).
 */
// Mock the DB layer so importing the feature store doesn't pull op-sqlite (ESM, not transformable
// under ts-jest). We drive listAttachmentsByMessageIds directly and never touch a real DB.
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@db/repositories', () => ({ listAttachmentsByMessageIds: jest.fn() }));
jest.mock('@/services/download/index', () => ({ download: jest.fn() }));
jest.mock('@/services/media', () => ({ saveImageToLibrary: jest.fn() }));

import { listAttachmentsByMessageIds } from '@db/repositories';
import { download } from '@/services/download/index';
import { saveImageToLibrary } from '@/services/media';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useToastStore } from '@ui/toast/toastStore';
import { servicePresentationAdapter } from '@ui/servicePresentation';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import {
  autoDownloadMessageAttachments,
  MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE,
  MAX_AUTO_DOWNLOAD_FILES_PER_MESSAGE,
} from '@/services/download/autoDownloadAttachments';

const mockList = listAttachmentsByMessageIds as jest.Mock;
const mockDownload = download as jest.Mock;
const mockSave = saveImageToLibrary as jest.Mock;
const db = {} as never;

function imageRow(over: Record<string, unknown> = {}) {
  return {
    guid: 'a1',
    mimeType: 'image/jpeg',
    transferName: null,
    totalBytes: 1000,
    localPath: null,
    service: null,
    id: 1,
    ...over,
  };
}

beforeEach(() => {
  servicePresentationAdapter.resetSession();
  mockList.mockReset();
  mockDownload.mockReset().mockResolvedValue('file:///dl/a1.jpg');
  mockSave.mockReset().mockResolvedValue('saved');
  useFeatureSettingsStore.setState({
    hydrated: true,
    autoDownloadAttachments: true,
    autoDownloadOnWifiOnly: false,
    autoDownloadDestination: 'app',
  });
  useToastStore.setState({ current: null, queue: [] });
});

describe('autoDownloadMessageAttachments', () => {
  it('does nothing when auto-download is off', async () => {
    useFeatureSettingsStore.setState({ autoDownloadAttachments: false });
    await autoDownloadMessageAttachments(db, 1);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('fails closed when a headless wake cannot confirm feature settings', async () => {
    useFeatureSettingsStore.setState({ hydrated: false, autoDownloadAttachments: true });
    const hydrate = jest
      .spyOn(useFeatureSettingsStore.getState(), 'hydrate')
      .mockResolvedValue(undefined);

    try {
      await autoDownloadMessageAttachments(db, 1);

      expect(hydrate).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldCommit: expect.any(Function),
          onError: expect.any(Function),
        }),
      );
      expect(mockList).not.toHaveBeenCalled();
      expect(mockDownload).not.toHaveBeenCalled();
    } finally {
      hydrate.mockRestore();
    }
  });

  it('skips a non-image attachment (not eligible)', async () => {
    mockList.mockResolvedValue(new Map([[1, [imageRow({ mimeType: 'application/pdf' })]]]));
    await autoDownloadMessageAttachments(db, 1);
    expect(mockList).toHaveBeenCalledWith(db, [1], MAX_AUTO_DOWNLOAD_FILES_PER_MESSAGE, {
      excludeDeletedMessages: true,
      excludePluginPayloads: true,
    });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('skips an already-downloaded attachment (localPath set)', async () => {
    mockList.mockResolvedValue(new Map([[1, [imageRow({ localPath: 'file:///dl/a1.jpg' })]]]));
    await autoDownloadMessageAttachments(db, 1);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('downloads an eligible image; "app" destination saves no external copy', async () => {
    mockList.mockResolvedValue(new Map([[1, [imageRow()]]]));
    await autoDownloadMessageAttachments(db, 1);
    expect(mockDownload).toHaveBeenCalledWith(
      expect.objectContaining({ guid: 'a1' }),
      'automatic',
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
      expect.any(Function),
      MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE,
    );
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('returns an album-save outcome for the mounted UI to batch into one toast', async () => {
    jest.useFakeTimers();
    try {
      useFeatureSettingsStore.setState({ autoDownloadDestination: 'album' });
      mockList.mockResolvedValue(new Map([[1, [imageRow()]]]));
      const outcome = await autoDownloadMessageAttachments(db, 1);
      expect(mockSave).toHaveBeenCalledWith('file:///dl/a1.jpg', { album: true });
      expect(outcome).toEqual({ savedImages: 1, destination: 'album' });
      // Toast is batched — nothing yet, then fires after the debounce window.
      expect(useToastStore.getState().current).toBeNull();
      servicePresentationAdapter.presentAutoDownload(outcome);
      jest.advanceTimersByTime(1300);
      expect(useToastStore.getState().current?.message).toContain('Gator album');
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels an account-A batched toast before account B starts', async () => {
    jest.useFakeTimers();
    try {
      useFeatureSettingsStore.setState({ autoDownloadDestination: 'album' });
      mockList.mockResolvedValue(new Map([[1, [imageRow()]]]));
      const outcome = await autoDownloadMessageAttachments(db, 1);
      expect(mockSave).toHaveBeenCalledTimes(1);

      servicePresentationAdapter.presentAutoDownload(outcome);
      servicePresentationAdapter.resetSession();
      jest.advanceTimersByTime(1_300);

      expect(useToastStore.getState().current).toBeNull();
    } finally {
      servicePresentationAdapter.resetSession();
      jest.useRealTimers();
    }
  });

  it('does not recreate an account-A toast when its gallery save finishes after reset', async () => {
    jest.useFakeTimers();
    let current = true;
    let finishSave!: (result: 'saved') => void;
    try {
      useFeatureSettingsStore.setState({ autoDownloadDestination: 'album' });
      mockList.mockResolvedValue(new Map([[1, [imageRow()]]]));
      mockSave.mockReturnValueOnce(
        new Promise<'saved'>((resolve) => {
          finishSave = resolve;
        }),
      );
      const run = autoDownloadMessageAttachments(db, 1, {
        generation: 7,
        isCurrent: () => current,
      });
      for (let i = 0; i < 20 && mockSave.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(mockSave).toHaveBeenCalledTimes(1);

      current = false;
      servicePresentationAdapter.resetSession();
      finishSave('saved');
      await run;
      jest.advanceTimersByTime(1_300);

      expect(useToastStore.getState().current).toBeNull();
    } finally {
      servicePresentationAdapter.resetSession();
      jest.useRealTimers();
    }
  });

  it('keeps Disconnect draining until an admitted gallery save settles', async () => {
    let finishSave!: (result: 'saved') => void;
    let pause: Promise<void> | undefined;
    useFeatureSettingsStore.setState({ autoDownloadDestination: 'album' });
    mockList.mockResolvedValue(new Map([[1, [imageRow()]]]));
    mockSave.mockReturnValueOnce(
      new Promise<'saved'>((resolve) => {
        finishSave = resolve;
      }),
    );

    try {
      const run = autoDownloadMessageAttachments(db, 1);
      for (let i = 0; i < 20 && mockSave.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(mockSave).toHaveBeenCalledTimes(1);

      let drainFinished = false;
      pause = pauseRealtimeDeliveries().then(() => {
        drainFinished = true;
      });
      await Promise.resolve();
      expect(drainFinished).toBe(false);

      finishSave('saved');
      await run;
      await pause;
      expect(drainFinished).toBe(true);
      expect(useToastStore.getState().current).toBeNull();
    } finally {
      finishSave?.('saved');
      await pause;
      resumeRealtimeDeliveries();
    }
  });
  // A sticker is downloaded (the in-bubble overlay needs the file) but must never be filed into the
  // user's Photos. Before the overlay existed, that stray gallery image plus a "Downloaded 1 image"
  // toast was the ONLY visible trace of a received sticker.
  it('downloads a sticker but never saves it to the gallery, and pops no toast', async () => {
    jest.useFakeTimers();
    try {
      useFeatureSettingsStore.setState({ autoDownloadDestination: 'album' });
      mockList.mockResolvedValue(new Map([[1, [imageRow({ isSticker: 1 })]]]));
      await autoDownloadMessageAttachments(db, 1);
      expect(mockDownload).toHaveBeenCalledWith(
        expect.objectContaining({ guid: 'a1' }),
        'automatic',
        expect.objectContaining({
          generation: expect.any(Number),
          isCurrent: expect.any(Function),
        }),
        expect.any(Function),
        MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE,
      );
      expect(mockSave).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1300);
      expect(useToastStore.getState().current).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an image with missing or over-cap size metadata before importing the downloader', async () => {
    mockList.mockResolvedValue(
      new Map([
        [
          1,
          [
            imageRow({ guid: 'unknown', totalBytes: null }),
            imageRow({ totalBytes: 6 * 1024 * 1024 }),
          ],
        ],
      ]),
    );

    await autoDownloadMessageAttachments(db, 1);

    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('bounds the number of automatic files selected from one hostile message', async () => {
    mockList.mockResolvedValue(
      new Map([
        [
          1,
          Array.from({ length: MAX_AUTO_DOWNLOAD_FILES_PER_MESSAGE + 5 }, (_unused, index) =>
            imageRow({ guid: `many-${index}`, totalBytes: 1 }),
          ),
        ],
      ]),
    );

    await autoDownloadMessageAttachments(db, 1);

    expect(mockDownload).toHaveBeenCalledTimes(MAX_AUTO_DOWNLOAD_FILES_PER_MESSAGE);
  });

  it('bounds aggregate automatic bytes selected from one hostile message', async () => {
    const eachBytes = 4 * 1024 * 1024;
    mockList.mockResolvedValue(
      new Map([
        [
          1,
          Array.from({ length: MAX_AUTO_DOWNLOAD_FILES_PER_MESSAGE }, (_unused, index) =>
            imageRow({ guid: `aggregate-${index}`, totalBytes: eachBytes }),
          ),
        ],
      ]),
    );

    await autoDownloadMessageAttachments(db, 1);

    expect(mockDownload).toHaveBeenCalledTimes(
      Math.floor(MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE / eachBytes),
    );
  });

  it('shrinks the native per-file cap so under-reported actual bytes cannot cross the aggregate budget', async () => {
    const actualBytes = 5 * 1024 * 1024;
    mockList.mockResolvedValue(
      new Map([
        [
          1,
          Array.from({ length: MAX_AUTO_DOWNLOAD_FILES_PER_MESSAGE }, (_unused, index) =>
            imageRow({ guid: `under-reported-${index}`, totalBytes: 1 }),
          ),
        ],
      ]),
    );
    mockDownload.mockImplementation(
      async (
        attachment: { guid: string },
        _mode: string,
        _lease: unknown,
        onVerifiedBytes: (bytes: number) => void,
        maxBytes: number,
      ) => {
        expect(maxBytes).toBe(
          MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE -
            mockDownload.mock.calls.length * actualBytes +
            actualBytes,
        );
        onVerifiedBytes(actualBytes);
        return `file:///dl/${attachment.guid}.jpg`;
      },
    );

    await autoDownloadMessageAttachments(db, 1);

    expect(mockDownload).toHaveBeenCalledTimes(MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE / actualBytes);
    const caps = mockDownload.mock.calls.map((call) => call[4] as number);
    expect(caps).toEqual([
      40 * 1024 * 1024,
      35 * 1024 * 1024,
      30 * 1024 * 1024,
      25 * 1024 * 1024,
      20 * 1024 * 1024,
      15 * 1024 * 1024,
      10 * 1024 * 1024,
      5 * 1024 * 1024,
    ]);
  });
});
