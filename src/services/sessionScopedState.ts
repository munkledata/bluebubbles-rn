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
}

/**
 * Synchronously retire every account-owned in-memory UI/cache surface.
 *
 * This deliberately excludes durable user preferences (theme, feature/sync settings, app lock)
 * and `shareIntentStore`: a file shared from another Android app must survive the
 * unauthenticated/locked gate until the user connects and chooses its recipient.
 */
export function resetSessionScopedState(): SessionScopedResetResult {
  // Invalidate async writers first. A Find My promise that settles after this point is disowned by
  // its generation check and cannot put the previous account's locations back into the store.
  const errorReportsIdle = errorReportSink.resetSession();
  useFindMyStore.getState().reset();
  useTypingStore.getState().reset();
  resetPendingNotification();
  resetAutoDownloadToastBatch();

  useFaceTimeStore.getState().reset();
  useRcsHealthStore.getState().reset();
  useSyncStore.getState().reset();
  useUploadStore.getState().reset();
  useDownloadStore.getState().reset();

  // Dialog/toast copy can contain contact names, message state, or server errors. Their queued
  // callbacks also belong to the old screen/session and must not run after reconnecting.
  useDialogStore.getState().reset();
  useToastStore.getState().reset();

  // QueryClient.clear() destroys active query entries (including chat search and server/account
  // responses) and synchronously removes all cached data from the shared provider.
  queryClient.clear();

  return { errorReportsIdle };
}
