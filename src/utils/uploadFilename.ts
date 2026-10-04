import { utf8Encode } from './bytes';

/** Match the native multipart bound; never change a selected file's name silently. */
export function assertSafeUploadFilename(name: string): void {
  if (
    name.length === 0 ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    // Quotes would be percent-escaped by OkHttp, changing the name the server receives.
    /[\u0000-\u001f\u007f-\u009f/\\"]/u.test(name) ||
    // With the Unicode flag this matches only unpaired surrogate code units.
    /[\ud800-\udfff]/u.test(name) ||
    utf8Encode(name).byteLength > 255
  ) {
    throw new Error('Choose a file with a valid name of at most 255 UTF-8 bytes.');
  }
}
