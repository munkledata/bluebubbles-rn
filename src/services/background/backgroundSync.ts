import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { logger } from '@core/secure';
import { useSessionStore } from '@state/sessionStore';
import { ensureDatabase, http } from '@/services';
import { runOutgoingQueue } from '@/services/send';
import { httpSyncApi, incrementalSync } from '@/services/sync';

export const BG_SYNC_TASK = 'bluebubbles-bg-sync';

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
    const db = await ensureDatabase();
    const api = httpSyncApi(http);
    const version =
      useSessionStore.getState().serverInfo?.server_version ?? (await api.serverVersion());
    await incrementalSync(db, api, { serverVersion: version });
    // Retry stranded/failed sends while we're awake (the ~15-min recovery cadence).
    await runOutgoingQueue(db, http);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
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
