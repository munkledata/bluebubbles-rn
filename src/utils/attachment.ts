import { MEDIA_PATH_ENCODED_VALUE_MAX_CHARS } from './mediaPathLimits';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'contact' | 'location' | 'file';

/**
 * Image types Android's own decoder reads on every supported device (minSdk 36). Only these are
 * drawn inline and pass the download's decode check. TIFF, SVG, JPEG-XL and any other `image/*`
 * type are ordinary files that open in another app: the decode check could never pass for them,
 * and an undecodable picture must not reach an inline renderer. The shared-media queries compare
 * the lowercased MIME against this same list, so the carousel and Documents page agree.
 */
export const INLINE_IMAGE_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-ms-bmp',
  'image/heic',
  'image/heif',
  'image/avif',
];
const INLINE_IMAGE_MIME_SET = new Set(INLINE_IMAGE_MIME_TYPES);

/** File-name ending Apple gives a Messages extension's own payload file (compared lowercase). */
export const APPLE_EXTENSION_PAYLOAD_SUFFIX = '.pluginpayloadattachment';

/**
 * Whether an attachment is a file the user sent, judged by its message's extension identity. An
 * ordinary message's attachments all qualify. An iMessage app message ("balloon") can carry real
 * photos (the Photos drawer, iCloud photo links), which Apple leaves unhidden with a file type,
 * next to the extension's own payload file. An old server's push copy can omit the hidden flag,
 * so a balloon attachment also needs a file type and a name that is not Apple's payload file.
 * Callers still check `hideAttachment` themselves. Mirrors `attachmentIsUserFileSql`.
 */
export function isUserFileAttachment(
  attachment: { mimeType?: string | null; transferName?: string | null },
  balloonBundleId: string | null | undefined,
): boolean {
  if (balloonBundleId == null) return true;
  return (
    !!attachment.mimeType &&
    attachment.transferName != null &&
    !attachment.transferName.toLowerCase().endsWith(APPLE_EXTENSION_PAYLOAD_SUFFIX)
  );
}

/** Dispatch an attachment to a render type by MIME. */
export function attachmentKind(mimeType: string | null): AttachmentKind {
  if (!mimeType) return 'file';
  if (mimeType.startsWith('image/')) {
    return INLINE_IMAGE_MIME_SET.has(mimeType.toLowerCase()) ? 'image' : 'file';
  }
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  // An Apple location is a vCard too, so test the more specific type FIRST.
  if (mimeType === 'text/x-vlocation') return 'location';
  if (mimeType.includes('vcard')) return 'contact'; // text/vcard, text/x-vcard
  return 'file';
}

/**
 * Bucket an attachment into the conversation-details "shared media" sections.
 * Photos = images, Videos = videos; everything else (files, audio, contacts,
 * locations) folds into Documents. (Links are derived from message text, not here.)
 */
export type MediaSection = 'photo' | 'video' | 'document';
export function mediaSection(mimeType: string | null): MediaSection {
  const kind = attachmentKind(mimeType);
  if (kind === 'image') return 'photo';
  if (kind === 'video') return 'video';
  return 'document';
}

/** Human-readable byte size, e.g. "2.5 MB". */
export function friendlySize(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  const rounded = i === 0 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/** Short uppercase type label for a file chip, e.g. "application/pdf" → "PDF". */
export function fileTypeLabel(mimeType: string | null, transferName: string | null): string {
  const ext = transferName?.split('.').pop();
  if (ext && ext.length <= 5 && ext !== transferName) return ext.toUpperCase();
  if (mimeType) return (mimeType.split('/').pop() ?? 'FILE').toUpperCase();
  return 'FILE';
}

/**
 * A downloaded local file (a `file://` URI) can be shared/saved; a remote/dev URL cannot.
 * Every production writer emits `file://` URIs, so that scheme is the whole test.
 */
export function isLocalFileUri(path: string | null | undefined): path is string {
  return !!path && path.startsWith('file://');
}

/**
 * File extension for a MIME type — used ONLY to name a downloaded file. An unknown type gets
 * no extension.
 */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/3gpp': '.3gp',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/amr': '.amr',
  'application/pdf': '.pdf',
};

export function extensionForMime(mimeType: string | null | undefined): string {
  if (!mimeType) return '';
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_EXTENSIONS[base] ?? '';
}

/**
 * Local file name for a downloaded attachment: the server's transfer name when there is one,
 * else the guid PLUS a MIME-derived extension, or a short `attachment` basename when it will not
 * fit the bounded local filename namespace.
 *
 * The extension is load-bearing, not cosmetic: expo-media-library derives the MediaStore type
 * from the file name and REJECTS a name with no dot at all ("Could not get the file's
 * extension"), so a bare-guid name can never be saved to the gallery — silently, since the
 * failure surfaces as a generic error. iMessage always sends a transfer name; RCS-bridged media
 * can arrive with none (the bridge maps an empty media name to null).
 */
export function attachmentFileName(
  transferName: string | null | undefined,
  guid: string,
  mimeType?: string | null,
): string {
  if (transferName) return fitTransferName(transferName, mimeType);
  const extension = extensionForMime(mimeType);
  const candidate = `${guid}${extension}`;
  // Identity already lives in its own directory; an absent server filename need not repeat an
  // arbitrarily long opaque GUID. Keep existing short spellings and the MIME extension.
  const fallback = `attachment${extension}`;
  if (candidate.length > MEDIA_PATH_ENCODED_VALUE_MAX_CHARS) return fallback;
  try {
    return encodeURIComponent(candidate).length <= MEDIA_PATH_ENCODED_VALUE_MAX_CHARS
      ? candidate
      : fallback;
  } catch {
    // The guarded destination calculation owns rejection of malformed identifiers/names.
    return candidate;
  }
}

/**
 * A server name whose encoded form exceeds the local filename limit used to make the attachment
 * permanently undownloadable (about 20 CJK or 15 emoji characters were enough). Its own directory
 * already holds the identity, so keep the longest whole-character prefix that fits plus the
 * extension the gallery needs. The DB keeps the full original name for display.
 */
function fitTransferName(name: string, mimeType: string | null | undefined): string {
  let encodedLength: number;
  try {
    encodedLength = encodeURIComponent(name).length;
  } catch {
    // The guarded destination calculation owns rejection of malformed names.
    return name;
  }
  if (encodedLength <= MEDIA_PATH_ENCODED_VALUE_MAX_CHARS) return name;
  const dot = name.lastIndexOf('.');
  const ownExtension = dot > 0 ? name.slice(dot) : '';
  const keepsOwnExtension = /^\.[A-Za-z0-9]{1,10}$/.test(ownExtension);
  const extension = keepsOwnExtension ? ownExtension : extensionForMime(mimeType);
  const stem = keepsOwnExtension ? name.slice(0, dot) : name;
  const budget = MEDIA_PATH_ENCODED_VALUE_MAX_CHARS - encodeURIComponent(extension).length;
  let prefix = '';
  let used = 0;
  // Iterate whole code points so an emoji is never split into a lone surrogate.
  for (const character of stem) {
    const cost = encodeURIComponent(character).length;
    if (used + cost > budget) break;
    prefix += character;
    used += cost;
  }
  return `${prefix || 'attachment'}${extension}`;
}

/**
 * Automatic transfers are deliberately much smaller than the manual ceiling. The server's
 * metadata is only a pre-flight hint — the downloader independently enforces the streamed and
 * final on-disk byte counts against this same limit.
 */
export const AUTO_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

/** Images under the cap auto-download; everything else is tap-to-download. */
export function shouldAutoDownload(att: {
  mimeType: string | null;
  totalBytes: number | null;
  localPath: string | null;
}): boolean {
  if (att.localPath) return false;
  if (attachmentKind(att.mimeType) !== 'image') return false;
  // Automatic network work must have a trustworthy, finite pre-flight bound. A missing, negative,
  // fractional, or otherwise malformed server length remains available through an explicit tap,
  // where the downloader enforces its larger absolute cap against the ACTUAL bytes.
  const totalBytes = att.totalBytes;
  if (totalBytes == null || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) return false;
  return totalBytes <= AUTO_IMAGE_MAX_BYTES;
}
