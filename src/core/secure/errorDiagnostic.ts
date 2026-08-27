import type { ApiErrorKind } from '../api/errors';
import { SERVER_EVENTS, type ServerEventName } from '../config';

/** Version of the privacy-safe JSON object stored in `error_reports.meta`. */
export const ERROR_REPORT_ENVELOPE_VERSION = 1 as const;
export const DIAGNOSTIC_EVENT_ENVELOPE_VERSION = 1 as const;

interface EventDefinition {
  code: string;
  tag: string;
  matches(message: string): boolean;
}

const exact =
  (expected: string) =>
  (message: string): boolean =>
    message === expected;
const begins =
  (prefix: string) =>
  (message: string): boolean =>
    message.startsWith(prefix);
const either =
  (...predicates: Array<(message: string) => boolean>) =>
  (message: string): boolean =>
    predicates.some((predicate) => predicate(message));

const unreadableShareCount = (message: string): number | undefined => {
  const match = /^\[share\] all (\d{1,3}) shared file\(s\) were unreadable$/.exec(message);
  if (!match) return undefined;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? count : undefined;
};

/**
 * Finite vocabulary for retained ERROR diagnostics.
 *
 * Prefix rules exist only to migrate old rows and the three runtime-handler messages whose suffix
 * is an Error. The suffix is never copied. New explicit call sites use the exact static forms.
 */
const EVENT_DEFINITIONS: readonly EventDefinition[] = [
  {
    code: 'share.no_cache_directory',
    tag: 'share',
    matches: exact('[share] no cache directory available — cannot accept shared files'),
  },
  {
    code: 'share.all_files_unreadable',
    tag: 'share',
    matches: either(
      exact('[share] all shared files were unreadable'),
      (message) => unreadableShareCount(message) !== undefined,
    ),
  },
  {
    code: 'share.capture_failed',
    tag: 'share',
    matches: either(exact('[share] capture failed'), begins('[share] capture failed:')),
  },
  {
    code: 'db.initialization_failed',
    tag: 'db',
    matches: exact('[db] initialization failed'),
  },
  {
    code: 'connect.database_initialization_failed',
    tag: 'connect',
    matches: exact('[connect] database initialization failed'),
  },
  {
    code: 'new_chat.create_failed',
    tag: 'new-chat',
    matches: exact('[new-chat] createNewChat failed'),
  },
  {
    code: 'media.share_source_unprotected',
    tag: 'media',
    matches: exact('[media] share source could not be protected'),
  },
  {
    code: 'media.share_source_missing',
    tag: 'media',
    matches: exact('[media] share source is no longer available'),
  },
  { code: 'media.share_failed', tag: 'media', matches: exact('[media] share failed') },
  {
    code: 'background.work_failed',
    tag: 'bg',
    matches: exact('[bg] background work failed'),
  },
  {
    code: 'db.write_queue_wedged',
    tag: 'db',
    matches: either(
      exact('[db] write queue appears wedged'),
      begins('[db] no write-lock holder released in '),
    ),
  },
  {
    code: 'open_file.open_failed',
    tag: 'openFile',
    matches: exact('[openFile] failed to open attachment'),
  },
  {
    code: 'ui.render_crash',
    tag: 'ErrorBoundary',
    matches: exact('[ErrorBoundary] render crash'),
  },
  {
    code: 'socket.event_handling_failed',
    tag: 'socket',
    matches: exact('[socket] event handling failed'),
  },
  {
    code: 'socket.connection_failed',
    tag: 'socket',
    matches: either(exact('[socket] connection failed'), begins('[socket] error connecting to ')),
  },
  {
    code: 'lock.unlock_failed',
    tag: 'lock',
    matches: either(
      exact('[lock] unlock failed after successful auth'),
      begins('[lock] unlock failed after a successful auth:'),
    ),
  },
  {
    code: 'runtime.fatal',
    tag: 'fatal',
    matches: either(exact('[fatal] runtime error'), begins('[fatal] ')),
  },
  {
    code: 'runtime.uncaught',
    tag: 'uncaught',
    matches: either(exact('[uncaught] runtime error'), begins('[uncaught] ')),
  },
  {
    code: 'runtime.unhandled_rejection',
    tag: 'unhandledRejection',
    matches: either(exact('[unhandledRejection] runtime error'), begins('[unhandledRejection] ')),
  },
  {
    code: 'runtime.recoverable',
    tag: 'recoverable',
    matches: exact('[recoverable] runtime warning'),
  },
] as const;

const FALLBACK_EVENT = { code: 'diagnostic.unclassified', tag: 'diagnostic' } as const;
const EVENT_BY_CODE = new Map(EVENT_DEFINITIONS.map((definition) => [definition.code, definition]));
const SERVER_EVENT_NAMES = new Set<string>(SERVER_EVENTS);

const ERROR_DETAIL_EVENT_CODES = new Set([
  'share.capture_failed',
  'db.initialization_failed',
  'connect.database_initialization_failed',
  'new_chat.create_failed',
  'media.share_failed',
  'background.work_failed',
  'open_file.open_failed',
  'ui.render_crash',
  'socket.event_handling_failed',
  'socket.connection_failed',
  'lock.unlock_failed',
  'runtime.fatal',
  'runtime.recoverable',
  'runtime.uncaught',
  'runtime.unhandled_rejection',
]);

const SAFE_ERROR_NAMES = new Set([
  'AggregateError',
  'ApiError',
  'AttachmentFetchError',
  'BackupAccountChangedError',
  'BackupInputLimitError',
  'BackupPassphraseRejectedError',
  'BootAdapterContractError',
  'BootStageTimeoutError',
  'BoundedDownloadError',
  'ContactsAccountChangedError',
  'ContactsPermissionDeniedError',
  'DbCommitGuardRejectedError',
  'DeletionSyncProtocolError',
  'Error',
  'EvalError',
  'ForegroundBootOperationalError',
  'ForegroundBootSupersededError',
  'IncomingEventClaimLostError',
  'IncomingEventCodecError',
  'IncomingEventDeliveryTimeoutError',
  'InvalidAppLockSettingError',
  'NativeBoundedDownloadError',
  'RangeError',
  'RealtimeGroupMutationUnavailableError',
  'RealtimeMessageChatUnavailableError',
  'RealtimeNotificationSettingsUnavailableError',
  'RealtimeReadStatusUnavailableError',
  'ReferenceError',
  'ReminderSessionChangedError',
  'ScheduledSessionChangedError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'UnimplementedEndpointError',
  'UploadGateCancelledError',
]);

const SAFE_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ERR_NETWORK',
  'ETIMEDOUT',
  'SQLITE_BUSY',
  'SQLITE_CANTOPEN',
  'SQLITE_CONSTRAINT',
  'SQLITE_CORRUPT',
  'SQLITE_FULL',
  'SQLITE_IOERR',
  'SQLITE_LOCKED',
  'SQLITE_NOTADB',
  'SQLITE_READONLY',
]);

const SAFE_API_KIND_RECORD = {
  bad_request: true,
  cancelled: true,
  local_file: true,
  no_connection: true,
  parse_error: true,
  server_error: true,
  timeout: true,
  unauthorized: true,
} as const satisfies Record<ApiErrorKind, true>;
const SAFE_API_KINDS = new Set<string>(Object.keys(SAFE_API_KIND_RECORD));

export interface SafeErrorDiagnosticMeta {
  schemaVersion: typeof ERROR_REPORT_ENVELOPE_VERSION;
  errorName?: string;
  errorCode?: string;
  status?: number;
  retryable?: boolean;
  fatal?: boolean;
  eventName?: string;
  affectedCount?: number;
  waitedMs?: number;
  waiting?: number;
  releasedWhileWaiting?: number;
}

export interface PrivacySafeErrorDiagnostic {
  message: string;
  stack?: string;
  tag: string;
  meta: SafeErrorDiagnosticMeta;
}

export interface PrivacySafeErrorReport extends Omit<PrivacySafeErrorDiagnostic, 'meta'> {
  level: 'error';
  meta: string;
}

export type DiagnosticEventCode = 'fcm.push_received';
export type DiagnosticReceiptSource = 'background' | 'foreground';

export interface DiagnosticEventInputByCode {
  'fcm.push_received': {
    /** Provider input stays open; the projector maps every unknown value to `unknown`. */
    readonly eventName: string;
    readonly source: DiagnosticReceiptSource;
  };
}

export interface SafeDiagnosticEventMeta {
  readonly schemaVersion: typeof DIAGNOSTIC_EVENT_ENVELOPE_VERSION;
  readonly eventName: ServerEventName | 'unknown';
  readonly source: DiagnosticReceiptSource | 'unknown';
}

export interface PrivacySafeDiagnosticEvent {
  readonly message: string;
  readonly tag: 'fcm';
  readonly meta: SafeDiagnosticEventMeta;
}

export interface PrivacySafeDiagnosticEventReport extends Omit<PrivacySafeDiagnosticEvent, 'meta'> {
  readonly level: 'info';
  readonly meta: string;
}

export interface StoredErrorReportInput {
  level?: unknown;
  message: string;
  stack?: string | null;
  tag?: string | null;
  meta?: string | null;
}

export interface StoredDiagnosticEventInput {
  readonly message: string;
  readonly meta?: string | null;
}

export interface PrivacySafeClientContext {
  appVersion?: string;
  platform?: 'android';
  osVersion?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function read(record: Record<string, unknown> | undefined, key: string): unknown {
  try {
    return record?.[key];
  } catch {
    return undefined;
  }
}

function parseStoredMeta(value: string | null | undefined): Record<string, unknown> | undefined {
  if (value == null || value.length > 16_000) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function eventFor(message: string): EventDefinition | typeof FALLBACK_EVENT {
  const bounded = message.slice(0, 4_096);
  const qualifierAt = bounded.indexOf(' [');
  const possibleCode = qualifierAt === -1 ? bounded : bounded.slice(0, qualifierAt);
  const alreadyProjected = EVENT_BY_CODE.get(possibleCode);
  if (alreadyProjected) return alreadyProjected;
  return EVENT_DEFINITIONS.find((definition) => definition.matches(bounded)) ?? FALLBACK_EVENT;
}

export function isClassifiedErrorMessage(message: string): boolean {
  return eventFor(message) !== FALLBACK_EVENT;
}

function safeInteger(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function safeSetValue(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === 'string' && value.length <= 64 && allowed.has(value) ? value : undefined;
}

function diagnosticEventCodeFor(message: unknown): DiagnosticEventCode | undefined {
  if (typeof message !== 'string' || message.length > 4_096) return undefined;
  const qualifierAt = message.indexOf(' [');
  const possibleCode = qualifierAt === -1 ? message : message.slice(0, qualifierAt);
  return possibleCode === 'fcm.push_received' ? possibleCode : undefined;
}

function safeServerEventName(value: unknown): ServerEventName | 'unknown' {
  if (typeof value !== 'string' || value.length > 64) return 'unknown';
  return SERVER_EVENTS.find((eventName) => eventName === value) ?? 'unknown';
}

function safeDiagnosticReceiptSource(value: unknown): DiagnosticReceiptSource | 'unknown' {
  return value === 'background' || value === 'foreground' ? value : 'unknown';
}

/** Project one selected non-error event before any release sink can inspect arbitrary metadata. */
export function projectCapturedDiagnosticEvent(
  message: unknown,
  meta?: unknown,
): PrivacySafeDiagnosticEvent | undefined {
  const code = diagnosticEventCodeFor(message);
  if (code === undefined) return undefined;
  const record = asRecord(meta);
  const eventNameValue = read(record, 'eventName') ?? read(record, 'event');
  const eventName = safeServerEventName(eventNameValue);
  const source = safeDiagnosticReceiptSource(read(record, 'source'));
  const safeMeta: SafeDiagnosticEventMeta = {
    schemaVersion: DIAGNOSTIC_EVENT_ENVELOPE_VERSION,
    eventName,
    source,
  };
  return {
    message: `${code} [event:${eventName}|source:${source}]`,
    tag: 'fcm',
    meta: safeMeta,
  };
}

function asDiagnosticEventReport(
  event: PrivacySafeDiagnosticEvent,
): PrivacySafeDiagnosticEventReport {
  return { ...event, level: 'info', meta: JSON.stringify(event.meta) };
}

/** Re-project a persisted finite event before restore or diagnostic sharing. */
export function projectStoredDiagnosticEvent(
  input: StoredDiagnosticEventInput,
): PrivacySafeDiagnosticEventReport | undefined {
  const event = projectCapturedDiagnosticEvent(input.message, parseStoredMeta(input.meta));
  return event === undefined ? undefined : asDiagnosticEventReport(event);
}

function errorRecord(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asRecord(read(meta, 'error')) ?? meta;
}

function hasErrorEvidence(error: Record<string, unknown> | undefined): boolean {
  // A canonical diagnostic carries its synthetic grouping frame in `stack`; that frame must not
  // invent an UnknownError classifier when the original event had no Error object.
  return ['errorName', 'name', 'errorCode', 'kind', 'code', 'status', 'retryable'].some(
    (key) => read(error, key) !== undefined,
  );
}

function buildMeta(
  rawMeta: Record<string, unknown> | undefined,
  definition: EventDefinition | typeof FALLBACK_EVENT,
  originalMessage: string,
): SafeErrorDiagnosticMeta {
  const result: SafeErrorDiagnosticMeta = { schemaVersion: ERROR_REPORT_ENVELOPE_VERSION };
  const code = definition.code;
  const error = errorRecord(rawMeta);

  if (ERROR_DETAIL_EVENT_CODES.has(code) && hasErrorEvidence(error)) {
    result.errorName =
      safeSetValue(read(rawMeta, 'errorName'), SAFE_ERROR_NAMES) ??
      safeSetValue(read(error, 'name'), SAFE_ERROR_NAMES) ??
      'UnknownError';
    const errorCode =
      safeSetValue(read(rawMeta, 'errorCode'), SAFE_API_KINDS) ??
      safeSetValue(read(rawMeta, 'errorCode'), SAFE_ERROR_CODES) ??
      safeSetValue(read(error, 'kind'), SAFE_API_KINDS) ??
      safeSetValue(read(error, 'code'), SAFE_ERROR_CODES);
    if (errorCode !== undefined) result.errorCode = errorCode;
    const status =
      safeInteger(read(rawMeta, 'status'), 599) ?? safeInteger(read(error, 'status'), 599);
    if (status === 0 || (status !== undefined && status >= 100)) result.status = status;
    const retryable =
      safeBoolean(read(rawMeta, 'retryable')) ?? safeBoolean(read(error, 'retryable'));
    if (retryable !== undefined) result.retryable = retryable;
  }

  if (code === 'runtime.fatal') result.fatal = true;

  if (code === 'socket.event_handling_failed') {
    const eventName =
      safeSetValue(read(rawMeta, 'eventName'), SERVER_EVENT_NAMES) ??
      safeSetValue(read(rawMeta, 'event'), SERVER_EVENT_NAMES);
    if (eventName !== undefined) result.eventName = eventName;
  }

  if (code === 'share.all_files_unreadable') {
    const affectedCount =
      safeInteger(read(rawMeta, 'affectedCount'), 200) ?? unreadableShareCount(originalMessage);
    if (affectedCount !== undefined) result.affectedCount = affectedCount;
  }

  if (code === 'db.write_queue_wedged') {
    const waitedMs = safeInteger(read(rawMeta, 'waitedMs'), 24 * 60 * 60 * 1000);
    const waiting = safeInteger(read(rawMeta, 'waiting'), 10_000);
    const releasedWhileWaiting = safeInteger(read(rawMeta, 'releasedWhileWaiting'), 10_000);
    if (waitedMs !== undefined) result.waitedMs = waitedMs;
    if (waiting !== undefined) result.waiting = waiting;
    if (releasedWhileWaiting !== undefined) result.releasedWhileWaiting = releasedWhileWaiting;
  }
  return result;
}

function statusClass(status: number | undefined): string | undefined {
  if (status === undefined) return undefined;
  if (status === 0) return 'status_0';
  return `http_${Math.floor(status / 100)}xx`;
}

function canonicalMessage(code: string, meta: SafeErrorDiagnosticMeta): string {
  const qualifiers = [
    meta.eventName === undefined ? undefined : `event:${meta.eventName}`,
    meta.errorName,
    meta.errorCode,
    statusClass(meta.status),
  ].filter((value): value is string => value !== undefined);
  return qualifiers.length === 0 ? code : `${code} [${qualifiers.join('|')}]`;
}

function project(
  message: string,
  rawMeta: Record<string, unknown> | undefined,
): PrivacySafeErrorDiagnostic {
  const definition = eventFor(message);
  const meta = buildMeta(rawMeta, definition, message);
  return {
    message: canonicalMessage(definition.code, meta),
    ...(definition === FALLBACK_EVENT ? {} : { stack: `at gator.${definition.code}` }),
    tag: definition.tag,
    meta,
  };
}

function fallbackDiagnostic(): PrivacySafeErrorDiagnostic {
  return {
    message: FALLBACK_EVENT.code,
    tag: FALLBACK_EVENT.tag,
    meta: { schemaVersion: ERROR_REPORT_ENVELOPE_VERSION },
  };
}

/** Project a raw logger call before any console, memory, file, database, or HTTP sink sees it. */
export function projectCapturedErrorDiagnostic(
  message: string,
  meta?: unknown,
): PrivacySafeErrorDiagnostic {
  try {
    return project(message, asRecord(meta));
  } catch {
    return fallbackDiagnostic();
  }
}

function asReport(diagnostic: PrivacySafeErrorDiagnostic): PrivacySafeErrorReport {
  return {
    level: 'error',
    message: diagnostic.message,
    ...(diagnostic.stack === undefined ? {} : { stack: diagnostic.stack }),
    tag: diagnostic.tag,
    meta: JSON.stringify(diagnostic.meta),
  };
}

/** Defensively rebuild a logger diagnostic before it can enter the durable database. */
export function projectCapturedErrorReport(
  message: string,
  meta?: unknown,
): PrivacySafeErrorReport {
  return asReport(projectCapturedErrorDiagnostic(message, meta));
}

/** Re-project legacy/current durable rows immediately before the HTTP boundary. */
export function projectStoredErrorReport(input: StoredErrorReportInput): PrivacySafeErrorReport {
  try {
    return asReport(project(input.message, parseStoredMeta(input.meta)));
  } catch {
    return asReport(fallbackDiagnostic());
  }
}

/** Device context uses package/OS-owned buckets; the user-visible device name is omitted. */
export function projectErrorReportClientContext(input: {
  appVersion?: string;
  platform?: string;
  osVersion?: string;
  deviceModel?: string;
}): PrivacySafeClientContext {
  const result: PrivacySafeClientContext = {};
  const record = asRecord(input);
  const rawAppVersion = read(record, 'appVersion');
  const rawPlatform = read(record, 'platform');
  const rawOsVersion = read(record, 'osVersion');
  const appVersion = typeof rawAppVersion === 'string' ? rawAppVersion : undefined;
  const platform = typeof rawPlatform === 'string' ? rawPlatform : undefined;
  const osVersion = typeof rawOsVersion === 'string' ? rawOsVersion : undefined;
  if (
    /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]{1,16})?(?:\+[0-9A-Za-z.-]{1,16})?$/.test(
      appVersion ?? '',
    )
  ) {
    result.appVersion = appVersion;
  }
  if (platform === 'android') result.platform = platform;
  if (/^(?:2[1-9]|[3-9]\d)$/.test(osVersion ?? '')) result.osVersion = osVersion;
  return result;
}

/** Exact capture times are unnecessary diagnostics and can become a correlation identifier. */
export function projectErrorReportTimestamp(value: number): number {
  const min = Date.UTC(2020, 0, 1);
  const max = Date.UTC(2100, 0, 1);
  if (!Number.isSafeInteger(value) || value < min || value >= max) return 0;
  return Math.floor(value / 60_000) * 60_000;
}
