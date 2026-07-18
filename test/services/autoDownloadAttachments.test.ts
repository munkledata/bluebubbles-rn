/**
 * autoDownloadMessageAttachments (src/services/download/autoDownloadAttachments.ts): the ingestion
 * -path auto-download orchestration. The native pieces it lazily imports (the download fetcher +
 * expo-media-library) are mocked; assertions cover the gating (flag off / non-image) and the
 * download → album-save → batched-toast flow. Node project (no real natives).
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
import { autoDownloadMessageAttachments } from '@/services/download/autoDownloadAttachments';

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

  it('skips a non-image attachment (not eligible)', async () => {
    mockList.mockResolvedValue(new Map([[1, [imageRow({ mimeType: 'application/pdf' })]]]));
    await autoDownloadMessageAttachments(db, 1);
    expect(mockList).toHaveBeenCalledWith(db, [1]);
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
    expect(mockDownload).toHaveBeenCalledWith(expect.objectContaining({ guid: 'a1' }));
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('album destination saves into the album (move) and pops a batched toast', async () => {
    jest.useFakeTimers();
    try {
      useFeatureSettingsStore.setState({ autoDownloadDestination: 'album' });
      mockList.mockResolvedValue(new Map([[1, [imageRow()]]]));
      await autoDownloadMessageAttachments(db, 1);
      expect(mockSave).toHaveBeenCalledWith('file:///dl/a1.jpg', { album: true });
      // Toast is batched — nothing yet, then fires after the debounce window.
      expect(useToastStore.getState().current).toBeNull();
      jest.advanceTimersByTime(1300);
      expect(useToastStore.getState().current?.message).toContain('Gator album');
    } finally {
      jest.useRealTimers();
    }
  });
});
