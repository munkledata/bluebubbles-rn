import type {
  ServicePresentationAdapter,
  SessionPresentationSurface,
} from '@/services/presentationAdapter';
import type { AutoDownloadOutcome } from '@/services/download/autoDownloadAttachments';
import { useDialogStore } from './dialog/dialogStore';
import { showToast, useToastStore } from './toast/toastStore';

const AUTO_DOWNLOAD_BATCH_MS = 1_200;
let pendingImages = 0;
let pendingDestination: AutoDownloadOutcome['destination'] = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function flushAutoDownloadNotice(): void {
  const count = pendingImages;
  const destination = pendingDestination;
  pendingImages = 0;
  pendingDestination = null;
  pendingTimer = null;
  if (count <= 0 || destination === null) return;
  const where = destination === 'album' ? 'to Gator album' : 'to Photos';
  showToast(`Downloaded ${count} ${count === 1 ? 'image' : 'images'} ${where}`);
}

function presentAutoDownload(outcome: AutoDownloadOutcome): void {
  if (outcome.savedImages <= 0 || outcome.destination === null) return;
  pendingImages += outcome.savedImages;
  pendingDestination = outcome.destination;
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushAutoDownloadNotice, AUTO_DOWNLOAD_BATCH_MS);
}

function resetAutoDownloadNotice(): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  pendingImages = 0;
  pendingDestination = null;
}

/** Mounted-UI implementation of the service layer's narrow, explicit presentation port. */
export const servicePresentationAdapter: ServicePresentationAdapter = {
  presentAutoDownload,
  resetSession: () => {
    const failed: SessionPresentationSurface[] = [];
    try {
      resetAutoDownloadNotice();
    } catch {
      failed.push('auto-download-toast');
    }
    try {
      useDialogStore.getState().reset();
    } catch {
      failed.push('dialogs');
    }
    try {
      useToastStore.getState().reset();
    } catch {
      failed.push('toasts');
    }
    return failed;
  },
};
