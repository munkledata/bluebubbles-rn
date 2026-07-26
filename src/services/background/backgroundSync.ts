import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { logger } from '@core/secure';
import { useSessionStore } from '@state/sessionStore';
import { http } from '../clients';
import { ensureDatabase } from '../databaseControl';
import { flushErrorReports } from '@/services/errors';
import { outgoingQueueIO, runOutgoingQueue } from '@/services/send';
import { httpSyncApi, incrementalSync } from '@/services/sync';
import { runTrackedSync } from '../syncControl';

export const BG_SYNC_TASK = 'gator-bg-sync';

/**
 * Background catch-up: an incremental sync run by WorkManager (~15-min floor,
 * deferred further by Doze). This is the "missed messages while killed" backstop
 * until real FCM push is provisioned. `defineTask` MUST run at module top level —
 * this file is imported for its side effect at the top of `app/_layout.tsx`.
 */
TaskManager.defineTask(BG_SYNC_TASK, async () => {
  try {
    const { origin, password } = useSessionStore.getState();
    if (!origin || !password) return BackgroundTask.BackgroundTaskResult.Success; // not connected
    // Published into the TRACKED slot, NOT a bare call: `forget()` drains that slot before wiping
    // the DB, so a run it can't see is one whose next page lands after the deletes and re-creates
    // the previous account's chats, handles and messages — plus a non-null sync marker over the
    // reset. Reachable without any exotic timing: the worker starts while the app is backgrounded,
    // the user foregrounds it and taps Disconnect while a long catch-up is still paging.
    // `startSync()` is deliberately NOT what we call — it owns the first-sync/full-sync branch and
    // the trailing contacts sync, neither of which belongs on a 15-minute background timer. That
    // is also why the tracked slot is SEPARATE from the one `startSync` coalesces on: a foreground
    // caller arriving mid-task must still run the whole pipeline, not inherit this narrower run.
    //
    // EVERYTHING THIS RUN NEEDS IS RESOLVED INSIDE THE SLOT, and the session is re-read there.
    // Resolving them first left a window the drain cannot see: `ensureDatabase()` is a Keystore
    // read plus, after a schema bump, the whole migration pass, and `serverVersion()` is a
    // retryable network GET — on a cold headless wake that is seconds during which BOTH slots are
    // null, so a `forget()` draining right then returns instantly and wipes, and this run then
    // pages into the emptied DB. The re-check is what actually aborts it: the wipe clears the
    // credentials first, so an empty session here means the disconnect has already happened.
    await runTrackedSync(async () => {
      const session = useSessionStore.getState();
      if (!session.origin || !session.password) return;
      const db = await ensureDatabase();
      const api = httpSyncApi(http);
      const version = session.serverInfo?.server_version ?? (await api.serverVersion());
      await incrementalSync(db, api, { serverVersion: version });
    });
    // Retry stranded/failed sends while we're awake (the ~15-min recovery cadence).
    // Attachments re-upload too (outgoingQueueIO streams from the retained localPath).
    // Deliberately OUTSIDE the tracked slot above: an attachment upload has no timeout at all, so
    // holding the slot across one would stall a Disconnect behind it for minutes — and a drain
    // after a wipe finds no queue rows, so it has nothing to resurrect. (`ensureDatabase` is
    // single-flight and returns the already-open handle, so asking for it again costs nothing.)
    await runOutgoingQueue(await ensureDatabase(), http, outgoingQueueIO);
    // Upload any buffered error reports too (no-op unless connected + server supports it + enabled).
    await flushErrorReports();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    // Don't swallow silently: a recurring catch-up failure (auth expiry, schema/migration
    // error, etc.) is otherwise invisible. The logger redacts before any sink.
    logger.error('[bg] background sync failed', e);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Register the catch-up task (idempotent). Called once after credentials hydrate. */
export async function registerBackgroundSync(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) {
      logger.info('[bg] background task unavailable', status);
      return;
    }
    if (!(await TaskManager.isTaskRegisteredAsync(BG_SYNC_TASK))) {
      await BackgroundTask.registerTaskAsync(BG_SYNC_TASK, { minimumInterval: 15 });
    }
    logger.info('[bg] background sync registered');
  } catch (e) {
    logger.warn('[bg] register failed', e);
  }
}
