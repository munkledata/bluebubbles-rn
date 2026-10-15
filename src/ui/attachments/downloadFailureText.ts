import type { DownloadFailureReason } from '@state/downloadStore';

/** Short, user-facing text for a download failure the owner can act on; null means generic. */
export function downloadFailureText(reason: DownloadFailureReason | undefined): string | null {
  if (reason === 'too-large') return 'Too large to download';
  if (reason === 'storage-full') return 'Not enough storage';
  return null;
}
