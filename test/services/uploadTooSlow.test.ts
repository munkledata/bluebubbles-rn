import { ApiError } from '@core/api/errors';
import { isPreDispatchOneShotRejection } from '@/services/send/sendOutcome';
import {
  ClientErrorCode,
  errorHintForCode,
  errorTitleForCode,
  UPLOAD_TOO_SLOW_HINT,
} from '@utils/messageStatus';

describe('a large upload stopped at the server deadline', () => {
  // bbd answers 503 "upload_timeout" (retryable, nothing sent) when a body does not finish in time.
  const timedOut = ApiError.fromStatus(503, 'Upload timed out', undefined, 'upload_timeout');

  it('is a refusal before anything reached Messages, never "may have been delivered"', () => {
    expect(isPreDispatchOneShotRejection(timedOut)).toBe(true);
  });

  it('is not confused with another 503', () => {
    expect(
      isPreDispatchOneShotRejection(ApiError.fromStatus(503, 'x', undefined, 'something_else')),
    ).toBe(false);
  });

  it('names what happened and tells the person what to do', () => {
    expect(errorTitleForCode(ClientErrorCode.uploadTooSlow, 'iMessage')).toBe(
      'Upload Took Too Long',
    );
    expect(errorHintForCode(ClientErrorCode.uploadTooSlow)).toBe(UPLOAD_TOO_SLOW_HINT);
    expect(UPLOAD_TOO_SLOW_HINT).toMatch(/Nothing was sent/);
    expect(UPLOAD_TOO_SLOW_HINT).toMatch(/Wi-Fi/);
  });
});
