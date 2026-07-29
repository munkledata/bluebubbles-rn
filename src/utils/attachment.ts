export type AttachmentKind = 'image' | 'video' | 'audio' | 'contact' | 'location' | 'file';

/** Dispatch an attachment to a render type by MIME. */
export function attachmentKind(mimeType: string | null): AttachmentKind {
  if (!mimeType) return 'file';
  if (mimeType.startsWith('image/')) return 'image';
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
 * else the guid PLUS a MIME-derived extension.
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
  if (transferName) return transferName;
  return `${guid}${extensionForMime(mimeType)}`;
}

export const AUTO_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

/** Images under the cap auto-download; everything else is tap-to-download. */
export function shouldAutoDownload(att: {
  mimeType: string | null;
  totalBytes: number | null;
  localPath: string | null;
}): boolean {
  if (att.localPath) return false;
  if (!att.mimeType?.startsWith('image/')) return false;
  if (att.totalBytes == null) return true;
  return att.totalBytes <= AUTO_IMAGE_MAX_BYTES;
}
