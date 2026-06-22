/** Error categories mirroring the Flutter app's MessageError enum. */
export type ApiErrorKind =
  | 'no_connection'
  | 'timeout'
  | 'unauthorized'
  | 'bad_request'
  | 'server_error'
  | 'parse_error';

export class ApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static fromStatus(status: number, message?: string): ApiError {
    if (status === 401 || status === 403)
      return new ApiError('unauthorized', message ?? 'Unauthorized', status);
    if (status >= 500) return new ApiError('server_error', message ?? 'Server error', status);
    if (status >= 400) return new ApiError('bad_request', message ?? 'Bad request', status);
    return new ApiError('server_error', message ?? `Unexpected status ${status}`, status);
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
