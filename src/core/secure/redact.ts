/**
 * Log redaction.
 *
 * The Flutter app logged FCM tokens and could leak the `?guid=` auth token via
 * logged URLs. Everything bound for a log sink (console, file, Sentry breadcrumb)
 * passes through {@link redact} first.
 */

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

// Query params / JSON keys whose values must never be logged.
const SENSITIVE_KEYS = new RegExp(`^(${SENSITIVE_KEY_NAMES.join('|')})$`, 'i');

// `?guid=…` / `&apikey=…` etc. — the same key list, matched as a URL query param.
const SENSITIVE_QUERY = new RegExp(`([?&])(${SENSITIVE_KEY_NAMES.join('|')})=[^&\\s]+`, 'gi');

/** Strip sensitive query params (notably `guid`) AND bearer tokens from any string. */
export function redactUrls(input: string): string {
  return (
    input
      .replace(SENSITIVE_QUERY, `$1$2=${PLACEHOLDER}`)
      // `Authorization: Bearer <password>` logged as a raw string (the key-based redaction
      // only catches structured `{ authorization: ... }`, not a bare header string).
      .replace(/\bBearer\s+\S+/gi, `Bearer ${PLACEHOLDER}`)
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
      out[k] = SENSITIVE_KEYS.test(k) ? PLACEHOLDER : redact(v, seen);
    }
    return out;
  }

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.test(k) ? PLACEHOLDER : redact(v, seen);
  }
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSink {
  write(level: LogLevel, message: string, meta?: unknown): void;
}

/** Wraps a sink so every message + meta object is redacted before it is written. */
export class RedactingLogger {
  constructor(private readonly sink: LogSink) {}

  private log(level: LogLevel, message: string, meta?: unknown): void {
    this.sink.write(level, redactUrls(message), meta === undefined ? undefined : redact(meta));
  }

  debug = (m: string, meta?: unknown) => this.log('debug', m, meta);
  info = (m: string, meta?: unknown) => this.log('info', m, meta);
  warn = (m: string, meta?: unknown) => this.log('warn', m, meta);
  error = (m: string, meta?: unknown) => this.log('error', m, meta);
}
