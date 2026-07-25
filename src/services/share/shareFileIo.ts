import * as FileSystem from 'expo-file-system/legacy';
import type { ShareFileIO } from './materializeShare';

/**
 * The ONLY file in `src/services/share/` that touches expo — everything else stays node-testable.
 *
 * Uses the LEGACY expo-file-system API on purpose. Its `copyAsync` passes the source string to
 * native untouched, so a `content://` uri survives verbatim (the native side resolves it through
 * `ContentResolver`/SAF). The modern `File` API instead round-trips the uri through `Paths.join`
 * → `new URL(...)`, which re-encodes a non-special scheme and mangles it.
 */

/** Per-share batch directories live here. */
const SHARE_DIR = 'shared-in/';

function withTrailingSlash(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`;
}

/** `<cache>/shared-in/` — app-private, OS-evictable. `''` when there is no cache directory. */
export function shareCacheRoot(): string {
  const cache = FileSystem.cacheDirectory;
  return cache ? `${withTrailingSlash(cache)}${SHARE_DIR}` : '';
}

/**
 * BARE paths (scheme stripped) the app can already read directly. A shared file whose resolved
 * path is under one of these is the share library's own cache copy — reusable as-is, which is
 * what keeps a large shared video from being copied a second time.
 */
export function appPrivateRoots(): string[] {
  return [FileSystem.cacheDirectory, FileSystem.documentDirectory]
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .map((d) => d.replace(/^file:\/\//, ''));
}

export const expoShareFileIO: ShareFileIO = {
  makeDir: async (dirUri) => {
    try {
      await FileSystem.makeDirectoryAsync(dirUri, { intermediates: true });
    } catch {
      // Already exists — `intermediates` makes this idempotent on most paths, but not all.
    }
  },
  copy: (from, to) => FileSystem.copyAsync({ from, to }),
  stat: async (uri) => {
    try {
      const info = await FileSystem.getInfoAsync(uri);
      return info.exists ? { exists: true, size: info.size ?? 0 } : { exists: false, size: 0 };
    } catch {
      return { exists: false, size: 0 };
    }
  },
  listDir: async (dirUri) => {
    try {
      return await FileSystem.readDirectoryAsync(dirUri);
    } catch {
      return [];
    }
  },
  remove: async (uri) => {
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch {
      // Best-effort housekeeping.
    }
  },
};
