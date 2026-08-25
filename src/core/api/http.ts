import ky from 'ky';
import type { z } from 'zod/v4';
import {
  API_BASE_PATH,
  AUTH_HEADER,
  AUTH_SCHEME,
  TUNNEL_SKIP_HEADERS,
} from '@core/config/constants';
import { apiResponse } from '@core/models/common';
import { logger } from '@core/secure';
import { ApiError } from './errors';
import { withRetry, type RetryPolicy } from './retry';
import { MAX_SERVER_ERROR_BODY_BYTES, parseServerErrorDetailBody } from './serverErrorDetail';

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

export interface HttpClientConfig {
  /** Current server origin, e.g. "https://abc.ngrok.io". May change on failover. */
  getOrigin: () => string;
  /** Server password (the legacy "guid"). Header by default; URL only in explicit legacy mode. */
  getPassword: () => string | undefined;
  /** Optional user-defined headers (ported from settings.customHeaders). */
  getCustomHeaders?: () => Record<string, string>;
  /**
   * When false, fall back to legacy `?guid=` query auth for old servers. Default
   * true. SECURITY: the rebuild gates setup on MIN_SERVER_VERSION so header auth
   * is the norm; legacy mode is permitted only over HTTPS and is logged.
   */
  useHeaderAuth?: () => boolean;
  /** Separate ceilings for receiving headers and then consuming the complete JSON body. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to the platform fetch. */
  fetch?: typeof fetch;
  /**
   * Optional tighter client-wide response cap (primarily for focused tests). It may never raise
   * the production default; a genuinely larger endpoint needs its own reviewed transport design.
   */
  responseByteLimit?: number;
  /** Called when legacy query auth is used, so callers can warn/redact. */
  onLegacyAuth?: () => void;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  /** Multipart form body for attachment uploads. */
  form?: FormData;
  signal?: AbortSignal;
  /**
   * Read only the bounded JSON `error.message` field on a non-success response. This is opt-in for
   * send endpoints whose failed optimistic row can surface the detail; ordinary APIs remain
   * status-only and cancel their error body without reading it.
   */
  captureErrorDetail?: true;
  /**
   * Retry transient failures (dropped connection / timeout / 5xx) with backoff. Defaults ON for
   * GET (idempotent reads), OFF for writes — a retried POST could double-send (the outgoing-queue
   * owns send retries). Pass an explicit policy to opt a write in, or `false` to force a single
   * shot (e.g. a reachability ping that must fail fast). Never applied to multipart `form` uploads.
   */
  retry?: RetryPolicy | false;
}

export type HttpAuthMode = 'header' | 'legacy-query';

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
 * payload (or its explicit legacy query mode); file-transfer callers must use `headers`/`buildUrl`.
 */
export interface HttpTransportSnapshot extends HttpUrlBuilder {
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly authMode: HttpAuthMode;
  readonly password: string | undefined;
}

interface RequestSnapshot {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly search: URLSearchParams;
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
    sameStringRecord(left.headers, right.headers) &&
    sameSearchParams(left.search, right.search)
  );
}

function responseParseError(message: string, response: Response, cause?: unknown): ApiError {
  return new ApiError('parse_error', message, response.status, cause);
}

function callerCancellationError(signal: AbortSignal): ApiError {
  return new ApiError('cancelled', 'Network request was cancelled', undefined, signal.reason);
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

  constructor(private readonly cfg: HttpClientConfig) {
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

  put<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: RequestOptions = {},
  ): Promise<z.infer<S>> {
    return this.request('PUT', path, schema, opts);
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

  buildHeaders(): Record<string, string> {
    return this.buildHeadersFor(this.cfg.getPassword(), this.useHeaderAuth());
  }

  private buildHeadersFor(
    password: string | undefined,
    useHeaderAuth: boolean,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      ...TUNNEL_SKIP_HEADERS,
      ...(this.cfg.getCustomHeaders?.() ?? {}),
    };
    if (useHeaderAuth && password) {
      headers[AUTH_HEADER] = `${AUTH_SCHEME} ${password}`;
    }
    return headers;
  }

  private buildSearch(
    query: RequestOptions['query'],
    password: string | undefined,
    useHeaderAuth: boolean,
  ): URLSearchParams {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) search.set(k, String(v));
    }
    if (!useHeaderAuth) {
      if (password) {
        this.cfg.onLegacyAuth?.();
        search.set('guid', password); // legacy fallback only
      }
    }
    return search;
  }

  private useHeaderAuth(): boolean {
    return this.cfg.useHeaderAuth ? this.cfg.useHeaderAuth() : true;
  }

  /**
   * Whether auth travels in a header (secure default) vs. the legacy `?guid=` query.
   * Kept for simple inspection/tests; native transports must read the mode from one snapshot.
   */
  usesHeaderAuth(): boolean {
    return this.useHeaderAuth();
  }

  /**
   * Capture a coherent origin/auth/header view for a native transport.
   *
   * `buildUrl` is bound to the captured origin. In explicit legacy mode it also appends the
   * captured `guid` query credential, because native file APIs cannot use HttpClient's normal
   * query injection. Header-auth mode always keeps the password out of the URL.
   */
  snapshotTransport(): HttpTransportSnapshot {
    // All accessors are synchronous. Keeping this block await-free makes the values one JS-turn
    // snapshot; Object.freeze then prevents either our code or a native adapter from changing it.
    const origin = this.cfg.getOrigin();
    const password = this.cfg.getPassword();
    const useHeaderAuth = this.useHeaderAuth();
    const onLegacyAuth = this.cfg.onLegacyAuth;
    const headers = Object.freeze(this.buildHeadersFor(password, useHeaderAuth));
    const buildUrl = (path: string): string => {
      const url = this.buildUrlForOrigin(origin, path);
      if (useHeaderAuth || !password) return url;
      onLegacyAuth?.();
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}${new URLSearchParams({ guid: password }).toString()}`;
    };
    return Object.freeze({
      origin,
      headers,
      authMode: useHeaderAuth ? 'header' : 'legacy-query',
      password,
      buildUrl,
    });
  }

  /**
   * Capture one coherent transport identity before a request starts.
   *
   * A retry may run after Disconnect + reconnect. Reading the live password again while retaining
   * the first attempt's URL would send the new account's credential to the old server. Keep the
   * origin, password, auth mode, query, and custom headers together for the request's whole life.
   */
  private snapshotRequest(path: string, query: RequestOptions['query']): RequestSnapshot {
    const transport = this.snapshotTransport();
    const useHeaderAuth = transport.authMode === 'header';
    return {
      // The normal ky path injects legacy auth through searchParams below. Use the clean URL here
      // so `guid` is present exactly once; snapshot.buildUrl handles native callers instead.
      url: this.buildUrlForOrigin(transport.origin, path),
      headers: transport.headers,
      search: this.buildSearch(query, transport.password, useHeaderAuth),
    };
  }

  private async request<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S,
    opts: RequestOptions,
  ): Promise<z.infer<S>> {
    const initialRequest = this.snapshotRequest(path, opts.query);

    // Multipart uploads take a SEPARATE path: RN's raw `fetch` streams a FormData file part from
    // disk, whereas `ky` mishandles React Native's FormData (its body/timeout machinery breaks the
    // native stream, surfacing as an opaque "connection refused"). Raw fetch also drops the 30s
    // timeout, which would otherwise kill a large video mid-upload. Never retried (double-send).
    if (opts.form) {
      const { url, headers, search } = initialRequest;
      return this.uploadMultipart(method, path, url, headers, search, schema, opts);
    }

    // One full attempt: send, map transport/status/parse failures to a typed ApiError, return data.
    // A logical request owns one transport identity. A retry re-reads the live configuration only
    // to prove it is still that identity: if Disconnect/reconnect changed origin, credentials,
    // auth mode, query auth, or custom headers, retire the old request without sending either the
    // old credential after revocation or the new credential with old-account work.
    let firstAttempt = true;
    const run = async (): Promise<z.infer<S>> => {
      if (opts.signal?.aborted) throw callerCancellationError(opts.signal);
      const request = firstAttempt ? initialRequest : this.snapshotRequest(path, opts.query);
      firstAttempt = false;
      if (!sameRequestSnapshot(initialRequest, request)) {
        throw new ApiError('cancelled', 'Request configuration changed before retry');
      }
      const { url, headers, search } = request;
      const requestController = new AbortController();
      const abortFromCaller = (): void => requestController.abort(opts.signal?.reason);
      if (opts.signal?.aborted) abortFromCaller();
      else opts.signal?.addEventListener('abort', abortFromCaller, { once: true });
      try {
        let response: Response;
        try {
          response = await ky(url, {
            method,
            headers: { ...headers },
            searchParams: new URLSearchParams(search),
            json: opts.json,
            signal: requestController.signal,
            timeout: this.timeoutMs,
            retry: 0,
            throwHttpErrors: false,
            fetch: this.cfg.fetch,
          });
        } catch (err) {
          if (opts.signal?.aborted) throw callerCancellationError(opts.signal);
          if (err instanceof DOMException && err.name === 'TimeoutError') {
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
          if (opts.signal?.aborted) throw callerCancellationError(opts.signal);
          throw error;
        }
      } finally {
        opts.signal?.removeEventListener('abort', abortFromCaller);
      }
    };

    // Retry idempotent GETs by default; writes only when explicitly opted in; never when
    // `retry: false`.
    const wantsRetry = opts.retry !== false && (method === 'GET' || opts.retry !== undefined);
    return wantsRetry
      ? withRetry(run, typeof opts.retry === 'object' ? opts.retry : undefined, (ms) =>
          waitForRetry(ms, opts.signal),
        )
      : run();
  }

  /**
   * Streamed multipart upload via RN's raw `fetch` (not `ky`). We deliberately do NOT set a
   * Content-Type header — RN's networking fills in `multipart/form-data; boundary=…` and streams
   * the file part from disk, so a large video is never buffered. No timeout (uploads can run for
   * minutes) and no retry (a retried upload would double-send).
   */
  private async uploadMultipart<S extends z.ZodType>(
    method: string,
    path: string,
    url: string,
    headers: Readonly<Record<string, string>>,
    search: URLSearchParams,
    schema: S,
    opts: RequestOptions,
  ): Promise<z.infer<S>> {
    const qs = search.toString();
    const fullUrl = qs ? `${url}?${qs}` : url;
    const fetchImpl = this.cfg.fetch ?? fetch;
    const requestController = new AbortController();
    const abortFromCaller = (): void => requestController.abort(opts.signal?.reason);
    if (opts.signal?.aborted) abortFromCaller();
    else opts.signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      let response: Response;
      try {
        response = await fetchImpl(fullUrl, {
          method,
          headers: { ...headers },
          body: opts.form,
          signal: requestController.signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw callerCancellationError(opts.signal);
        // Development-only diagnosis. RN's network Error has no enumerable fields, so include its
        // cause/URL locally; release builds drop this free-form line before inspecting it.
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        logger.warn(`[http] multipart upload failed url=${fullUrl} err=${detail}`);
        throw new ApiError('no_connection', 'Upload request failed', undefined, err);
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
        if (opts.signal?.aborted) throw callerCancellationError(opts.signal);
        throw error;
      }
    } finally {
      opts.signal?.removeEventListener('abort', abortFromCaller);
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
    if (!response.ok) {
      let serverDetail: string | undefined;
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
          serverDetail = parseServerErrorDetailBody(errorBody);
        } catch {
          // Status classification remains authoritative for malformed, oversized, or stalled
          // untrusted error bodies. The bounded reader has already canceled failed reads.
        }
      } else {
        cancelResponseBody(response, 'HTTP error response is not consumed', cancelRequest);
      }
      throw ApiError.fromStatus(response.status, `${method} ${path} failed`, serverDetail);
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
