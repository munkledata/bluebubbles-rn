import { ApiError } from '@core/api/errors';
import { serverFailureKind } from '@ui/serverFailure';

describe('serverFailureKind', () => {
  it.each([
    ['no_connection', 'unreachable'],
    ['timeout', 'unreachable'],
    ['bad_request', 'rejected'],
    ['server_error', 'rejected'],
    ['unauthorized', 'rejected'],
    ['parse_error', 'rejected'],
    ['cancelled', 'unknown'],
    ['local_file', 'unknown'],
  ] as const)('maps a %s request failure to %s', (kind, expected) => {
    expect(serverFailureKind(new ApiError(kind, 'request failed'))).toBe(expected);
  });

  it('treats anything that is not a request failure as unknown', () => {
    expect(serverFailureKind(new TypeError('boom'))).toBe('unknown');
    expect(serverFailureKind('nope')).toBe('unknown');
  });
});
