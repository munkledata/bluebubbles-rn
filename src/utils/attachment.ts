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
