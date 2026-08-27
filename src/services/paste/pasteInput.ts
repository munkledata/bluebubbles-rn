import { requireOptionalNativeModule } from 'expo';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import { listPastedAttachmentProtectionPaths } from '@db/repositories';
import type { SharedAttachment } from '@state/shareIntentStore';
import { parsePasteEvent } from './pastePayload';

/**
 * Bridge to the `GatorPasteInput` native module (`modules/gator-paste-input/`), which lets the
 * chat composer accept pasted pictures and files.
 *
 * Every native call goes through `requireOptionalNativeModule`: on a JS bundle running against a
 * build that hasn't linked the module yet (i.e. before the next native rebuild), or under Jest,
 * the lookup returns null and everything here is a safe no-op — the composer just keeps its
 * current text-only paste behaviour instead of crashing. Same pattern as `shareShortcuts.ts`.
 *
 * The native side does the file copying (the pasted uri's read grant is transient — see
 * `pastePayload.ts`), so all that arrives here is a list of app-private `file://` paths.
 */

interface PasteSubscription {
  remove: () => void;
}

interface GatorPasteInputNative {
  /** Register the receive-content listener on the input with this React tag. */
  attach: (tag: number, protectedUris: string[]) => Promise<void>;
  detach: (tag: number) => Promise<void>;
  addListener: (event: 'onPaste', listener: (payload: unknown) => void) => PasteSubscription;
}

/** Guarded so a build without the native module (pre-rebuild) or Jest just gets null → no-ops. */
function getNative(): GatorPasteInputNative | null {
  try {
    return requireOptionalNativeModule<GatorPasteInputNative>('GatorPasteInput');
  } catch {
    return null;
  }
}

/** True when the running build can actually accept pasted files. */
export function isPasteInputAvailable(): boolean {
  return getNative() != null;
}

export interface PasteResult {
  files: SharedAttachment[];
  /** Entries the native side sent that turned out to be unusable. */
  dropped: number;
}

type PasteProtectionLoader = () => Promise<string[]>;

async function loadPastedAttachmentProtectionPaths(): Promise<string[]> {
  const snapshot = await listPastedAttachmentProtectionPaths(getDatabase());
  if (snapshot.status !== 'complete') {
    throw new Error('Pasted attachment protection snapshot is incomplete.');
  }
  return snapshot.paths;
}

/**
 * Start accepting pasted files on the text input with the given React tag; returns an unsubscribe.
 *
 * `tag` must come from `findNodeHandle(ref)` and be called once the view actually exists natively
 * (an `onLayout`, not a mount effect) — the native lookup resolves through the UIManager's
 * mounting layer and simply finds nothing if the Fabric mount hasn't landed yet.
 *
 * Events are filtered by tag because the native module is a singleton emitter: during a screen
 * transition two composers can be mounted at once, and an unfiltered handler would stage the
 * paste into both.
 */
export function attachPasteListener(
  tag: number,
  onPaste: (result: PasteResult) => void,
  loadProtectedUris: PasteProtectionLoader = loadPastedAttachmentProtectionPaths,
): () => void {
  const native = getNative();
  if (!native) return () => {};

  let active = true;
  let subscription: PasteSubscription | null = null;
  try {
    subscription = native.addListener('onPaste', (payload: unknown) => {
      const parsed = parsePasteEvent(payload, { now: Date.now() });
      // A null tag means the native side couldn't report one — accept it rather than silently
      // swallowing the paste.
      if (parsed.tag != null && parsed.tag !== tag) return;
      if (parsed.dropped > 0) {
        logger.warn(`[paste] dropped ${parsed.dropped} unusable pasted item(s)`);
      }
      if (parsed.files.length > 0 || parsed.dropped > 0) {
        onPaste({ files: parsed.files, dropped: parsed.dropped });
      }
    });
    void loadProtectedUris()
      .then((protectedUris) => {
        if (!active) return;
        return native.attach(tag, protectedUris);
      })
      .catch(() => {
        // An incomplete DB snapshot must disable file paste rather than age-delete a durable retry.
        logger.warn('[paste] attach protection snapshot rejected');
      });
  } catch (err) {
    logger.warn(`[paste] could not attach: ${err instanceof Error ? err.message : String(err)}`);
  }

  return () => {
    active = false;
    try {
      subscription?.remove();
      void native.detach(tag)?.catch?.(() => {
        // The view is usually already gone by unmount time — nothing to report.
      });
    } catch {
      // best-effort teardown
    }
  };
}
