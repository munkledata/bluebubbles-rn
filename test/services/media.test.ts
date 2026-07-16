/**
 * src/services/media.ts — the shared attachment share / save-to-Photos helpers used by
 * the chat screen's message actions and the fullscreen media viewer. The expo natives
 * are mocked; assertions cover the permission gating, the file://-only path filter
 * (bare '/' paths are NOT local files), and the error-to-result mapping.
 */
jest.mock('expo-media-library', () => ({
  requestPermissionsAsync: jest.fn(),
  saveToLibraryAsync: jest.fn(),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';

const requestPerm = MediaLibrary.requestPermissionsAsync as jest.Mock;
const saveToLibrary = MediaLibrary.saveToLibraryAsync as jest.Mock;
const isAvailable = Sharing.isAvailableAsync as jest.Mock;
const shareAsync = Sharing.shareAsync as jest.Mock;

beforeEach(() => {
  // The helpers log failures via the redacting logger's console sink — keep test output clean.
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('shareAttachment', () => {
  it('opens the share sheet with the path + mimeType and reports handled', async () => {
    isAvailable.mockResolvedValue(true);
    shareAsync.mockResolvedValue(undefined);
    await expect(shareAttachment('file:///docs/a.jpg', 'image/jpeg')).resolves.toBe(true);
    expect(shareAsync).toHaveBeenCalledWith('file:///docs/a.jpg', { mimeType: 'image/jpeg' });
  });

  it('maps a null mimeType to undefined', async () => {
    isAvailable.mockResolvedValue(true);
    shareAsync.mockResolvedValue(undefined);
    await shareAttachment('file:///docs/a.bin', null);
    expect(shareAsync).toHaveBeenCalledWith('file:///docs/a.bin', { mimeType: undefined });
  });

  it('returns false (caller may fall back) when sharing is unavailable', async () => {
    isAvailable.mockResolvedValue(false);
    await expect(shareAttachment('file:///docs/a.jpg', 'image/jpeg')).resolves.toBe(false);
    expect(shareAsync).not.toHaveBeenCalled();
  });

  it('treats a cancelled/failed share sheet as handled (true, no throw)', async () => {
    isAvailable.mockResolvedValue(true);
    shareAsync.mockRejectedValue(new Error('cancelled'));
    await expect(shareAttachment('file:///docs/a.jpg', 'image/jpeg')).resolves.toBe(true);
  });
});

describe('saveAttachmentsToPhotos', () => {
  it('reports denied (and saves nothing) without the Photos permission', async () => {
    requestPerm.mockResolvedValue({ status: 'denied' });
    await expect(saveAttachmentsToPhotos(['file:///docs/a.jpg'])).resolves.toEqual({
      status: 'denied',
    });
    expect(saveToLibrary).not.toHaveBeenCalled();
  });

  it('saves only local file:// URIs — bare paths and remote URLs are skipped', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    saveToLibrary.mockResolvedValue(undefined);
    const res = await saveAttachmentsToPhotos([
      'file:///docs/a.jpg',
      '/tmp/bare.jpg',
      'https://dev.local/b.jpg',
      null,
      undefined,
      'file:///docs/c.png',
    ]);
    expect(res).toEqual({ status: 'saved', saved: 2 });
    expect(saveToLibrary).toHaveBeenCalledTimes(2);
    expect(saveToLibrary).toHaveBeenNthCalledWith(1, 'file:///docs/a.jpg');
    expect(saveToLibrary).toHaveBeenNthCalledWith(2, 'file:///docs/c.png');
  });

  it('reports none when nothing is downloaded yet', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    await expect(saveAttachmentsToPhotos([null, 'https://dev.local/b.jpg'])).resolves.toEqual({
      status: 'none',
    });
    expect(saveToLibrary).not.toHaveBeenCalled();
  });

  it('maps a native save failure to an error result (no throw)', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    saveToLibrary.mockRejectedValue(new Error('disk full'));
    await expect(saveAttachmentsToPhotos(['file:///docs/a.jpg'])).resolves.toEqual({
      status: 'error',
    });
  });

  it('maps a permission-request failure to an error result (no throw)', async () => {
    requestPerm.mockRejectedValue(new Error('activity gone'));
    await expect(saveAttachmentsToPhotos(['file:///docs/a.jpg'])).resolves.toEqual({
      status: 'error',
    });
  });
});
