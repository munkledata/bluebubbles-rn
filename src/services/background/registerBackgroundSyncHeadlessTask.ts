import * as TaskManager from 'expo-task-manager';
import { retainBackgroundTaskExecution } from '@/native/backgroundTaskExecution';
import { BG_SYNC_TASK, executeBackgroundSyncTask } from './backgroundSync';

// Explicit bundle-entry side effect. Android can start this JS context without rendering Expo
// Router, so the WorkManager task definition must exist before the bundle entry completes.
TaskManager.defineTask<{ gatorExecutionId?: unknown }>(BG_SYNC_TASK, (body) => {
  return executeBackgroundSyncTask(() =>
    retainBackgroundTaskExecution(body.executionInfo.eventId, body.data?.gatorExecutionId),
  );
});
