/**
 * Log redaction.
 *
 * The Flutter app logged FCM tokens and could leak the `?guid=` auth token via
 * logged URLs. ERROR lines and selected event calls are rebuilt from finite structured allowlists
 * before any sink. Free-form levels pass through {@link redact} only in development and are
 * dropped before release sinks.
 */
import {
  projectCapturedDiagnosticEvent,
  projectCapturedErrorDiagnostic,
  type DiagnosticEventCode,
  type DiagnosticEventInputByCode,
  type ErrorDiagnosticMessage,
  type ErrorDiagnosticSiteFor,
} from './errorDiagnostic';

const PLACEHOLDER = '[redacted]';

// The single source of truth for sensitive names — used for BOTH structured object-key
// redaction AND URL query-param redaction so the two never drift (the URL path previously
// covered only guid|password|token while object keys covered more, leaking e.g. ?apikey=).
const SENSITIVE_KEY_NAMES = [
  'guid',
  'password',
  'token',
  'fcmtoken',
  'authorization',
  'apikey',
  'api_key',
  'secret',
  'credential',
];

// Identity-bearing query params are treated like secrets. This does not include a generic `id`:
// request ids, status codes and row ids are useful diagnostics and are not necessarily private.
const IDENTITY_QUERY_KEY_NAMES = [
  'chatguid',
  'messageguid',
  'targetguid',
  'attachmentguid',
  'uuid',
  'handle',
  'address',
  'email',
  'phone',
  'serveraddress',
  'serverurl',
  'url',
  'origin',
  'host',
];

const QUERY_KEY_NAMES = [...SENSITIVE_KEY_NAMES, ...IDENTITY_QUERY_KEY_NAMES];

// `?guid=…` / `&apikey=…` etc. — secret and identity-bearing URL query params.
const SENSITIVE_QUERY = new RegExp(`([?&])(${QUERY_KEY_NAMES.join('|')})=[^&\\s]+`, 'gi');

// Keep the scheme, path, query-key names and endpoint in logs, but never the server authority.
// The authority includes user-info and port, either of which can identify a private deployment.
const URL_AUTHORITY = /\b((?:https?|wss?):\/\/)(?:\[[^\]\s/?#]+\](?::\d{1,5})?|[^\s/?#]+)/gi;

// Canonical UUIDs are used for message, attachment and FaceTime identifiers. Arbitrary ordinary
// numbers are intentionally excluded so timestamps, row ids and stack line/column numbers survive.
const CANONICAL_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const EMAIL_ADDRESS = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi;

// A leading `+` makes a 7–15 digit run unambiguously phone-like. The second expression handles
// common North-American formatting while deliberately not matching bare 10/13 digit numbers (a
// Unix timestamp is common in our errors) or dates such as 2026-08-04.
const INTERNATIONAL_PHONE = /(^|[^\w])\+\d(?:[ \t().-]*\d){6,14}(?!\d)/g;
const FORMATTED_PHONE = /(^|[^\d])(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?!\d)/g;
const QUOTED_PHONE_FIELD =
  /(["'])((?:phone(?:number)?|telephone|tel|mobile|handle|senderhandle|recipienthandle|participantaddress|senderaddress|recipientaddress|address))\1(\s*:\s*)(["'])\d{7,15}\4/gi;
const UNQUOTED_PHONE_FIELD =
  /\b((?:phone(?:number)?|telephone|tel|mobile|handle|senderhandle|recipienthandle|participantaddress|senderaddress|recipientaddress|address))\b(\s*[:=]\s*)(["']?)\d{7,15}\3/gi;

// BlueBubbles identifiers are not always canonical UUIDs. Catch arbitrary values when the string
// itself labels one as a GUID/UUID, including JSON fragments copied into native error messages.
const QUOTED_IDENTIFIER_FIELD =
  /(["'])((?:[a-z0-9_-]*guid|[a-z0-9_-]*uuid))\1(\s*:\s*)(["'])(.*?)\4/gi;
const UNQUOTED_IDENTIFIER_FIELD =
  /\b((?:[a-z0-9_-]*guid|[a-z0-9_-]*uuid))\b(\s*[:=]\s*)(\[[^\]\r\n]*\]|[^\s,}&\]]+)/gi;

// Some native networking errors expose a host without a URL, for example
// `Unable to resolve host "private.example"`. Limit this to explicit host/server phrases so a
// source filename such as `redact.test.ts` is not mistaken for a hostname in a stack trace.
const HOST_TOKEN = '(?:\\[[0-9a-f:.%]+\\]|[a-z0-9][a-z0-9._-]*)';
const LABELED_HOST = new RegExp(
  `(\\b(?:(?:host(?:name)?|origin)\\b\\s*(?::|=|is)\\s*["']?|(?:connecting\\s+to|resolve\\s+host)\\b\\s+["']?|server\\s+(?:host|origin|address|url)\\b(?:\\s*(?::|=|is)\\s*|\\s+)["']?))${HOST_TOKEN}(?::\\d{1,5})?(?![a-z0-9._-]|:\\/\\/)`,
  'gi',
);

function keyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Sensitive structured fields are replaced in full rather than relying on value heuristics. */
function isSensitiveStructuredKey(key: string): boolean {
  const parts = keyParts(key);
  const last = parts.at(-1) ?? '';
  const normalized = parts.join('');

  if (
    SENSITIVE_KEY_NAMES.includes(normalized) ||
    parts.some((part) => SENSITIVE_KEY_NAMES.includes(part))
  ) {
    return true;
  }

  // Prefixes are expected here: chatGuid, message_guid, senderHandle, serverUrl, etc. Matching
  // the final key part avoids false positives such as `ghost` (host) and `microphone` (phone).
  if (
    [
      'guid',
      'uuid',
      'handle',
      'address',
      'email',
      'url',
      'uri',
      'origin',
      'host',
      'hostname',
    ].includes(last)
  ) {
    return true;
  }
  if (['handles', 'addresses', 'emails', 'urls', 'uris', 'hosts'].includes(last)) return true;
  return (
    ['phone', 'phones'].includes(last) ||
    normalized.endsWith('phonenumber') ||
    normalized.endsWith('phonenumbers')
  );
}

/** Strip secrets and durable account/person identifiers from any log-bound string. */
export function redactUrls(input: string): string {
  return (
    input
      .replace(SENSITIVE_QUERY, `$1$2=${PLACEHOLDER}`)
      // `Authorization: Bearer <password>` logged as a raw string (the key-based redaction only
      // catches structured `{ authorization: ... }`, not a bare header string).
      .replace(/\bBearer\s+\S+/gi, `Bearer ${PLACEHOLDER}`)
      .replace(URL_AUTHORITY, `$1${PLACEHOLDER}`)
      .replace(EMAIL_ADDRESS, PLACEHOLDER)
      .replace(CANONICAL_UUID, PLACEHOLDER)
      .replace(
        QUOTED_IDENTIFIER_FIELD,
        (_match, keyQuote, key, separator, valueQuote) =>
          `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${PLACEHOLDER}${valueQuote}`,
      )
      .replace(UNQUOTED_IDENTIFIER_FIELD, `$1$2${PLACEHOLDER}`)
      .replace(INTERNATIONAL_PHONE, `$1${PLACEHOLDER}`)
      .replace(FORMATTED_PHONE, `$1${PLACEHOLDER}`)
      .replace(
        QUOTED_PHONE_FIELD,
        (_match, keyQuote, key, separator, valueQuote) =>
          `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${PLACEHOLDER}${valueQuote}`,
      )
      .replace(UNQUOTED_PHONE_FIELD, `$1$2$3${PLACEHOLDER}$3`)
      .replace(LABELED_HOST, `$1${PLACEHOLDER}`)
  );
}

/** Deep-redact an arbitrary value (objects, arrays, strings) for safe logging. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactUrls(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  // Error objects keep name/message/stack as NON-enumerable props, so the `Object.entries` walk
  // below would drop them (an Error meta would serialize to `{}` — losing the stack). Flatten to a
  // plain object explicitly, redacting the (attacker-influenceable) message/stack strings. A chained
  // `cause` and any own-enumerable custom fields (e.g. an ApiError's `kind`) are carried through too.
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: redactUrls(value.message) };
    if (value.stack) out.stack = redactUrls(value.stack);
    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = redact(cause, seen);
    for (const [k, v] of Object.entries(value)) {
      if (k in out) continue;
      out[k] = isSensitiveStructuredKey(k) ? PLACEHOLDER : redact(v, seen);
    }
    return out;
  }

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveStructuredKey(k) ? PLACEHOLDER : redact(v, seen);
  }
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSink {
  write(level: LogLevel, message: string, meta?: unknown): void;
}

/** Free-form local diagnostics exist only in development until each event has a finite schema. */
export function isVerboseLocalLoggingEnabled(): boolean {
  // Fail closed in an unexpected runtime. Tests that exercise development diagnostics set this
  // global explicitly; React Native defines it in every app bundle.
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

/** Projects finite diagnostics and keeps legacy free-form levels development-only. */
export class RedactingLogger {
  constructor(private readonly sink: LogSink) {}

  private log(level: LogLevel, message: string, meta?: unknown): void {
    // This check intentionally precedes message/meta inspection: release builds cannot traverse,
    // retain, print, or export arbitrary native errors through the legacy levels.
    if (!isVerboseLocalLoggingEnabled()) return;
    try {
      const safeMessage = redactUrls(message);
      let safeMeta: unknown;
      if (meta !== undefined) {
        try {
          safeMeta = redact(meta);
        } catch {
          // A proxy/getter/deep graph must not make diagnostics mask the operation being reported.
          safeMeta = { redactionStatus: 'metadata_dropped' };
        }
      }
      this.sink.write(level, safeMessage, safeMeta);
    } catch {
      // Logging is best-effort and must never become the app failure.
    }
  }

  debug = (m: string, meta?: unknown) => this.log('debug', m, meta);
  info = (m: string, meta?: unknown) => this.log('info', m, meta);
  warn = (m: string, meta?: unknown) => this.log('warn', m, meta);
  event = <Code extends DiagnosticEventCode>(
    code: Code,
    meta: DiagnosticEventInputByCode[Code],
  ): void => {
    try {
      const event = projectCapturedDiagnosticEvent(code, meta);
      if (event !== undefined) this.sink.write('info', event.message, event.meta);
    } catch {
      // Logging is best-effort and must never become the app failure.
    }
  };
  error = <Message extends ErrorDiagnosticMessage>(
    message: Message,
    site: ErrorDiagnosticSiteFor<Message>,
    meta?: unknown,
  ): void => {
    try {
      const diagnostic = projectCapturedErrorDiagnostic(message, meta, site);
      this.sink.write('error', diagnostic.message, {
        ...diagnostic.meta,
        ...(diagnostic.stack === undefined ? {} : { stack: diagnostic.stack }),
      });
    } catch {
      // Logging is best-effort and must never become the app failure.
    }
  };
}
