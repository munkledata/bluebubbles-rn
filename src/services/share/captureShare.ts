import { logger } from '@core/secure';
import type { SharedAttachment } from '@state/shareIntentStore';
import { materializeSharedFiles, pruneShareCache, type ShareFileIO } from './materializeShare';
import { parseRawShareEvent } from './shareIntentPayload';

/**
 * Orchestrates one incoming share: parse the raw native payload → copy the files somewhere we can
 * actually read → stage them for the composer → clear the native intent.
 *
 * Pure + fully injected so the whole sequence (including the ORDER of staging vs clearing) is
 * asserted in the node jest project. The production binding lives in `index.ts`.
 */

export interface ShareCaptureDeps {
  io: ShareFileIO;
  /** Directory holding per-share batch dirs; `''` when the platform exposes no cache dir. */
  cacheRoot: string;
  /** Bare paths already readable by the app (expo cache + document dirs). */
  privateRoots: string[];
  /** Drop the native singleton so the same share can't re-fire on the next foreground. */
  clearNativeIntent: () => void;
  stage: (payload: { text: string | null; files: SharedAttachment[] }) => void;
  toast: (message: string) => void;
  now: () => number;
}

/**
 * Build the `onChange` handler. The returned function NEVER rejects — it is called from an event
 * listener where an unhandled rejection would be invisible, which is exactly the silence this
 * whole change set exists to remove.
 */
export function createShareCapture(deps: ShareCaptureDeps): (rawValue: unknown) => Promise<void> {
  return async function captureShare(rawValue: unknown): Promise<void> {
    try {
      const now = deps.now();
      const { text, files: sources } = parseRawShareEvent(rawValue, {
        privateRoots: deps.privateRoots,
        now,
      });

      if (!text && sources.length === 0) {
        logger.warn('[share] received a share with no usable text or files');
        deps.clearNativeIntent();
        return;
      }

      // Text/URL only — nothing to copy, so don't pay the latency.
      if (sources.length === 0) {
        logger.debug('[share] captured text');
        deps.stage({ text, files: [] });
        deps.clearNativeIntent();
        return;
      }

      if (deps.cacheRoot.length === 0) {
        logger.error('[share] no cache directory available — cannot accept shared files');
        deps.toast("Couldn't read that file.");
        deps.clearNativeIntent();
        return;
      }

      const { files, failed } = await materializeSharedFiles({
        sources,
        cacheRoot: deps.cacheRoot,
        io: deps.io,
        now,
      });

      if (files.length === 0) {
        // Staging nothing keeps ShareIntentNavigator from routing to an empty composer.
        logger.error(`[share] all ${failed} shared file(s) were unreadable`);
        deps.toast("Couldn't read that file. Try sharing it again.");
        deps.clearNativeIntent();
        return;
      }

      logger.debug(`[share] captured ${files.length} file(s)${text ? ' + text' : ''}`);
      // Stage BEFORE clearing: the navigator watches the store, and clearing the native intent
      // is only safe once the payload is somewhere durable.
      deps.stage({ text, files });
      deps.clearNativeIntent();
      if (failed > 0) {
        logger.warn(`[share] ${failed} shared file(s) could not be read`);
        deps.toast(`Couldn't read ${failed} of ${files.length + failed} files.`);
      }

      // Housekeeping, deliberately not awaited.
      void pruneShareCache({ cacheRoot: deps.cacheRoot, io: deps.io, now }).catch(() => {});
    } catch (err) {
      // Belt and braces: a throw here would be the silent failure all over again.
      logger.error(
        `[share] capture failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
      try {
        deps.clearNativeIntent();
      } catch {
        // nothing left to do
      }
    }
  };
}
