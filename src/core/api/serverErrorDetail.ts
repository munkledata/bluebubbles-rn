import { redactUrls } from '@core/secure/redact';

/** Maximum non-success response body considered for a failed send. */
export const MAX_SERVER_ERROR_BODY_BYTES = 4 * 1024;
/** Durable/UI detail limit. The DB migration enforces the same UTF-8 ceiling. */
export const MAX_SERVER_ERROR_DETAIL_BYTES = 512;
/** Prevent a long run of cheap ASCII from filling the failed-message sheet. */
export const MAX_SERVER_ERROR_DETAIL_CODE_POINTS = 240;

const encoder = new TextEncoder();
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const INVISIBLE_FORMATTING = /[\u200b\u2060\ufeff]/gu;
const WEB_URL = /\b(?:https?|wss?):\/\/[^\s,;]+/giu;
const FILE_OR_CONTENT_URI = /\b(?:file|content):\/\/[^\s,;]+/giu;
const POSIX_PRIVATE_PATH =
  /(?:^|[\s"'(\[])(\/(?:Users|home|data|storage|sdcard|private|var|tmp|Volumes)\/[^\s,"';)\]]*)/giu;
const WINDOWS_PRIVATE_PATH = /\b[a-z]:\\(?:[^\\\s,;]+\\)*[^\s,;]*/giu;
const LABELED_SECRET =
  /\b(password|passcode|token|secret|api[ _-]?key|authorization)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const STACK_FRAME = /(?:^|\s)at\s+(?:[^\s(]+\s+)?\(?[^()\s]+:\d+:\d+\)?(?:\s|$)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedDetail(value: string): string {
  let output = '';
  let bytes = 0;
  let codePoints = 0;
  for (const codePoint of value) {
    if (codePoints >= MAX_SERVER_ERROR_DETAIL_CODE_POINTS) break;
    const encoded = encoder.encode(codePoint);
    if (bytes + encoded.byteLength > MAX_SERVER_ERROR_DETAIL_BYTES) break;
    output += codePoint;
    bytes += encoded.byteLength;
    codePoints += 1;
  }
  return output.trim();
}

/**
 * Turn one explicitly-designated server error string into safe, bounded display text.
 *
 * The input is untrusted. It is never used for retry/status decisions and must not be logged,
 * placed in notifications, or persisted without passing through this projector first.
 */
export function projectServerErrorDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Realtime and native transports have already materialized their payload strings. Reject a
  // hostile source by its constant-time length property before normalization or regex scanning.
  // Any body that fits the stricter 4 KiB UTF-8 limit also fits this code-unit ceiling.
  if (value.length > MAX_SERVER_ERROR_BODY_BYTES) return undefined;
  let detail: string;
  try {
    detail = value.normalize('NFKC');
  } catch {
    return undefined;
  }
  detail = detail
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(BIDI_CONTROLS, '')
    .replace(INVISIBLE_FORMATTING, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!detail || STACK_FRAME.test(detail)) return undefined;

  // Unlike diagnostic redaction, UI prose has no reason to retain an endpoint path or query. Drop
  // the whole URL first so unlabeled identifiers or credentials in its path cannot survive.
  detail = redactUrls(detail.replace(WEB_URL, '[redacted URL]'))
    .replace(FILE_OR_CONTENT_URI, '[redacted path]')
    .replace(POSIX_PRIVATE_PATH, (_match, prefix: string) => `${prefix}[redacted path]`)
    .replace(WINDOWS_PRIVATE_PATH, '[redacted path]')
    .replace(LABELED_SECRET, (_match, label: string) => `${label}=[redacted]`)
    .replace(/\s+/gu, ' ')
    .trim();
  if (!detail || STACK_FRAME.test(detail)) return undefined;
  const bounded = boundedDetail(detail);
  return bounded || undefined;
}

/** Parse only the reviewed v1 error envelope field: `{ error: { message: string } }`. */
export function parseServerErrorDetailBody(bodyText: string): string | undefined {
  if (bodyText.length > MAX_SERVER_ERROR_BODY_BYTES) return undefined;
  if (encoder.encode(bodyText).byteLength > MAX_SERVER_ERROR_BODY_BYTES) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  return projectServerErrorDetail(body.error.message);
}
