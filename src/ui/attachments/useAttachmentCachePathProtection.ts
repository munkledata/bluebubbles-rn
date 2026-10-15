import { useLayoutEffect, useState } from 'react';
import { attachmentCacheCoordinator } from '@/services/download/attachmentCacheCoordinator';
import { recordAttachmentCacheView } from '@/services/download/attachmentCacheViews';
import { isLocalFileUri } from '@utils';

/**
 * Keep a mounted cache-backed attachment out of LRU retirement while native UI may read it.
 *
 * A local path is returned only after `protect()` succeeds. The first render therefore hands
 * native children `null`; the layout effect acquires the synchronous pin and immediately triggers
 * the safe render before paint. If retirement already owns the path, it stays `null` and no native
 * image/video/file reader can race the unlink. Remote URLs are not owned by this cache and pass
 * through unchanged.
 *
 * A refused pin (retirement briefly owns the path) is retried on its own every
 * {@link REFUSED_PIN_RETRY_MS} until it lands or the row changes, so a short refusal never leaves a
 * blank bubble. `refreshKey` lets a caller retry at once after an explicit recovery attempt returns
 * the same path string.
 *
 * Cleanup is identity-checked by the coordinator, so a recycled row can release its old path
 * without removing a newer component's protection for that same file.
 *
 * A successful pin also records the view (throttled, best effort), so least-recently-used storage
 * cleanup counts files people look at, not only when they downloaded.
 */
export const REFUSED_PIN_RETRY_MS = 500;

export function useAttachmentCachePathProtection(
  path: string | null | undefined,
  refreshKey = 0,
): string | null {
  const localPath = isLocalFileUri(path) ? path : null;
  const [protectedPath, setProtectedPath] = useState<string | null>(null);
  const [refusalRetry, setRefusalRetry] = useState(0);

  useLayoutEffect(() => {
    if (!localPath) {
      // This synchronous layout-effect update is the safety gate: clearing it before paint keeps a
      // previously protected URI from being reused if the component later cycles back to it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProtectedPath(null);
      return;
    }

    let protection: ReturnType<typeof attachmentCacheCoordinator.protect> = null;
    let untrusted = false;
    try {
      protection = attachmentCacheCoordinator.protect(localPath);
    } catch {
      // Malformed or overlong persisted paths are untrusted input. Fail closed instead of taking
      // down the whole message list while trying to protect one attachment.
      untrusted = true;
    }
    // Deliberately re-render before paint only after the external cache protection is established.
    setProtectedPath(protection ? localPath : null);
    const pin = protection;
    if (pin) {
      void recordAttachmentCacheView(localPath);
      return () => pin.release();
    }
    if (untrusted) return undefined;
    // Retirement owns the path for now. Try again shortly: the pin lands once retirement lets go,
    // or the row changes (its file was removed) and this effect re-runs for the new path.
    const timer = setTimeout(() => setRefusalRetry((attempt) => attempt + 1), REFUSED_PIN_RETRY_MS);
    return () => clearTimeout(timer);
  }, [localPath, refreshKey, refusalRetry]);

  if (!path) return null;
  if (!localPath) return path;
  // A prop change renders before the old layout-effect cleanup. Comparing identities prevents the
  // newly requested path from borrowing the previous path's still-live protection for one commit.
  return protectedPath === localPath ? protectedPath : null;
}
