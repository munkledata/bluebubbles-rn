import { safePathSegment } from '@/services/download/pathSafety';

/**
 * Pure mime/extension mapping and safe single-segment file names, used by paste intake and
 * attachment downloads. The raw share-intent payload parser that used to live here was deleted in
 * Phase 6 with the rest of the dormant JS share pipeline; the owned `gator-share-intake` module
 * now performs bounded share intake natively.
 */

export const DEFAULT_MIME = 'application/octet-stream';

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/vcard': 'vcf',
  'text/x-vcard': 'vcf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
};

const EXT_TO_MIME: Record<string, string> = Object.entries(MIME_TO_EXT).reduce<
  Record<string, string>
>((acc, [mime, ext]) => (acc[ext] ? acc : { ...acc, [ext]: mime }), {});

/** A filename extension for a mime type, without the dot. Always returns something. */
export function extensionForMime(mimeType: string): string {
  const lower = mimeType.toLowerCase().trim();
  const exact = MIME_TO_EXT[lower];
  if (exact) return exact;
  // e.g. 'image/svg+xml' → 'svg'. Reject anything that isn't a plain short token, which also
  // rules out 'octet-stream' (the hyphen fails the test) → 'bin'.
  const subtype = (lower.split('/')[1] ?? '').split(';')[0] ?? '';
  const candidate = subtype.split('+')[0] ?? '';
  return /^[a-z0-9]{1,8}$/.test(candidate) ? candidate : 'bin';
}

/** The mime type for a filename extension (no dot), or null when unknown. */
export function mimeForExtension(ext: string): string | null {
  return EXT_TO_MIME[ext.toLowerCase().trim()] ?? null;
}

/** Last path segment, treating both separators — never throws. */
function baseName(s: string): string {
  const parts = s.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? '';
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  // A leading dot is a hidden file, not an extension; cap the length so `x.somethinglong`
  // isn't mistaken for one.
  if (dot <= 0 || dot === name.length - 1) return '';
  const ext = name.slice(dot + 1);
  return /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : '';
}

/** Drop C0/DEL control characters — they have no place in a filename. */
function stripControlChars(s: string): string {
  return Array.from(s)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
}

/**
 * A display name we can safely use as ONE path segment, always carrying an extension.
 * Falls back through: the provider's name → the source uri's last segment → a generated name.
 */
export function safeShareFileName(
  rawName: string | null,
  sourceUri: string,
  mimeType: string,
  index: number,
  now: number,
): string {
  let candidate = rawName ? baseName(rawName) : '';
  if (candidate.length === 0) {
    // A SAF uri's last segment is percent-encoded junk ('primary%3ADownload%2Fx.pdf'); only take
    // it when it decodes to something that actually looks like a filename.
    let decoded = '';
    try {
      decoded = decodeURIComponent(baseName(sourceUri));
    } catch {
      decoded = baseName(sourceUri);
    }
    if (extensionOf(decoded).length > 0 && !/[:/\\]/.test(decoded)) candidate = decoded;
  }
  if (candidate.length === 0) candidate = `shared-${now}-${index}`;

  // Neutralize path separators / '..' (shared with the attachment downloader), then strip
  // control characters and collapse whitespace so the name is a well-behaved single segment.
  let name = stripControlChars(safePathSegment(candidate)).replace(/\s+/g, ' ').trim();
  if (name.length === 0) name = `shared-${now}-${index}`;

  if (extensionOf(name).length === 0) {
    name = `${name.replace(/\.+$/, '')}.${extensionForMime(mimeType)}`;
  }

  // Cap the length, keeping the extension (filesystems cap a segment at ~255 bytes).
  const MAX = 100;
  if (name.length > MAX) {
    const ext = extensionOf(name);
    const suffix = ext.length > 0 ? `.${ext}` : '';
    name = name.slice(0, Math.max(1, MAX - suffix.length)) + suffix;
  }
  return name;
}
