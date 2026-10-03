#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  extractZipEntry,
  readAabArchiveSnapshot,
  REVIEWED_ANDROID_ABSOLUTE_PATH_EXCEPTIONS,
  scanZipArchiveForSensitiveMetadata,
} from './legal-aab-inventory.mjs';

const DEFAULT_DEBUG_MANIFESTS = [
  'android/app/build/intermediates/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml',
  'android/app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml',
  'android/app/build/intermediates/merged_manifests/debug/processDebugMainManifest/AndroidManifest.xml',
];
const DEFAULT_RELEASE_MANIFESTS = [
  'android/app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml',
  'android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml',
  'android/app/build/intermediates/merged_manifests/release/processReleaseMainManifest/AndroidManifest.xml',
];
const DEFAULT_RELEASE_BUNDLE = 'android/app/build/outputs/bundle/release/app-release.aab';
const DEFAULT_NETWORK_SECURITY_CONFIG = 'android/app/src/main/res/xml/network_security_config.xml';
const DEFAULT_MAIN_ACTIVITY_SOURCE =
  'android/app/src/main/java/com/bluegreengatorapps/messages/MainActivity.kt';
const PACKAGED_MANIFEST_ENTRY = 'base/manifest/AndroidManifest.xml';
const PACKAGED_RESOURCES_ENTRY = 'base/resources.pb';
const PACKAGED_SHORTCUTS_ENTRY = 'base/res/xml/shortcuts.xml';
const PACKAGED_DEX_PATTERN = /^base\/dex\/[^/]+\.dex$/;
const MAX_PACKAGED_DEX_BYTES = 256 * 1024 * 1024;
const ANDROID_NAMESPACE = 'http://schemas.android.com/apk/res/android';
const REQUIRED_MIN_SDK_VERSION = '36';
const FORBIDDEN_INBOUND_SHARE_DEX_MARKERS = ['ExpoShareIntent', 'expo/modules/shareintent'];
const REQUIRED_SHARE_ACTIONS = [
  'android.intent.action.SEND',
  'android.intent.action.SEND_MULTIPLE',
];
const SHARE_TARGET_CATEGORY = 'com.bluegreengatorapps.messages.category.SHARE_TARGET';
const SHARE_TARGET_ACTIVITY = 'com.bluegreengatorapps.messages.MainActivity';
const SHARE_ON_CREATE_CAPTURE =
  'expo.modules.gatorshareintake.GatorShareIntakeActivityBridge.captureOnCreate(this, intent, savedInstanceState)';
const SHARE_ON_NEW_INTENT_CAPTURE =
  'expo.modules.gatorshareintake.GatorShareIntakeActivityBridge.captureOnNewIntent(this, intent)';
const EXPO_BACKGROUND_TASK_VERSION = '57.0.21';
const EXPO_TASK_MANAGER_VERSION = '57.0.21';
const UNIMODULES_APP_LOADER_VERSION = '57.0.2';
const EXPO_FILE_SYSTEM_VERSION = '57.0.7';
const EXPO_ROUTER_VERSION = '57.0.24';
const REACT_NATIVE_SCREENS_VERSION = '4.26.2';
const REACT_NATIVE_SCREENS_RANGE = '~4.26.0';
const PATCH_PACKAGE_VERSION = '8.0.1';
const EXPO_BACKGROUND_TASK_PATCH_PATH = `patches/expo-background-task+${EXPO_BACKGROUND_TASK_VERSION}.patch`;
const EXPO_BACKGROUND_TASK_SCHEDULER_PATH =
  'node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskScheduler.kt';
const EXPO_BACKGROUND_TASK_WORK_PATH =
  'node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskWork.kt';
const EXPO_TASK_MANAGER_PATCH_PATH = `patches/expo-task-manager+${EXPO_TASK_MANAGER_VERSION}.patch`;
const EXPO_TASK_MANAGER_SOURCE_PATH = 'node_modules/expo-task-manager/src/TaskManager.ts';
const EXPO_TASK_MANAGER_RUNTIME_PATH = 'node_modules/expo-task-manager/build/TaskManager.js';
const EXPO_TASK_MANAGER_UTILS_PATH =
  'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskManagerUtils.java';
const EXPO_TASK_SERVICE_PATH =
  'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskService.java';
const EXPO_TASK_MANAGER_BUILD_PATH = 'node_modules/expo-task-manager/android/build.gradle';
const EXPO_TASK_MANAGER_LIFETIME_TEST_PATH =
  'node_modules/expo-task-manager/android/src/test/java/expo/modules/taskManager/TaskServiceContextLifetimeTest.java';
const EXPO_TASKS_REPOSITORY_PATH =
  'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/TasksAndEventsRepository.java';
const EXPO_BARE_TASKS_REPOSITORY_PATH =
  'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/BareTasksAndEventsRepository.java';
const EXPO_MANAGED_TASKS_REPOSITORY_PATH =
  'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/ManagedTasksAndEventsRepository.java';
const EXPO_FILE_SYSTEM_PATCH_PATH = `patches/expo-file-system+${EXPO_FILE_SYSTEM_VERSION}.patch`;
const EXPO_FILE_SYSTEM_LEGACY_ANDROID_PATH =
  'node_modules/expo-file-system/android/src/main/java/expo/modules/filesystem/legacy/FileSystemLegacyModule.kt';
const EXPO_FILE_SYSTEM_REDIRECT_TEST_PATH =
  'node_modules/expo-file-system/android/src/test/java/expo/modules/filesystem/legacy/FileSystemLegacyRedirectPolicyTest.kt';
const EXPO_ROUTER_PATCH_PATH = `patches/expo-router+${EXPO_ROUTER_VERSION}.patch`;
const EXPO_ROUTER_EXPERIMENTAL_STACK_PATH =
  'node_modules/expo-router/build/layouts/experimental-stack/ExperimentalStackView.js';
const REACT_NATIVE_SCREENS_PATCH_PATH = `patches/react-native-screens+${REACT_NATIVE_SCREENS_VERSION}.patch`;
const REACT_NATIVE_SCREENS_STACK_CONTAINER_PATH =
  'node_modules/react-native-screens/android/src/main/java/com/swmansion/rnscreens/gamma/stack/host/StackContainer.kt';

// These exact product-owned runtime values bind an AAB to the pinned-shortcut retirement added in
// 9d97eab. Generic ShortcutManager method names are deliberately excluded because AndroidX itself
// contributes them to DEX even when Gator's cleanup implementation is stale or absent.
export const REQUIRED_PINNED_SHORTCUT_CLEANUP_DEX_MARKERS = [
  'GatorShareShortcuts',
  'clearShareShortcuts',
  'com.bluegreengatorapps.messages.category.RETIRED_SHORTCUT',
  'gator.retired',
  'gator-retired-shortcut',
  'This shortcut is no longer available',
  'Direct Share cleanup could not replace ',
];

// These product-owned class descriptors prove the AAB contains both the Expo bridge and the
// synchronous MainActivity capture bridge that runs before ReactActivity sees either intent.
export const REQUIRED_SHARE_INTAKE_DEX_MARKERS = [
  'Lexpo/modules/gatorshareintake/GatorShareIntakeModule;',
  'Lexpo/modules/gatorshareintake/GatorShareIntakeActivityBridge;',
];

// These strings exist only in the patched Kotlin source. Requiring them in DEX rejects a stale AAB
// that still linked Expo's prebuilt worker even when the current checkout is configured correctly.
export const REQUIRED_BACKGROUND_TASK_RETRY_DEX_MARKERS = [
  'Task finished; success=',
  'doWork: Worker failed; requesting retry',
];

// These messages exist only in the patched task-manager sources. They prove the packaged runtime
// settles pre-JavaScript failures instead of leaving BackgroundTaskWork suspended forever.
export const REQUIRED_TASK_MANAGER_SETTLEMENT_DEX_MARKERS = [
  'Trying to execute a null task; completing callback with failure.',
  'Task manager threw before queued JavaScript dispatch; completing task with failure.',
  'Headless app is already running without a task manager; completing pending task with failure.',
  'Headless app load failed; completing pending tasks with failure.',
  'Headless app loader threw before JavaScript dispatch; completing pending tasks with failure.',
];

export const FORBIDDEN_LEGACY_SHORTCUT_PUBLISHER_DEX_MARKERS = [
  'getLaunchShortcutId',
  'share shortcuts were not published (device cap or disabled shortcuts)',
];

// The exact package-registration descriptor gives a precise error for the usual autolinking path,
// while the namespace prefix catches any other class from the retired community WebView package.
// Expo DOM's supported bridge uses the separate expo/modules/webview namespace.
export const FORBIDDEN_COMMUNITY_WEBVIEW_DEX_MARKERS = [
  'Lcom/reactnativecommunity/webview/RNCWebViewPackage;',
  'Lcom/reactnativecommunity/webview/',
];

export const FORBIDDEN_PERMISSIONS = [
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_EXACT_ALARM',
  'android.permission.WRITE_CONTACTS',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.ACCESS_NOTIFICATION_POLICY',
  'android.permission.USE_FULL_SCREEN_INTENT',
];

export const GOOGLE_MAPS_API_KEY_METADATA_NAME = 'com.google.android.geo.API_KEY';
export const GOOGLE_MAPS_API_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{35}$/;
export const NETWORK_SECURITY_CONFIG_REFERENCE = '@xml/network_security_config';

function countOccurrences(source, needle) {
  if (typeof source !== 'string' || needle.length === 0) return 0;
  return source.split(needle).length - 1;
}

/**
 * Keep Expo's Android WorkManager result bridge source-built and fail closed on patch drift.
 * SDK 57 otherwise links the package's prebuilt AAR, whose worker reports every JS result as
 * success and prevents Android from retrying transient failures.
 */
export function validateExpoBackgroundTaskRetryBridge({
  packageJson,
  packageLock,
  patchSource,
  schedulerSource,
  workerSource,
}) {
  const errors = [];
  if (packageJson?.dependencies?.['expo-background-task'] !== EXPO_BACKGROUND_TASK_VERSION) {
    errors.push(`expo-background-task must be pinned exactly to ${EXPO_BACKGROUND_TASK_VERSION}`);
  }
  if (
    packageLock?.packages?.['']?.dependencies?.['expo-background-task'] !==
    EXPO_BACKGROUND_TASK_VERSION
  ) {
    errors.push(
      `package-lock root must pin expo-background-task exactly to ${EXPO_BACKGROUND_TASK_VERSION}`,
    );
  }
  if (
    packageLock?.packages?.['node_modules/expo-background-task']?.version !==
    EXPO_BACKGROUND_TASK_VERSION
  ) {
    errors.push(`package-lock must resolve expo-background-task ${EXPO_BACKGROUND_TASK_VERSION}`);
  }

  const sourceBuild = packageJson?.expo?.autolinking?.android?.buildFromSource;
  if (
    !Array.isArray(sourceBuild) ||
    sourceBuild.filter((name) => name === 'expo-background-task').length !== 1
  ) {
    errors.push(
      'Expo Android autolinking must build expo-background-task from source exactly once',
    );
  }

  const patchMarkers = [
    `a/${EXPO_BACKGROUND_TASK_SCHEDULER_PATH}`,
    `a/${EXPO_BACKGROUND_TASK_WORK_PATH}`,
    '+    if (cancelExisting && hasUnfinishedWorker(context)) {',
    'if (consumers.isEmpty()) {\n-      return\n+      return true',
    '+        return scheduled',
    '+          val succeeded = result is Number && result.toDouble() == 1.0',
    '+        taskCompletion.complete(false)',
    '+    if (!succeeded) {\n+      return false\n     }',
    '+      workInfos.any { !it.state.isFinished }',
    '+      return if (succeeded) Result.success() else Result.retry()',
    '+      return Result.retry()',
  ];
  if (patchMarkers.some((marker) => !patchSource?.includes(marker))) {
    errors.push(
      `${EXPO_BACKGROUND_TASK_PATCH_PATH} must carry the reviewed retry and unfinished-chain repair`,
    );
  }

  const schedulerMarkers = [
    'suspend fun runTasks(context: Context, appScopeKey: String): Boolean',
    'if (cancelExisting && hasUnfinishedWorker(context)) {',
    '.filterIsInstance<BackgroundTaskConsumer>()',
    'if (consumers.isEmpty()) {\n      return true\n    }',
    'Log.d(TAG, "runTasks: Deferred foreground worker; scheduled=$scheduled")\n        return scheduled',
    'val succeeded = result is Number && result.toDouble() == 1.0',
    'Log.e(TAG, "Task failed: ${e.message}")\n        taskCompletion.complete(false)',
    'val succeeded = tasks.awaitAll().all { it }',
    'if (!succeeded) {\n      return false\n    }\n    return Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||',
    'scheduleWorker(context, appScopeKey, false)',
    'private suspend fun hasUnfinishedWorker(context: Context): Boolean',
    'workInfos.any { !it.state.isFinished }',
  ];
  if (schedulerMarkers.some((marker) => !schedulerSource?.includes(marker))) {
    errors.push('expo-background-task scheduler source must preserve the reviewed retry flow');
  }
  const cancellationHandlers =
    schedulerSource?.match(/catch \(e: CancellationException\) \{[\s\S]*?\n\s*\}/g) ?? [];
  if (
    cancellationHandlers.length !== 6 ||
    cancellationHandlers.some((handler) => !handler.includes('throw e')) ||
    schedulerSource?.includes('workInfos.firstOrNull()') ||
    schedulerSource?.includes('.toInt() == 1')
  ) {
    errors.push(
      'expo-background-task scheduler must propagate cancellation and inspect the full worker chain',
    );
  }

  const workerMarkers = [
    'if (appScopeKey == null) {',
    'return Result.failure(outputData)',
    'return if (succeeded) Result.success() else Result.retry()',
    'catch (e: CancellationException)',
    'doWork: Worker failed; requesting retry',
  ];
  const workerCancellationHandler = workerSource?.match(
    /catch \(e: CancellationException\) \{[\s\S]*?\n\s*\}/,
  )?.[0];
  if (
    workerMarkers.some((marker) => !workerSource?.includes(marker)) ||
    !workerCancellationHandler?.includes('throw e') ||
    countOccurrences(workerSource, 'return Result.retry()') !== 1
  ) {
    errors.push(
      'expo-background-task worker must fail malformed input, propagate cancellation, and retry operational failures',
    );
  }
  return errors;
}

function hasNativeOwnedTaskKeeper(source, path, partialPatchContext = false) {
  if (typeof source !== 'string') return false;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if (!partialPatchContext && file.parseDiagnostics.length > 0) return false;
  const registrations = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === 'AppRegistry' &&
      ['registerHeadlessTask', 'registerCancellableHeadlessTask'].includes(
        node.expression.name.text,
      )
    )
      registrations.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (registrations.length !== 1) return false;
  const call = registrations[0];
  const statement = call.parent;
  const block = statement.parent;
  const condition = block.parent;
  const type = path === EXPO_TASK_MANAGER_SOURCE_PATH ? '<void>' : '';
  return (
    ts.isExpressionStatement(statement) &&
    ts.isBlock(block) &&
    block.statements.length === 1 &&
    ts.isIfStatement(condition) &&
    condition.parent === file &&
    condition.thenStatement === block &&
    !condition.elseStatement &&
    condition.expression.getText(file).replace(/\s+/g, '') === "Platform.OS==='android'" &&
    call.getText(file).replace(/\s+/g, '') ===
      `AppRegistry.registerHeadlessTask('expo-task-manager',()=>()=>newPromise${type}(()=>{}))`
  );
}

/**
 * Keep Expo TaskManager's native settlement and JavaScript timer keeper paired and fail closed on drift.
 * A missing task or failed headless loader must resolve only its still-queued native callback so
 * WorkManager can retry; it must never unregister durable tasks or race work already handed to JS.
 */
export function validateExpoTaskManagerPreJsSettlement({
  packageJson,
  packageLock,
  patchSource,
  utilsSource,
  serviceSource,
  repositorySource,
  bareRepositorySource,
  managedRepositorySource,
  taskManagerSource,
  taskManagerRuntimeSource,
}) {
  const errors = [];
  if (packageJson?.dependencies?.['expo-task-manager'] !== EXPO_TASK_MANAGER_VERSION) {
    errors.push(`expo-task-manager must be pinned exactly to ${EXPO_TASK_MANAGER_VERSION}`);
  }
  if (
    packageLock?.packages?.['']?.dependencies?.['expo-task-manager'] !== EXPO_TASK_MANAGER_VERSION
  ) {
    errors.push(
      `package-lock root must pin expo-task-manager exactly to ${EXPO_TASK_MANAGER_VERSION}`,
    );
  }
  if (
    packageLock?.packages?.['node_modules/expo-task-manager']?.version !== EXPO_TASK_MANAGER_VERSION
  ) {
    errors.push(`package-lock must resolve expo-task-manager ${EXPO_TASK_MANAGER_VERSION}`);
  }
  if (
    packageLock?.packages?.['node_modules/unimodules-app-loader']?.version !==
    UNIMODULES_APP_LOADER_VERSION
  ) {
    errors.push(`package-lock must resolve unimodules-app-loader ${UNIMODULES_APP_LOADER_VERSION}`);
  }

  const sourceBuild = packageJson?.expo?.autolinking?.android?.buildFromSource;
  if (
    !Array.isArray(sourceBuild) ||
    sourceBuild.filter((name) => name === 'expo-task-manager').length !== 1
  ) {
    errors.push('Expo Android autolinking must build expo-task-manager from source exactly once');
  }
  if (
    !Array.isArray(sourceBuild) ||
    sourceBuild.filter((name) => name === 'unimodules-app-loader').length !== 1
  ) {
    errors.push(
      'Expo Android autolinking must build unimodules-app-loader from source exactly once',
    );
  }

  const expectedPatchPaths = [
    EXPO_TASK_MANAGER_BUILD_PATH,
    EXPO_TASK_MANAGER_LIFETIME_TEST_PATH,
    EXPO_TASK_MANAGER_UTILS_PATH,
    EXPO_TASK_SERVICE_PATH,
    EXPO_TASKS_REPOSITORY_PATH,
    EXPO_BARE_TASKS_REPOSITORY_PATH,
    EXPO_MANAGED_TASKS_REPOSITORY_PATH,
    EXPO_TASK_MANAGER_SOURCE_PATH,
    EXPO_TASK_MANAGER_RUNTIME_PATH,
  ].sort();
  const patchHeaders =
    typeof patchSource === 'string'
      ? [...patchSource.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
      : [];
  const patchedPaths = patchHeaders.map((match) => match[1]).sort();
  if (
    patchHeaders.some((match) => match[1] !== match[2]) ||
    JSON.stringify(patchedPaths) !== JSON.stringify(expectedPatchPaths)
  ) {
    errors.push(
      `${EXPO_TASK_MANAGER_PATCH_PATH} must patch only the nine reviewed source/test files`,
    );
  }

  const patchMarkers = [
    '+        callback.onFinished(Collections.emptyMap());',
    '+  private static final Object sTaskExecutionLock = new Object();',
    '+      // Publishing the manager and detaching its queue under one lock assigns every event to',
    '+            finishClaimedTaskExecutionWithFailure(appScopeKey, eventId);',
    '+      finishPendingTaskExecutionWithFailure(appScopeKey, eventId, body);',
    '+      if (pendingBody != null && !mTasksAndEventsRepository.removeEventForAppScopeKey(appScopeKey, pendingBody)) {',
    '+          finishedHeadlessStartToken = sHeadlessStartTokens.remove(appScopeKey);',
    '+        sHeadlessTaskIds.put(headlessStartToken, taskId);',
    '+      Integer taskId = sHeadlessTaskIds.remove(headlessStartToken);',
    '+  boolean removeEventForAppScopeKey(String appScopeKey, Bundle body);',
    '-          unregisterAllTasksForAppScopeKey(appScopeKey);',
  ];
  if (patchMarkers.some((marker) => !patchSource?.includes(marker))) {
    errors.push(
      `${EXPO_TASK_MANAGER_PATCH_PATH} must carry the reviewed pre-JavaScript settlement repair`,
    );
  }

  for (const [path, source] of [
    [EXPO_TASK_MANAGER_SOURCE_PATH, taskManagerSource],
    [EXPO_TASK_MANAGER_RUNTIME_PATH, taskManagerRuntimeSource],
  ]) {
    const patchSection = patchSource
      ?.split(/(?=^diff --git )/m)
      .find((section) => section.startsWith(`diff --git a/${path} b/${path}\n`));
    const patchAfter = patchSection
      ?.split('\n')
      .filter((line) => line.startsWith(' ') || (line.startsWith('+') && !line.startsWith('+++')))
      .map((line) => line.slice(1))
      .join('\n');
    if (
      !hasNativeOwnedTaskKeeper(source, path) ||
      !hasNativeOwnedTaskKeeper(patchAfter, path, true)
    ) {
      errors.push(
        `${path} and its patch must retain one Android timer keeper until native completion`,
      );
    }
  }

  const utilsMarkers = [
    'Trying to execute a null task; completing callback with failure.',
    'if (callback != null) {\n        callback.onFinished(Collections.emptyMap());\n      }',
  ];
  if (utilsMarkers.some((marker) => !utilsSource?.includes(marker))) {
    errors.push('expo-task-manager utils must settle null-task callbacks as failures');
  }

  const serviceMarkers = [
    'private static final Object sTaskExecutionLock = new Object();',
    'private static final Map<Object, Integer> sHeadlessTaskIds = new HashMap<>();',
    'private static final Map<String, Object> sHeadlessStartTokens = new HashMap<>();',
    'Task execution body is missing execution info; completing callback with failure.',
    'Task execution body is missing an event ID; completing callback with failure.',
    'Task manager threw before queued JavaScript dispatch; completing task with failure.',
    'Task manager threw before JavaScript dispatch; completing task with failure.',
    'Headless app loader is unavailable; completing pending tasks with failure.',
    'Headless app is already running without a task manager; completing pending task with failure.',
    'Headless app load failed; completing pending tasks with failure.',
    'Headless app loader threw before JavaScript dispatch; completing pending tasks with failure.',
    'private void finishPendingTaskExecutionWithFailure(String appScopeKey, String eventId, Bundle body)',
    'private void finishClaimedTaskExecutionWithFailure(String appScopeKey, String eventId)',
    'pendingBody != null && !mTasksAndEventsRepository.removeEventForAppScopeKey(appScopeKey, pendingBody)',
    'finishedHeadlessStartToken = sHeadlessStartTokens.remove(appScopeKey);',
    'sHeadlessStartTokens.get(appScopeKey) != headlessStartToken',
    'sHeadlessTaskIds.put(headlessStartToken, taskId);',
    'sHeadlessTaskIds.remove(headlessStartToken);',
    'response.put("eventId", eventId);',
  ];
  const managerHandoffRegion = serviceSource?.match(
    /final List<Bundle> eventsQueue;[\s\S]*?Execute events only after releasing the handoff lock/,
  )?.[0];
  const managerDestructionRegion = serviceSource?.match(
    /if \(taskManager == null\) \{[\s\S]*?return;/,
  )?.[0];
  const loaderInvalidationRegion = serviceSource?.match(
    /private void invalidateAppRecord\(String appScopeKey\) \{[\s\S]*?\n {0,2}}/,
  )?.[0];
  if (
    !managerDestructionRegion
      ?.replace(/\s+/g, '')
      .includes(
        'synchronized(sTaskExecutionLock){sTaskManagers.remove(appScopeKey);sHeadlessTaskManagers.remove(appScopeKey);}',
      ) ||
    !loaderInvalidationRegion?.includes('appLoader.invalidateApp(appScopeKey);') ||
    loaderInvalidationRegion.includes('sHeadlessTaskManagers.remove')
  ) {
    errors.push(
      'expo-task-manager must remove both managers at context destruction, not loader invalidation',
    );
  }
  const enqueueDecisionRegion = serviceSource?.match(
    /final TaskManagerInterface taskManager;[\s\S]*?if \(headlessStartToken != null\)/,
  )?.[0];
  const failureSettlementRegion = serviceSource?.match(
    /private void finishTaskExecutionWithFailure[\s\S]*?\/\/endregion/,
  )?.[0];
  const executeTaskRegion = serviceSource?.match(
    /public void executeTask\(TaskInterface task[\s\S]*?\/\/endregion/,
  )?.[0];
  const queuedBootstrapOffset = executeTaskRegion?.indexOf(
    'HeadlessAppLoader appLoader = getAppLoader();',
  );
  const preJsSettlementRegion =
    queuedBootstrapOffset != null && queuedBootstrapOffset >= 0
      ? executeTaskRegion?.slice(queuedBootstrapOffset)
      : undefined;
  const queuedLoaderGuardIndex = preJsSettlementRegion?.indexOf(
    'if (appLoader == null || context == null)',
  );
  const queuedKeeperIndex = preJsSettlementRegion?.indexOf(
    'maybeStartHeadlessTask(appScopeKey, headlessStartToken);',
  );
  const queuedLoadIndex = preJsSettlementRegion?.indexOf('appLoader.loadApp');
  const headlessTokenRegion = serviceSource?.match(
    /private void invokeStartHeadlessTask[\s\S]*?private void maybeFinishHeadlessTask[\s\S]*?\n  }/,
  )?.[0];
  if (
    serviceMarkers.some((marker) => !serviceSource?.includes(marker)) ||
    !managerHandoffRegion?.includes('synchronized (sTaskExecutionLock)') ||
    !managerHandoffRegion.includes('taskManagers.put(appScopeKey') ||
    !managerHandoffRegion.includes('mTasksAndEventsRepository.removeEvents(appScopeKey);') ||
    !enqueueDecisionRegion?.includes('synchronized (sTaskExecutionLock)') ||
    !enqueueDecisionRegion.includes('taskManager = getTaskManager(appScopeKey);') ||
    !enqueueDecisionRegion.includes('mTasksAndEventsRepository.putEventForAppScopeKey') ||
    !failureSettlementRegion?.includes('synchronized (sTaskExecutionLock)') ||
    !/taskCallback = sTaskCallbacks\.remove\(eventId\);\n\s*}\n\n\s*if \(finishedHeadlessStartToken != null\)[\s\S]*?taskCallback\.onFinished\(response\);/.test(
      failureSettlementRegion,
    ) ||
    !headlessTokenRegion?.includes(
      'stillOwnsHeadlessStart = sHeadlessStartTokens.get(appScopeKey) == headlessStartToken',
    ) ||
    !headlessTokenRegion.includes('sHeadlessTaskIds.remove(headlessStartToken)') ||
    queuedLoaderGuardIndex == null ||
    queuedLoaderGuardIndex < 0 ||
    queuedKeeperIndex == null ||
    queuedKeeperIndex <= queuedLoaderGuardIndex ||
    queuedLoadIndex == null ||
    queuedLoadIndex <= queuedKeeperIndex ||
    !preJsSettlementRegion ||
    preJsSettlementRegion.includes('unregisterAllTasksForAppScopeKey') ||
    preJsSettlementRegion.includes('response.put("result"')
  ) {
    errors.push(
      'expo-task-manager service must preserve locked one-owner handoff and generation-bound failure settlement',
    );
  }

  if (
    !repositorySource?.includes(
      'boolean removeEventForAppScopeKey(String appScopeKey, Bundle body);',
    ) ||
    !bareRepositorySource?.includes(
      'public boolean removeEventForAppScopeKey(String appScopeKey, Bundle body)',
    ) ||
    !managedRepositorySource?.includes(
      'public boolean removeEventForAppScopeKey(String appScopeKey, Bundle body)',
    ) ||
    !bareRepositorySource?.includes('if (events == null || !events.remove(body))') ||
    !managedRepositorySource?.includes('if (events == null || !events.remove(body))')
  ) {
    errors.push('expo-task-manager repositories must remove the exact still-queued event');
  }

  return errors;
}

/**
 * Keep SDK 57's experimental Router stack safe for Gator's predictive-Back contract.
 *
 * Upstream 57.0.24 does not redispatch a native dismissal that usePreventRemove blocked, so
 * authored-work guards never receive the pending pop action. It also paints every scene white,
 * which flashes during the preview in this dark-only app. Every route layout must use the same
 * stack on Android; mixing the standard and experimental navigators disables the native preview
 * contract.
 */
export function validateExpoRouterPredictiveBackBridge({
  packageJson,
  packageLock,
  appConfigSource,
  patchSource,
  experimentalStackSource,
  screensPatchSource,
  stackContainerSource,
  rootLayoutSource,
  setupLayoutSource,
  appLayoutSource,
}) {
  const errors = [];
  const predictiveBackOptIns =
    typeof appConfigSource === 'string'
      ? (appConfigSource.match(/^\s*predictiveBackGestureEnabled:\s*true,?\s*$/gm) ?? [])
      : [];
  const predictiveBackKeys =
    typeof appConfigSource === 'string'
      ? (appConfigSource.match(/^\s*predictiveBackGestureEnabled\s*:/gm) ?? [])
      : [];
  if (predictiveBackOptIns.length !== 1 || predictiveBackKeys.length !== 1) {
    errors.push('app.config.ts must set android.predictiveBackGestureEnabled to true exactly once');
  }
  const expectedRange = `~${EXPO_ROUTER_VERSION}`;
  if (packageJson?.dependencies?.['expo-router'] !== expectedRange) {
    errors.push(`expo-router must remain pinned to ${expectedRange} while its local patch applies`);
  }
  if (packageLock?.packages?.['']?.dependencies?.['expo-router'] !== expectedRange) {
    errors.push(`package-lock root must pin expo-router to ${expectedRange}`);
  }
  if (packageLock?.packages?.['node_modules/expo-router']?.version !== EXPO_ROUTER_VERSION) {
    errors.push(`package-lock must resolve expo-router ${EXPO_ROUTER_VERSION}`);
  }
  if (packageJson?.dependencies?.['react-native-screens'] !== REACT_NATIVE_SCREENS_RANGE) {
    errors.push(
      `react-native-screens must remain pinned to ${REACT_NATIVE_SCREENS_RANGE} while its local patch applies`,
    );
  }
  if (
    packageLock?.packages?.['']?.dependencies?.['react-native-screens'] !==
    REACT_NATIVE_SCREENS_RANGE
  ) {
    errors.push(`package-lock root must pin react-native-screens to ${REACT_NATIVE_SCREENS_RANGE}`);
  }
  if (
    packageLock?.packages?.['node_modules/react-native-screens']?.version !==
    REACT_NATIVE_SCREENS_VERSION
  ) {
    errors.push(`package-lock must resolve react-native-screens ${REACT_NATIVE_SCREENS_VERSION}`);
  }

  const patchHeaders =
    typeof patchSource === 'string'
      ? [...patchSource.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
      : [];
  if (
    patchHeaders.length !== 1 ||
    patchHeaders[0]?.[1] !== EXPO_ROUTER_EXPERIMENTAL_STACK_PATH ||
    patchHeaders[0]?.[2] !== EXPO_ROUTER_EXPERIMENTAL_STACK_PATH
  ) {
    errors.push(`${EXPO_ROUTER_PATCH_PATH} must patch only the reviewed experimental stack file`);
  }

  const patchMarkers = [
    '+                        navigation.dispatch({',
    '+                            ...native_1.StackActions.pop(),',
    '+                            source: route.key,',
    '+                            target: state.key,',
    '+    const { colors } = (0, native_1.useTheme)();',
    '+    return ((0, jsx_runtime_1.jsxs)(experimental_1.Stack.Screen,',
    'style: [styles.scene, { backgroundColor: colors.background }]',
    'headerConfigProps.hidden === true ? null :',
    "-        backgroundColor: 'white',",
  ];
  if (patchMarkers.some((marker) => !patchSource?.includes(marker))) {
    errors.push(`${EXPO_ROUTER_PATCH_PATH} must carry the reviewed pop and theme repairs`);
  }

  const screensPatchHeaders =
    typeof screensPatchSource === 'string'
      ? [...screensPatchSource.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
      : [];
  if (
    screensPatchHeaders.length !== 1 ||
    screensPatchHeaders[0]?.[1] !== REACT_NATIVE_SCREENS_STACK_CONTAINER_PATH ||
    screensPatchHeaders[0]?.[2] !== REACT_NATIVE_SCREENS_STACK_CONTAINER_PATH
  ) {
    errors.push(
      `${REACT_NATIVE_SCREENS_PATCH_PATH} must patch only the reviewed gamma stack container`,
    );
  }
  const screensPatchMarkers = [
    '+        pendingPopOperations.toList().forEach { popOperation ->',
    '+            if (stackModel.none { it.stackScreen === popOperation.screen }) {',
    '+                    pendingPushOperations.indexOfLast { it.screen === popOperation.screen }',
    '+                    pendingPushOperations.removeAt(matchingPushIndex)',
    '+                    pendingPopOperations.remove(popOperation)',
    '+        if (!hasPendingOperations) {',
    '+            val isRootReplacement =',
    '+                stackModel.size == 1 &&',
    '+                    pendingPopOperations.size == 1 &&',
    '+                    pendingPushOperations.size == 1 &&',
    '+                    stackModel.single().stackScreen === pendingPopOperations.single().screen &&',
    '+                    pendingPushOperations.single().screen !== pendingPopOperations.single().screen',
    '+            if (isRootReplacement) {',
    '+                fragmentOps.add(RemoveOp(fragment))',
    '+                check(stackModel.size > 1) {',
    '+                    "[RNScreens] Attempt to pop last screen from the stack"',
    '+                fragmentOps.add(PopBackStackOp(fragment))',
  ];
  const exactRootReplacementBlock = [
    '            val isRootReplacement =',
    '                stackModel.size == 1 &&',
    '                    pendingPopOperations.size == 1 &&',
    '                    pendingPushOperations.size == 1 &&',
    '                    stackModel.single().stackScreen === pendingPopOperations.single().screen &&',
    '                    pendingPushOperations.single().screen !== pendingPopOperations.single().screen',
    '',
    '            if (isRootReplacement) {',
    '                fragmentOps.add(RemoveOp(fragment))',
    '            } else {',
    '                check(stackModel.size > 1) {',
    '                    "[RNScreens] Attempt to pop last screen from the stack"',
    '                }',
    '',
    '                fragmentOps.add(PopBackStackOp(fragment))',
    '            }',
  ].join('\n');
  const exactRootReplacementPatchBlock = exactRootReplacementBlock
    .split('\n')
    .map((line) => `+${line}`)
    .join('\n');
  if (screensPatchMarkers.some((marker) => !screensPatchSource?.includes(marker))) {
    errors.push(
      `${REACT_NATIVE_SCREENS_PATCH_PATH} must carry the reviewed uncommitted-pair and root-replacement repairs`,
    );
  }
  if (
    screensPatchSource?.split('+            val isRootReplacement =').length !== 2 ||
    !screensPatchSource.includes(exactRootReplacementPatchBlock)
  ) {
    errors.push(
      `${REACT_NATIVE_SCREENS_PATCH_PATH} must preserve the exact reviewed root-replacement predicate and branches`,
    );
  }

  const preventedStart = experimentalStackSource?.indexOf('onNativeDismissPrevented: () => {');
  const preventedEnd =
    preventedStart == null || preventedStart < 0
      ? -1
      : experimentalStackSource.indexOf('} }, route.key)', preventedStart);
  const preventedBlock =
    preventedStart != null && preventedStart >= 0 && preventedEnd > preventedStart
      ? experimentalStackSource.slice(preventedStart, preventedEnd)
      : '';
  if (
    !preventedBlock.includes("type: 'gestureCancel'") ||
    !preventedBlock.includes('navigation.dispatch({') ||
    !preventedBlock.includes('...native_1.StackActions.pop(),') ||
    !preventedBlock.includes('source: route.key,') ||
    !preventedBlock.includes('target: state.key,')
  ) {
    errors.push('installed experimental stack must redispatch the exact prevented pop action');
  }
  if (
    !experimentalStackSource?.includes('const { colors } = (0, native_1.useTheme)();') ||
    !experimentalStackSource.includes(
      'style: [styles.scene, { backgroundColor: colors.background }]',
    ) ||
    experimentalStackSource.includes("backgroundColor: 'white'")
  ) {
    errors.push('installed experimental stack must use the navigation theme background');
  }
  if (
    !experimentalStackSource?.includes(
      'headerConfigProps.hidden === true ? null : (0, jsx_runtime_1.jsx)(experimental_1.Stack.HeaderConfig',
    )
  ) {
    errors.push(
      'installed experimental stack must omit native HeaderConfig when explicitly hidden',
    );
  }

  const fragmentOpsClearStart = stackContainerSource?.indexOf('fragmentOps.clear()');
  const reconciliationStart = stackContainerSource?.indexOf(
    'pendingPopOperations.toList().forEach { popOperation ->',
  );
  const emptyBatchReturnStart = stackContainerSource?.indexOf(
    'if (!hasPendingOperations) {\n            return\n        }',
  );
  const ordinaryPopStart = stackContainerSource?.indexOf('// Handle pop operations first.');
  const popLoopStart = stackContainerSource?.indexOf('pendingPopOperations.forEach { operation ->');
  const rootReplacementStart = stackContainerSource?.indexOf('val isRootReplacement =');
  const rootRemovalStart = stackContainerSource?.indexOf('fragmentOps.add(RemoveOp(fragment))');
  const finalPopGuardStart = stackContainerSource?.indexOf(
    'check(stackModel.size > 1)',
    rootReplacementStart,
  );
  const ordinaryPopOperationStart = stackContainerSource?.indexOf(
    'fragmentOps.add(PopBackStackOp(fragment))',
    rootReplacementStart,
  );
  const pushLoopStart = stackContainerSource?.indexOf(
    'pendingPushOperations.forEach { operation ->',
    rootReplacementStart,
  );
  const pushBackStackDecisionStart = stackContainerSource?.indexOf(
    'addToBackStack = stackModel.isNotEmpty()',
    pushLoopStart,
  );
  if (
    fragmentOpsClearStart == null ||
    fragmentOpsClearStart < 0 ||
    reconciliationStart == null ||
    reconciliationStart < 0 ||
    fragmentOpsClearStart >= reconciliationStart ||
    emptyBatchReturnStart == null ||
    emptyBatchReturnStart <= reconciliationStart ||
    ordinaryPopStart == null ||
    ordinaryPopStart <= emptyBatchReturnStart ||
    popLoopStart == null ||
    popLoopStart <= ordinaryPopStart ||
    rootReplacementStart == null ||
    rootReplacementStart <= popLoopStart ||
    rootRemovalStart == null ||
    rootRemovalStart <= rootReplacementStart ||
    finalPopGuardStart == null ||
    finalPopGuardStart <= rootRemovalStart ||
    ordinaryPopOperationStart == null ||
    ordinaryPopOperationStart <= finalPopGuardStart ||
    pushLoopStart == null ||
    pushLoopStart <= ordinaryPopOperationStart ||
    pushBackStackDecisionStart == null ||
    pushBackStackDecisionStart <= pushLoopStart ||
    !stackContainerSource.includes(
      'if (stackModel.none { it.stackScreen === popOperation.screen })',
    ) ||
    !stackContainerSource.includes(
      'pendingPushOperations.indexOfLast { it.screen === popOperation.screen }',
    ) ||
    !stackContainerSource.includes('pendingPushOperations.removeAt(matchingPushIndex)') ||
    !stackContainerSource.includes('pendingPopOperations.remove(popOperation)') ||
    stackContainerSource.split('val isRootReplacement =').length !== 2 ||
    !stackContainerSource.includes(exactRootReplacementBlock) ||
    !stackContainerSource.includes('stackModel.size == 1 &&') ||
    !stackContainerSource.includes('pendingPopOperations.size == 1 &&') ||
    !stackContainerSource.includes('pendingPushOperations.size == 1 &&') ||
    !stackContainerSource.includes(
      'stackModel.single().stackScreen === pendingPopOperations.single().screen &&',
    ) ||
    !stackContainerSource.includes(
      'pendingPushOperations.single().screen !== pendingPopOperations.single().screen',
    ) ||
    !stackContainerSource.includes('if (isRootReplacement) {') ||
    !stackContainerSource.includes('check(stackModel.size > 1) {') ||
    !stackContainerSource.includes('[RNScreens] Attempt to pop last screen from the stack') ||
    !stackContainerSource.includes('[RNScreens] Attempt to pop non-top screen') ||
    !stackContainerSource.includes('[RNScreens] Stack should never be empty after updates') ||
    !stackContainerSource.includes(
      'checkNotNull(stackModel.find { it.stackScreen === operation.screen })',
    ) ||
    !stackContainerSource.includes('[RNScreens] Unable to find a fragment to pop')
  ) {
    errors.push(
      'installed gamma stack must cancel only identity-matched uncommitted pairs, safely replace a sole root, and reject unmatched pops',
    );
  }

  for (const [label, source] of [
    ['root layout', rootLayoutSource],
    ['setup layout', setupLayoutSource],
    ['authenticated layout', appLayoutSource],
  ]) {
    if (!source?.includes("from 'expo-router'") || !/<ExperimentalStack\b/.test(source)) {
      errors.push(`${label} must render Expo Router ExperimentalStack`);
    }
    if (/<Stack\b/.test(source)) {
      errors.push(`${label} must not mix the standard Stack with ExperimentalStack`);
    }
    if (
      !/<ExperimentalStack\s+screenOptions=\{\{\s*headerShown:\s*false\s*\}\}\s*\/>/.test(source)
    ) {
      errors.push(`${label} must keep its experimental stack explicitly headerless`);
    }
  }

  return errors;
}

/**
 * Keep the SDK 57 upload redirect repair durable across installs and native builds.
 *
 * Expo file-system ships a prebuilt Android AAR, so merely patching its Kotlin source is inert.
 * The exact package must remain pinned, patch-package must restore the source after npm ci, and
 * Expo autolinking must compile that source instead of resolving the bundled AAR.
 */
export function validateExpoFileSystemRedirectContainment({
  packageJson,
  packageLock,
  patchSource,
  legacyModuleSource,
  appConfigSource,
}) {
  const errors = [];
  if (packageJson?.dependencies?.['expo-file-system'] !== EXPO_FILE_SYSTEM_VERSION) {
    errors.push(`expo-file-system must be pinned exactly to ${EXPO_FILE_SYSTEM_VERSION}`);
  }
  if (
    packageLock?.packages?.['']?.dependencies?.['expo-file-system'] !== EXPO_FILE_SYSTEM_VERSION
  ) {
    errors.push(
      `package-lock root must pin expo-file-system exactly to ${EXPO_FILE_SYSTEM_VERSION}`,
    );
  }
  if (
    packageLock?.packages?.['node_modules/expo-file-system']?.version !== EXPO_FILE_SYSTEM_VERSION
  ) {
    errors.push(`package-lock must resolve expo-file-system ${EXPO_FILE_SYSTEM_VERSION}`);
  }
  if (packageJson?.devDependencies?.['patch-package'] !== PATCH_PACKAGE_VERSION) {
    errors.push(`patch-package must be pinned exactly to ${PATCH_PACKAGE_VERSION}`);
  }
  if (packageLock?.packages?.['']?.devDependencies?.['patch-package'] !== PATCH_PACKAGE_VERSION) {
    errors.push(`package-lock root must pin patch-package exactly to ${PATCH_PACKAGE_VERSION}`);
  }
  if (packageLock?.packages?.['node_modules/patch-package']?.version !== PATCH_PACKAGE_VERSION) {
    errors.push(`package-lock must resolve patch-package ${PATCH_PACKAGE_VERSION}`);
  }
  const postinstallSteps = String(packageJson?.scripts?.postinstall ?? '')
    .split(/\s*&&\s*/)
    .filter(Boolean);
  if (!postinstallSteps.includes('patch-package')) {
    errors.push('package.json postinstall must run patch-package');
  }

  const sourceBuild = packageJson?.expo?.autolinking?.android?.buildFromSource;
  if (
    !Array.isArray(sourceBuild) ||
    sourceBuild.filter((name) => name === 'expo-file-system').length !== 1
  ) {
    errors.push('Expo Android autolinking must build expo-file-system from source exactly once');
  }

  const builder = legacyModuleSource?.match(
    /val builder = OkHttpClient\.Builder\(\)([\s\S]*?)client = builder\.build\(\)/,
  )?.[1];
  if (!builder || countOccurrences(builder, '.followRedirects(false)') !== 1) {
    errors.push('legacy expo-file-system OkHttp builder must disable redirects exactly once');
  }
  if (!builder || countOccurrences(builder, '.followSslRedirects(false)') !== 1) {
    errors.push('legacy expo-file-system OkHttp builder must disable SSL redirects exactly once');
  }

  if (
    !patchSource?.includes(`a/${EXPO_FILE_SYSTEM_LEGACY_ANDROID_PATH}`) ||
    !patchSource.includes('+          .followRedirects(false)') ||
    !patchSource.includes('+          .followSslRedirects(false)')
  ) {
    errors.push(`${EXPO_FILE_SYSTEM_PATCH_PATH} must carry both legacy OkHttp redirect flags`);
  }
  const nativeProofMarkers = [
    'a/node_modules/expo-file-system/android/build.gradle',
    `b/${EXPO_FILE_SYSTEM_REDIRECT_TEST_PATH}`,
    "+  testImplementation 'com.squareup.okhttp3:mockwebserver:4.9.2'",
    '+      val statuses = listOf(301, 302, 303, 307, 308)',
    '+      assertEquals(0, trap.requestCount)',
    '+  fun `redirect policy preserves successful request progress`() {',
    '+  fun `redirect policy preserves active call cancellation`() {',
  ];
  if (nativeProofMarkers.some((marker) => !patchSource?.includes(marker))) {
    errors.push(
      `${EXPO_FILE_SYSTEM_PATCH_PATH} must carry the redirect trap, progress, and cancellation native proof`,
    );
  }
  if (
    !appConfigSource?.includes('process.env.EXPO_PUBLIC_USE_RN_FETCH') ||
    !appConfigSource.includes("rnFetchEscapeHatch === '1'") ||
    !appConfigSource.includes("rnFetchEscapeHatch === 'true'")
  ) {
    errors.push('app config must reject the EXPO_PUBLIC_USE_RN_FETCH redirect escape hatch');
  }
  return errors;
}

// Expo's dev-client overlay legitimately needs this in a debuggable build. It remains forbidden
// in the release manifest and packaged AAB, which are the artifacts shipped to users.
const DEBUG_ONLY_ALLOWED_PERMISSIONS = new Set(['android.permission.SYSTEM_ALERT_WINDOW']);

// This is the sensitive/product permission contract. The merged manifest also contains normal
// platform permissions such as INTERNET and WAKE_LOCK from the runtime and its libraries.
export const REQUIRED_PERMISSIONS = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.READ_CONTACTS',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.CAMERA',
];

const REQUIRED_COMPONENTS = [
  {
    tag: 'service',
    name: 'expo.modules.location.services.LocationTaskService',
    attributes: {
      'android:exported': 'false',
      'android:foregroundServiceType': 'location',
    },
  },
  {
    tag: 'service',
    name: 'app.notifee.core.ReceiverService',
    attributes: { 'android:exported': 'false' },
  },
  {
    tag: 'service',
    name: 'io.invertase.firebase.messaging.ReactNativeFirebaseMessagingHeadlessService',
    attributes: { 'android:exported': 'false' },
  },
  {
    tag: 'service',
    name: 'io.invertase.firebase.messaging.ReactNativeFirebaseMessagingService',
    attributes: { 'android:exported': 'false' },
  },
  {
    tag: 'receiver',
    name: 'expo.modules.taskManager.TaskBroadcastReceiver',
    attributes: { 'android:exported': 'false' },
  },
  {
    tag: 'service',
    name: 'expo.modules.taskManager.TaskJobService',
    attributes: {
      'android:enabled': 'true',
      'android:exported': 'false',
      'android:permission': 'android.permission.BIND_JOB_SERVICE',
    },
  },
];

const REQUIRED_ENTRY_IMPORTS = [
  './src/services/errors/registerReactNativeExceptionPrivacy',
  './src/services/logging/registerPersistentLogs',
  './src/services/notifications/backgroundEvents',
  './src/services/background/registerBackgroundSyncHeadlessTask',
  './src/services/notifications/registerFcmBackgroundHandler',
  './src/services/download/registerBoundedNativeDownloadCleanup',
];

function parseAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(
    /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    attributes.set(match[1], match[2] ?? match[3] ?? '');
  }
  return attributes;
}

// Android's merged manifest is regular element/attribute XML. This small parser deliberately
// strips comments and records the element hierarchy, which prevents a marker in a comment, the
// wrong tag, or the wrong parent from satisfying a component assertion without adding a package.
function parseElements(manifest) {
  const source = manifest.replace(/<!--[\s\S]*?-->/g, '');
  const elements = [];
  const stack = [];
  const tagPattern = /<\s*(\/?)\s*([A-Za-z_][A-Za-z0-9_.:-]*)([^<>]*?)>/g;

  for (const match of source.matchAll(tagPattern)) {
    const closing = match[1] === '/';
    const name = match[2];
    if (closing) {
      const index = stack.findLastIndex((element) => element.name === name);
      if (index >= 0) stack.length = index;
      continue;
    }

    const parent = stack.at(-1);
    const element = {
      name,
      attributes: parseAttributes(match[3] ?? ''),
      parent,
      children: [],
    };
    if (parent) parent.children.push(element);
    elements.push(element);

    if (!/\/\s*>$/.test(match[0])) stack.push(element);
  }

  return elements;
}

function validateSystemCaNetworkSecurityConfigElements(elements) {
  const root = elements.filter(
    (element) => element.name === 'network-security-config' && !element.parent,
  );
  const base = elements.filter(
    (element) => element.name === 'base-config' && element.parent === root[0],
  );
  const anchors = elements.filter(
    (element) => element.name === 'trust-anchors' && element.parent === base[0],
  );
  const certificates = elements.filter(
    (element) => element.name === 'certificates' && element.parent === anchors[0],
  );
  const errors = [];

  if (root.length !== 1 || base.length !== 1 || anchors.length !== 1 || certificates.length !== 1) {
    errors.push('network security config must contain one base system-CA trust chain');
    return errors;
  }
  if (elements.length !== 4) {
    errors.push(
      'network security config must not contain domain, debug, pin, or extra trust rules',
    );
  }
  if (
    base[0].attributes.size !== 1 ||
    base[0].attributes.get('cleartextTrafficPermitted') !== 'true'
  ) {
    errors.push(
      'network security base config must preserve cleartext for the separately consented HTTP path',
    );
  }
  if (certificates[0].attributes.size !== 1 || certificates[0].attributes.get('src') !== 'system') {
    errors.push('network security config must trust only Android system CAs');
  }
  if (certificates[0].compiledAttributeKinds?.has('src')) {
    errors.push('network security config certificate src must be a literal, uncompiled value');
  }
  if (root[0].attributes.size !== 0 || anchors[0].attributes.size !== 0) {
    errors.push('network security config must not add unreviewed root or trust-anchor attributes');
  }

  return errors;
}

export function validateSystemCaNetworkSecurityConfig(source) {
  return validateSystemCaNetworkSecurityConfigElements(parseElements(source));
}

function permissionElementsOf(elements) {
  return elements.filter(
    (element) =>
      /^uses-permission(?:-sdk-\d+)?$/.test(element.name) && element.parent?.name === 'manifest',
  );
}

function permissionsOf(permissionElements) {
  return new Set(
    permissionElements
      .map((element) => element.attributes.get('android:name'))
      .filter((name) => typeof name === 'string'),
  );
}

function hasIntentFilter(activity, requirements) {
  return activity.children
    .filter((child) => child.name === 'intent-filter')
    .some((filter) =>
      requirements.every(([tag, attribute, value]) =>
        filter.children.some(
          (child) => child.name === tag && child.attributes.get(attribute) === value,
        ),
      ),
    );
}

function findLauncherActivity(application) {
  return application?.children.find(
    (child) =>
      child.name === 'activity' &&
      hasIntentFilter(child, [
        ['action', 'android:name', 'android.intent.action.MAIN'],
        ['category', 'android:name', 'android.intent.category.LAUNCHER'],
      ]),
  );
}

function selectArtifactPath(root, explicitPath, candidates) {
  if (explicitPath) return resolve(root, explicitPath);
  return (
    candidates.map((candidate) => resolve(root, candidate)).find(existsSync) ??
    resolve(root, candidates[0])
  );
}

function readVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  let offset = start;

  while (offset < buffer.length && shift <= 63n) {
    const byte = buffer[offset];
    value |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('protobuf varint exceeds JavaScript safe integer range');
      }
      return { value: Number(value), offset };
    }
    shift += 7n;
  }

  throw new Error('protobuf contains a truncated or oversized varint');
}

function decodeProtoFields(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const fields = [];
  let offset = 0;

  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const number = Math.floor(key.value / 8);
    const wireType = key.value & 0x07;
    if (number === 0) throw new Error('protobuf field number must be non-zero');

    if (wireType === 0) {
      const scalar = readVarint(buffer, offset);
      fields.push({ number, wireType, value: scalar.value });
      offset = scalar.offset;
    } else if (wireType === 1 || wireType === 5) {
      const length = wireType === 1 ? 8 : 4;
      if (offset + length > buffer.length) throw new Error('protobuf fixed field is truncated');
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + length) });
      offset += length;
    } else if (wireType === 2) {
      const size = readVarint(buffer, offset);
      offset = size.offset;
      const end = offset + size.value;
      if (end > buffer.length) throw new Error('protobuf length-delimited field is truncated');
      fields.push({ number, wireType, value: buffer.subarray(offset, end) });
      offset = end;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }

  return fields;
}

function messageFields(fields, number) {
  return fields
    .filter((field) => field.number === number && field.wireType === 2)
    .map((field) => field.value);
}

function stringField(fields, number) {
  const matches = messageFields(fields, number);
  if (matches.length > 1) throw new Error(`protobuf field ${number} is unexpectedly repeated`);
  return matches[0]?.toString('utf8');
}

function scalarField(fields, number) {
  const matches = fields.filter((field) => field.number === number && field.wireType === 0);
  if (matches.length > 1) throw new Error(`protobuf field ${number} is unexpectedly repeated`);
  return matches[0]?.value;
}

function wrappedIdField(fields, number, label) {
  const messages = messageFields(fields, number);
  if (messages.length !== 1) throw new Error(`${label} must contain exactly one id wrapper`);
  const id = scalarField(decodeProtoFields(messages[0]), 1);
  if (!Number.isSafeInteger(id)) throw new Error(`${label} is missing a valid id`);
  return id;
}

function qualifiedProtoXmlName(namespace, localName, label) {
  if (localName.includes(':')) {
    throw new Error(`protobuf XML ${label} local name must not contain a namespace prefix`);
  }
  if (!namespace) return localName;
  if (namespace === ANDROID_NAMESPACE) return `android:${localName}`;
  return `{${namespace}}${localName}`;
}

function decodeProtoXmlAttribute(input) {
  const fields = decodeProtoFields(input);
  const namespace = stringField(fields, 1) ?? '';
  const localName = stringField(fields, 2);
  if (!localName) throw new Error('protobuf XML attribute is missing its name');
  const name = qualifiedProtoXmlName(namespace, localName, 'attribute');
  const compiledItems = messageFields(fields, 6);
  if (compiledItems.length > 1) {
    throw new Error(`protobuf XML attribute ${name} repeats its compiled item`);
  }
  let compiledResourceId;
  let compiledReferenceName;
  let compiledItemKind;
  let compiledReferenceIsPlain = false;
  if (compiledItems.length === 1) {
    const itemFields = decodeProtoFields(compiledItems[0]);
    const itemValues = itemFields.filter((field) => field.number >= 1 && field.number <= 7);
    if (itemValues.length !== 1 || itemValues[0].wireType !== 2) {
      throw new Error(`protobuf XML attribute ${name} compiled item must have exactly one value`);
    }
    compiledItemKind = itemValues[0].number;
    if (compiledItemKind === 1) {
      const referenceFields = decodeProtoFields(itemValues[0].value);
      compiledResourceId = scalarField(referenceFields, 2);
      compiledReferenceName = stringField(referenceFields, 3);
      compiledReferenceIsPlain =
        (scalarField(referenceFields, 1) ?? 0) === 0 &&
        (scalarField(referenceFields, 4) ?? 0) === 0 &&
        messageFields(referenceFields, 5).length === 0 &&
        (scalarField(referenceFields, 7) ?? 0) === 0 &&
        !itemFields.some((field) => field.number >= 8);
    }
  }
  return {
    name,
    value: stringField(fields, 3) ?? '',
    compiledResourceId,
    compiledReferenceName,
    compiledItemKind,
    compiledReferenceIsPlain,
  };
}

function decodeProtoXmlNode(input, parent, elements) {
  const fields = decodeProtoFields(input);
  const encodedElements = messageFields(fields, 1);
  const encodedTexts = messageFields(fields, 2);
  if (encodedElements.length + encodedTexts.length !== 1) {
    throw new Error('protobuf XML node must contain exactly one element or text value');
  }
  if (encodedTexts.length === 1) return undefined;
  const encodedElement = encodedElements[0];

  const elementFields = decodeProtoFields(encodedElement);
  const namespace = stringField(elementFields, 2) ?? '';
  const localName = stringField(elementFields, 3);
  if (!localName) throw new Error('protobuf XML element is missing its name');
  const name = qualifiedProtoXmlName(namespace, localName, 'element');
  const element = {
    name,
    attributes: new Map(),
    compiledAttributeKinds: new Map(),
    compiledReferenceNames: new Map(),
    plainCompiledReferences: new Set(),
    compiledResourceIds: new Map(),
    parent,
    children: [],
  };
  for (const encodedAttribute of messageFields(elementFields, 4)) {
    const attribute = decodeProtoXmlAttribute(encodedAttribute);
    if (element.attributes.has(attribute.name)) {
      throw new Error(`protobuf XML element ${name} repeats attribute ${attribute.name}`);
    }
    element.attributes.set(attribute.name, attribute.value);
    if (attribute.compiledItemKind !== undefined) {
      element.compiledAttributeKinds.set(attribute.name, attribute.compiledItemKind);
    }
    if (attribute.compiledReferenceIsPlain) {
      element.plainCompiledReferences.add(attribute.name);
    }
    if (attribute.compiledReferenceName !== undefined) {
      element.compiledReferenceNames.set(attribute.name, attribute.compiledReferenceName);
    }
    if (attribute.compiledResourceId !== undefined) {
      element.compiledResourceIds.set(attribute.name, attribute.compiledResourceId);
    }
  }
  if (parent) parent.children.push(element);
  elements.push(element);
  for (const encodedChild of messageFields(elementFields, 5)) {
    decodeProtoXmlNode(encodedChild, element, elements);
  }
  return element;
}

export function decodeProtoXml(input) {
  const elements = [];
  const root = decodeProtoXmlNode(input, undefined, elements);
  if (!root) throw new Error('protobuf XML document has no root element');
  return elements;
}

function validateOwnedShareTargetElements(elements) {
  const errors = [];
  const roots = elements.filter((element) => element.parent == null);
  if (roots.length !== 1 || roots[0].name !== 'shortcuts') {
    return ['packaged shortcuts.xml must contain exactly one <shortcuts> root'];
  }
  const root = roots[0];
  const targets = root.children.filter((child) => child.name === 'share-target');
  if (root.children.length !== 1 || targets.length !== 1) {
    errors.push('packaged shortcuts.xml must contain exactly one owned <share-target>');
    return errors;
  }

  const target = targets[0];
  if (target.attributes.get('android:targetClass') !== SHARE_TARGET_ACTIVITY) {
    errors.push(`packaged share-target must target ${SHARE_TARGET_ACTIVITY}`);
  }
  const data = target.children.filter((child) => child.name === 'data');
  const categories = target.children.filter((child) => child.name === 'category');
  if (
    target.children.length !== 2 ||
    data.length !== 1 ||
    data[0].attributes.get('android:mimeType') !== '*/*'
  ) {
    errors.push('packaged share-target must declare exactly one */* data element');
  }
  if (
    categories.length !== 1 ||
    categories[0].attributes.get('android:name') !== SHARE_TARGET_CATEGORY
  ) {
    errors.push(`packaged share-target must declare exactly one ${SHARE_TARGET_CATEGORY} category`);
  }
  return errors;
}

/**
 * Resolve the manifest's compiled Network Security Config reference through the AAB resource table.
 * This prevents a safe-looking, unused XML file from hiding a qualified variant or values alias
 * that Android would select at runtime.
 */
export function resolvePackagedNetworkSecurityConfig(manifestProto, resourcesProto) {
  const manifestElements = decodeProtoXml(manifestProto);
  const manifest = manifestElements.find(
    (element) => element.name === 'manifest' && element.parent == null,
  );
  const application = manifestElements.find(
    (element) => element.name === 'application' && element.parent?.name === 'manifest',
  );
  const packageName = manifest?.attributes.get('package');
  const reference = application?.attributes.get('android:networkSecurityConfig');
  const compiledResourceId = application?.compiledResourceIds.get('android:networkSecurityConfig');
  if (!packageName) throw new Error('packaged manifest is missing its application package');
  if (reference !== NETWORK_SECURITY_CONFIG_REFERENCE) {
    throw new Error(
      `packaged manifest must reference ${NETWORK_SECURITY_CONFIG_REFERENCE} exactly`,
    );
  }
  if (
    application?.compiledAttributeKinds.get('android:networkSecurityConfig') !== 1 ||
    !application?.plainCompiledReferences.has('android:networkSecurityConfig')
  ) {
    throw new Error(
      'packaged manifest network security config must compile to one plain resource reference',
    );
  }
  const compiledReferenceName = application.compiledReferenceNames.get(
    'android:networkSecurityConfig',
  );
  if (compiledReferenceName && compiledReferenceName !== 'xml/network_security_config') {
    throw new Error(
      'packaged manifest network security config compiled reference has the wrong name',
    );
  }
  if (!Number.isSafeInteger(compiledResourceId) || compiledResourceId <= 0) {
    throw new Error(
      'packaged manifest network security config is missing its compiled resource id',
    );
  }

  const tableFields = decodeProtoFields(resourcesProto);
  const matches = [];
  for (const packageMessage of messageFields(tableFields, 2)) {
    const packageFields = decodeProtoFields(packageMessage);
    const candidatePackageName = stringField(packageFields, 2);
    if (candidatePackageName !== packageName) continue;
    const packageId = wrappedIdField(packageFields, 1, `resource package ${packageName}`);

    for (const typeMessage of messageFields(packageFields, 3)) {
      const typeFields = decodeProtoFields(typeMessage);
      if (stringField(typeFields, 2) !== 'xml') continue;
      const typeId = wrappedIdField(typeFields, 1, 'xml resource type');

      for (const entryMessage of messageFields(typeFields, 3)) {
        const entryFields = decodeProtoFields(entryMessage);
        if (stringField(entryFields, 2) !== 'network_security_config') continue;
        const entryId = wrappedIdField(entryFields, 1, 'network_security_config resource');
        matches.push({
          resourceId: packageId * 0x1000000 + typeId * 0x10000 + entryId,
          activeValues: messageFields(entryFields, 6),
          disabledValues: messageFields(entryFields, 8),
        });
      }
    }
  }

  if (matches.length !== 1) {
    throw new Error(
      `AAB resource table must contain exactly one ${packageName}:xml/network_security_config entry`,
    );
  }
  const match = matches[0];
  if (match.resourceId !== compiledResourceId) {
    throw new Error(
      'packaged manifest network security config id does not match the named resource-table entry',
    );
  }
  if (match.disabledValues.length !== 0) {
    throw new Error('network_security_config must not have flag-disabled resource variants');
  }
  if (match.activeValues.length !== 1) {
    throw new Error('network_security_config must have exactly one active resource value');
  }

  const configValueFields = decodeProtoFields(match.activeValues[0]);
  const configurations = messageFields(configValueFields, 1);
  if (
    configurations.length > 1 ||
    (configurations.length === 1 && decodeProtoFields(configurations[0]).length !== 0)
  ) {
    throw new Error('network_security_config must not have a qualified resource variant');
  }
  const values = messageFields(configValueFields, 2);
  if (values.length !== 1) throw new Error('network_security_config resource value is missing');
  const valueFields = decodeProtoFields(values[0]);
  const items = messageFields(valueFields, 4);
  if (items.length !== 1 || messageFields(valueFields, 5).length !== 0) {
    throw new Error('network_security_config resource value must be one file item');
  }

  const itemFields = decodeProtoFields(items[0]);
  if (messageFields(itemFields, 1).length !== 0) {
    throw new Error('network_security_config resource aliases are forbidden');
  }
  if (
    itemFields.some(
      (field) =>
        (field.number >= 1 && field.number <= 7 && field.number !== 5) || field.number >= 8,
    )
  ) {
    throw new Error('network_security_config must be an unflagged protobuf XML file reference');
  }
  const files = messageFields(itemFields, 5);
  if (files.length !== 1) {
    throw new Error('network_security_config must resolve to exactly one protobuf XML file');
  }
  const fileFields = decodeProtoFields(files[0]);
  const path = stringField(fileFields, 1);
  const fileType = scalarField(fileFields, 2);
  if (
    !path ||
    !/^res\/(?:[^/]+\/)?[^/]+\.xml$/.test(path) ||
    path.includes('..') ||
    fileType !== 3
  ) {
    throw new Error('network_security_config must resolve to a safe PROTO_XML resource path');
  }

  return { path, resourceId: compiledResourceId };
}

export function validatePackagedAndroidBundle({
  manifestProto,
  networkSecurityConfigProto,
  shortcutsProto,
  dexBytes,
}) {
  const errors = [];

  try {
    const manifestElements = decodeProtoXml(manifestProto);
    errors.push(
      ...validateManifestElements(manifestElements).map((error) => `packaged manifest: ${error}`),
    );
  } catch (error) {
    errors.push(
      `packaged manifest protobuf is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!networkSecurityConfigProto) {
    errors.push('packaged network security config protobuf is missing');
  } else {
    try {
      errors.push(
        ...validateSystemCaNetworkSecurityConfigElements(
          decodeProtoXml(networkSecurityConfigProto),
        ).map((error) => `packaged network security config: ${error}`),
      );
    } catch (error) {
      errors.push(
        `packaged network security config protobuf is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (!shortcutsProto) {
    errors.push('packaged owned shortcuts.xml is missing');
  } else {
    try {
      errors.push(...validateOwnedShareTargetElements(decodeProtoXml(shortcutsProto)));
    } catch (error) {
      errors.push(
        `packaged shortcuts.xml protobuf is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (dexBytes) {
    for (const marker of REQUIRED_BACKGROUND_TASK_RETRY_DEX_MARKERS) {
      if (!dexBytes.includes(Buffer.from(marker, 'utf8'))) {
        errors.push(`packaged DEX is missing required background-task retry marker: ${marker}`);
      }
    }
    for (const marker of REQUIRED_TASK_MANAGER_SETTLEMENT_DEX_MARKERS) {
      if (!dexBytes.includes(Buffer.from(marker, 'utf8'))) {
        errors.push(`packaged DEX is missing required task-manager settlement marker: ${marker}`);
      }
    }
    for (const marker of REQUIRED_PINNED_SHORTCUT_CLEANUP_DEX_MARKERS) {
      if (!dexBytes.includes(Buffer.from(marker, 'utf8'))) {
        errors.push(`packaged DEX is missing required pinned-shortcut cleanup marker: ${marker}`);
      }
    }
    for (const marker of REQUIRED_SHARE_INTAKE_DEX_MARKERS) {
      if (!dexBytes.includes(Buffer.from(marker, 'utf8'))) {
        errors.push(`packaged DEX is missing required owned-share intake marker: ${marker}`);
      }
    }
    for (const marker of FORBIDDEN_LEGACY_SHORTCUT_PUBLISHER_DEX_MARKERS) {
      if (dexBytes.includes(Buffer.from(marker, 'utf8'))) {
        errors.push(`packaged DEX contains forbidden legacy shortcut-publishing marker: ${marker}`);
      }
    }
    const communityWebViewMarker = FORBIDDEN_COMMUNITY_WEBVIEW_DEX_MARKERS.find((marker) =>
      dexBytes.includes(Buffer.from(marker, 'utf8')),
    );
    if (communityWebViewMarker) {
      errors.push(
        `packaged DEX contains forbidden direct community WebView marker: ${communityWebViewMarker}`,
      );
    }
    for (const marker of FORBIDDEN_INBOUND_SHARE_DEX_MARKERS) {
      if (dexBytes.includes(Buffer.from(marker, 'utf8'))) {
        errors.push(`packaged DEX contains disabled inbound-share native marker: ${marker}`);
      }
    }
  }

  return errors;
}

/**
 * Inspect one built Android App Bundle without requiring a generated native tree.
 *
 * This is the release-tool boundary: it applies the same packaged manifest/shortcuts/DEX contract
 * as the full Android build guard, then returns only the finite identity fields needed to bind an
 * artifact to its release record.
 */
export function inspectPackagedAndroidBundle(
  bundlePath,
  { reviewedSensitiveMetadataExceptions = REVIEWED_ANDROID_ABSOLUTE_PATH_EXCEPTIONS } = {},
) {
  const snapshot = readAabArchiveSnapshot(bundlePath);
  const sensitiveMetadataFindings = scanZipArchiveForSensitiveMetadata(
    snapshot.bytes,
    snapshot.archive,
    { reviewedExceptions: reviewedSensitiveMetadataExceptions },
  );
  if (sensitiveMetadataFindings.length > 0) {
    throw new Error(
      [
        'packaged AAB contains forbidden absolute user-directory metadata:',
        ...sensitiveMetadataFindings.map((finding) => `- ${finding.path}: ${finding.rule}`),
      ].join('\n'),
    );
  }

  const manifestEntry = snapshot.archive.entries.find(
    (entry) => entry.path === PACKAGED_MANIFEST_ENTRY && !entry.directory,
  );
  if (!manifestEntry) throw new Error(`could not read ${PACKAGED_MANIFEST_ENTRY} from AAB`);
  const manifestProto = extractZipEntry(snapshot.bytes, manifestEntry, 16 * 1024 * 1024);
  const resourcesEntries = snapshot.archive.entries.filter(
    (entry) => entry.path === PACKAGED_RESOURCES_ENTRY && !entry.directory,
  );
  if (resourcesEntries.length !== 1) {
    throw new Error(
      `expected exactly one ${PACKAGED_RESOURCES_ENTRY} in AAB; found ${resourcesEntries.length}`,
    );
  }
  const resourcesProto = extractZipEntry(snapshot.bytes, resourcesEntries[0], 16 * 1024 * 1024);
  const resolvedNetworkSecurityConfig = resolvePackagedNetworkSecurityConfig(
    manifestProto,
    resourcesProto,
  );
  const packagedNetworkSecurityConfigPath = `base/${resolvedNetworkSecurityConfig.path}`;
  const networkSecurityConfigEntries = snapshot.archive.entries.filter(
    (entry) => entry.path === packagedNetworkSecurityConfigPath && !entry.directory,
  );
  if (networkSecurityConfigEntries.length !== 1) {
    throw new Error(
      `expected exactly one resolved ${packagedNetworkSecurityConfigPath} in AAB; found ${networkSecurityConfigEntries.length}`,
    );
  }
  const networkSecurityConfigProto = extractZipEntry(
    snapshot.bytes,
    networkSecurityConfigEntries[0],
    1024 * 1024,
  );
  const shortcutsEntry = snapshot.archive.entries.find(
    (entry) => entry.path === PACKAGED_SHORTCUTS_ENTRY && !entry.directory,
  );
  const dexEntries = snapshot.archive.entries
    .filter((entry) => PACKAGED_DEX_PATTERN.test(entry.path) && !entry.directory)
    .sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  const totalDexBytes = dexEntries.reduce((total, entry) => total + entry.uncompressedBytes, 0);
  if (dexEntries.length === 0 || totalDexBytes === 0 || totalDexBytes > MAX_PACKAGED_DEX_BYTES) {
    throw new Error('packaged DEX entries are missing, empty, or exceed the 256 MiB limit');
  }
  const errors = validatePackagedAndroidBundle({
    manifestProto,
    networkSecurityConfigProto,
    shortcutsProto: shortcutsEntry
      ? extractZipEntry(snapshot.bytes, shortcutsEntry, 16 * 1024 * 1024)
      : undefined,
    // The package/lock/autolinking checks prevent a clean build from linking the removed module.
    // This additionally rejects a stale or otherwise contaminated release artifact.
    dexBytes: Buffer.concat(
      dexEntries.map((entry) => extractZipEntry(snapshot.bytes, entry, MAX_PACKAGED_DEX_BYTES)),
      totalDexBytes,
    ),
  });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));

  const manifestElements = decodeProtoXml(manifestProto);
  const manifest = manifestElements.find(
    (element) => element.name === 'manifest' && element.parent == null,
  );
  if (!manifest) throw new Error('packaged manifest identity is missing its root element');
  const applicationId = manifest.attributes.get('package');
  const versionName =
    manifest.attributes.get('android:versionName') ?? manifest.attributes.get('versionName');
  const versionCodeText =
    manifest.attributes.get('android:versionCode') ?? manifest.attributes.get('versionCode');
  if (!applicationId) throw new Error('packaged manifest identity is missing package');
  if (!versionName) throw new Error('packaged manifest identity is missing versionName');
  if (!versionCodeText || !/^[1-9]\d*$/.test(versionCodeText)) {
    throw new Error('packaged manifest identity has an invalid versionCode');
  }
  const versionCode = Number(versionCodeText);
  if (!Number.isSafeInteger(versionCode)) {
    throw new Error('packaged manifest identity versionCode exceeds the safe integer range');
  }

  const googleMapsApiKey = googleMapsApiKeyFromElements(manifestElements).value;
  if (!googleMapsApiKey) {
    throw new Error('packaged manifest identity is missing its validated Google Maps API key');
  }

  return {
    applicationId,
    versionName,
    versionCode,
    googleMapsApiKeySha256: createHash('sha256').update(googleMapsApiKey).digest('hex'),
  };
}

function googleMapsApiKeyFromElements(elements) {
  const application = elements.find(
    (element) => element.name === 'application' && element.parent?.name === 'manifest',
  );
  const entries = (application?.children ?? []).filter(
    (child) =>
      child.name === 'meta-data' &&
      child.attributes.get('android:name') === GOOGLE_MAPS_API_KEY_METADATA_NAME,
  );
  return {
    count: entries.length,
    value: entries[0]?.attributes.get('android:value'),
  };
}

function validateOwnedShareManifest(application, launcherActivity) {
  const errors = [];
  if (!launcherActivity) return errors;

  const shortcutMetadata = launcherActivity.children.filter(
    (child) =>
      child.name === 'meta-data' &&
      child.attributes.get('android:name') === 'android.app.shortcuts',
  );
  if (shortcutMetadata.length !== 1) {
    errors.push('launcher activity must declare android.app.shortcuts meta-data exactly once');
  } else if (shortcutMetadata[0].attributes.get('android:resource') !== '@xml/shortcuts') {
    errors.push('launcher android.app.shortcuts meta-data must reference "@xml/shortcuts"');
  }

  const components = (application?.children ?? []).filter(
    (child) => child.name === 'activity' || child.name === 'activity-alias',
  );
  for (const component of components) {
    for (const filter of component.children.filter((child) => child.name === 'intent-filter')) {
      const actions = filter.children
        .filter((child) => child.name === 'action')
        .map((child) => child.attributes.get('android:name'));
      const ownedActions = actions.filter((action) => REQUIRED_SHARE_ACTIONS.includes(action));
      if (ownedActions.length === 0) continue;
      if (component !== launcherActivity) {
        for (const action of ownedActions) {
          errors.push(
            `${component.attributes.get('android:name') ?? component.name} must not declare owned inbound ${action}`,
          );
        }
        continue;
      }

      const categories = filter.children
        .filter((child) => child.name === 'category')
        .map((child) => child.attributes.get('android:name'));
      const mimeTypes = filter.children
        .filter((child) => child.name === 'data')
        .map((child) => child.attributes.get('android:mimeType'));
      const action = ownedActions[0];
      if (
        ownedActions.length !== 1 ||
        actions.length !== 1 ||
        categories.length !== 1 ||
        categories[0] !== 'android.intent.category.DEFAULT' ||
        mimeTypes.length !== 1 ||
        mimeTypes[0] !== '*/*' ||
        filter.children.some((child) => !['action', 'category', 'data'].includes(child.name))
      ) {
        errors.push(
          `launcher ${action ?? 'share'} intent-filter must contain only its action, DEFAULT, and */*`,
        );
      }
    }
  }

  for (const action of REQUIRED_SHARE_ACTIONS) {
    const matches = launcherActivity.children
      .filter((child) => child.name === 'intent-filter')
      .filter((filter) =>
        filter.children.some(
          (child) => child.name === 'action' && child.attributes.get('android:name') === action,
        ),
      );
    if (matches.length !== 1) {
      errors.push(`launcher activity must declare inbound ${action} exactly once`);
    }
  }

  return errors;
}

function validateManifestElements(elements, { debug = false } = {}) {
  const errors = [];
  const manifest = elements.find(
    (element) => element.name === 'manifest' && element.parent == null,
  );
  const usesSdk = (manifest?.children ?? []).filter((element) => element.name === 'uses-sdk');
  if (usesSdk.length !== 1) {
    errors.push('manifest must declare exactly one <uses-sdk> element');
  } else if (usesSdk[0].attributes.get('android:minSdkVersion') !== REQUIRED_MIN_SDK_VERSION) {
    errors.push(`manifest android:minSdkVersion must be exactly ${REQUIRED_MIN_SDK_VERSION}`);
  }
  const permissionElements = permissionElementsOf(elements);
  const permissions = permissionsOf(permissionElements);

  for (const permission of FORBIDDEN_PERMISSIONS) {
    if (debug && DEBUG_ONLY_ALLOWED_PERMISSIONS.has(permission)) continue;
    if (permissions.has(permission)) errors.push(`forbidden permission is merged: ${permission}`);
  }
  for (const permission of REQUIRED_PERMISSIONS) {
    const declarations = permissionElements.filter(
      (element) => element.attributes.get('android:name') === permission,
    );
    if (declarations.length === 0) {
      errors.push(`required permission is missing: ${permission}`);
    } else if (declarations.every((element) => element.attributes.has('android:maxSdkVersion'))) {
      errors.push(`required permission is capped by android:maxSdkVersion: ${permission}`);
    }
  }

  const application = elements.find(
    (element) => element.name === 'application' && element.parent?.name === 'manifest',
  );
  if (application?.attributes.get('android:allowBackup') !== 'false') {
    errors.push('application must set android:allowBackup="false"');
  }
  if (
    application?.attributes.get('android:networkSecurityConfig') !==
    NETWORK_SECURITY_CONFIG_REFERENCE
  ) {
    errors.push(
      `application must set android:networkSecurityConfig="${NETWORK_SECURITY_CONFIG_REFERENCE}"`,
    );
  }
  if (application?.attributes.get('android:enableOnBackInvokedCallback') !== 'true') {
    errors.push('application must set android:enableOnBackInvokedCallback="true"');
  }

  const mapsApiKey = googleMapsApiKeyFromElements(elements);
  if (mapsApiKey.count !== 1) {
    errors.push('application must declare exactly one Google Maps API key metadata entry');
  } else if (!mapsApiKey.value || !GOOGLE_MAPS_API_KEY_PATTERN.test(mapsApiKey.value)) {
    errors.push('Google Maps API key metadata must contain a valid Google API key');
  }

  for (const component of REQUIRED_COMPONENTS) {
    const element = application?.children.find(
      (child) =>
        child.name === component.tag && child.attributes.get('android:name') === component.name,
    );
    if (!element) {
      errors.push(`merged manifest is missing <${component.tag}> ${component.name}`);
      continue;
    }
    for (const [attribute, value] of Object.entries(component.attributes)) {
      if (element.attributes.get(attribute) !== value) {
        errors.push(`${component.name} must set ${attribute}="${value}"`);
      }
    }
  }

  const launcherActivity = findLauncherActivity(application);
  if (!launcherActivity) {
    errors.push('merged manifest is missing the launcher activity');
  } else {
    errors.push(...validateOwnedShareManifest(application, launcherActivity));
  }

  return errors;
}

export function validateAndroidBuild({ manifest, packageJson, entrySource, debug = false }) {
  return [
    ...validateManifestElements(parseElements(manifest), { debug }),
    ...validateHeadlessEntry({ packageJson, entrySource }),
  ];
}

function entrySideEffectImports(entrySource) {
  return [...entrySource.matchAll(/^\s*import\s+['"]([^'"]+)['"];?\s*$/gm)].map(
    (match) => match[1],
  );
}

/**
 * Validate the JavaScript bundle entry without requiring generated Android artifacts.
 *
 * The full Android guard reuses this exact function for manifest/AAB validation, while the ordinary
 * architecture gate can call it directly so a missing, late, or bypassed headless registration
 * fails during repository-local checks too.
 */
export function validateHeadlessEntry({ packageJson, entrySource }) {
  const errors = [];

  if (packageJson.main !== 'index.js') errors.push('package.json main must remain index.js');
  const entryImports = entrySideEffectImports(entrySource);
  const staticImports = [...entrySource.matchAll(/^\s*import\b[^\n]*$/gm)];
  if (staticImports.length !== entryImports.length) {
    errors.push('index.js may contain only ordered side-effect imports');
  }
  const routerIndex = entryImports.indexOf('expo-router/entry');
  if (entryImports[0] !== './src/services/errors/registerReactNativeExceptionPrivacy') {
    errors.push(
      'the React Native exception privacy boundary must be the first index.js side-effect import',
    );
  }
  if (entryImports[1] !== './src/services/logging/registerPersistentLogs') {
    errors.push(
      'the persistent log sink must be the second index.js side-effect import, before headless tasks',
    );
  }
  if (routerIndex < 0) {
    errors.push('index.js must import expo-router/entry');
  } else if (routerIndex !== entryImports.length - 1) {
    errors.push('expo-router/entry must be the final side-effect import');
  }
  for (const requiredImport of REQUIRED_ENTRY_IMPORTS) {
    const index = entryImports.indexOf(requiredImport);
    if (index < 0) errors.push(`index.js is missing required startup import ${requiredImport}`);
    else if (routerIndex >= 0 && index > routerIndex) {
      errors.push(`${requiredImport} must load before expo-router/entry`);
    }
  }

  return errors;
}

export function runHeadlessEntryCheck({ root = process.cwd() } = {}) {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const entrySource = readFileSync(resolve(root, 'index.js'), 'utf8');
  const errors = validateHeadlessEntry({ packageJson, entrySource });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return { imports: entrySideEffectImports(entrySource).length };
}

function withoutKotlinComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

export function validateShareIntakeMainActivity(source) {
  const errors = [];
  const contracts = [
    {
      name: 'onCreate',
      signature: /override\s+fun\s+onCreate\s*\(\s*savedInstanceState:\s*Bundle\?\s*\)\s*\{/g,
      call: SHARE_ON_CREATE_CAPTURE,
      superCall: 'super.onCreate(',
    },
    {
      name: 'onNewIntent',
      signature:
        /override\s+fun\s+onNewIntent\s*\(\s*intent:\s*(?:android\.content\.)?Intent\s*\)\s*\{/g,
      call: SHARE_ON_NEW_INTENT_CAPTURE,
      superCall: 'super.onNewIntent(',
    },
  ];

  for (const contract of contracts) {
    const signatures = [...source.matchAll(contract.signature)];
    if (signatures.length !== 1) {
      errors.push(
        `MainActivity must declare ${contract.name} exactly once for owned share capture`,
      );
      continue;
    }
    if (countOccurrences(source, contract.call) !== 1) {
      errors.push(`MainActivity ${contract.name} must call the owned share capture exactly once`);
      continue;
    }
    const signature = signatures[0];
    const methodStart = signature.index ?? -1;
    const bodyStart = methodStart + signature[0].length;
    const callIndex = source.indexOf(contract.call, bodyStart);
    const superIndex = source.indexOf(contract.superCall, bodyStart);
    if (callIndex < bodyStart || superIndex < bodyStart || callIndex > superIndex) {
      errors.push(
        `MainActivity ${contract.name} must capture the owned share before ${contract.superCall.slice(0, -1)}`,
      );
      continue;
    }
    if (withoutKotlinComments(source.slice(bodyStart, callIndex)).trim().length !== 0) {
      errors.push(`MainActivity ${contract.name} owned share capture must be its first statement`);
    }
  }
  return errors;
}

export function runAndroidBuildCheck({
  root = process.cwd(),
  debugManifestPath,
  releaseManifestPath,
  releaseBundlePath,
} = {}) {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  const entrySource = readFileSync(resolve(root, 'index.js'), 'utf8');
  const manifests = [
    ['debug', selectArtifactPath(root, debugManifestPath, DEFAULT_DEBUG_MANIFESTS)],
    ['release', selectArtifactPath(root, releaseManifestPath, DEFAULT_RELEASE_MANIFESTS)],
  ];
  const errors = validateExpoFileSystemRedirectContainment({
    packageJson,
    packageLock,
    patchSource: readFileSync(resolve(root, EXPO_FILE_SYSTEM_PATCH_PATH), 'utf8'),
    legacyModuleSource: readFileSync(resolve(root, EXPO_FILE_SYSTEM_LEGACY_ANDROID_PATH), 'utf8'),
    appConfigSource: readFileSync(resolve(root, 'app.config.ts'), 'utf8'),
  }).map((error) => `network redirect containment: ${error}`);
  errors.push(
    ...validateExpoBackgroundTaskRetryBridge({
      packageJson,
      packageLock,
      patchSource: readFileSync(resolve(root, EXPO_BACKGROUND_TASK_PATCH_PATH), 'utf8'),
      schedulerSource: readFileSync(resolve(root, EXPO_BACKGROUND_TASK_SCHEDULER_PATH), 'utf8'),
      workerSource: readFileSync(resolve(root, EXPO_BACKGROUND_TASK_WORK_PATH), 'utf8'),
    }).map((error) => `background task retry bridge: ${error}`),
  );
  errors.push(
    ...validateExpoTaskManagerPreJsSettlement({
      packageJson,
      packageLock,
      patchSource: readFileSync(resolve(root, EXPO_TASK_MANAGER_PATCH_PATH), 'utf8'),
      utilsSource: readFileSync(resolve(root, EXPO_TASK_MANAGER_UTILS_PATH), 'utf8'),
      serviceSource: readFileSync(resolve(root, EXPO_TASK_SERVICE_PATH), 'utf8'),
      repositorySource: readFileSync(resolve(root, EXPO_TASKS_REPOSITORY_PATH), 'utf8'),
      bareRepositorySource: readFileSync(resolve(root, EXPO_BARE_TASKS_REPOSITORY_PATH), 'utf8'),
      managedRepositorySource: readFileSync(
        resolve(root, EXPO_MANAGED_TASKS_REPOSITORY_PATH),
        'utf8',
      ),
      taskManagerSource: readFileSync(resolve(root, EXPO_TASK_MANAGER_SOURCE_PATH), 'utf8'),
      taskManagerRuntimeSource: readFileSync(resolve(root, EXPO_TASK_MANAGER_RUNTIME_PATH), 'utf8'),
    }).map((error) => `task-manager pre-JavaScript settlement: ${error}`),
  );
  errors.push(
    ...validateExpoRouterPredictiveBackBridge({
      packageJson,
      packageLock,
      appConfigSource: readFileSync(resolve(root, 'app.config.ts'), 'utf8'),
      patchSource: readFileSync(resolve(root, EXPO_ROUTER_PATCH_PATH), 'utf8'),
      experimentalStackSource: readFileSync(
        resolve(root, EXPO_ROUTER_EXPERIMENTAL_STACK_PATH),
        'utf8',
      ),
      screensPatchSource: readFileSync(resolve(root, REACT_NATIVE_SCREENS_PATCH_PATH), 'utf8'),
      stackContainerSource: readFileSync(
        resolve(root, REACT_NATIVE_SCREENS_STACK_CONTAINER_PATH),
        'utf8',
      ),
      rootLayoutSource: readFileSync(resolve(root, 'app/_layout.tsx'), 'utf8'),
      setupLayoutSource: readFileSync(resolve(root, 'app/(setup)/_layout.tsx'), 'utf8'),
      appLayoutSource: readFileSync(resolve(root, 'app/(app)/_layout.tsx'), 'utf8'),
    }).map((error) => `predictive Back bridge: ${error}`),
  );

  const mainActivityPath = resolve(root, DEFAULT_MAIN_ACTIVITY_SOURCE);
  if (!existsSync(mainActivityPath)) {
    errors.push(`generated MainActivity source is missing: ${mainActivityPath}`);
  } else {
    errors.push(
      ...validateShareIntakeMainActivity(readFileSync(mainActivityPath, 'utf8')).map(
        (error) => `owned share MainActivity capture: ${error}`,
      ),
    );
  }

  const networkSecurityConfigPath = resolve(root, DEFAULT_NETWORK_SECURITY_CONFIG);
  if (!existsSync(networkSecurityConfigPath)) {
    errors.push(`network security config is missing: ${networkSecurityConfigPath}`);
  } else {
    errors.push(
      ...validateSystemCaNetworkSecurityConfig(readFileSync(networkSecurityConfigPath, 'utf8')).map(
        (error) => `network security config: ${error}`,
      ),
    );
  }

  for (const [label, path] of manifests) {
    if (!existsSync(path)) {
      errors.push(`${label} merged manifest is missing: ${path}`);
      continue;
    }
    errors.push(
      ...validateAndroidBuild({
        manifest: readFileSync(path, 'utf8'),
        packageJson,
        entrySource,
        debug: label === 'debug',
      }).map((error) => `${label} manifest: ${error}`),
    );
  }

  const bundlePath = resolve(root, releaseBundlePath ?? DEFAULT_RELEASE_BUNDLE);
  const bundleExists =
    existsSync(bundlePath) && statSync(bundlePath).isFile() && statSync(bundlePath).size > 0;
  if (!bundleExists) {
    errors.push(`release AAB is missing or empty: ${bundlePath}`);
  } else {
    try {
      inspectPackagedAndroidBundle(bundlePath);
    } catch (error) {
      errors.push(
        `release AAB inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return {
    debugManifestPath: manifests[0][1],
    releaseManifestPath: manifests[1][1],
    releaseBundlePath: bundlePath,
    networkSecurityConfigPath,
  };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runAndroidBuildCheck({
      debugManifestPath: process.argv[2],
      releaseManifestPath: process.argv[3],
      releaseBundlePath: process.argv[4],
    });
    console.log(
      `Android artifact guard passed: debug ${result.debugManifestPath}; release ${result.releaseManifestPath}; AAB ${result.releaseBundlePath}.`,
    );
  } catch (error) {
    console.error(
      `Android artifact guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
