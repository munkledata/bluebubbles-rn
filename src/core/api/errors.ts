/**
 * Error categories mirroring the Flutter app's MessageError enum.
 *
 * `local_file` is ours, not Flutter's: an attachment upload can fail because the file on THIS
 * device is gone/unreadable (a share-sheet uri whose grant lapsed, an evicted cache entry),
 * which has nothing to do with the network. Without it every such failure collapsed into
 * `no_connection` and the bubble read "Connection Refused" — pointing the user at their server
 * instead of at the file.
 *
 * `cancelled` is ours too, and exists for the same reason: a user-cancelled attachment upload
 * resolves with no response at all, which is indistinguishable from a dead network unless it is
 * named. Without it, cancelling your own upload reported "Connection Refused".
 */
export type ApiErrorKind =
  | 'no_connection'
  | 'timeout'
  | 'unauthorized'
  | 'bad_request'
  | 'server_error'
  | 'parse_error'
  | 'local_file'
  | 'cancelled';

export class ApiError extends Error {
  /**
   * Sanitized, bounded server prose suitable only for the failed-message detail UI.
   * Installed as non-enumerable so generic Error serialization cannot copy it into diagnostics.
   */
  public readonly serverDetail?: string;

  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
    serverDetail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    Object.defineProperty(this, 'serverDetail', {
      value: serverDetail,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  static fromStatus(status: number, message?: string, serverDetail?: string): ApiError {
    if (status === 401 || status === 403)
      return new ApiError(
        'unauthorized',
        message ?? 'Unauthorized',
        status,
        undefined,
        serverDetail,
      );
    if (status >= 500)
      return new ApiError(
        'server_error',
        message ?? 'Server error',
        status,
        undefined,
        serverDetail,
      );
    if (status >= 400)
      return new ApiError('bad_request', message ?? 'Bad request', status, undefined, serverDetail);
    return new ApiError(
      'server_error',
      message ?? `Unexpected status ${status}`,
      status,
      undefined,
      serverDetail,
    );
  }
}

/**
 * Thrown by endpoint wrappers whose server route the Gator server does NOT implement (would
 * 404). Distinct from a connection error so callers can show "unsupported on this server"
 * (and hide/disable the action) instead of a misleading "check your connection" message.
 */
export class UnimplementedEndpointError extends Error {
  constructor(public readonly endpoint: string) {
    super(`Endpoint not implemented on this server: ${endpoint}`);
    this.name = 'UnimplementedEndpointError';
  }
}

/** True if `e` is an {@link UnimplementedEndpointError} (route not supported by the server). */
export function isUnimplementedEndpoint(e: unknown): e is UnimplementedEndpointError {
  return e instanceof UnimplementedEndpointError;
}
