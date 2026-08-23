import { logger } from '@core/secure';
import type { SharedAttachment } from '@state/shareIntentStore';
import type { ShareSource } from './shareIntentPayload';

/**
 * Historical, dormant JS materialization logic. No production native binding calls this module
 * while IPC-01 is fail-closed: its `copy` interface cannot observe/cancel bytes as they stream and
 * therefore cannot provide the required hard size/deadline guarantees by itself.
 *
 * WHY THIS MUST HAPPEN AT CAPTURE TIME, NOT AT SEND TIME: Android's `FLAG_GRANT_READ_URI_PERMISSION`
 * is a TRANSIENT grant scoped to the receiving task. A staged attachment can sit in the composer
 * for minutes across background/foreground cycles, and `sendAttachmentService` writes the staged
 * path into the `attachments` row as `localPath` — which `runOutgoingQueue` re-streams on later
 * drains, including after an app restart. A `content://` uri parked there is permanently
 * unreadable. Copying the instant the share arrives is the only way that path stays valid.
 *
 * All filesystem access is INJECTED ({@link ShareFileIO}) — same pattern as `OutgoingQueueIO` —
 * so the logic runs in the node jest project with no expo/native imports.
 */

/** Injected only by tests; the former production `shareFileIo.ts` binding was removed. */
export interface ShareFileIO {
  /** Create a directory (and parents); must not throw when it already exists. */
  makeDir: (dirUri: string) => Promise<void>;
  /** Copy `from` (may be `content://`) to `to` (always an app-private `file://`). */
  copy: (from: string, to: string) => Promise<void>;
  stat: (uri: string) => Promise<{ exists: boolean; size: number }>;
  /** Entry NAMES (not uris) directly inside a directory; `[]` when unreadable. */
  listDir: (dirUri: string) => Promise<string[]>;
  /** Delete a file or directory; must not throw when it's already gone. */
  remove: (uri: string) => Promise<void>;
}

export interface MaterializeResult {
  files: SharedAttachment[];
  /** How many sources could not be made readable — drives the "couldn't read that" toast. */
  failed: number;
}

/** Keep two files shared in the same batch from colliding on one display name. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 100; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const fallback = `${stem}-${taken.size}${ext}`;
  taken.add(fallback);
  return fallback;
}

/**
 * Copy every source into `<cacheRoot><now>/`, verifying each landed.
 *
 * One batch directory per share keeps names from colliding across shares and makes pruning a
 * pure numeric comparison on the directory name (no modification-time round trip, so the whole
 * thing stays node-testable).
 *
 * A failing file is logged and skipped — the rest of the batch still stages.
 */
export async function materializeSharedFiles(args: {
  sources: ShareSource[];
  /** Directory holding the per-share batch dirs. MUST end with a slash. */
  cacheRoot: string;
  io: ShareFileIO;
  now: number;
}): Promise<MaterializeResult> {
  const { sources, cacheRoot, io, now } = args;
  if (sources.length === 0) return { files: [], failed: 0 };

  const files: SharedAttachment[] = [];
  let failed = 0;
  const taken = new Set<string>();
  const batchDir = `${cacheRoot}${now}/`;
  let batchDirReady = false;

  for (const source of sources) {
    try {
      // Already inside our own storage (the library's own cache copy — the path photos and
      // videos take today). Re-copying would duplicate a huge video for nothing.
      if (source.alreadyLocal) {
        const info = await io.stat(source.sourceUri);
        if (info.exists && info.size > 0) {
          files.push({
            uri: source.sourceUri,
            name: source.fileName,
            mimeType: source.mimeType,
            size: info.size,
          });
        } else {
          failed += 1;
          logger.warn(`[share] local source missing or empty (${source.mimeType})`);
        }
        continue;
      }

      if (!batchDirReady) {
        await io.makeDir(batchDir);
        batchDirReady = true;
      }
      const dest = `${batchDir}${uniqueName(source.fileName, taken)}`;
      await io.copy(source.sourceUri, dest);

      // MANDATORY re-stat: expo-file-system's SAF copy branch silently no-ops when the provider
      // reports no display name (it resolves without writing anything), so a resolved promise is
      // NOT proof the file exists. The provider's reported size is not trusted either.
      const info = await io.stat(dest);
      if (!info.exists || info.size === 0) {
        failed += 1;
        logger.warn(`[share] copy produced no file (${source.mimeType}) — dropping`);
        continue;
      }
      files.push({
        uri: dest,
        name: source.fileName,
        mimeType: source.mimeType,
        size: info.size,
      });
    } catch (err) {
      failed += 1;
      logger.warn(
        `[share] could not materialize a shared file (${source.mimeType}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return { files, failed };
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete batch directories older than `maxAgeMs` (plus anything whose name isn't a timestamp).
 * Best-effort housekeeping — never throws, never blocks the share.
 */
export async function pruneShareCache(args: {
  cacheRoot: string;
  io: ShareFileIO;
  now: number;
  maxAgeMs?: number;
}): Promise<number> {
  const { cacheRoot, io, now } = args;
  const maxAgeMs = args.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  let removed = 0;
  try {
    const names = await io.listDir(cacheRoot);
    for (const name of names) {
      const stamp = Number(name);
      const stale = !Number.isFinite(stamp) || stamp < now - maxAgeMs;
      if (!stale) continue;
      try {
        await io.remove(`${cacheRoot}${name}`);
        removed += 1;
      } catch {
        // A file we can't delete is not worth failing a share over.
      }
    }
  } catch {
    // The directory may not exist yet — nothing to prune.
  }
  return removed;
}
