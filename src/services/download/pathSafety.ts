/**
 * Make a SERVER-supplied string safe to use as a single filesystem path segment.
 *
 * Attachment `guid` and `transferName` both come straight from the server. expo-file-system's
 * `resolve()` keeps a leading `..` (unlike Node's `path.resolve`), so a hostile/compromised
 * server sending `guid: "../../databases"` + `transferName: "gator.db"` could otherwise
 * escape `{documents}/attachments/…` and overwrite the SQLCipher DB (permanent message loss).
 *
 * We neutralize BOTH escape routes: path separators (so a value can never introduce a new path
 * level) and an all-dots segment like `.` / `..` (a parent-directory reference). Everything else
 * is preserved, so legitimate guids/filenames land at the same place they always did.
 */
export function safePathSegment(s: string): string {
  const cleaned = s.replace(/[/\\]/g, '_');
  return /^\.+$/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Encode one server-controlled media identifier without collapsing distinct values.
 *
 * Replacing unsafe characters with `_` is traversal-safe but not collision-safe: `a/b` and
 * `a_b` become the same path. Percent encoding preserves that distinction, while the prefix
 * prevents `.` / `..` from becoming special path segments. Empty identifiers are rejected because
 * the native cache scanner/stat/delete boundary intentionally has no canonical spelling for them.
 * Very long encoded names are rejected instead of being truncated into another collision or
 * exceeding filesystem filename limits.
 */
export const MAX_ENCODED_MEDIA_SEGMENT_CHARS = 180;

export function encodedMediaPathSegment(value: string): string {
  if (value.length === 0) throw new Error('Media path identifier must not be empty');
  let encoded: string;
  try {
    encoded = encodeURIComponent(value);
  } catch {
    throw new Error('Media path identifier contains invalid Unicode');
  }
  if (encoded.length > MAX_ENCODED_MEDIA_SEGMENT_CHARS) {
    throw new Error('Media path identifier is too long');
  }
  return `media-${encoded}`;
}

/** Stable namespace for callers that deliberately run without an account-generation lease. */
export const UNSCOPED_MEDIA_GENERATION = 'unscoped';

/**
 * Turn an account generation into one safe, visibly named directory segment.
 *
 * Real account leases are non-negative safe integers. Reject every alternate spelling here so a
 * writer can never create a generation directory the native recovery/stat/delete policy refuses.
 */
export function mediaGenerationPathSegment(generation?: number | null): string {
  if (generation == null) return `generation-${UNSCOPED_MEDIA_GENERATION}`;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('Media generation must be a non-negative safe integer');
  }
  return `generation-${String(generation)}`;
}

export interface ParsedAttachmentCacheFileUri {
  readonly attachmentGuid: string;
  readonly generation: number | typeof UNSCOPED_MEDIA_GENERATION;
  readonly transferName: string;
}

const ATTACHMENT_CACHE_URI_MAX_CHARS = 4096;
const ATTACHMENT_CACHE_GENERATION = /^generation-(0|[1-9][0-9]*|unscoped)$/;

/**
 * Conservatively recognize any local URI that names an `attachments` path segment.
 *
 * This is intentionally broader than {@link parseAttachmentCacheFileUri}. When the fixed native
 * ownership/stat boundary rejects a malformed managed path, callers must not reinterpret parser
 * failure as permission to use a weaker generic filesystem API. An external user folder also named
 * `attachments` can therefore fail closed; that rare false refusal is safer than following a
 * corrupt/symlinked app-cache path.
 */
export function isPotentialAttachmentCacheFileUri(uri: string): boolean {
  if (uri.length === 0 || uri.length > ATTACHMENT_CACHE_URI_MAX_CHARS || uri.includes('\\')) {
    return false;
  }
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return false;
    return parsed.pathname
      .split('/')
      .filter((segment) => segment.length > 0)
      .some((segment) => {
        try {
          return decodeURIComponent(segment) === 'attachments';
        } catch {
          return segment === 'attachments';
        }
      });
  } catch {
    return false;
  }
}

/** Decode one physical `media-<encodeURIComponent(value)>` filename without accepting aliases. */
function decodeMediaPathSegment(segment: string): string | null {
  if (!segment.startsWith('media-')) return null;
  try {
    const decoded = decodeURIComponent(segment.slice('media-'.length));
    if (decoded.length === 0 || encodedMediaPathSegment(decoded) !== segment) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Parse only a canonical file URI emitted by the native fixed-root attachment-cache scanner.
 *
 * `Uri.fromFile` percent-escapes the physical `%` characters written by
 * {@link encodedMediaPathSegment}, so each URL component is decoded once to recover the physical
 * filename and the `media-…` payload is decoded a second time. Re-encoding both payloads rejects
 * alternate spellings such as `%41` for `A`; exact depth/name checks prevent nearby app-private
 * files from being mistaken for attachment cache entries.
 */
export function parseAttachmentCacheFileUri(uri: string): ParsedAttachmentCacheFileUri | null {
  if (
    uri.length === 0 ||
    uri.length > ATTACHMENT_CACHE_URI_MAX_CHARS ||
    uri.includes('\\') ||
    /[\u0000-\u001F\u007F]/.test(uri)
  ) {
    return null;
  }

  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== 'file:' ||
      parsed.hostname !== '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return null;
    }
    const encodedSegments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    if (encodedSegments.length < 4) return null;
    const tail = encodedSegments.slice(-4);
    const physical = tail.map((segment) => decodeURIComponent(segment));
    const rootName = physical[0];
    const guidSegment = physical[1];
    const generationSegment = physical[2];
    const transferSegment = physical[3];
    if (
      rootName !== 'attachments' ||
      guidSegment == null ||
      generationSegment == null ||
      transferSegment == null ||
      !ATTACHMENT_CACHE_GENERATION.test(generationSegment)
    ) {
      return null;
    }
    const attachmentGuid = decodeMediaPathSegment(guidSegment);
    const transferName = decodeMediaPathSegment(transferSegment);
    if (attachmentGuid === null || transferName === null) return null;
    const generationValue = generationSegment.slice('generation-'.length);
    if (generationValue === UNSCOPED_MEDIA_GENERATION) {
      return { attachmentGuid, generation: UNSCOPED_MEDIA_GENERATION, transferName };
    }
    const generation = Number(generationValue);
    if (!Number.isSafeInteger(generation) || generation < 0) return null;
    return { attachmentGuid, generation, transferName };
  } catch {
    return null;
  }
}
