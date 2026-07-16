import * as MediaLibrary from 'expo-media-library';
import { logger } from '@core/secure';
import { isLocalFileUri } from '@utils';

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
