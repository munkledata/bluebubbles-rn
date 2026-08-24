import { useDownloadStore } from '@state/downloadStore';
import { useFaceTimeStore } from '@state/faceTimeStore';
import { useFindMyStore } from '@state/findmyStore';
import { queryClient } from '@state/queryClient';
import { useRcsHealthStore } from '@state/rcsHealthStore';
import { useSyncStore } from '@state/syncStore';
import { useTypingStore } from '@state/typingStore';
import { useUploadStore } from '@state/uploadStore';
import { useDialogStore } from '@ui/dialog/dialogStore';
import { useToastStore } from '@ui/toast/toastStore';
import { resetAutoDownloadToastBatch } from './download/autoDownloadAttachments';
import { errorReportSink } from './errors/errorReportSink';
import { resetPendingNotification } from './notifications/pendingNav';

export interface SessionScopedResetResult {
  /** Drains already inside the DB path when the old account was synchronously disowned. */
  errorReportsIdle: Promise<void>;
  /** Reset adapters that threw. Teardown still runs every later adapter and blocks account B. */
  failedSurfaces: readonly SessionScopedResetSurface[];
}

export type SessionScopedResetSurface =
  | 'error-reports'
  | 'find-my'
  | 'typing'
  | 'pending-notification'
  | 'auto-download-toast'
  | 'facetime'
  | 'rcs-health'
  | 'sync'
  | 'uploads'
  | 'downloads'
  | 'dialogs'
  | 'toasts'
  | 'query-cache';

/**
 * Synchronously retire every account-owned in-memory UI/cache surface.
 *
 * This deliberately excludes durable user preferences (theme, feature/sync settings, app lock)
 * and `shareIntentStore`: a file shared from another Android app must survive the
 * unauthenticated/locked gate until the user connects and chooses its recipient.
 */
export function resetSessionScopedState(): SessionScopedResetResult {
  const failedSurfaces: SessionScopedResetSurface[] = [];

  // Invalidate async writers first. A Find My promise that settles after this point is disowned by
  // its generation check and cannot put the previous account's locations back into the store.
  let errorReportsIdle = Promise.resolve();
  try {
    errorReportsIdle = errorReportSink.resetSession();
  } catch {
    failedSurfaces.push('error-reports');
  }
  try {
    useFindMyStore.getState().reset();
  } catch {
    failedSurfaces.push('find-my');
  }
  try {
    useTypingStore.getState().reset();
  } catch {
    failedSurfaces.push('typing');
  }
  try {
    resetPendingNotification();
  } catch {
    failedSurfaces.push('pending-notification');
  }
  try {
    resetAutoDownloadToastBatch();
  } catch {
    failedSurfaces.push('auto-download-toast');
  }

  try {
    useFaceTimeStore.getState().reset();
  } catch {
    failedSurfaces.push('facetime');
  }
  try {
    useRcsHealthStore.getState().reset();
  } catch {
    failedSurfaces.push('rcs-health');
  }
  try {
    useSyncStore.getState().reset();
  } catch {
    failedSurfaces.push('sync');
  }
  try {
    useUploadStore.getState().reset();
  } catch {
    failedSurfaces.push('uploads');
  }
  try {
    useDownloadStore.getState().reset();
  } catch {
    failedSurfaces.push('downloads');
  }

  // Dialog/toast copy can contain contact names, message state, or server errors. Their queued
  // callbacks also belong to the old screen/session and must not run after reconnecting.
  try {
    useDialogStore.getState().reset();
  } catch {
    failedSurfaces.push('dialogs');
  }
  try {
    useToastStore.getState().reset();
  } catch {
    failedSurfaces.push('toasts');
  }

  // QueryClient.clear() destroys active query entries (including chat search and server/account
  // responses) and synchronously removes all cached data from the shared provider.
  try {
    queryClient.clear();
  } catch {
    failedSurfaces.push('query-cache');
  }

  return { errorReportsIdle, failedSurfaces };
}
