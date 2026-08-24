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
const mockFileExists = jest.fn((_path: string) => true);
jest.mock('expo-file-system', () => ({
  File: class {
    constructor(private readonly path: string) {}
    get exists(): boolean {
      return mockFileExists(this.path);
    }
  },
}));

const mockReleaseProtection = jest.fn();
const mockProtectPath = jest.fn<{ path: string; release: () => void } | null, [string]>((path) => ({
  path,
  release: mockReleaseProtection,
}));
jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: { protect: (path: string) => mockProtectPath(path) },
}));

import * as MediaLibrary from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';
import { statNativeAttachmentCacheFile } from '@native/boundedDownload';
import { saveAttachmentsToPhotos, saveImageToLibrary, shareAttachment } from '@/services/media';

const requestPerm = MediaLibrary.requestPermissionsAsync as jest.Mock;
const saveToLibrary = MediaLibrary.saveToLibraryAsync as jest.Mock;
const createAsset = MediaLibrary.createAssetAsync as jest.Mock;
const getAlbum = MediaLibrary.getAlbumAsync as jest.Mock;
const createAlbum = MediaLibrary.createAlbumAsync as jest.Mock;
const addToAlbum = MediaLibrary.addAssetsToAlbumAsync as jest.Mock;
const isAvailable = Sharing.isAvailableAsync as jest.Mock;
const shareAsync = Sharing.shareAsync as jest.Mock;
const statAttachment = statNativeAttachmentCacheFile as jest.Mock;

beforeEach(() => {
  // The helpers log failures via the redacting logger's console sink — keep test output clean.
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockProtectPath.mockReset().mockImplementation((path: string) => ({
    path,
    release: mockReleaseProtection,
  }));
  mockReleaseProtection.mockReset();
  statAttachment.mockReset().mockResolvedValue({ exists: true, bytes: 100 });
  mockFileExists.mockReset().mockReturnValue(true);
});

describe('shareAttachment', () => {
  it('opens the share sheet with the path + mimeType and reports ok', async () => {
    isAvailable.mockResolvedValue(true);
    shareAsync.mockResolvedValue(undefined);
    await expect(shareAttachment('file:///docs/a.jpg', 'image/jpeg')).resolves.toEqual({
      ok: true,
    });
    expect(shareAsync).toHaveBeenCalledWith('file:///docs/a.jpg', { mimeType: 'image/jpeg' });
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
  });

  it('acquires its operation pin synchronously and holds it until sharing settles', async () => {
    let settle!: (available: boolean) => void;
    isAvailable.mockReturnValue(
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
    );

    const result = shareAttachment('file:///docs/a.jpg', 'image/jpeg');
    expect(mockProtectPath).toHaveBeenCalledWith('file:///docs/a.jpg');
    expect(mockReleaseProtection).not.toHaveBeenCalled();

    settle(false);
    await expect(result).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
  });

  it('never hands the path to native sharing when protection is refused', async () => {
    mockProtectPath.mockReturnValueOnce(null);
    await expect(shareAttachment('file:///docs/a.jpg', 'image/jpeg')).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(statAttachment).not.toHaveBeenCalled();
    expect(isAvailable).not.toHaveBeenCalled();
    expect(shareAsync).not.toHaveBeenCalled();
  });

  it('revalidates the exact file under the pin before opening the share sheet', async () => {
    statAttachment.mockResolvedValueOnce({ exists: false, bytes: 0 });
    await expect(shareAttachment('file:///docs/a.jpg', 'image/jpeg')).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(statAttachment).toHaveBeenCalledWith('file:///docs/a.jpg');
    expect(isAvailable).not.toHaveBeenCalled();
    expect(shareAsync).not.toHaveBeenCalled();
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
  });

  it('uses an exact Expo stat for a valid user file outside the fixed cache boundary', async () => {
    statAttachment.mockRejectedValueOnce(new Error('outside attachment root'));
    isAvailable.mockResolvedValue(true);
    shareAsync.mockResolvedValue(undefined);

    await expect(shareAttachment('file:///picker/a.jpg', 'image/jpeg')).resolves.toEqual({
      ok: true,
    });
    expect(mockFileExists).toHaveBeenCalledWith('file:///picker/a.jpg');
    expect(shareAsync).toHaveBeenCalledWith('file:///picker/a.jpg', { mimeType: 'image/jpeg' });
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
  });

  it('fails closed when native stat rejects a canonical managed-cache path', async () => {
    const managedPath =
      'file:///data/user/0/app/files/attachments/media-att-1/generation-1/media-a.jpg';
    statAttachment.mockRejectedValueOnce(new Error('symlink or corrupt managed path'));

    await expect(shareAttachment(managedPath, 'image/jpeg')).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(mockFileExists).not.toHaveBeenCalled();
    expect(isAvailable).not.toHaveBeenCalled();
    expect(shareAsync).not.toHaveBeenCalled();
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when native stat rejects a malformed path in the managed namespace', async () => {
    const malformedManagedPath =
      'file:///data/user/0/app/files/attachments/media-att-1/generation-01/media-a.jpg';
    statAttachment.mockRejectedValueOnce(new Error('noncanonical managed path'));

    await expect(shareAttachment(malformedManagedPath, 'image/jpeg')).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(mockFileExists).not.toHaveBeenCalled();
    expect(isAvailable).not.toHaveBeenCalled();
    expect(shareAsync).not.toHaveBeenCalled();
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
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

  it('does not open the share sheet after ownership retires during file revalidation', async () => {
    let resolveStat!: (value: { exists: boolean; bytes: number }) => void;
    statAttachment.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStat = resolve;
      }),
    );
    isAvailable.mockResolvedValue(true);
    shareAsync.mockResolvedValue(undefined);
    let current = true;
    const pending = shareAttachment('file:///docs/a.jpg', 'image/jpeg', () => current);
    expect(statAttachment).toHaveBeenCalledTimes(1);

    current = false;
    resolveStat({ exists: true, bytes: 100 });

    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' });
    expect(isAvailable).not.toHaveBeenCalled();
    expect(shareAsync).not.toHaveBeenCalled();
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
  });
});

describe('saveAttachmentsToPhotos', () => {
  it('does not write to Photos after ownership retires during file revalidation', async () => {
    let resolveStat!: (value: { exists: boolean; bytes: number }) => void;
    statAttachment.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStat = resolve;
      }),
    );
    requestPerm.mockResolvedValue({ status: 'granted' });
    saveToLibrary.mockResolvedValue(undefined);
    let current = true;
    const pending = saveAttachmentsToPhotos(['file:///docs/a.jpg'], () => current);
    expect(statAttachment).toHaveBeenCalledTimes(1);

    current = false;
    resolveStat({ exists: true, bytes: 100 });

    await expect(pending).resolves.toEqual({ status: 'stale' });
    expect(requestPerm).not.toHaveBeenCalled();
    expect(saveToLibrary).not.toHaveBeenCalled();
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
  });

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

  it('pins every local source synchronously before the first permission await', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    saveToLibrary.mockResolvedValue(undefined);

    const result = saveAttachmentsToPhotos(['file:///docs/a.jpg', 'file:///docs/b.jpg']);
    expect(mockProtectPath).toHaveBeenNthCalledWith(1, 'file:///docs/a.jpg');
    expect(mockProtectPath).toHaveBeenNthCalledWith(2, 'file:///docs/b.jpg');
    expect(mockReleaseProtection).not.toHaveBeenCalled();

    await expect(result).resolves.toEqual({ status: 'saved', saved: 2 });
    expect(mockReleaseProtection).toHaveBeenCalledTimes(2);
  });

  it('skips a path whose protection is refused and never passes it to MediaLibrary', async () => {
    mockProtectPath.mockImplementation((path: string) =>
      path.endsWith('/a.jpg') ? null : { path, release: mockReleaseProtection },
    );
    requestPerm.mockResolvedValue({ status: 'granted' });
    saveToLibrary.mockResolvedValue(undefined);

    await expect(
      saveAttachmentsToPhotos(['file:///docs/a.jpg', 'file:///docs/b.jpg']),
    ).resolves.toEqual({ status: 'saved', saved: 1 });
    expect(saveToLibrary).toHaveBeenCalledTimes(1);
    expect(saveToLibrary).toHaveBeenCalledWith('file:///docs/b.jpg');
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
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
    await expect(saveAttachmentsToPhotos([null, 'https://dev.local/b.jpg'])).resolves.toEqual({
      status: 'none',
    });
    expect(requestPerm).not.toHaveBeenCalled();
    expect(mockProtectPath).not.toHaveBeenCalled();
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
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
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
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
  });

  it('never calls the library when its operation pin is refused', async () => {
    mockProtectPath.mockReturnValueOnce(null);
    await expect(saveImageToLibrary('file:///docs/a.jpg')).resolves.toBe('error');
    expect(statAttachment).not.toHaveBeenCalled();
    expect(requestPerm).not.toHaveBeenCalled();
    expect(saveToLibrary).not.toHaveBeenCalled();
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

  // THE GUARD for the write-only permission's one sharp edge. `getAlbumAsync` is the only call on
  // this path gated on READ permission, which write-only never grants — so on a device that has
  // never granted media read it THROWS, and without this fallback every auto-downloaded picture
  // would silently stop reaching the Gator album (auto-download + the album destination are both
  // ON by default, and the caller only toasts on 'saved', so the failure would be invisible).
  it('still files into the album when the read-gated album LOOKUP throws', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    getAlbum.mockRejectedValue(new Error('Missing MEDIA_LIBRARY permissions.'));
    createAlbum.mockResolvedValue({ id: 'album-1', title: 'Gator' });
    await expect(saveImageToLibrary('file:///docs/a.jpg', { album: true })).resolves.toBe('saved');
    // Falls through to the write-gated, idempotent seed call — NOT to an unfiled gallery save.
    expect(createAlbum).toHaveBeenCalledWith('Gator', undefined, false, 'file:///docs/a.jpg');
    expect(saveToLibrary).not.toHaveBeenCalled();
    expect(addToAlbum).not.toHaveBeenCalled();
  });

  it('maps a native failure to error (no throw)', async () => {
    requestPerm.mockResolvedValue({ status: 'granted' });
    saveToLibrary.mockRejectedValue(new Error('disk full'));
    await expect(saveImageToLibrary('file:///docs/a.jpg')).resolves.toBe('error');
  });
});
