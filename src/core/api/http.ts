import ky from 'ky';
import type { z } from 'zod/v4';
import {
  API_BASE_PATH,
  AUTH_HEADER,
  AUTH_SCHEME,
  TUNNEL_SKIP_HEADERS,
} from '@core/config/constants';
import { apiResponse } from '@core/models/common';
import { ApiError } from './errors';
import { withRetry, type RetryPolicy } from './retry';
import { MAX_SERVER_ERROR_BODY_BYTES, parseServerErrorBody } from './serverErrorDetail';

/** Hard default for every JSON/envelope response before it is decoded or passed to Zod. */
export const DEFAULT_MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MiB

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const MAX_SERVER_ERROR_BODY_TIMEOUT_MS = 2_000;
const MAX_TIMER_MS = 2_147_483_647;
// Coalescing bounds string metadata to <=257 pieces at the 16 MiB cap. The chunk ceiling is much
// more generous than Expo's normal native network chunks while still bounding hostile microtasks.
const RESPONSE_DECODE_BLOCK_BYTES = 64 * 1024;
const MAX_RESPONSE_STREAM_CHUNKS = 16_384;
const MAX_CONSECUTIVE_EMPTY_CHUNKS = 16;
const REPAIR_SNAPSHOT_HEADER = 'x-gator-repair-snapshot';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Restate the redirect policy on the final fetch call instead of trusting its Request object.
 *
 * React Native's whatwg-fetch Request polyfill drops `redirect` while Ky constructs/clones the
 * request. Ky then omits standard RequestInit fields from the fetch call because browsers retain
 * them on Request. Expo fetch consequently sees no policy and defaults to following the redirect.
 * Supplying it here makes Expo's native no-follow path authoritative on every ordinary API call.
 */
function fetchRejectingRedirects(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, redirect: 'error' });
}

interface RequiredResponseHeader {
  readonly name: string;
  readonly value: string;
}

export interface HttpClientConfig {
  /** Current server origin, e.g. "https://abc.ngrok.io". May change on failover. */
  getOrigin: () => string;
  /** Server password. Sent only as an Authorization Bearer credential, never in the URL. */
  getPassword: () => string | undefined;
  /**
   * Optional monotonic identity for transports whose origin/password can rotate back to an older
   * value. Fixed/candidate clients may omit it; the session-bound app client supplies it.
   */
  getTransportRevision?: () => number;
  /** Optional user-defined headers (ported from settings.customHeaders). */
  getCustomHeaders?: () => Record<string, string>;
  /** Separate ceilings for receiving headers and then consuming the complete JSON body. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to the platform fetch. */
  fetch?: typeof fetch;
  /**
   * Optional lifetime shared by every request from this client and its pinned children.
   * Background-task composition uses this to stop the complete request graph at one deadline;
   * ordinary foreground clients leave it unset and retain per-request cancellation only.
   */
  lifetimeSignal?: AbortSignal;
  /**
   * Extra cancellation added by {@link HttpClient.withCancellation}. Like `lifetimeSignal`, each
   * one stops every request from this client and its pinned children.
   */
  cancellationSignals?: readonly AbortSignal[];
  /**
   * Optional tighter client-wide response cap (primarily for focused tests). It may never raise
   * the production default; a genuinely larger endpoint needs its own reviewed transport design.
   */
  responseByteLimit?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  signal?: AbortSignal;
  /**
   * Read only the bounded JSON `error.message` and machine-readable `error.type` fields on a
   * non-success response. This is opt-in for endpoints with reviewed error behavior; ordinary APIs
   * remain status-only and cancel their error body without reading it.
   */
  captureErrorDetail?: true;
  /**
   * Retry transient failures (dropped connection / timeout / 5xx) with backoff. Defaults ON for
   * GET (idempotent reads), OFF for writes — a retried POST could double-send (the outgoing-queue
   * owns send retries). Pass an explicit policy to opt a write in, or `false` to force a single
   * shot (e.g. a reachability ping that must fail fast).
   */
  retry?: RetryPolicy | false;
}

/** Minimal URL-building surface accepted by binary endpoint helpers. */
export interface HttpUrlBuilder {
  buildUrl(path: string): string;
}

/**
 * One immutable view of the server transport identity.
 *
 * Native file and socket APIs cannot delegate URL/header injection to {@link HttpClient}, so they
 * must capture this object once, before their first await, and reuse it for the operation's whole
 * lifetime. That prevents an old URL from ever being paired with a newly connected account's
 * credential. `password` is exposed only because Socket.IO requires the raw value in its auth
 * payload; file-transfer callers must use `headers`/`buildUrl`.
 */
export interface HttpTransportSnapshot extends HttpUrlBuilder {
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly password: string | undefined;
  readonly transportRevision: number | undefined;
}

interface RequestSnapshot {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly search: URLSearchParams;
  readonly transportRevision: number | undefined;
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        key === rightEntries[index]?.[0] && value === rightEntries[index]?.[1],
    )
  );
}

function sameSearchParams(left: URLSearchParams, right: URLSearchParams): boolean {
  const normalized = (value: URLSearchParams): string => {
    const copy = new URLSearchParams(value);
    copy.sort();
    return copy.toString();
  };
  return normalized(left) === normalized(right);
}

function sameRequestSnapshot(left: RequestSnapshot, right: RequestSnapshot): boolean {
  return (
    left.url === right.url &&
    left.transportRevision === right.transportRevision &&
    sameStringRecord(left.headers, right.headers) &&
    sameSearchParams(left.search, right.search)
  );
}

function sameTransportIdentity(left: HttpTransportSnapshot, right: HttpTransportSnapshot): boolean {
  return (
    left.origin === right.origin &&
    left.password === right.password &&
    left.transportRevision === right.transportRevision &&
    sameStringRecord(left.headers, right.headers)
  );
}

function responseParseError(message: string, response: Response, cause?: unknown): ApiError {
  return new ApiError('parse_error', message, response.status, cause);
}

function callerCancellationError(signal: AbortSignal): ApiError {
  return new ApiError('cancelled', 'Network request was cancelled', undefined, signal.reason);
}

interface LinkedAbortSignal {
  readonly signal?: AbortSignal;
  release(): void;
}

/** Combine per-request and client-wide cancellation without relying on AbortSignal.any. */
function linkAbortSignals(...candidates: Array<AbortSignal | undefined>): LinkedAbortSignal {
  const signals = [...new Set(candidates.filter(Boolean))] as AbortSignal[];
  if (signals.length === 0) return { signal: undefined, release: () => undefined };
  if (signals.length === 1) return { signal: signals[0], release: () => undefined };

  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of signals) {
    const listener = (): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    signal.addEventListener('abort', listener, { once: true });
    listeners.push({ signal, listener });
    // Close the check/listener race for injected AbortSignal implementations.
    if (signal.aborted) listener();
  }
  return {
    signal: controller.signal,
    release: () => {
      for (const entry of listeners) {
        entry.signal.removeEventListener('abort', entry.listener);
      }
    },
  };
}

/** Abort-aware retry delay so Disconnect cannot leave an old logical request parked in backoff. */
function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(callerCancellationError(signal));

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(callerCancellationError(signal));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    // Close the check/listener race for injected AbortSignal implementations.
    if (signal.aborted) abort();
  });
}

function cancelRequestSafely(
  cancelRequest: ((reason: string) => void) | undefined,
  reason: string,
): void {
  try {
    cancelRequest?.(reason);
  } catch {
    // The response/body cancellation below still gets its own chance.
  }
}

function cancelResponseBody(
  response: Response,
  reason: string,
  cancelRequest?: (reason: string) => void,
): void {
  // Aborting the owning fetch is important on Expo: before the first stream pull, native may be
  // queueing bytes and `ReadableStream.cancel()` alone cannot reliably stop that request state.
  cancelRequestSafely(cancelRequest, reason);
  try {
    const cancellation = response.body?.cancel(reason);
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // Body cancellation is cleanup only; the typed HTTP/parse error remains authoritative.
  }
}

/**
 * Read one response as UTF-8 while enforcing ACTUAL streamed bytes.
 *
 * The default Expo fetch implementation exposes a ReadableStream on Android, as does Node's
 * Response in tests. A legacy/custom Response with no stream fails closed: calling `.text()` or
 * `.arrayBuffer()` there would simply move the unbounded allocation behind another API.
 *
 * Native residual: Expo may queue bytes between receiving headers and JavaScript's first stream
 * pull. We attach the reader immediately after `ky` returns and Content-Length rejects an honest
 * oversize response before decoding, but JavaScript cannot cap that small pre-reader native queue.
 * Eliminating it completely would require an owned native JSON transport.
 */
async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  bodyTimeoutMs: number,
  cancelRequest?: (reason: string) => void,
): Promise<string> {
  const rawLength = response.headers.get('content-length');
  if (rawLength != null) {
    const normalized = rawLength.trim();
    if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(Number(normalized))) {
      cancelResponseBody(response, 'invalid Content-Length', cancelRequest);
      throw responseParseError('Response declared an invalid size', response);
    }
    if (Number(normalized) > maxBytes) {
      cancelResponseBody(response, 'declared response exceeds byte limit', cancelRequest);
      throw responseParseError('Response exceeded the safe size limit', response);
    }
  }

  // Standard no-body responses expose `body: null`. A missing property means a legacy/custom
  // implementation without stream support, which cannot be read with an honest actual-byte cap.
  if (!('body' in response)) {
    cancelRequestSafely(cancelRequest, 'response stream unavailable');
    throw responseParseError('Response body could not be read safely', response);
  }
  const stream = response.body;
  if (stream == null) return '';
  if (typeof stream.getReader !== 'function') {
    cancelResponseBody(response, 'response stream unavailable', cancelRequest);
    throw responseParseError('Response body could not be read safely', response);
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch (error) {
    cancelResponseBody(response, 'response stream could not be locked', cancelRequest);
    throw responseParseError('Response body could not be read safely', response, error);
  }
  const decoder = new TextDecoder();
  const textParts: string[] = [];
  // Decode fixed-size blocks instead of each native chunk. Otherwise a legal byte budget could
  // still create millions of tiny strings/array entries when a peer fragments every byte.
  const decodeBlock = new Uint8Array(Math.min(RESPONSE_DECODE_BLOCK_BYTES, maxBytes));
  let decodeBlockBytes = 0;
  let receivedBytes = 0;
  let streamChunks = 0;
  let consecutiveEmptyChunks = 0;
  let deadlineExpired = false;
  const timeoutError = new ApiError('timeout', 'Response body timed out', response.status);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      // Abort the owning native request as well as rejecting the JS-side race. The race is still
      // required because a custom/stalled stream is not guaranteed to observe fetch cancellation.
      cancelRequestSafely(cancelRequest, 'response body deadline exceeded');
      reject(timeoutError);
    }, bodyTimeoutMs);
  });

  const flushDecodeBlock = (): void => {
    if (decodeBlockBytes === 0) return;
    const text = decoder.decode(decodeBlock.subarray(0, decodeBlockBytes), { stream: true });
    if (text.length > 0) textParts.push(text);
    decodeBlockBytes = 0;
  };

  const readBody = async (): Promise<string> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (deadlineExpired) throw timeoutError;
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw responseParseError('Response stream returned invalid bytes', response);
      }

      streamChunks += 1;
      if (streamChunks > MAX_RESPONSE_STREAM_CHUNKS) {
        throw responseParseError('Response stream was too fragmented', response);
      }
      if (value.byteLength === 0) {
        consecutiveEmptyChunks += 1;
        if (consecutiveEmptyChunks > MAX_CONSECUTIVE_EMPTY_CHUNKS) {
          throw responseParseError('Response stream made no progress', response);
        }
        continue;
      }
      consecutiveEmptyChunks = 0;

      if (value.byteLength > maxBytes - receivedBytes) {
        throw responseParseError('Response exceeded the safe size limit', response);
      }
      receivedBytes += value.byteLength;

      let sourceOffset = 0;
      while (sourceOffset < value.byteLength) {
        const copyBytes = Math.min(
          decodeBlock.byteLength - decodeBlockBytes,
          value.byteLength - sourceOffset,
        );
        decodeBlock.set(value.subarray(sourceOffset, sourceOffset + copyBytes), decodeBlockBytes);
        decodeBlockBytes += copyBytes;
        sourceOffset += copyBytes;
        if (decodeBlockBytes === decodeBlock.byteLength) flushDecodeBlock();
      }
    }

    flushDecodeBlock();
    const finalText = decoder.decode();
    if (finalText.length > 0) textParts.push(finalText);
    return textParts.join('');
  };

  try {
    return await Promise.race([readBody(), deadline]);
  } catch (error) {
    // The deadline is authoritative even if aborting native caused `reader.read()` to reject one
    // microtask before the deadline promise. This keeps a body stall classified as retryable timeout.
    const failure = deadlineExpired ? timeoutError : error;
    cancelRequestSafely(
      cancelRequest,
      deadlineExpired ? 'response body deadline exceeded' : 'response stream rejected',
    );
    try {
      const cancellation = reader.cancel('response read stopped');
      // Cancellation is cleanup and must never become another unbounded await if an implementation
      // has a broken cancel algorithm. Promise.race already observes a late read rejection.
      if (cancellation) void cancellation.catch(() => undefined);
    } catch {
      // Preserve the original size/stream failure when native cancellation itself fails.
    }
    throw failure;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    try {
      reader.releaseLock();
    } catch {
      // A canceled/failed stream may already have released its reader.
    }
  }
}

/**
 * Thin typed wrapper over `ky`. This class is the ONLY credential-injection point: normal requests
 * use the private header/query builders, while native transports use {@link snapshotTransport}.
 * Features must never assemble another Authorization header or legacy `guid` query themselves.
 */
export class HttpClient {
  private readonly responseByteLimit: number;
  private readonly timeoutMs: number;
  private readonly transportStillCurrent?: () => boolean;
  private readonly requiredResponseHeader?: RequiredResponseHeader;

  constructor(
    private readonly cfg: HttpClientConfig,
    transportStillCurrent?: () => boolean,
    requiredResponseHeader?: RequiredResponseHeader,
  ) {
    this.transportStillCurrent = transportStillCurrent;
    this.requiredResponseHeader = requiredResponseHeader;
    const responseByteLimit = cfg.responseByteLimit ?? DEFAULT_MAX_JSON_RESPONSE_BYTES;
    if (
      !Number.isSafeInteger(responseByteLimit) ||
      responseByteLimit <= 0 ||
      responseByteLimit > DEFAULT_MAX_JSON_RESPONSE_BYTES
    ) {
      throw new RangeError(
        `responseByteLimit must be a positive safe integer no greater than ${DEFAULT_MAX_JSON_RESPONSE_BYTES}`,
      );
    }
    this.responseByteLimit = responseByteLimit;

    const timeoutMs = cfg.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
      throw new RangeError(
        `timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_MS}`,
      );
    }
    this.timeoutMs = timeoutMs;
  }

  get<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: RequestOptions = {},
  ): Promise<z.infer<S>> {
    return this.request('GET', path, schema, opts);
  }

  post<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: RequestOptions = {},
  ): Promise<z.infer<S>> {
    return this.request('POST', path, schema, opts);
  }

  delete<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: RequestOptions = {},
  ): Promise<z.infer<S>> {
    return this.request('DELETE', path, schema, opts);
  }

  /** Clean live URL helper. Native URL+auth consumers must use {@link snapshotTransport}. */
  buildUrl(path: string): string {
    return this.buildUrlForOrigin(this.cfg.getOrigin(), path);
  }

  private buildUrlForOrigin(rawOrigin: string, path: string): string {
    const origin = rawOrigin.replace(/\/+$/, '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${origin}${API_BASE_PATH}${cleanPath}`;
  }

  private buildHeadersFor(password: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      ...TUNNEL_SKIP_HEADERS,
      ...(this.cfg.getCustomHeaders?.() ?? {}),
    };
    if (password) {
      headers[AUTH_HEADER] = `${AUTH_SCHEME} ${password}`;
    }
    return headers;
  }

  private buildSearch(query: RequestOptions['query']): URLSearchParams {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) search.set(k, String(v));
    }
    return search;
  }

  /**
   * Freeze one origin/auth/custom-header identity for a multi-request operation.
   *
   * Each request also checks the source client, so a tunnel, account, or credential rotation
   * cancels the operation instead of silently moving later pages to another server identity.
   */
  pinTransport(): HttpClient {
    return this.createPinnedClient();
  }

  /**
   * This live client with one more way to cancel: every request from the returned client (and its
   * pinned children) also stops when `signal` aborts. The parent is unaffected, so Disconnect can
   * cancel an account's requests while its own cleanup keeps using the shared client.
   */
  withCancellation(signal: AbortSignal): HttpClient {
    return new HttpClient(
      { ...this.cfg, cancellationSignals: [...(this.cfg.cancellationSignals ?? []), signal] },
      this.transportStillCurrent,
      this.requiredResponseHeader,
    );
  }

  /** True for a live client, or while a pinned client's exact source transport remains current. */
  isTransportCurrent(): boolean {
    return this.transportStillCurrent?.() ?? true;
  }

  /** Fail before a transport-scoped native effect starts if its pinned source has been replaced. */
  assertTransportCurrent(): void {
    if (!this.isTransportCurrent()) {
      throw new ApiError('cancelled', 'Request configuration changed during pinned operation');
    }
  }

  /** Add the server-issued repair token to every request on an already-pinned crawl client. */
  bindRepairSnapshot(token: string): HttpClient {
    if (!UUID_V4.test(token)) throw new RangeError('repair snapshot token must be a UUID');
    return this.createPinnedClient(
      { [REPAIR_SNAPSHOT_HEADER]: token },
      { name: REPAIR_SNAPSHOT_HEADER, value: token },
    );
  }

  /**
   * Capture a coherent origin/auth/header view for a native transport.
   *
   * `buildUrl` is bound to the captured origin. Credentials remain in the captured headers so
   * native file APIs cannot accidentally place them in a URL.
   */
  snapshotTransport(): HttpTransportSnapshot {
    // All accessors are synchronous. Keeping this block await-free makes the values one JS-turn
    // snapshot; Object.freeze then prevents either our code or a native adapter from changing it.
    const origin = this.cfg.getOrigin();
    const password = this.cfg.getPassword();
    const transportRevision = this.cfg.getTransportRevision?.();
    const headers = Object.freeze(this.buildHeadersFor(password));
    const buildUrl = (path: string): string => this.buildUrlForOrigin(origin, path);
    return Object.freeze({
      origin,
      headers,
      password,
      transportRevision,
      buildUrl,
    });
  }

  private createPinnedClient(
    additionalHeaders: Readonly<Record<string, string>> = {},
    requiredResponseHeader = this.requiredResponseHeader,
  ): HttpClient {
    const transport = this.snapshotTransport();
    const transportRevision = transport.transportRevision;
    const parentGuard = this.transportStillCurrent;
    const fixedHeaders: Record<string, string> = { ...transport.headers };
    for (const [name, value] of Object.entries(additionalHeaders)) {
      for (const existing of Object.keys(fixedHeaders)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete fixedHeaders[existing];
      }
      fixedHeaders[name] = value;
    }
    Object.freeze(fixedHeaders);
    const transportStillCurrent = (): boolean => {
      if (parentGuard && !parentGuard()) return false;
      return sameTransportIdentity(transport, this.snapshotTransport());
    };
    return new HttpClient(
      {
        getOrigin: () => transport.origin,
        getPassword: () => transport.password,
        ...(transportRevision === undefined
          ? {}
          : { getTransportRevision: () => transportRevision }),
        getCustomHeaders: () => fixedHeaders,
        timeoutMs: this.timeoutMs,
        fetch: this.cfg.fetch,
        lifetimeSignal: this.cfg.lifetimeSignal,
        cancellationSignals: this.cfg.cancellationSignals,
        responseByteLimit: this.responseByteLimit,
      },
      transportStillCurrent,
      requiredResponseHeader,
    );
  }

  /**
   * Capture one coherent transport identity before a request starts.
   *
   * A retry may run after Disconnect + reconnect. Reading the live password again while retaining
   * the first attempt's URL would send the new account's credential to the old server. Keep the
   * origin, password, query, and custom headers together for the request's whole life.
   */
  private snapshotRequest(path: string, query: RequestOptions['query']): RequestSnapshot {
    const transport = this.snapshotTransport();
    return {
      url: this.buildUrlForOrigin(transport.origin, path),
      headers: transport.headers,
      search: this.buildSearch(query),
      transportRevision: transport.transportRevision,
    };
  }

  private async request<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S,
    opts: RequestOptions,
  ): Promise<z.infer<S>> {
    const linkedSignal = linkAbortSignals(
      opts.signal,
      this.cfg.lifetimeSignal,
      ...(this.cfg.cancellationSignals ?? []),
    );
    const signal = linkedSignal.signal;
    try {
      if (signal?.aborted) throw callerCancellationError(signal);
      this.assertTransportCurrent();
      const initialRequest = this.snapshotRequest(path, opts.query);

      // One full attempt: send, map transport/status/parse failures to a typed ApiError, return
      // data. A logical request owns one transport identity. A retry re-reads the live
      // configuration only to prove it is still that identity: if Disconnect/reconnect changed
      // origin, credentials, query parameters, or custom headers, retire the old request without
      // sending either the old credential after revocation or the new credential with old-account
      // work.
      let firstAttempt = true;
      const run = async (): Promise<z.infer<S>> => {
        if (signal?.aborted) throw callerCancellationError(signal);
        this.assertTransportCurrent();
        const request = firstAttempt ? initialRequest : this.snapshotRequest(path, opts.query);
        firstAttempt = false;
        if (!sameRequestSnapshot(initialRequest, request)) {
          throw new ApiError('cancelled', 'Request configuration changed before retry');
        }
        const { url, headers, search } = request;
        const requestController = new AbortController();
        const abortFromCaller = (): void => requestController.abort(signal?.reason);
        if (signal?.aborted) abortFromCaller();
        else signal?.addEventListener('abort', abortFromCaller, { once: true });
        try {
          let response: Response;
          try {
            response = await ky(url, {
              method,
              headers: { ...headers },
              searchParams: new URLSearchParams(search),
              json: opts.json,
              redirect: 'error',
              signal: requestController.signal,
              timeout: this.timeoutMs,
              retry: 0,
              throwHttpErrors: false,
              // RN's Request polyfill does not retain `redirect`; force it again at fetch dispatch.
              fetch: fetchRejectingRedirects(this.cfg.fetch ?? fetch),
            });
          } catch (err) {
            if (signal?.aborted) throw callerCancellationError(signal);
            // ky throws its own TimeoutError (an Error subclass, not a DOMException); a fetch-level
            // timeout can surface as a DOMException of the same name. Both are a timeout.
            if ((err as { name?: unknown } | null)?.name === 'TimeoutError') {
              throw new ApiError('timeout', 'Request timed out', undefined, err);
            }
            throw new ApiError('no_connection', 'Network request failed', undefined, err);
          }
          try {
            return await this.parseResponse(
              response,
              method,
              path,
              schema,
              (reason) => requestController.abort(reason),
              opts.captureErrorDetail === true,
            );
          } catch (error) {
            if (signal?.aborted) throw callerCancellationError(signal);
            throw error;
          }
        } finally {
          signal?.removeEventListener('abort', abortFromCaller);
        }
      };

      // Retry idempotent GETs by default; writes only when explicitly opted in; never when
      // `retry: false`.
      const wantsRetry = opts.retry !== false && (method === 'GET' || opts.retry !== undefined);
      return await (wantsRetry
        ? withRetry(run, typeof opts.retry === 'object' ? opts.retry : undefined, (ms) =>
            waitForRetry(ms, signal),
          )
        : run());
    } finally {
      linkedSignal.release();
    }
  }

  /** Shared response handling: status check → byte-capped JSON parse → envelope/schema validation. */
  private async parseResponse<S extends z.ZodType>(
    response: Response,
    method: string,
    path: string,
    schema: S,
    cancelRequest?: (reason: string) => void,
    captureErrorDetail = false,
  ): Promise<z.infer<S>> {
    if (
      response.ok &&
      this.requiredResponseHeader != null &&
      response.headers.get(this.requiredResponseHeader.name) !== this.requiredResponseHeader.value
    ) {
      cancelResponseBody(response, 'repair response acknowledgement is missing', cancelRequest);
      throw new ApiError(
        'parse_error',
        'Server did not acknowledge the repair snapshot page',
        response.status,
      );
    }
    if (!response.ok) {
      let serverDetail: string | undefined;
      let serverErrorType: string | undefined;
      const mediaType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      const isJson = mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
      if (captureErrorDetail && isJson) {
        try {
          const errorBody = await readBoundedResponseText(
            response,
            Math.min(this.responseByteLimit, MAX_SERVER_ERROR_BODY_BYTES),
            Math.min(this.timeoutMs, MAX_SERVER_ERROR_BODY_TIMEOUT_MS),
            cancelRequest,
          );
          const serverError = parseServerErrorBody(errorBody);
          serverDetail = serverError?.detail;
          serverErrorType = serverError?.type;
        } catch {
          // Status classification remains authoritative for malformed, oversized, or stalled
          // untrusted error bodies. The bounded reader has already canceled failed reads.
        }
      } else {
        cancelResponseBody(response, 'HTTP error response is not consumed', cancelRequest);
      }
      throw ApiError.fromStatus(
        response.status,
        `${method} ${path} failed`,
        serverDetail,
        serverErrorType,
      );
    }

    // 204/205 and HEAD intentionally have no envelope. Validate `undefined` against the endpoint's
    // own schema so `z.unknown()`/`z.void()` endpoints work, while object-returning endpoints fail.
    if (response.status === 204 || response.status === 205 || method === 'HEAD') {
      cancelResponseBody(response, 'no-content response', cancelRequest);
      const empty = schema.safeParse(undefined);
      if (!empty.success) {
        throw new ApiError(
          'parse_error',
          `Empty response did not match schema for ${path}`,
          response.status,
          empty.error,
        );
      }
      return empty.data as z.infer<S>;
    }

    let text: string;
    try {
      text = await readBoundedResponseText(
        response,
        this.responseByteLimit,
        this.timeoutMs,
        cancelRequest,
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError('parse_error', 'Response body could not be read', response.status, err);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new ApiError('parse_error', 'Response was not valid JSON', response.status, err);
    }
    const parsed = apiResponse(schema).safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        'parse_error',
        `Response did not match schema for ${path}`,
        response.status,
        parsed.error,
      );
    }
    // zod v4's object output type can't surface `.data` when the payload field is
    // the generic `S`; the validated envelope's `data` is `z.infer<S>` at runtime.
    return (parsed.data as { data: z.infer<S> }).data;
  }
}
