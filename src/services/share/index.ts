import { ShareIntentModule } from 'expo-share-intent';
import { logger } from '@core/secure';
import { useShareIntentStore } from '@state/shareIntentStore';
import { showToast } from '@ui/toast/toastStore';
import { createShareCapture } from './captureShare';
import { appPrivateRoots, expoShareFileIO, shareCacheRoot } from './shareFileIo';

export type { ShareFileIO } from './materializeShare';
export { materializeSharedFiles, pruneShareCache } from './materializeShare';
export { parseRawShareEvent } from './shareIntentPayload';
export type { ParsedShare, RawShareFile, ShareSource } from './shareIntentPayload';
export { createShareCapture } from './captureShare';

/**
 * The production share-capture handler, wired to expo + the app stores.
 *
 * Subscribed to `ExpoShareIntentModule`'s raw `onChange` event by `ShareIntentCapture`
 * (`src/ui/ShareIntentHandler.tsx`).
 */
export const captureShareIntent = createShareCapture({
  io: expoShareFileIO,
  cacheRoot: shareCacheRoot(),
  privateRoots: appPrivateRoots(),
  clearNativeIntent: () => {
    try {
      // The key argument is ignored on Android; it just nulls the pending-intent singleton.
      ShareIntentModule?.clearShareIntent('');
    } catch (err) {
      logger.warn(
        `[share] could not clear the native intent: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  },
  stage: (payload) => useShareIntentStore.getState().set(payload),
  toast: showToast,
  now: () => Date.now(),
});
