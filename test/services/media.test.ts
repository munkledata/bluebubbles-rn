/**
 * src/services/media.ts — the shared attachment share / save-to-Photos helpers used by
 * the chat screen's message actions and the fullscreen media viewer. The expo natives
 * are mocked; assertions cover the permission gating, the file://-only path filter
 * (bare '/' paths are NOT local files), and the error-to-result mapping.
 */
jest.mock('expo-media-library/legacy', () => ({
  requestPermissionsAsync: jest.fn(),
  saveToLibraryAsync: jest.fn(),
  createAssetAsync: jest.fn(),
  getAlbumAsync: jest.fn(),
  createAlbumAsync: jest.fn(),
  addAssetsToAlbumAsync: jest.fn(),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

import * as MediaLibrary from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';
import { saveAttachmentsToPhotos, saveImageToLibrary, shareAttachment } from '@/services/media';

const requestPerm = MediaLibrary.requestPermissionsAsync as jest.Mock;
const saveToLibrary = MediaLibrary.saveToLibraryAsync as jest.Mock;
const createAsset = MediaLibrary.createAssetAsync as jest.Mock;
const getAlbum = MediaLibrary.getAlbumAsync as jest.Mock;
const createAlbum = MediaLibrary.createAlbumAsync as jest.Mock;
const addToAlbum = MediaLibrary.addAssetsToAlbumAsync as jest.Mock;
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

describe('saveImageToLibrary', () => {
  it('skips a non-local path without touching the library', async () => {
    await expect(saveImageToLibrary('https://dev.local/a.jpg')).resolves.toBe('skipped');
    await expect(saveImageToLibrary(null)).resolves.toBe('skipped');
    expect(requestPerm).not.toHaveBeenCalled();
  });

  it('reports denied without permission', async () => {
    requestPerm.mockResolvedValue({ status: 'denied' });
    await expect(saveImageToLibrary('file:///docs/a.jpg')).resolves.toBe('denied');
    expect(saveToLibrary).not.toHaveBeenCalled();
  });

  it('gallery save (no album) uses saveToLibraryAsync', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    saveToLibrary.mockResolvedValue(undefined);
    await expect(saveImageToLibrary('file:///docs/a.jpg')).resolves.toBe('saved');
    expect(saveToLibrary).toHaveBeenCalledWith('file:///docs/a.jpg');
    expect(createAsset).not.toHaveBeenCalled();
  });

  it('album save creates the album (moving the asset) when it does not exist yet', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    createAsset.mockResolvedValue({ id: 'asset-1' });
    getAlbum.mockResolvedValue(null);
    createAlbum.mockResolvedValue({ id: 'album-1', title: 'Gator' });
    await expect(saveImageToLibrary('file:///docs/a.jpg', { album: true })).resolves.toBe('saved');
    expect(createAsset).toHaveBeenCalledWith('file:///docs/a.jpg');
    expect(createAlbum).toHaveBeenCalledWith('Gator', { id: 'asset-1' }, false);
    expect(addToAlbum).not.toHaveBeenCalled();
  });

  it('album save adds to the existing album (copy=false → move, no duplicate)', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    createAsset.mockResolvedValue({ id: 'asset-2' });
    getAlbum.mockResolvedValue({ id: 'album-1', title: 'Gator' });
    addToAlbum.mockResolvedValue(true);
    await expect(saveImageToLibrary('file:///docs/a.jpg', { album: true })).resolves.toBe('saved');
    expect(addToAlbum).toHaveBeenCalledWith([{ id: 'asset-2' }], { id: 'album-1', title: 'Gator' }, false);
    expect(createAlbum).not.toHaveBeenCalled();
  });

  it('maps a native failure to error (no throw)', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    saveToLibrary.mockRejectedValue(new Error('disk full'));
    await expect(saveImageToLibrary('file:///docs/a.jpg')).resolves.toBe('error');
  });
});
