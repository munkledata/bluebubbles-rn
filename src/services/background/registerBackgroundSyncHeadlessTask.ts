import * as TaskManager from 'expo-task-manager';
import { BG_SYNC_TASK, executeBackgroundSyncTask } from './backgroundSync';

// Explicit bundle-entry side effect. Android can start this JS context without rendering Expo
// Router, so the WorkManager task definition must exist before the bundle entry completes.
TaskManager.defineTask(BG_SYNC_TASK, executeBackgroundSyncTask);
