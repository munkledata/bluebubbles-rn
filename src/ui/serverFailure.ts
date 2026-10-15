import { ApiError } from '@core/api/errors';

/**
 * Plain classification of a failed server request for user copy: the Mac could not be reached,
 * it answered and refused, or the cause is unknown (cancelled, local, or not a request failure).
 */
export function serverFailureKind(error: unknown): 'unreachable' | 'rejected' | 'unknown' {
  if (!(error instanceof ApiError)) return 'unknown';
  if (error.kind === 'no_connection' || error.kind === 'timeout') return 'unreachable';
  if (
    error.kind === 'bad_request' ||
    error.kind === 'server_error' ||
    error.kind === 'unauthorized' ||
    error.kind === 'parse_error'
  ) {
    return 'rejected';
  }
  return 'unknown';
}
