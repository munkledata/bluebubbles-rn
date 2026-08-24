import { logger } from '@core/secure';
import { isLocalFileUri } from '@utils';

/**
 * Opening a downloaded attachment in another app.
 *
 * WHY THIS MODULE EXISTS: downloaded attachments live at
 * `file:///data/user/0/<pkg>/files/attachments/<guid>/<name>` — an app-PRIVATE path. Android
 * forbids handing a `file://` uri to another app (`FileUriExposedException`, API 24+) and no
 * other app can read that directory anyway, so the previous implementation
 * (`void safeOpenUrl(att.localPath)`) could never work: the native throw was swallowed by
 * `safeOpenUrl`'s catch, the returned `false` was discarded by `void`, and tapping a received
 * PDF did nothing at all, silently. `file` has since been removed from `safeOpenUrl`'s scheme
 * allowlist so that shape of bug cannot come back.
 *
 * THE TWO FILE APIS WANT OPPOSITE URI KINDS — this is the easy, silent mistake here:
 *  - `ACTION_VIEW` (expo-intent-launcher) needs a `content://` FileProvider uri.
 *  - `expo-sharing` needs the `file://` path (its native side rejects any other scheme and
 *    builds its own content uri through its own provider).
 * The node tests assert both directions.
 *
 * Every native module is imported LAZILY inside the function, so this module stays importable
 * in the React-free ts-jest project and adds nothing to any startup path.
 */

export type OpenFileStatus = 'opened' | 'shared' | 'missing' | 'no_handler' | 'stale' | 'error';

export interface OpenFileResult {
  status: OpenFileStatus;
}

interface OpenFileOptions {
  /**
   * How long to wait for a *fast* rejection before treating the launch as successful.
   * `startActivityAsync` only RESOLVES when the user returns from the viewer, so success is
   * read from the ABSENCE of an early rejection rather than from resolution. Tests pass a few ms.
   */
  settleMs?: number;
  /** Original route/account ownership, rechecked before every external native launch. */
  isCurrent?: () => boolean;
}

/**
 * The `type` to put on the VIEW intent, or `undefined` to let Android infer it.
 *
 * Omitting `type` makes Android resolve via `ContentResolver.getType()`, i.e. FileProvider's
 * extension-based `MimeTypeMap` lookup — which is usually BETTER than the generic
 * `application/octet-stream` the server sometimes reports, because an `octet-stream` intent
 * matches almost no viewer.
 */
export function resolveViewType(mimeType: string | null | undefined): string | undefined {
  if (!mimeType) return undefined;
  const m = mimeType.trim().toLowerCase();
  if (!m || m === 'application/octet-stream' || m === '*/*') return undefined;
  return m;
}

/** FLAG_GRANT_READ_URI_PERMISSION — the receiving app needs it to read our provider uri. */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

/**
 * Resolve the app-private `file://` path to a shareable `content://` uri.
 *
 * Tries the SDK 57 `File.contentUri` property first, then the legacy async call. Both go
 * through the same `<pkg>.FileSystemFileProvider` authority; the second attempt exists because
 * `contentUri` is a native Property, so on a build compiled against an older expo-file-system
 * it would silently be `undefined` — and a dataless VIEW intent fails in a way that looks like
 * "no app can open this".
 */
async function resolveContentUri(
  localPath: string,
  isCurrent: () => boolean,
): Promise<string | null> {
  if (!isCurrent()) return null;
  try {
    const { File } = await import('expo-file-system');
    if (!isCurrent()) return null;
    const direct: unknown = new File(localPath).contentUri;
    if (typeof direct === 'string' && direct.startsWith('content://')) return direct;
  } catch (e) {
    if (!isCurrent()) return null;
    logger.warn('[openFile] File.contentUri unavailable, trying the legacy resolver', e);
  }
  if (!isCurrent()) return null;
  try {
    const legacy = await import('expo-file-system/legacy');
    if (!isCurrent()) return null;
    const uri = await legacy.getContentUriAsync(localPath);
    if (!isCurrent()) return null;
    if (typeof uri === 'string' && uri.startsWith('content://')) return uri;
  } catch (e) {
    if (!isCurrent()) return null;
    logger.warn('[openFile] legacy getContentUriAsync failed', e);
  }
  return null;
}

/**
 * Open a downloaded attachment in whatever app the user has for it.
 *
 * Returns a status the CALLER MUST CONSUME — that is the whole point of this module. A discarded
 * rich result is what made the fullscreen viewer's save button look dead (see
 * `app/(app)/media/[guid].tsx`), and the same mistake here made every received document
 * un-openable. `void openAttachmentFile(...)` reintroduces the bug in a new shape.
 *
 * - `opened`     — a viewer took the intent.
 * - `shared`     — no viewer, but the share sheet opened (the user can pick a target).
 * - `missing`    — the local file is gone or the path was never a local file; caller should re-download.
 * - `no_handler` — nothing could open or share it.
 * - `stale`      — the route/account that requested the open retired before native launch.
 * - `error`      — unexpected failure, already logged.
 */
export async function openAttachmentFile(
  localPath: string | null | undefined,
  mimeType?: string | null,
  opts?: OpenFileOptions,
): Promise<OpenFileResult> {
  const isCurrent = opts?.isCurrent ?? (() => true);
  try {
    if (!isCurrent()) return { status: 'stale' };
    // Not a local file at all (null, or an http/content uri) — nothing to open from disk.
    if (!isLocalFileUri(localPath)) return { status: 'missing' };

    // A wiped cache is the common case; reporting `missing` is what lets the chip re-download
    // instead of showing an error the user can do nothing about.
    try {
      const { File } = await import('expo-file-system');
      if (!isCurrent()) return { status: 'stale' };
      if (!new File(localPath).exists) return { status: 'missing' };
    } catch (e) {
      if (!isCurrent()) return { status: 'stale' };
      logger.warn('[openFile] could not stat the attachment, treating it as missing', e);
      return { status: 'missing' };
    }

    const contentUri = await resolveContentUri(localPath, isCurrent);
    if (!isCurrent()) return { status: 'stale' };

    if (contentUri) {
      const IntentLauncher = await import('expo-intent-launcher');
      if (!isCurrent()) return { status: 'stale' };
      const launch = IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        type: resolveViewType(mimeType),
        flags: FLAG_GRANT_READ_URI_PERMISSION,
      });
      // Success is the ABSENCE of a fast rejection. `startActivityAsync` resolves only when the
      // user comes BACK from the viewer, so awaiting it would hang for as long as the PDF is
      // open (and hold the caller's in-flight guard). An ActivityNotFoundException, by contrast,
      // rejects within one bridge hop. The `.then(ok, err)` form means a later rejection is
      // still handled and never becomes an unhandled rejection.
      const failure = await Promise.race([
        launch.then(
          () => null,
          (e: unknown) => e ?? new Error('view rejected'),
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), opts?.settleMs ?? 600)),
      ]);
      if (!isCurrent()) return { status: 'stale' };
      if (!failure) return { status: 'opened' };
      logger.warn(
        '[openFile] no viewer for this attachment, falling back to the share sheet',
        failure,
      );
    }

    // Share fallback. NOTE: the FILE path goes here, never the content uri — expo-sharing
    // rejects anything whose scheme is not `file`.
    const { shareAttachment } = await import('@/services/media');
    if (!isCurrent()) return { status: 'stale' };
    const res = await shareAttachment(localPath, mimeType, isCurrent);
    if (!isCurrent() || (!res.ok && res.reason === 'stale')) return { status: 'stale' };
    return { status: res.ok ? 'shared' : 'no_handler' };
  } catch (e) {
    if (!isCurrent()) return { status: 'stale' };
    // `error`, not `warn`: only error-level lines reach ErrorReportSink, and this failure is
    // otherwise invisible to us.
    logger.error('[openFile] failed to open attachment', e);
    return { status: 'error' };
  }
}
