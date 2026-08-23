import { safePathSegment } from '@/services/download/pathSafety';

/**
 * Historical, dormant pure parser for the former raw Android share-intent payload. It retains the
 * provider/path edge-case evidence in node tests, but no installed module or production listener
 * supplies it while IPC-01 is fail-closed.
 *
 * WHY WE READ THE RAW PAYLOAD: the library's parser collapses each file to
 * `path: file.path || 'file://'+file.filePath || file.contentUri` and then DROPS `contentUri`.
 * On Android `filePath` is whatever `getAbsolutePath()` returned — and for a document shared
 * from the Files app it's a raw `/storage/emulated/0/Download/x.pdf` (unreadable: the app has no
 * READ_EXTERNAL_STORAGE above API 32 and scoped storage blocks raw non-media reads), while for
 * Drive/Dropbox/most carrier apps it's a bogus `/document/acc=1;doc=…`. Either way the bad value
 * WINS the `||` chain and shadows the one thing that always works: the original `content://` uri,
 * which our own ContentResolver-backed copy can read. Images escaped this only because the
 * library already stream-copies MediaStore uris into its cache.
 *
 * This module is PURE (no expo/react-native imports) so the old decision table remains testable.
 */

/** One file entry exactly as `ExpoShareIntentModule.getFileInfo` emits it — every field is
 *  optional/nullable at runtime no matter what the library's `.d.ts` claims. */
export interface RawShareFile {
  contentUri?: string | null;
  filePath?: string | null;
  fileName?: string | null;
  fileSize?: string | number | null;
  mimeType?: string | null;
}

/** A shared file resolved to a readable source, ready to be copied into app-private storage. */
export interface ShareSource {
  /** The best readable source: a `content://` uri, or a `file://` path we can already read. */
  sourceUri: string;
  /** Safe single path segment, always carrying an extension. */
  fileName: string;
  /** Never empty — falls back to the extension, then to `application/octet-stream`. */
  mimeType: string;
  /** What the provider claimed. Advisory ONLY — always re-stat after copying. */
  reportedSize: number | null;
  /** `sourceUri` already points inside our own private storage → no copy needed. */
  alreadyLocal: boolean;
}

export interface ParsedShare {
  text: string | null;
  files: ShareSource[];
}

export interface ParseShareOptions {
  /**
   * Bare filesystem paths (no scheme) the app can already read directly — normally the expo
   * cache + document directories. A `filePath` under one of these is the library's OWN cache
   * copy (the working photo/video path), so we reuse it instead of re-copying, which would
   * otherwise duplicate a multi-hundred-MB video before the composer even opens.
   */
  privateRoots?: string[];
  /** Injected clock — keeps generated filenames deterministic in tests. */
  now: number;
}

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

/** The first http(s) URL inside a shared text blob, or null. */
export function extractWebUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match?.[0] ?? null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** A provider may report the size as a decimal STRING. Anything unparseable → null. */
function asSize(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
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
 * Is this `getAbsolutePath()` result a real filesystem path, or the SAF junk it falls back to?
 *
 * The library ends with a bare `return uri.path` for any DocumentProvider it doesn't special-case
 * (Drive, Dropbox, Gmail, most carrier apps), yielding `/document/acc=1;doc=…` — which would
 * otherwise become a `file:///document/…` that can never be opened.
 */
function isPlausibleFilePath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  const first = path.split('/')[1] ?? '';
  if (first === 'document' || first === 'tree') return false;
  return !/[;%]/.test(path);
}

function isPrivatePath(path: string, roots: string[]): boolean {
  return roots.some((root) => root.length > 0 && path.startsWith(root));
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

/** Resolve ONE raw entry to a readable source, or null when nothing usable is present. */
function toSource(
  raw: RawShareFile,
  index: number,
  opts: { privateRoots: string[]; now: number },
): ShareSource | null {
  const contentUri = asString(raw.contentUri);
  const filePath = asString(raw.filePath);

  let sourceUri: string | null = null;
  let alreadyLocal = false;
  if (filePath && isPlausibleFilePath(filePath) && isPrivatePath(filePath, opts.privateRoots)) {
    // The library's own cache copy (the path photos/videos already take today) — free to reuse.
    sourceUri = `file://${filePath}`;
    alreadyLocal = true;
  } else if (contentUri) {
    sourceUri = contentUri;
  } else if (filePath && isPlausibleFilePath(filePath)) {
    // No content uri to fall back on. Probably unreadable, but a logged copy failure beats
    // silently dropping the file.
    sourceUri = `file://${filePath}`;
  }
  if (!sourceUri) return null;

  const rawName = asString(raw.fileName);
  const declaredMime = asString(raw.mimeType);
  const provisionalName = rawName ?? baseName(sourceUri);
  const mimeType = declaredMime ?? mimeForExtension(extensionOf(provisionalName)) ?? DEFAULT_MIME;

  return {
    sourceUri,
    fileName: safeShareFileName(rawName, sourceUri, mimeType, index, opts.now),
    mimeType,
    reportedSize: asSize(raw.fileSize),
    alreadyLocal,
  };
}

/**
 * Parse the raw `onChange` payload. NEVER throws — a malformed payload yields an empty share.
 *
 * Defends against a real upstream bug: for every single-file `ACTION_SEND`, the library builds
 * `mapOf("files" to arrayOf(getFileInfo(uri), "type" to "file"))` (a misplaced bracket), so the
 * files array carries a junk 2-element ARRAY alongside the real entry. Non-object entries are
 * skipped.
 */
export function parseRawShareEvent(value: unknown, opts: ParseShareOptions): ParsedShare {
  const empty: ParsedShare = { text: null, files: [] };
  if (typeof value !== 'object' || value === null) return empty;
  const payload = value as { text?: unknown; files?: unknown };

  const rawText = asString(payload.text);
  const text = rawText ? (extractWebUrl(rawText) ?? rawText) : null;

  const entries = Array.isArray(payload.files) ? payload.files : [];
  const resolved: ShareSource[] = [];
  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return;
    const source = toSource(entry as RawShareFile, index, {
      privateRoots: opts.privateRoots ?? [],
      now: opts.now,
    });
    if (source) resolved.push(source);
  });

  return { text, files: resolved };
}
