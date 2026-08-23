import { useLayoutEffect, useState } from 'react';
import { attachmentCacheCoordinator } from '@/services/download/attachmentCacheCoordinator';
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
 * Cleanup is identity-checked by the coordinator, so a recycled row can release its old path
 * without removing a newer component's protection for that same file.
 */
export function useAttachmentCachePathProtection(path: string | null | undefined): string | null {
  const localPath = isLocalFileUri(path) ? path : null;
  const [protectedPath, setProtectedPath] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!localPath) {
      // This synchronous layout-effect update is the safety gate: clearing it before paint keeps a
      // previously protected URI from being reused if the component later cycles back to it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProtectedPath(null);
      return;
    }

    let protection: ReturnType<typeof attachmentCacheCoordinator.protect> = null;
    try {
      protection = attachmentCacheCoordinator.protect(localPath);
    } catch {
      // Malformed or overlong persisted paths are untrusted input. Fail closed instead of taking
      // down the whole message list while trying to protect one attachment.
    }
    // Deliberately re-render before paint only after the external cache protection is established.
    setProtectedPath(protection ? localPath : null);
    return () => protection?.release();
  }, [localPath]);

  if (!path) return null;
  if (!localPath) return path;
  // A prop change renders before the old layout-effect cleanup. Comparing identities prevents the
  // newly requested path from borrowing the previous path's still-live protection for one commit.
  return protectedPath === localPath ? protectedPath : null;
}
