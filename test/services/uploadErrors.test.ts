/**
 * Classifying an attachment-upload throw (src/services/send/uploadErrors.ts).
 *
 * expo-file-system's native uploader raises a plain IOException for BOTH a dead network and an
 * unreadable local file, so without this every share-sheet file problem rendered as the bubble
 * label "Connection Refused" — blaming the server for a missing file.
 */
import { ApiError } from '@core/api/errors';
import { isLocalFileFailure } from '@/services/send/uploadErrors';

describe('isLocalFileFailure', () => {
  it.each([
    // The exact wording expo-file-system's Android module produces.
    "Directory for 'file:///document/acc=1' doesn't exist.",
    "Location 'file:///storage/emulated/0/Download/bill.pdf' isn't readable.",
    "Unsupported scheme for location 'content://x/1'.",
    'ENOENT: no such file or directory',
    'EACCES: permission denied',
    'java.io.FileNotFoundException: open failed',
  ])('is true for a local file error: %s', (message) => {
    expect(isLocalFileFailure(new Error(message))).toBe(true);
  });

  it.each([
    'Network request failed',
    'Software caused connection abort',
    'timeout of 30000ms exceeded',
    'Unable to resolve host "gator.example.com"',
  ])('is false for a network error: %s', (message) => {
    expect(isLocalFileFailure(new Error(message))).toBe(false);
  });

  it('is false for a server-side ApiError', () => {
    expect(isLocalFileFailure(new ApiError('server_error', 'Server error', 500))).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}]])('does not throw on a non-Error value (%p)', (v) => {
    expect(() => isLocalFileFailure(v)).not.toThrow();
    expect(isLocalFileFailure(v)).toBe(false);
  });

  it('reads a bare string throw', () => {
    expect(isLocalFileFailure("Location 'x' isn't readable.")).toBe(true);
  });
});
