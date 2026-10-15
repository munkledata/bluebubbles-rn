/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
jest.mock('@db/database', () => ({ getDatabase: () => ({}) }));
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@/services/download/expoFetcher', () => ({
  expoFetcher: () => ({ exists: () => false, download: jest.fn() }),
}));
jest.mock('@utils/isDev', () => ({ isDevServer: () => true }));

import { logger } from '@core/secure';
import type { AttachmentRow } from '@db/repositories';
import { download, downloadFailureReason, setAttachmentFetcher } from '@/services/download';
import {
  AttachmentFetchError,
  MANUAL_ATTACHMENT_MAX_BYTES,
} from '@/services/download/downloadService';
import { captureRealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { useDownloadStore } from '@state/downloadStore';

function attachment(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 1,
    guid: 'att-reason-1',
    messageId: 1,
    mimeType: 'application/pdf',
    transferName: 'report.pdf',
    totalBytes: 1_000,
    height: null,
    width: null,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: null,
    service: 'iMessage',
    ...overrides,
  };
}

beforeEach(() => {
  useDownloadStore.getState().reset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('download failure reasons', () => {
  it('names only the failures the owner can act on', () => {
    expect(downloadFailureReason('storage', 'automatic')).toBe('storage-full');
    expect(downloadFailureReason('storage', 'manual')).toBe('storage-full');
    expect(downloadFailureReason('size', 'manual')).toBe('too-large');
    // An automatic attempt over its smaller cap can still be tapped to download.
    expect(downloadFailureReason('size', 'automatic')).toBeUndefined();
    expect(downloadFailureReason('timeout', 'manual')).toBeUndefined();
    expect(downloadFailureReason('missing', 'manual')).toBeUndefined();
  });

  it('says a tapped attachment over the absolute cap is too large, before any network work', async () => {
    const fetch = jest.fn();
    setAttachmentFetcher({ exists: () => false, download: fetch });
    const att = attachment({ totalBytes: MANUAL_ATTACHMENT_MAX_BYTES + 1 });

    await expect(download(att, 'manual', captureRealtimeDeliveryLease())).resolves.toBeNull();

    expect(fetch).not.toHaveBeenCalled();
    expect(useDownloadStore.getState().status[att.guid]).toBe('error');
    expect(useDownloadStore.getState().failure[att.guid]).toBe('too-large');
  });

  it('keeps and logs the reason a transfer failed, never its path', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    setAttachmentFetcher({
      exists: () => false,
      download: jest.fn(async () => {
        throw new AttachmentFetchError('size');
      }),
    });
    const att = attachment();

    await expect(download(att, 'manual', captureRealtimeDeliveryLease())).resolves.toBeNull();

    expect(useDownloadStore.getState().status[att.guid]).toBe('error');
    expect(useDownloadStore.getState().failure[att.guid]).toBe('too-large');
    expect(warn).toHaveBeenCalledWith('[download] attachment download failed', {
      status: 'size',
      mode: 'manual',
    });
  });
});
