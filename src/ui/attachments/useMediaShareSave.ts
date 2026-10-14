import { useCallback, useRef } from 'react';
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
import { runAccountOperation } from '@/services/realtime/accountOperation';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { showDialog } from '@ui/dialog/dialogStore';
import { showToast } from '@ui/toast/toastStore';
import { isLocalFileUri } from '@utils';
import type { MediaActionOperation, MediaSourceGrant } from './mediaViewerModel';

/**
 * Share and Save-to-Photos for the media viewer's active page. Each action runs only while
 * `sourceGrantIsCurrent` still accepts the page and file it was started for.
 *
 * Both actions REPORT their outcome. They used to `await` the helper and discard its answer,
 * which made a successful save pixel-identical to a dead button (and hid every failure), so the
 * pills read as broken even when they worked. A toast for the happy path (non-blocking, and the
 * host is `pointerEvents:'none'` so it can't eat a swipe), a dialog when there is something the
 * user has to act on.
 *
 * The in-flight guards matter BECAUSE of that reporting: a user whose buttons appear dead taps
 * twice, and expo-sharing throws "sharing already in progress" on a concurrent call — which
 * would now raise a "couldn't open the share sheet" dialog (and upload an error report) for a
 * sheet that opened perfectly on the first tap. Per-action refs, not one shared flag, so a share
 * that never settles can't also disable saving.
 */
export function useMediaShareSave(
  accountLease: RealtimeDeliveryLease,
  sourceGrantIsCurrent: (source: MediaSourceGrant) => boolean,
): {
  performShare: (source: MediaSourceGrant) => Promise<void>;
  performSave: (source: MediaSourceGrant) => Promise<void>;
} {
  const sharing = useRef<MediaActionOperation | null>(null);
  const saving = useRef<MediaActionOperation | null>(null);

  const performShare = useCallback(
    async (source: MediaSourceGrant): Promise<void> => {
      if (
        !source.localPath ||
        !isLocalFileUri(source.localPath) ||
        sharing.current ||
        !sourceGrantIsCurrent(source)
      ) {
        return;
      }
      const operation: MediaActionOperation = { token: Symbol('media-share'), source };
      sharing.current = operation;
      const localPath = source.localPath;
      const operationIsCurrent = (): boolean =>
        sharing.current?.token === operation.token && sourceGrantIsCurrent(operation.source);
      try {
        const result = await runAccountOperation(accountLease, () =>
          shareAttachment(localPath, source.mimeType, operationIsCurrent),
        );
        if (!result.ok || !operationIsCurrent() || result.value.ok) {
          return;
        }
        showDialog(
          'Share',
          result.value.reason === 'unavailable'
            ? 'Sharing isn’t available on this device.'
            : 'Couldn’t open the share sheet for this photo. The details are in Settings → App Logs.',
        );
      } catch {
        if (operationIsCurrent()) {
          showDialog(
            'Share',
            'Couldn’t open the share sheet for this photo. The details are in Settings → App Logs.',
          );
        }
      } finally {
        if (sharing.current?.token === operation.token) sharing.current = null;
      }
    },
    [accountLease, sourceGrantIsCurrent],
  );

  const performSave = useCallback(
    async (source: MediaSourceGrant): Promise<void> => {
      if (
        !source.localPath ||
        !isLocalFileUri(source.localPath) ||
        saving.current ||
        !sourceGrantIsCurrent(source)
      ) {
        return;
      }
      const operation: MediaActionOperation = { token: Symbol('media-save'), source };
      saving.current = operation;
      const localPath = source.localPath;
      const operationIsCurrent = (): boolean =>
        saving.current?.token === operation.token && sourceGrantIsCurrent(operation.source);
      try {
        const result = await runAccountOperation(accountLease, () =>
          saveAttachmentsToPhotos([localPath], operationIsCurrent),
        );
        if (!result.ok || !operationIsCurrent()) return;
        if (result.value.status === 'saved') showToast('Saved to Photos');
        else if (result.value.status === 'denied')
          showDialog('Save', 'Photos permission is required to save attachments.');
        else showToast('Couldn’t save this photo');
      } catch {
        if (operationIsCurrent()) showToast('Couldn’t save this photo');
      } finally {
        if (saving.current?.token === operation.token) saving.current = null;
      }
    },
    [accountLease, sourceGrantIsCurrent],
  );

  return { performShare, performSave };
}
