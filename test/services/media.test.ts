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
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('shareAttachment', () => {
  it('opens the share sheet with the path + mimeType and reports ok', async () => {
    isAvailable.mockResolvedValue(true);
    shareAsync.mockResolvedValue(undefined);
    await expect(shareAttachment('file:///docs/a.jpg', 'image/jpeg')).resolves.toEqual({ ok: true });
    expect(shareAsync).toHaveBeenCalledWith('file:///docs/a.jpg', { mimeType: 'image/jpeg' });
  });

  it('maps a null mimeType to undefined', async () => {
    isAvailable.mockResolvedValue(true);
    shareAsync.mockResolvedValue(undefined);
    await shareAttachment('file:///docs/a.bin', null);
    expect(shareAsync).toHaveBeenCalledWith('file:///docs/a.bin', { mimeType: undefined });
  });

  it('reports unavailable (caller may fall back) when sharing is unavailable', async () => {
    isAvailable.mockResolvedValue(false);
    await expect(shareAttachment('file:///docs/a.jpg', 'image/jpeg')).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(shareAsync).not.toHaveBeenCalled();
  });

  // THE REGRESSION GUARD. This used to swallow the throw and `return true` — so a share sheet that
  // never opened was indistinguishable from one the user used, and the viewer's share button read
  // as permanently dead with nothing anywhere to say why.
  it('reports failure when the native share throws — never a false success', async () => {
    isAvailable.mockResolvedValue(true);
    shareAsync.mockRejectedValue(new Error('Failed to share the file'));
    await expect(shareAttachment('file:///docs/a.jpg', 'image/jpeg')).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  // `error`, not `warn`: ErrorReportSink only captures error-level lines, so a warn would never
  // reach the uploaded error log — and there is no other signal that the sheet failed to open.
  it('logs the failure at error level so it reaches the error report queue', async () => {
    isAvailable.mockResolvedValue(true);
    shareAsync.mockRejectedValue(new Error('boom'));
    await shareAttachment('file:///docs/a.jpg', 'image/jpeg');
    expect(console.error).toHaveBeenCalled();
  });
});

describe('saveAttachmentsToPhotos', () => {
  // THE REGRESSION GUARD for the music-permission trap. A bare requestPermissionsAsync() asks for
  // READ access to photos + video + AUDIO as one all-or-nothing bundle, so declining the separate
  // "Music and audio" dialog silently killed saving for good — and after the second decline Android
  // stops asking at all. writeOnly resolves to an EMPTY permission set on Android 13+ (where the
  // native save needs no runtime permission anyway) and to WRITE_EXTERNAL_STORAGE below that.
  it('asks for WRITE-ONLY permission — never the read/audio bundle', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    saveToLibrary.mockResolvedValue(undefined);
    await saveAttachmentsToPhotos(['file:///docs/a.jpg']);
    expect(requestPerm).toHaveBeenCalledWith(true);
  });

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

  it('asks for WRITE-ONLY permission on the auto-download path too', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    saveToLibrary.mockResolvedValue(undefined);
    await saveImageToLibrary('file:///docs/a.jpg');
    expect(requestPerm).toHaveBeenCalledWith(true);
  });

  it('gallery save (no album) uses saveToLibraryAsync', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    saveToLibrary.mockResolvedValue(undefined);
    await expect(saveImageToLibrary('file:///docs/a.jpg')).resolves.toBe('saved');
    expect(saveToLibrary).toHaveBeenCalledWith('file:///docs/a.jpg');
    expect(createAsset).not.toHaveBeenCalled();
  });

  // THE GUARD, and the reason the album path looks the way it does: `addAssetsToAlbumAsync(…,
  // copy=false)` routes through `MediaStore.createWriteRequest` on Android 11+, which is a SYSTEM
  // CONSENT DIALOG ("Allow Gator to modify this photo?"). It is raised per IMAGE — each new picture
  // is a new URI the previous grant doesn't cover — and it needs a foreground Activity, so pictures
  // auto-downloaded while the app is backgrounded queue their prompts and land on the user in a
  // stack on the next resume, naming threads they never opened. Writing the asset straight into the
  // album sets the MediaStore RELATIVE_PATH at INSERT time: nothing to consent to, and no
  // camera-roll duplicate to clean up afterwards.
  it('album save writes STRAIGHT into an existing album — never create-then-move', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    getAlbum.mockResolvedValue({ id: 'album-1', title: 'Gator' });
    createAsset.mockResolvedValue({ id: 'asset-2' });
    await expect(saveImageToLibrary('file:///docs/a.jpg', { album: true })).resolves.toBe('saved');
    expect(createAsset).toHaveBeenCalledWith('file:///docs/a.jpg', {
      id: 'album-1',
      title: 'Gator',
    });
    // Exactly one call, and it carries the album: a bare createAssetAsync(uri) would put the image
    // in the camera roll first, which is the duplicate the old move existed to clean up.
    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(addToAlbum).not.toHaveBeenCalled();
    expect(createAlbum).not.toHaveBeenCalled();
  });

  // Android can't create an EMPTY album, so the first save ever has to seed it. Seeding from an
  // already-created ASSET is the move path in disguise (createAlbumAsync's copy=false branch) and
  // would put the dialog right back on the very first picture — so seed from the local FILE.
  it('album save seeds a missing album from the local file, not from an asset', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    getAlbum.mockResolvedValue(null);
    createAlbum.mockResolvedValue({ id: 'album-1', title: 'Gator' });
    await expect(saveImageToLibrary('file:///docs/a.jpg', { album: true })).resolves.toBe('saved');
    expect(createAlbum).toHaveBeenCalledWith('Gator', undefined, false, 'file:///docs/a.jpg');
    expect(createAsset).not.toHaveBeenCalled();
    expect(addToAlbum).not.toHaveBeenCalled();
  });

  it('maps a native failure to error (no throw)', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    saveToLibrary.mockRejectedValue(new Error('disk full'));
    await expect(saveImageToLibrary('file:///docs/a.jpg')).resolves.toBe('error');
  });
});
