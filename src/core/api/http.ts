import ky from 'ky';
import type { z } from 'zod';
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

export interface HttpClientConfig {
  /** Current server origin, e.g. "https://abc.ngrok.io". May change on failover. */
  getOrigin: () => string;
  /** Server password (the legacy "guid"). Injected as a header, never the URL. */
  getPassword: () => string | undefined;
  /** Optional user-defined headers (ported from settings.customHeaders). */
  getCustomHeaders?: () => Record<string, string>;
  /**
   * When false, fall back to legacy `?guid=` query auth for old servers. Default
   * true. SECURITY: the rebuild gates setup on MIN_SERVER_VERSION so header auth
   * is the norm; legacy mode is permitted only over HTTPS and is logged.
   */
  useHeaderAuth?: () => boolean;
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to the platform fetch. */
  fetch?: typeof fetch;
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
   * Retry transient failures (dropped connection / timeout / 5xx) with backoff. Defaults ON for
   * GET (idempotent reads), OFF for writes — a retried POST could double-send (the outgoing-queue
   * owns send retries). Pass an explicit policy to opt a write in, or `false` to force a single
   * shot (e.g. a reachability ping that must fail fast). Never applied to multipart `form` uploads.
   */
  retry?: RetryPolicy | false;
}

/**
 * Thin typed wrapper over `ky`. The ONLY place credentials are attached is
 * {@link buildHeaders}/{@link buildSearch} — the analog of the Flutter app's
 * single `HttpService.buildQueryParams()` injection point, but moved to a header.
 */
export class HttpClient {
  constructor(private readonly cfg: HttpClientConfig) {}

  get<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    opts: RequestOptions = {},
  ): Promise<z.infer<S>> {
    return this.request('GET', path, schema, opts);
  }

  post<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    opts: RequestOptions = {},
  ): Promise<z.infer<S>> {
    return this.request('POST', path, schema, opts);
  }

  put<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    opts: RequestOptions = {},
  ): Promise<z.infer<S>> {
    return this.request('PUT', path, schema, opts);
  }

  delete<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    opts: RequestOptions = {},
  ): Promise<z.infer<S>> {
    return this.request('DELETE', path, schema, opts);
  }

  /** Full request URL for a path (without auth). Exposed for downloads/sockets. */
  buildUrl(path: string): string {
    const origin = this.cfg.getOrigin().replace(/\/+$/, '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${origin}${API_BASE_PATH}${cleanPath}`;
  }

  buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...TUNNEL_SKIP_HEADERS,
      ...(this.cfg.getCustomHeaders?.() ?? {}),
    };
    const password = this.cfg.getPassword();
    if (this.useHeaderAuth() && password) {
      headers[AUTH_HEADER] = `${AUTH_SCHEME} ${password}`;
    }
    return headers;
  }

  private buildSearch(query: RequestOptions['query']): URLSearchParams {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) search.set(k, String(v));
    }
    if (!this.useHeaderAuth()) {
      const password = this.cfg.getPassword();
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
   * Exposed so the socket transport can pick the SAME mode — keeping REST + socket
   * coherent (a stock/old server that only reads the query needs both in legacy mode).
   */
  usesHeaderAuth(): boolean {
    return this.useHeaderAuth();
  }

  private async request<S extends z.ZodTypeAny>(
    method: string,
    path: string,
    schema: S,
    opts: RequestOptions,
  ): Promise<z.infer<S>> {
    const url = this.buildUrl(path);
    const search = this.buildSearch(opts.query);

    // Multipart uploads take a SEPARATE path: RN's raw `fetch` streams a FormData file part from
    // disk, whereas `ky` mishandles React Native's FormData (its body/timeout machinery breaks the
    // native stream, surfacing as an opaque "connection refused"). Raw fetch also drops the 30s
    // timeout, which would otherwise kill a large video mid-upload. Never retried (double-send).
    if (opts.form) {
      return this.uploadMultipart(method, path, url, search, schema, opts);
    }

    // One full attempt: send, map transport/status/parse failures to a typed ApiError, return data.
    // Headers are rebuilt per attempt so a retry picks up a refreshed origin/password.
    const run = async (): Promise<z.infer<S>> => {
      let response: Response;
      try {
        response = await ky(url, {
          method,
          headers: this.buildHeaders(),
          searchParams: search,
          json: opts.json,
          signal: opts.signal,
          timeout: this.cfg.timeoutMs ?? 30_000,
          retry: 0,
          throwHttpErrors: false,
          fetch: this.cfg.fetch,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw new ApiError('timeout', 'Request timed out', undefined, err);
        }
        throw new ApiError('no_connection', 'Network request failed', undefined, err);
      }
      return this.parseResponse(response, method, path, schema);
    };

    // Retry idempotent GETs by default; writes only when explicitly opted in; never when
    // `retry: false`.
    const wantsRetry =
      opts.retry !== false && (method === 'GET' || opts.retry !== undefined);
    return wantsRetry ? withRetry(run, typeof opts.retry === 'object' ? opts.retry : undefined) : run();
  }

  /**
   * Streamed multipart upload via RN's raw `fetch` (not `ky`). We deliberately do NOT set a
   * Content-Type header — RN's networking fills in `multipart/form-data; boundary=…` and streams
   * the file part from disk, so a large video is never buffered. No timeout (uploads can run for
   * minutes) and no retry (a retried upload would double-send).
   */
  private async uploadMultipart<S extends z.ZodTypeAny>(
    method: string,
    path: string,
    url: string,
    search: URLSearchParams,
    schema: S,
    opts: RequestOptions,
  ): Promise<z.infer<S>> {
    const qs = search.toString();
    const fullUrl = qs ? `${url}?${qs}` : url;
    const fetchImpl = this.cfg.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(fullUrl, {
        method,
        headers: this.buildHeaders(),
        body: opts.form,
        signal: opts.signal,
      });
    } catch (err) {
      // Log the REAL native cause inline (RN's "Network request failed" Error has no enumerable
      // fields, so logging it as an object yields `{}`). Include the URL for context.
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      logger.warn(`[http] multipart upload failed url=${fullUrl} err=${detail}`);
      throw new ApiError('no_connection', 'Upload request failed', undefined, err);
    }
    return this.parseResponse(response, method, path, schema);
  }

  /** Shared response handling: status check → JSON parse → envelope/schema validation. */
  private async parseResponse<S extends z.ZodTypeAny>(
    response: Response,
    method: string,
    path: string,
    schema: S,
  ): Promise<z.infer<S>> {
    if (!response.ok) {
      throw ApiError.fromStatus(response.status, `${method} ${path} failed`);
    }
    let body: unknown;
    try {
      body = await response.json();
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
    return parsed.data.data;
  }
}
