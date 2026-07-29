// SDK 57 moved expo-media-library to a class-based API and turned the ROOT imperative functions
// (saveToLibraryAsync/createAssetAsync/…) into THROWING deprecation stubs — so importing the root
// silently broke Save-to-Photos on device. Import the legacy imperative API instead (same pattern
// AttachmentTray uses). See the expo-contacts/legacy note in AGENTS.md.
import * as MediaLibrary from 'expo-media-library/legacy';
import { logger } from '@core/secure';
import { isLocalFileUri } from '@utils';

/** Photos album auto-downloaded images are filed into (when the destination setting is 'album'). */
export const GATOR_ALBUM = 'Gator';

/**
 * Share/save helpers for downloaded attachment files, shared by the chat screen's
 * message actions and the fullscreen media viewer so the permission + error
 * handling lives in one place. Only local `file://` URIs are actionable — see
 * {@link isLocalFileUri}.
 */

/**
 * Open the OS share sheet for a downloaded attachment file. Returns false when
 * sharing is unavailable on this device (the caller may fall back to sharing
 * text); a cancelled or failed share sheet is handled here and reads as true.
 */
export async function shareAttachment(
  localPath: string,
  mimeType?: string | null,
): Promise<boolean> {
  try {
    // Lazy import: expo-sharing is a native module, kept off the screen-open path.
    const Sharing = await import('expo-sharing');
    if (!(await Sharing.isAvailableAsync())) return false;
    await Sharing.shareAsync(localPath, { mimeType: mimeType ?? undefined });
  } catch (e) {
    // User cancelled the share sheet, or the native share failed — nothing to surface.
    logger.warn('[media] share failed', e);
  }
  return true;
}

export type SaveToPhotosResult =
  | { status: 'saved'; saved: number }
  | { status: 'none' } // nothing downloaded yet
  | { status: 'denied' } // Photos permission refused
  | { status: 'error' };

/**
 * Save already-downloaded attachment files to the device photo library.
 * Requests the Photos permission, saves every local `file://` path, and skips
 * the rest (undownloaded / remote dev URLs).
 */
export async function saveAttachmentsToPhotos(
  paths: ReadonlyArray<string | null | undefined>,
): Promise<SaveToPhotosResult> {
  try {
    const perm = await MediaLibrary.requestPermissionsAsync();
    if (perm.status !== 'granted') return { status: 'denied' };
    let saved = 0;
    for (const p of paths) {
      if (isLocalFileUri(p)) {
        await MediaLibrary.saveToLibraryAsync(p);
        saved += 1;
      }
    }
    return saved > 0 ? { status: 'saved', saved } : { status: 'none' };
  } catch (e) {
    logger.warn('[media] save to Photos failed', e);
    return { status: 'error' };
  }
}

export type SaveImageResult = 'saved' | 'skipped' | 'denied' | 'error';

/**
 * Save ONE already-downloaded image file to the device library, for the auto-download flow.
 * `album: true` files it into the {@link GATOR_ALBUM} album (created on first use); otherwise it
 * lands in the regular gallery. A non-local path (undownloaded / remote dev URL) is 'skipped'.
 * Never throws — maps failures to a result the caller can count.
 */
export async function saveImageToLibrary(
  uri: string | null | undefined,
  opts: { album?: boolean } = {},
): Promise<SaveImageResult> {
  if (!isLocalFileUri(uri)) return 'skipped';
  try {
    const perm = await MediaLibrary.requestPermissionsAsync();
    if (perm.status !== 'granted') return 'denied';
    if (!opts.album) {
      await MediaLibrary.saveToLibraryAsync(uri);
      return 'saved';
    }
    // Album path: write the asset STRAIGHT INTO the album, rather than creating it in the camera
    // roll and then MOVING it there. `addAssetsToAlbumAsync(…, copy=false)` routes through
    // `MediaStore.createWriteRequest` on Android 11+, which is a SYSTEM CONSENT DIALOG ("Allow
    // Gator to modify this photo?") — raised per IMAGE, since each new picture is a new URI the
    // previous grant doesn't cover. Worse, it needs a foreground Activity, so pictures
    // auto-downloaded while the app was backgrounded queue their prompts and ambush the user with
    // a stack of them on the next resume, naming threads they never opened.
    // `createAssetAsync(uri, album)` sets the MediaStore RELATIVE_PATH on INSERT instead — the app
    // is creating that row, so there is nothing to ask consent for — and, never having landed in
    // the camera roll first, it leaves no duplicate behind either.
    const album = await MediaLibrary.getAlbumAsync(GATOR_ALBUM);
    if (album) {
      await MediaLibrary.createAssetAsync(uri, album);
      return 'saved';
    }
    // Android can't create an EMPTY album, so the first save ever seeds it. Seed from the local
    // FILE (the 4th argument), NOT from an already-created asset: the asset form is the
    // move-with-consent path above, which would put the dialog right back on the first picture.
    await MediaLibrary.createAlbumAsync(GATOR_ALBUM, undefined, false, uri);
    return 'saved';
  } catch (e) {
    logger.warn('[media] save image to library failed', e);
    return 'error';
  }
}
