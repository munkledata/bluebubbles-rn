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

/** Outcome of a share attempt. `ok: false` means the OS share sheet never opened. */
export type ShareAttachmentResult = { ok: true } | { ok: false; reason: 'unavailable' | 'failed' };

/**
 * Open the OS share sheet for a downloaded attachment file.
 *
 * A user who opens the sheet and backs out still counts as `ok` — Android resolves the share
 * call on cancel. Only a genuine failure (sheet never opened) reports `ok: false`, and the
 * caller is expected to say so: this used to swallow every throw into a `logger.warn` and then
 * `return true` regardless, which made a hard native failure indistinguishable from a
 * successful share and left the fullscreen viewer's share button looking dead.
 */
export async function shareAttachment(
  localPath: string,
  mimeType?: string | null,
): Promise<ShareAttachmentResult> {
  try {
    // Lazy import: expo-sharing is a native module, kept off the screen-open path. NOTE the
    // import itself can reject (`requireNativeModule` throws when the module isn't linked into
    // the running build), which is why it sits inside the try.
    const Sharing = await import('expo-sharing');
    if (!(await Sharing.isAvailableAsync())) return { ok: false, reason: 'unavailable' };
    await Sharing.shareAsync(localPath, { mimeType: mimeType ?? undefined });
    return { ok: true };
  } catch (e) {
    // `error`, not `warn`: ErrorReportSink only captures error-level lines, and this failure is
    // otherwise invisible — there is no other signal that the share sheet failed to open.
    logger.error('[media] share failed', e);
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Ask for the WRITE half of the media-library permission only — never the read bundle.
 *
 * `requestPermissionsAsync()` with no argument asks for READ access to photos, video AND
 * music/audio together (expo-media-library defaults `granularPermissions` to all three) and
 * treats them as all-or-nothing. Refusing the separate "Music and audio" dialog — the obvious
 * thing to do when you are trying to save a picture — makes the whole request come back
 * not-granted, and after the second refusal Android stops showing it at all, so saving silently
 * stops working for good.
 *
 * Saving needs none of that. On Android 13+ the native save requires NO runtime permission
 * (`MediaLibraryModule.hasWritePermissions()` returns "nothing missing" on TIRAMISU+), and
 * `writeOnly: true` resolves to an EMPTY permission list there — granted, with zero dialogs. On
 * Android 12 and below it asks for WRITE_EXTERNAL_STORAGE, which is what is genuinely required.
 *
 * READING the gallery (the attachment tray's photo picker) still needs the full request — don't
 * "tidy" this into that call site.
 */
async function ensureSavePermission(): Promise<boolean> {
  const perm = await MediaLibrary.requestPermissionsAsync(true);
  return perm.status === 'granted';
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
    if (!(await ensureSavePermission())) return { status: 'denied' };
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
    if (!(await ensureSavePermission())) return 'denied';
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
    //
    // `getAlbumAsync` is the ONE call on this path gated on READ permission
    // (`requireSystemPermissions(false)` → `hasReadPermissions()`), which write-only never grants —
    // so on a device that has never granted media read it THROWS before the album is even looked
    // at, and every auto-downloaded picture would silently stop reaching the gallery. It's only a
    // fast path, so treat a throw as "album unknown" and fall through to the seed call below, which
    // is write-gated and idempotent (`createAlbumFile` is `exists() || mkdirs()`).
    const album = await MediaLibrary.getAlbumAsync(GATOR_ALBUM).catch(() => null);
    if (album) {
      await MediaLibrary.createAssetAsync(uri, album);
      return 'saved';
    }
    // Android can't create an EMPTY album, so the first save ever seeds it — and this is also the
    // standing path when the album lookup above is unavailable. Seed from the local FILE (the 4th
    // argument), NOT from an already-created asset: the asset form is the move-with-consent path
    // above, which would put the dialog right back on the first picture. Internally this still
    // sets RELATIVE_PATH at insert time (`CreateAssetWithAlbumFile`), so it asks for no consent.
    await MediaLibrary.createAlbumAsync(GATOR_ALBUM, undefined, false, uri);
    return 'saved';
  } catch (e) {
    logger.warn('[media] save image to library failed', e);
    return 'error';
  }
}
