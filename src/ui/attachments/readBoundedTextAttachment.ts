import { File } from 'expo-file-system';

/**
 * Contact/location cards are tiny text documents in normal use. Keep their inline parser far
 * below the manual attachment-download ceiling so a hostile server cannot make React Native load
 * hundreds of megabytes into the JavaScript heap merely by labelling a file as a vCard.
 */
export const MAX_INLINE_TEXT_ATTACHMENT_BYTES = 1024 * 1024; // 1 MiB

export async function readBoundedTextAttachment(path: string): Promise<string> {
  const file = new File(path);
  const bytes = file.size;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_INLINE_TEXT_ATTACHMENT_BYTES) {
    throw new Error('inline text attachment exceeds the safe parsing limit');
  }
  return file.text();
}
