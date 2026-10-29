import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import {
  FORBIDDEN_COMMUNITY_WEBVIEW_DEX_MARKERS,
  FORBIDDEN_LEGACY_SHORTCUT_PUBLISHER_DEX_MARKERS,
  FORBIDDEN_PERMISSIONS,
  GOOGLE_MAPS_API_KEY_METADATA_NAME,
  inspectPackagedAndroidBundle,
  NETWORK_SECURITY_CONFIG_REFERENCE,
  REACT_NATIVE_SCREENS_SOURCE_PATHS,
  REQUIRED_BACKGROUND_TASK_RETRY_DEX_MARKERS,
  REQUIRED_PINNED_SHORTCUT_CLEANUP_DEX_MARKERS,
  REQUIRED_SHARE_INTAKE_DEX_MARKERS,
  REQUIRED_TASK_MANAGER_SETTLEMENT_DEX_MARKERS,
  REQUIRED_UPLOAD_FILENAME_DEX_MARKERS,
  UPLOAD_FILENAME_SOURCE_PATHS,
  BACKGROUND_EXECUTION_SOURCE_PATHS,
  REQUIRED_PERMISSIONS,
  runAndroidBuildCheck,
  validateAndroidBuild,
  validateExpoBackgroundTaskRetryBridge,
  validateBackgroundExecutionLifetime,
  validateExpoFileSystemRedirectContainment,
  validateUploadFilenameBridge,
  validateExpoRouterPredictiveBackBridge,
  validateExpoSharingSelfShareSettlement,
  validateExpoTaskManagerPreJsSettlement,
  validateHeadlessEntry,
  validatePackagedAndroidBundle,
  validateShareIntakeMainActivity,
  validateSystemCaNetworkSecurityConfig,
} from './check-android-build.mjs';

const require = createRequire(import.meta.url);
const { applyWebSocketRedirectPolicy } = require('../plugins/withNoWebSocketRedirects');
const {
  NETWORK_SECURITY_CONFIG_XML,
  applySystemCaManifestPolicy,
  writeSystemCaNetworkSecurityConfig,
} = require('../plugins/withSystemCaNetworkSecurity');
const { applyMainActivityShareCapture } = require('../plugins/withShareTargets');
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const androidNamespace = 'http://schemas.android.com/apk/res/android';
const intendedPermissions = [
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
const mapsApiKeyFixture = `AIza${'A'.repeat(35)}`;
const networkSecurityConfigResourceId = 0x7f160009;

function xmlNode(name, attributes = {}, children = [], options = {}) {
  return { name, attributes, children, ...options };
}

function renderXml(node) {
  const attributes = Object.entries(node.attributes)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('');
  if (node.children.length === 0) return `<${node.name}${attributes} />`;
  return `<${node.name}${attributes}>${node.children.map(renderXml).join('')}</${node.name}>`;
}

function intentFilter(action, category, mimeType) {
  return xmlNode('intent-filter', {}, [
    xmlNode('action', { 'android:name': action }),
    xmlNode('category', { 'android:name': category }),
    ...(mimeType ? [xmlNode('data', { 'android:mimeType': mimeType })] : []),
  ]);
}

const manifestNode = xmlNode(
  'manifest',
  {
    'xmlns:android': androidNamespace,
    package: 'com.bluegreengatorapps.messages',
    'android:versionName': '0.1.41',
    'android:versionCode': '57',
  },
  [
    xmlNode('uses-sdk', {
      'android:minSdkVersion': '36',
      'android:targetSdkVersion': '36',
    }),
    ...intendedPermissions.map((name) => xmlNode('uses-permission', { 'android:name': name })),
    // Package visibility for sharing OUT of Gator is harmless. It is not nested below an
    // application component, so it cannot make MainActivity an inbound Android share target.
    xmlNode('queries', {}, [
      xmlNode('intent', {}, [
        xmlNode('action', { 'android:name': 'android.intent.action.SEND' }),
        xmlNode('data', { 'android:mimeType': '*/*' }),
      ]),
    ]),
    xmlNode(
      'application',
      {
        'android:allowBackup': 'false',
        'android:networkSecurityConfig': NETWORK_SECURITY_CONFIG_REFERENCE,
        'android:enableOnBackInvokedCallback': 'true',
      },
      [
        xmlNode('service', {
          'android:name': 'expo.modules.location.services.LocationTaskService',
          'android:exported': 'false',
          'android:foregroundServiceType': 'location',
        }),
        xmlNode('meta-data', {
          'android:name': GOOGLE_MAPS_API_KEY_METADATA_NAME,
          'android:value': mapsApiKeyFixture,
        }),
        xmlNode('activity', { 'android:name': '.MainActivity', 'android:exported': 'true' }, [
          intentFilter('android.intent.action.MAIN', 'android.intent.category.LAUNCHER'),
          intentFilter('android.intent.action.SEND', 'android.intent.category.DEFAULT', '*/*'),
          intentFilter(
            'android.intent.action.SEND_MULTIPLE',
            'android.intent.category.DEFAULT',
            '*/*',
          ),
          xmlNode('meta-data', {
            'android:name': 'android.app.shortcuts',
            'android:resource': '@xml/shortcuts',
          }),
        ]),
        xmlNode('service', {
          'android:name': 'app.notifee.core.ReceiverService',
          'android:exported': 'false',
        }),
        xmlNode('activity', {
          'android:name': 'app.notifee.core.NotificationReceiverActivity',
          'android:exported': 'false',
        }),
        xmlNode('service', {
          'android:name':
            'io.invertase.firebase.messaging.ReactNativeFirebaseMessagingHeadlessService',
          'android:exported': 'false',
        }),
        xmlNode('service', {
          'android:name': 'io.invertase.firebase.messaging.ReactNativeFirebaseMessagingService',
          'android:exported': 'false',
        }),
        xmlNode('receiver', {
          'android:name': 'expo.modules.taskManager.TaskBroadcastReceiver',
          'android:exported': 'false',
        }),
        xmlNode('service', {
          'android:name': 'expo.modules.taskManager.TaskJobService',
          'android:enabled': 'true',
          'android:exported': 'false',
          'android:permission': 'android.permission.BIND_JOB_SERVICE',
        }),
      ],
    ),
  ],
);

const systemCaNetworkSecurityConfigNode = xmlNode('network-security-config', {}, [
  xmlNode('base-config', { cleartextTrafficPermitted: 'true' }, [
    xmlNode('trust-anchors', {}, [xmlNode('certificates', { src: 'system' })]),
  ]),
]);

function ownedShareTargetNode() {
  return xmlNode('shortcuts', {}, [
    xmlNode(
      'share-target',
      { 'android:targetClass': 'com.bluegreengatorapps.messages.MainActivity' },
      [
        xmlNode('data', { 'android:mimeType': '*/*' }),
        xmlNode('category', {
          'android:name': 'com.bluegreengatorapps.messages.category.SHARE_TARGET',
        }),
      ],
    ),
  ]);
}

function encodeVarint(value) {
  const bytes = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function encodeMessageField(number, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([encodeVarint((number << 3) | 2), encodeVarint(payload.length), payload]);
}

function encodeScalarField(number, value) {
  return Buffer.concat([encodeVarint(number << 3), encodeVarint(value)]);
}

function encodeStringField(number, value) {
  return encodeMessageField(number, Buffer.from(value, 'utf8'));
}

function encodeXmlAttribute(name, value, namespaceOverride, compiledItemOverride) {
  const androidName =
    namespaceOverride === undefined && name.startsWith('android:')
      ? name.slice('android:'.length)
      : undefined;
  const namespace = namespaceOverride ?? (androidName ? androidNamespace : '');
  const compiledItem =
    compiledItemOverride ??
    (name === 'android:networkSecurityConfig'
      ? encodeMessageField(
          1,
          Buffer.concat([
            encodeScalarField(2, networkSecurityConfigResourceId),
            encodeStringField(3, 'xml/network_security_config'),
            encodeScalarField(6, 1),
          ]),
        )
      : undefined);
  return Buffer.concat([
    ...(namespace ? [encodeStringField(1, namespace)] : []),
    encodeStringField(2, androidName ?? name),
    encodeStringField(3, value),
    ...(compiledItem ? [encodeMessageField(6, compiledItem)] : []),
  ]);
}

function encodeXmlDocument(node) {
  const attributeEntries =
    node.attributeEntries ??
    Object.entries(node.attributes).map(([name, value]) => [name, value, undefined]);
  const element = Buffer.concat([
    ...(node.namespace ? [encodeStringField(2, node.namespace)] : []),
    encodeStringField(3, node.name),
    ...attributeEntries
      .filter(([name]) => name !== 'xmlns:android')
      .map(([name, value, namespace, compiledItem]) =>
        encodeMessageField(4, encodeXmlAttribute(name, value, namespace, compiledItem)),
      ),
    ...node.children.map((child) => encodeMessageField(5, encodeXmlDocument(child))),
  ]);
  return encodeMessageField(1, element);
}

function encodeNetworkSecurityResourceTable({
  path = 'res/xml/network_security_config.xml',
  repeatedPath,
  aliasResourceId,
  activeValues = 1,
  qualified = false,
  includeDisabledValue = false,
} = {}) {
  const item = aliasResourceId
    ? encodeMessageField(1, encodeScalarField(2, aliasResourceId))
    : encodeMessageField(
        5,
        Buffer.concat([
          encodeStringField(1, path),
          ...(repeatedPath ? [encodeStringField(1, repeatedPath)] : []),
          encodeScalarField(2, 3),
        ]),
      );
  const value = encodeMessageField(4, item);
  const configValue = (qualifiedValue = false) =>
    Buffer.concat([
      ...(qualifiedValue ? [encodeMessageField(1, encodeScalarField(1, 1))] : []),
      encodeMessageField(2, value),
    ]);
  const entry = Buffer.concat([
    encodeMessageField(1, encodeScalarField(1, 9)),
    encodeStringField(2, 'network_security_config'),
    ...Array.from({ length: activeValues }, (_, index) =>
      encodeMessageField(6, configValue(qualified || index > 0)),
    ),
    ...(includeDisabledValue ? [encodeMessageField(8, configValue())] : []),
  ]);
  const type = Buffer.concat([
    encodeMessageField(1, encodeScalarField(1, 22)),
    encodeStringField(2, 'xml'),
    encodeMessageField(3, entry),
  ]);
  const resourcePackage = Buffer.concat([
    encodeMessageField(1, encodeScalarField(1, 0x7f)),
    encodeStringField(2, 'com.bluegreengatorapps.messages'),
    encodeMessageField(3, type),
  ]);
  return encodeMessageField(2, resourcePackage);
}

const manifest = renderXml(manifestNode);
const entrySource = `
import './src/services/errors/registerReactNativeExceptionPrivacy';
import './src/services/logging/registerPersistentLogs';
import './src/services/notifications/backgroundEvents';
import './src/services/background/registerBackgroundSyncHeadlessTask';
import './src/services/notifications/registerFcmBackgroundHandler';
import './src/services/download/registerBoundedNativeDownloadCleanup';
import 'expo-router/entry';
`;
const baseMainActivitySource = `
package com.bluegreengatorapps.messages

import android.os.Bundle
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    prepareSplash()
    super.onCreate(null)
  }
}
`;
const shareMainActivitySource = applyMainActivityShareCapture(baseMainActivitySource);

const redirectContainmentPackageJson = {
  main: 'index.js',
  scripts: { postinstall: 'patch-package --error-on-fail' },
  dependencies: {
    'expo-background-task': '57.0.21',
    'expo-file-system': '57.0.7',
    'expo-router': '~57.0.24',
    'expo-sharing': '~57.0.24',
    'expo-task-manager': '57.0.21',
    'react-native-screens': '~4.26.0',
  },
  devDependencies: { 'patch-package': '8.0.1' },
  expo: {
    autolinking: {
      android: {
        buildFromSource: [
          'expo-background-task',
          'expo-file-system',
          'expo-sharing',
          'expo-task-manager',
          'unimodules-app-loader',
        ],
      },
    },
  },
};
const redirectContainmentPackageLock = {
  packages: {
    '': {
      dependencies: {
        'expo-background-task': '57.0.21',
        'expo-file-system': '57.0.7',
        'expo-router': '~57.0.24',
        'expo-sharing': '~57.0.24',
        'expo-task-manager': '57.0.21',
        'react-native-screens': '~4.26.0',
      },
      devDependencies: { 'patch-package': '8.0.1' },
    },
    'node_modules/expo-background-task': { version: '57.0.21' },
    'node_modules/expo-file-system': { version: '57.0.7' },
    'node_modules/expo-router': { version: '57.0.24' },
    'node_modules/expo-sharing': { version: '57.0.24' },
    'node_modules/expo-task-manager': { version: '57.0.21' },
    'node_modules/react-native-screens': { version: '4.26.2' },
    'node_modules/unimodules-app-loader': { version: '57.0.2' },
    'node_modules/patch-package': { version: '8.0.1' },
  },
};
const redirectContainmentPatchSource = `
diff --git a/node_modules/expo-file-system/android/src/main/java/expo/modules/filesystem/legacy/FileSystemLegacyModule.kt b/node_modules/expo-file-system/android/src/main/java/expo/modules/filesystem/legacy/FileSystemLegacyModule.kt
+          .followRedirects(false)
+          .followSslRedirects(false)
diff --git a/node_modules/expo-file-system/android/build.gradle b/node_modules/expo-file-system/android/build.gradle
+  testImplementation 'com.squareup.okhttp3:mockwebserver:4.9.2'
diff --git a/node_modules/expo-file-system/android/src/test/java/expo/modules/filesystem/legacy/FileSystemLegacyRedirectPolicyTest.kt b/node_modules/expo-file-system/android/src/test/java/expo/modules/filesystem/legacy/FileSystemLegacyRedirectPolicyTest.kt
+      val statuses = listOf(301, 302, 303, 307, 308)
+      assertEquals(0, trap.requestCount)
+  fun \`redirect policy preserves successful request progress\`() {
+  fun \`redirect policy preserves active call cancellation\`() {
`;
const redirectContainmentLegacyModuleSource = `
val builder = OkHttpClient.Builder()
  .followRedirects(false)
  .followSslRedirects(false)
client = builder.build()
`;
const redirectContainmentAppConfigSource = `
const rnFetchEscapeHatch = process.env.EXPO_PUBLIC_USE_RN_FETCH?.trim().toLowerCase();
if (rnFetchEscapeHatch === '1' || rnFetchEscapeHatch === 'true') throw new Error();
const config = {
  android: {
    predictiveBackGestureEnabled: true,
  },
};
`;
const backgroundTaskRetryPatchSource = `
diff --git a/node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskScheduler.kt b/node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskScheduler.kt
+    if (cancelExisting && hasUnfinishedWorker(context)) {
 if (consumers.isEmpty()) {
-      return
+      return true
+        return scheduled
+          val succeeded = result is Number && result.toDouble() == 1.0
+        taskCompletion.complete(false)
+    if (!succeeded) {
+      return false
     }
+      workInfos.any { !it.state.isFinished }
diff --git a/node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskWork.kt b/node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskWork.kt
+      return if (succeeded) Result.success() else Result.retry()
+      return Result.retry()
`;
const backgroundTaskRetrySchedulerSource = `
suspend fun runTasks(context: Context, appScopeKey: String): Boolean {
  if (cancelExisting && hasUnfinishedWorker(context)) {
  val consumers = taskService.getTaskConsumers(appScopeKey)
    .filterIsInstance<BackgroundTaskConsumer>()
    if (consumers.isEmpty()) {
      return true
    }
        Log.d(TAG, "runTasks: Deferred foreground worker; scheduled=$scheduled")
        return scheduled
  val succeeded = result is Number && result.toDouble() == 1.0
        Log.e(TAG, "Task failed: \${e.message}")
        taskCompletion.complete(false)
  val succeeded = tasks.awaitAll().all { it }
    if (!succeeded) {
      return false
    }
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
    scheduleWorker(context, appScopeKey, false)
}
private suspend fun hasUnfinishedWorker(context: Context): Boolean {
  workInfos.any { !it.state.isFinished }
}
catch (e: CancellationException) {
  throw e
}
catch (e: CancellationException) {
  throw e
}
catch (e: CancellationException) {
  throw e
}
catch (e: CancellationException) {
  throw e
}
catch (e: CancellationException) {
  throw e
}
catch (e: CancellationException) {
  cancel(true)
  throw e
}
catch (e: CancellationException) {
  backgroundTaskExecutions.cancel(execution)
  throw e
}
`;
const backgroundTaskRetryWorkerSource = `
if (appScopeKey == null) {
  return Result.failure(outputData)
}
return if (succeeded) Result.success() else Result.retry()
catch (e: CancellationException) {
  throw e
}
doWork: Worker failed; requesting retry
return Result.retry()
`;
const taskManagerKeeperSource = `
if (Platform.OS === 'android') {
  AppRegistry.registerHeadlessTask('expo-task-manager', () => () => new Promise<void>(() => {}));
}
`;
const taskManagerKeeperRuntimeSource = taskManagerKeeperSource.replace('<void>', '');
const taskManagerSettlementPatchSource = `
diff --git a/node_modules/expo-task-manager/android/build.gradle b/node_modules/expo-task-manager/android/build.gradle
diff --git a/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskManagerModule.kt b/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskManagerModule.kt
diff --git a/node_modules/expo-task-manager/android/src/test/java/expo/modules/taskManager/TaskServiceContextLifetimeTest.java b/node_modules/expo-task-manager/android/src/test/java/expo/modules/taskManager/TaskServiceContextLifetimeTest.java
diff --git a/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskManagerUtils.java b/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskManagerUtils.java
+        callback.onFinished(Collections.emptyMap());
diff --git a/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskService.java b/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskService.java
+  private static final Object sTaskExecutionLock = new Object();
+      // Publishing the manager and detaching its queue under one lock assigns every event to
+            finishClaimedTaskExecutionWithFailure(appScopeKey, eventId);
+      finishPendingTaskExecutionWithFailure(appScopeKey, eventId, body);
+      if (pendingBody != null && !mTasksAndEventsRepository.removeEventForAppScopeKey(appScopeKey, pendingBody)) {
+          finishedHeadlessStartToken = sHeadlessStartTokens.remove(appScopeKey);
+        sHeadlessTaskOwners.put(headlessStartToken, new HeadlessTaskOwner(headlessContext, taskId));
+      HeadlessTaskOwner owner = sHeadlessTaskOwners.remove(headlessStartToken);
-          unregisterAllTasksForAppScopeKey(appScopeKey);
diff --git a/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/TasksAndEventsRepository.java b/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/TasksAndEventsRepository.java
+  boolean removeEventForAppScopeKey(String appScopeKey, Bundle body);
diff --git a/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/BareTasksAndEventsRepository.java b/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/BareTasksAndEventsRepository.java
diff --git a/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/ManagedTasksAndEventsRepository.java b/node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/ManagedTasksAndEventsRepository.java
diff --git a/node_modules/expo-task-manager/src/TaskManager.ts b/node_modules/expo-task-manager/src/TaskManager.ts
${taskManagerKeeperSource
  .trim()
  .split('\n')
  .map((line) => `+${line}`)
  .join('\n')}
diff --git a/node_modules/expo-task-manager/build/TaskManager.js b/node_modules/expo-task-manager/build/TaskManager.js
${taskManagerKeeperRuntimeSource
  .trim()
  .split('\n')
  .map((line) => `+${line}`)
  .join('\n')}
`;
const taskManagerUtilsSource = `
if (task == null) {
  Log.e(TAG, "Trying to execute a null task; completing callback with failure.");
  if (callback != null) {
        callback.onFinished(Collections.emptyMap());
      }
}
`;
const taskManagerServiceSource = `
private static final Object sTaskExecutionLock = new Object();
private static final Map<Object, HeadlessTaskOwner> sHeadlessTaskOwners = new HashMap<>();
private static final Map<String, Object> sHeadlessStartTokens = new HashMap<>();
Task execution body is missing execution info; completing callback with failure.
Task execution body is missing an event ID; completing callback with failure.
public void setTaskManager(TaskManagerInterface taskManager, String appScopeKey, String appUrl) {
  if (taskManager == null) {
    synchronized (sTaskExecutionLock) {
      sTaskManagers.remove(appScopeKey);
      sHeadlessTaskManagers.remove(appScopeKey);
    }
    return;
  }
  final List<Bundle> eventsQueue;
  synchronized (sTaskExecutionLock) {
    taskManagers.put(appScopeKey, new WeakReference<>(taskManager));
    eventsQueue = mTasksAndEventsRepository.getEvents(appScopeKey);
    mTasksAndEventsRepository.removeEvents(appScopeKey);
  }
  // Execute events only after releasing the handoff lock
  try {
    taskManager.executeTaskWithBody(body);
  } catch (Exception e) {
    Task manager threw before queued JavaScript dispatch; completing task with failure.
    finishClaimedTaskExecutionWithFailure(appScopeKey, eventId);
  }
}
public void executeTask(TaskInterface task, Bundle data, Error error, TaskExecutionCallback callback) {
final TaskManagerInterface taskManager;
final Object headlessStartToken;
synchronized (sTaskExecutionLock) {
  taskManager = getTaskManager(appScopeKey);
  mTasksAndEventsRepository.putEventForAppScopeKey(appScopeKey, body);
}
if (headlessStartToken != null) {
  maybeStartHeadlessTask(appScopeKey, headlessStartToken);
}
Task manager threw before JavaScript dispatch; completing task with failure.
HeadlessAppLoader appLoader = getAppLoader();
if (appLoader == null || context == null) {
  Headless app loader is unavailable; completing pending tasks with failure.
  finishPendingTaskExecutionWithFailure(appScopeKey, eventId, body);
  return;
}
if (headlessStartToken != null) {
  maybeStartHeadlessTask(appScopeKey, headlessStartToken);
}
appLoader.loadApp(context,
Headless app is already running without a task manager; completing pending task with failure.
finishPendingTaskExecutionWithFailure(appScopeKey, eventId, body);
if (!success) {
  Headless app load failed; completing pending tasks with failure.
  finishPendingTaskExecutionWithFailure(appScopeKey, eventId, body);
}
Headless app loader threw before JavaScript dispatch; completing pending tasks with failure.
private void finishPendingTaskExecutionWithFailure(String appScopeKey, String eventId, Bundle body) {
  finishTaskExecutionWithFailure(appScopeKey, eventId, body);
}
private void finishClaimedTaskExecutionWithFailure(String appScopeKey, String eventId) {
  finishTaskExecutionWithFailure(appScopeKey, eventId, null);
}
private void finishTaskExecutionWithFailure(String appScopeKey, String eventId, @Nullable Bundle pendingBody) {
  synchronized (sTaskExecutionLock) {
    if (pendingBody != null && !mTasksAndEventsRepository.removeEventForAppScopeKey(appScopeKey, pendingBody)) {
      return;
    }
    finishedHeadlessStartToken = sHeadlessStartTokens.remove(appScopeKey);
    taskCallback = sTaskCallbacks.remove(eventId);
  }

  if (finishedHeadlessStartToken != null) {
    maybeFinishHeadlessTask(appScopeKey, finishedHeadlessStartToken);
  }
  if (taskCallback != null) {
    Map<String, Object> response = new HashMap<>();
    response.put("eventId", eventId);
    taskCallback.onFinished(response);
  }
}
//endregion
private void invalidateAppRecord(String appScopeKey) {
  HeadlessAppLoader appLoader = getAppLoader();
  if (appLoader != null) {
    appLoader.invalidateApp(appScopeKey);
  }
}
private void invokeStartHeadlessTask(ReactContext reactContext, String appScopeKey, Object headlessStartToken) {
  synchronized (sTaskExecutionLock) {
    if (sHeadlessStartTokens.get(appScopeKey) != headlessStartToken) {
      return;
    }
  }
  int taskId = headlessContext.startTask(taskConfig);
  stillOwnsHeadlessStart = sHeadlessStartTokens.get(appScopeKey) == headlessStartToken;
  sHeadlessTaskOwners.put(headlessStartToken, new HeadlessTaskOwner(headlessContext, taskId));
}
private void waitForReactContextAndStartTask() {
  hasPendingEvents = sHeadlessStartTokens.get(appScopeKey) == headlessStartToken;
}
private void maybeFinishHeadlessTask(String appScopeKey, Object headlessStartToken) {
  HeadlessTaskOwner owner = sHeadlessTaskOwners.remove(headlessStartToken);
  if (taskId == null) {
    return;
  }
}
`;
const taskManagerRepositorySource = `
boolean removeEventForAppScopeKey(String appScopeKey, Bundle body);
`;
const taskManagerBareRepositorySource = `
public boolean removeEventForAppScopeKey(String appScopeKey, Bundle body) {
  if (events == null || !events.remove(body)) return false;
}
`;
const taskManagerManagedRepositorySource = taskManagerBareRepositorySource;

function redirectContainmentInput(overrides = {}) {
  return {
    packageJson: structuredClone(redirectContainmentPackageJson),
    packageLock: structuredClone(redirectContainmentPackageLock),
    patchSource: redirectContainmentPatchSource,
    legacyModuleSource: redirectContainmentLegacyModuleSource,
    appConfigSource: redirectContainmentAppConfigSource,
    ...overrides,
  };
}

function uploadFilenameInput() {
  return {
    patchSource: readFileSync(join(ROOT, 'patches/expo-file-system+57.0.7.patch'), 'utf8'),
    ...Object.fromEntries(
      Object.entries(UPLOAD_FILENAME_SOURCE_PATHS).map(([key, path]) => [
        key,
        readFileSync(join(ROOT, path), 'utf8'),
      ]),
    ),
  };
}

test('upload filename guard rejects missing native wiring, types, validation, or durable patch', () => {
  assert.deepEqual(validateUploadFilenameBridge(uploadFilenameInput()), []);
  for (const field of [
    'legacyModuleSource',
    'recordsSource',
    'filenameSource',
    'typesSource',
    'declarationsSource',
    'patchSource',
  ]) {
    const input = uploadFilenameInput();
    input[field] = '';
    assert.ok(validateUploadFilenameBridge(input).length > 0, field);
  }
  for (const oldValue of [
    'options.gatorFileName?.let(GatorUploadFilename::validate) ?: file.name',
    'bodyBuilder.addFormDataPart(fieldName, uploadName,',
  ]) {
    const input = uploadFilenameInput();
    input.legacyModuleSource = input.legacyModuleSource.replace(oldValue, 'file.name');
    assert.ok(
      validateUploadFilenameBridge(input).some((message) =>
        message.includes('original streaming body'),
      ),
      oldValue,
    );
  }
  const stalePatch = uploadFilenameInput();
  stalePatch.patchSource = stalePatch.patchSource.replace(
    'name.length in 1..255',
    'name.isNotEmpty()',
  );
  assert.ok(
    validateUploadFilenameBridge(stalePatch).some((message) =>
      message.includes('patch must restore'),
    ),
  );
});

function backgroundTaskRetryInput(overrides = {}) {
  return {
    packageJson: structuredClone(redirectContainmentPackageJson),
    packageLock: structuredClone(redirectContainmentPackageLock),
    patchSource: backgroundTaskRetryPatchSource,
    schedulerSource: backgroundTaskRetrySchedulerSource,
    workerSource: backgroundTaskRetryWorkerSource,
    ...overrides,
  };
}

function backgroundExecutionInput() {
  return {
    sources: Object.fromEntries(
      Object.entries(BACKGROUND_EXECUTION_SOURCE_PATHS).map(([key, path]) => [
        key,
        readFileSync(join(ROOT, path), 'utf8'),
      ]),
    ),
    backgroundPatch: readFileSync(join(ROOT, 'patches/expo-background-task+57.0.21.patch'), 'utf8'),
    taskManagerPatch: readFileSync(join(ROOT, 'patches/expo-task-manager+57.0.21.patch'), 'utf8'),
  };
}

function taskManagerSettlementInput(overrides = {}) {
  return {
    packageJson: structuredClone(redirectContainmentPackageJson),
    packageLock: structuredClone(redirectContainmentPackageLock),
    patchSource: taskManagerSettlementPatchSource,
    utilsSource: taskManagerUtilsSource,
    serviceSource: taskManagerServiceSource,
    repositorySource: taskManagerRepositorySource,
    bareRepositorySource: taskManagerBareRepositorySource,
    managedRepositorySource: taskManagerManagedRepositorySource,
    taskManagerSource: taskManagerKeeperSource,
    taskManagerRuntimeSource: taskManagerKeeperRuntimeSource,
    ...overrides,
  };
}

const EXPO_SHARING_MODULE_FIXTURE_PATH =
  'node_modules/expo-sharing/android/src/main/java/expo/modules/sharing/SharingModule.kt';

function writeRedirectContainmentFixture(root) {
  const input = redirectContainmentInput();
  mkdirSync(join(root, 'patches'), { recursive: true });
  mkdirSync(
    join(
      root,
      'node_modules/expo-file-system/android/src/main/java/expo/modules/filesystem/legacy',
    ),
    { recursive: true },
  );
  mkdirSync(
    join(
      root,
      'node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask',
    ),
    { recursive: true },
  );
  mkdirSync(
    join(root, 'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager'),
    { recursive: true },
  );
  mkdirSync(
    join(
      root,
      'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository',
    ),
    { recursive: true },
  );
  mkdirSync(join(root, 'node_modules/expo-router/build/layouts/experimental-stack'), {
    recursive: true,
  });
  for (const folder of ['src', 'build']) {
    mkdirSync(join(root, 'node_modules/expo-task-manager', folder), { recursive: true });
  }
  mkdirSync(
    join(
      root,
      'node_modules/react-native-screens/android/src/main/java/com/swmansion/rnscreens/gamma/stack/host',
    ),
    { recursive: true },
  );
  mkdirSync(join(root, 'app/(app)'), { recursive: true });
  mkdirSync(join(root, 'app/(setup)'), { recursive: true });
  mkdirSync(join(root, 'android/app/src/main/java/com/bluegreengatorapps/messages'), {
    recursive: true,
  });
  writeFileSync(join(root, 'package.json'), JSON.stringify(input.packageJson));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(input.packageLock));
  writeFileSync(join(root, 'app.config.ts'), input.appConfigSource);
  writeFileSync(
    join(root, 'android/app/src/main/java/com/bluegreengatorapps/messages/MainActivity.kt'),
    shareMainActivitySource,
  );
  writeFileSync(
    join(root, 'patches/expo-file-system+57.0.7.patch'),
    uploadFilenameInput().patchSource,
  );
  for (const path of Object.values(UPLOAD_FILENAME_SOURCE_PATHS)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), readFileSync(join(ROOT, path), 'utf8'));
  }
  writeFileSync(
    join(root, 'patches/expo-background-task+57.0.21.patch'),
    backgroundTaskRetryPatchSource,
  );
  writeFileSync(
    join(root, 'patches/expo-task-manager+57.0.21.patch'),
    taskManagerSettlementPatchSource,
  );
  writeFileSync(
    join(root, 'node_modules/expo-task-manager/src/TaskManager.ts'),
    taskManagerKeeperSource,
  );
  writeFileSync(
    join(root, 'node_modules/expo-task-manager/build/TaskManager.js'),
    taskManagerKeeperRuntimeSource,
  );
  writeFileSync(
    join(root, 'patches/expo-router+57.0.24.patch'),
    readFileSync(join(ROOT, 'patches/expo-router+57.0.24.patch'), 'utf8'),
  );
  writeFileSync(
    join(root, 'patches/expo-sharing+57.0.24.patch'),
    readFileSync(join(ROOT, 'patches/expo-sharing+57.0.24.patch'), 'utf8'),
  );
  mkdirSync(dirname(join(root, EXPO_SHARING_MODULE_FIXTURE_PATH)), { recursive: true });
  writeFileSync(
    join(root, EXPO_SHARING_MODULE_FIXTURE_PATH),
    readFileSync(join(ROOT, EXPO_SHARING_MODULE_FIXTURE_PATH), 'utf8'),
  );
  writeFileSync(
    join(root, 'patches/react-native-screens+4.26.2.patch'),
    readFileSync(join(ROOT, 'patches/react-native-screens+4.26.2.patch'), 'utf8'),
  );
  writeFileSync(
    join(
      root,
      'node_modules/expo-file-system/android/src/main/java/expo/modules/filesystem/legacy/FileSystemLegacyModule.kt',
    ),
    uploadFilenameInput().legacyModuleSource,
  );
  writeFileSync(
    join(
      root,
      'node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskScheduler.kt',
    ),
    backgroundTaskRetrySchedulerSource,
  );
  writeFileSync(
    join(
      root,
      'node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskWork.kt',
    ),
    backgroundTaskRetryWorkerSource,
  );
  writeFileSync(
    join(
      root,
      'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskManagerUtils.java',
    ),
    taskManagerUtilsSource,
  );
  writeFileSync(
    join(
      root,
      'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskService.java',
    ),
    taskManagerServiceSource,
  );
  writeFileSync(
    join(
      root,
      'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/TasksAndEventsRepository.java',
    ),
    taskManagerRepositorySource,
  );
  writeFileSync(
    join(
      root,
      'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/BareTasksAndEventsRepository.java',
    ),
    taskManagerBareRepositorySource,
  );
  writeFileSync(
    join(
      root,
      'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/ManagedTasksAndEventsRepository.java',
    ),
    taskManagerManagedRepositorySource,
  );
  // Lifetime guards inspect installed production code and its corresponding durable patch.
  for (const path of [
    ...Object.values(BACKGROUND_EXECUTION_SOURCE_PATHS),
    'patches/expo-background-task+57.0.21.patch',
    'patches/expo-task-manager+57.0.21.patch',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), readFileSync(join(ROOT, path), 'utf8'));
  }
  writeFileSync(
    join(
      root,
      'node_modules/expo-router/build/layouts/experimental-stack/ExperimentalStackView.js',
    ),
    readFileSync(
      join(
        ROOT,
        'node_modules/expo-router/build/layouts/experimental-stack/ExperimentalStackView.js',
      ),
      'utf8',
    ),
  );
  for (const path of Object.values(REACT_NATIVE_SCREENS_SOURCE_PATHS)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), readFileSync(join(ROOT, path), 'utf8'));
  }
  writeFileSync(join(root, 'app/_layout.tsx'), readFileSync(join(ROOT, 'app/_layout.tsx'), 'utf8'));
  writeFileSync(
    join(root, 'app/(setup)/_layout.tsx'),
    readFileSync(join(ROOT, 'app/(setup)/_layout.tsx'), 'utf8'),
  );
  writeFileSync(
    join(root, 'app/(app)/_layout.tsx'),
    readFileSync(join(ROOT, 'app/(app)/_layout.tsx'), 'utf8'),
  );
  mkdirSync(join(root, 'android/app/src/main/res/xml'), { recursive: true });
  writeFileSync(
    join(root, 'android/app/src/main/res/xml/network_security_config.xml'),
    NETWORK_SECURITY_CONFIG_XML,
  );
}

function cleanupDexFixture({ omitRequiredMarker, extraMarkers = [] } = {}) {
  return Buffer.from(
    [
      ...REQUIRED_PINNED_SHORTCUT_CLEANUP_DEX_MARKERS.filter(
        (marker) => marker !== omitRequiredMarker,
      ),
      ...REQUIRED_BACKGROUND_TASK_RETRY_DEX_MARKERS.filter(
        (marker) => marker !== omitRequiredMarker,
      ),
      ...REQUIRED_UPLOAD_FILENAME_DEX_MARKERS.filter((marker) => marker !== omitRequiredMarker),
      ...REQUIRED_SHARE_INTAKE_DEX_MARKERS.filter((marker) => marker !== omitRequiredMarker),
      ...REQUIRED_TASK_MANAGER_SETTLEMENT_DEX_MARKERS.filter(
        (marker) => marker !== omitRequiredMarker,
      ),
      ...extraMarkers,
    ].join('\0'),
    'utf8',
  );
}

function validate(overrides = {}) {
  return validateAndroidBuild({
    manifest,
    packageJson: { main: 'index.js' },
    entrySource,
    ...overrides,
  });
}

test('accepts the expected manifest and headless entry order', () => {
  assert.deepEqual(REQUIRED_PERMISSIONS, intendedPermissions);
  assert.deepEqual(validate(), []);
});

test('requires exactly one Android 16 minimum in merged and packaged manifests', () => {
  const usesSdk = renderXml(
    xmlNode('uses-sdk', {
      'android:minSdkVersion': '36',
      'android:targetSdkVersion': '36',
    }),
  );
  assert.ok(
    validate({ manifest: manifest.replace(usesSdk, '') }).some((error) =>
      error.includes('exactly one <uses-sdk>'),
    ),
  );
  assert.ok(
    validate({
      manifest: manifest.replace('android:minSdkVersion="36"', 'android:minSdkVersion="35"'),
    }).some((error) => error.includes('android:minSdkVersion must be exactly 36')),
  );
  assert.ok(
    validate({ manifest: manifest.replace('</manifest>', `${usesSdk}</manifest>`) }).some((error) =>
      error.includes('exactly one <uses-sdk>'),
    ),
  );

  const packagedMissing = structuredClone(manifestNode);
  packagedMissing.children = packagedMissing.children.filter((child) => child.name !== 'uses-sdk');
  assert.ok(
    validatePackagedAndroidBundle({ manifestProto: encodeXmlDocument(packagedMissing) }).some(
      (error) => error.includes('exactly one <uses-sdk>'),
    ),
  );

  const packagedWrong = structuredClone(manifestNode);
  const packagedUsesSdk = packagedWrong.children.find((child) => child.name === 'uses-sdk');
  assert.ok(packagedUsesSdk);
  packagedUsesSdk.attributes['android:minSdkVersion'] = '35';
  assert.ok(
    validatePackagedAndroidBundle({ manifestProto: encodeXmlDocument(packagedWrong) }).some(
      (error) => error.includes('android:minSdkVersion must be exactly 36'),
    ),
  );

  const packagedDuplicate = structuredClone(manifestNode);
  const duplicateUsesSdk = structuredClone(
    packagedDuplicate.children.find((child) => child.name === 'uses-sdk'),
  );
  assert.ok(duplicateUsesSdk);
  packagedDuplicate.children.push(duplicateUsesSdk);
  assert.ok(
    validatePackagedAndroidBundle({ manifestProto: encodeXmlDocument(packagedDuplicate) }).some(
      (error) => error.includes('exactly one <uses-sdk>'),
    ),
  );
});

test('requires predictive Back in merged and packaged manifests', () => {
  assert.ok(
    validate({
      manifest: manifest.replace('android:enableOnBackInvokedCallback="true"', ''),
    }).some((error) => error.includes('android:enableOnBackInvokedCallback="true"')),
  );
  assert.ok(
    validate({
      manifest: manifest.replace(
        'android:enableOnBackInvokedCallback="true"',
        'android:enableOnBackInvokedCallback="false"',
      ),
    }).some((error) => error.includes('android:enableOnBackInvokedCallback="true"')),
  );

  const packagedWrong = structuredClone(manifestNode);
  const application = packagedWrong.children.find((child) => child.name === 'application');
  assert.ok(application);
  application.attributes['android:enableOnBackInvokedCallback'] = 'false';
  assert.ok(
    validatePackagedAndroidBundle({ manifestProto: encodeXmlDocument(packagedWrong) }).some(
      (error) => error.includes('android:enableOnBackInvokedCallback="true"'),
    ),
  );
});

test('generates and enforces the system-CA-only Android network policy', () => {
  const androidManifest = {
    manifest: {
      application: [{ $: { 'android:name': '.MainApplication', 'android:allowBackup': 'false' } }],
    },
  };
  assert.equal(
    applySystemCaManifestPolicy(androidManifest).manifest.application[0].$[
      'android:networkSecurityConfig'
    ],
    NETWORK_SECURITY_CONFIG_REFERENCE,
  );
  assert.equal(applySystemCaManifestPolicy(androidManifest), androidManifest);
  assert.throws(
    () =>
      applySystemCaManifestPolicy({
        manifest: {
          application: [
            {
              $: {
                'android:name': '.MainApplication',
                'android:networkSecurityConfig': '@xml/competing_policy',
              },
            },
          ],
        },
      }),
    /competing network security config/,
  );

  const root = mkdtempSync(join(tmpdir(), 'gator-system-ca-policy-'));
  try {
    const destination = writeSystemCaNetworkSecurityConfig(root);
    assert.equal(destination, join(root, 'app/src/main/res/xml/network_security_config.xml'));
    assert.equal(readFileSync(destination, 'utf8'), NETWORK_SECURITY_CONFIG_XML);
    assert.deepEqual(validateSystemCaNetworkSecurityConfig(NETWORK_SECURITY_CONFIG_XML), []);
    assert.ok(
      validateSystemCaNetworkSecurityConfig(
        NETWORK_SECURITY_CONFIG_XML.replace('src="system"', 'src="user"'),
      ).some((error) => error.includes('only Android system CAs')),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const appConfig = readFileSync(join(ROOT, 'app.config.ts'), 'utf8');
  assert.equal(appConfig.split("'./plugins/withSystemCaNetworkSecurity'").length - 1, 1);
});

test('accepts the pinned Expo file-system redirect containment chain', () => {
  assert.deepEqual(validateExpoFileSystemRedirectContainment(redirectContainmentInput()), []);
});

test('guards the expo-sharing self-share settlement against drift', () => {
  const currentInput = () => ({
    packageJson: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')),
    packageLock: JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')),
    patchSource: readFileSync(join(ROOT, 'patches/expo-sharing+57.0.24.patch'), 'utf8'),
    moduleSource: readFileSync(join(ROOT, EXPO_SHARING_MODULE_FIXTURE_PATH), 'utf8'),
  });

  assert.deepEqual(validateExpoSharingSelfShareSettlement(currentInput()), []);

  const mutations = [
    {
      label: 'loose version range',
      mutate(input) {
        input.packageJson.dependencies['expo-sharing'] = '^57.0.24';
      },
      error: /expo-sharing must remain pinned to ~57\.0\.24/,
    },
    {
      label: 'lock root range',
      mutate(input) {
        input.packageLock.packages[''].dependencies['expo-sharing'] = '~57.0.25';
      },
      error: /package-lock root must pin expo-sharing/,
    },
    {
      label: 'resolved version moved past the patch',
      mutate(input) {
        input.packageLock.packages['node_modules/expo-sharing'].version = '57.0.25';
      },
      error: /package-lock must resolve expo-sharing 57\.0\.24/,
    },
    {
      label: 'prebuilt AAR instead of the patched source',
      mutate(input) {
        input.packageJson.expo.autolinking.android.buildFromSource =
          input.packageJson.expo.autolinking.android.buildFromSource.filter(
            (name) => name !== 'expo-sharing',
          );
      },
      error: /must build expo-sharing from source exactly once/,
    },
    {
      label: 'patch touching another file',
      mutate(input) {
        input.patchSource +=
          '\ndiff --git a/node_modules/expo-sharing/x b/node_modules/expo-sharing/x\n';
      },
      error: /must patch only the reviewed sharing module/,
    },
    {
      label: 'patch without the settlement',
      mutate(input) {
        input.patchSource = input.patchSource.replace('+      pendingPromise?.resolve(null)', '');
      },
      error: /must carry the reviewed self-share settlement/,
    },
    {
      label: 'installed source not patched',
      mutate(input) {
        input.moduleSource = input.moduleSource.replace(
          'OnNewIntent { _ ->',
          'OnNewIntent { intent ->',
        );
      },
      error: /installed expo-sharing must settle a pending share on a new intent exactly once/,
    },
    {
      label: 'installed settlement duplicated',
      mutate(input) {
        const block = input.moduleSource.match(/OnNewIntent \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
        assert.notEqual(block, '');
        input.moduleSource = input.moduleSource.replace(block, `${block}\n    ${block}`);
      },
      error: /exactly once/,
    },
  ];
  for (const { label, mutate, error } of mutations) {
    const input = currentInput();
    mutate(input);
    const errors = validateExpoSharingSelfShareSettlement(input);
    assert.ok(
      errors.some((message) => error.test(message)),
      `${label}: ${JSON.stringify(errors)}`,
    );
  }
});

test('guards the Expo Router predictive-Back bridge against drift', () => {
  const currentInput = () => ({
    packageJson: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')),
    packageLock: JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')),
    appConfigSource: readFileSync(join(ROOT, 'app.config.ts'), 'utf8'),
    patchSource: readFileSync(join(ROOT, 'patches/expo-router+57.0.24.patch'), 'utf8'),
    experimentalStackSource: readFileSync(
      join(
        ROOT,
        'node_modules/expo-router/build/layouts/experimental-stack/ExperimentalStackView.js',
      ),
      'utf8',
    ),
    screensPatchSource: readFileSync(
      join(ROOT, 'patches/react-native-screens+4.26.2.patch'),
      'utf8',
    ),
    ...Object.fromEntries(
      Object.entries(REACT_NATIVE_SCREENS_SOURCE_PATHS).map(([key, path]) => [
        key,
        readFileSync(join(ROOT, path), 'utf8'),
      ]),
    ),
    rootLayoutSource: readFileSync(join(ROOT, 'app/_layout.tsx'), 'utf8'),
    setupLayoutSource: readFileSync(join(ROOT, 'app/(setup)/_layout.tsx'), 'utf8'),
    appLayoutSource: readFileSync(join(ROOT, 'app/(app)/_layout.tsx'), 'utf8'),
  });

  assert.deepEqual(validateExpoRouterPredictiveBackBridge(currentInput()), []);

  const mutations = [
    {
      label: 'ascending committed sort',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          '.sortedByDescending { it.first }',
          '.sortedBy { it.first }',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'nonidentity committed lookup',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          'it.stackScreen === operation.screen',
          'it.stackScreen == operation.screen',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'duplicate-pop check weakened',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          'orderedPopOperations.map { it.first }.distinct().size == orderedPopOperations.size',
          'true',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'suffix gap accepted',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          'index == stackModel.lastIndex - offset',
          'index <= stackModel.lastIndex - offset',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'root-pop precheck broadened',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          'orderedPopOperations.size < stackModel.size || isRootReplacement',
          'orderedPopOperations.size <= stackModel.size || isRootReplacement',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'pop removes before identity check',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          'check(stackModel.last() === fragment)',
          'check(stackModel.removeAt(stackModel.lastIndex) === fragment)',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'durable suffix gap accepted',
      mutate(input) {
        input.screensPatchSource = input.screensPatchSource.replace(
          '+            check(index == stackModel.lastIndex - offset)',
          '+            check(index <= stackModel.lastIndex - offset)',
        );
      },
      error: 'must carry the reviewed uncommitted-pair, root-replacement, and ordered-pop repairs',
    },
    {
      label: 'coordinator reverses pops',
      mutate(input) {
        input.stackCoordinatorSource = input.stackCoordinatorSource.replace(
          'pendingPopOperations.forEach { operation ->',
          'pendingPopOperations.asReversed().forEach { operation ->',
        );
      },
      error: 'must forward pops without rendered-index reordering',
    },
    {
      label: 'durable coordinator reverses pops',
      mutate(input) {
        input.screensPatchSource = input.screensPatchSource.replace(
          '+        pendingPopOperations.forEach { operation ->',
          '+        pendingPopOperations.asReversed().forEach { operation ->',
        );
      },
      error: 'must forward pops to the committed-model ordering owner',
    },
    {
      label: 'missing native test dependency',
      mutate(input) {
        input.screensBuildGradleSource = input.screensBuildGradleSource.replace(
          "testImplementation 'org.robolectric:robolectric:4.16'",
          '',
        );
      },
      error: 'must retain their reviewed test dependencies',
    },
    {
      label: 'missing adversarial native case',
      mutate(input) {
        input.screensPopOrderTestSource = input.screensPopOrderTestSource.replace(
          'fun gapBelowValidTopIsRejectedBeforeTopIsRemoved(',
          'fun unrelatedCase(',
        );
      },
      error: 'must retain the reviewed adversarial cases',
    },
    {
      label: 'durable native test case drift',
      mutate(input) {
        input.screensPatchSource = input.screensPatchSource.replace(
          '+    fun duplicatePopFailsBeforeAnyCommittedMutation(',
          '+    fun unrelatedCase(',
        );
      },
      error: 'must retain the reviewed adversarial cases',
    },
    {
      label: 'app config opt-in',
      mutate(input) {
        input.appConfigSource = input.appConfigSource.replace(
          'predictiveBackGestureEnabled: true',
          'predictiveBackGestureEnabled: false',
        );
      },
      error: 'must set android.predictiveBackGestureEnabled to true exactly once',
    },
    {
      label: 'dependency pin',
      mutate(input) {
        input.packageJson.dependencies['expo-router'] = '~57.0.21';
      },
      error: 'must remain pinned',
    },
    {
      label: 'lockfile resolution',
      mutate(input) {
        input.packageLock.packages['node_modules/expo-router'].version = '57.0.21';
      },
      error: 'package-lock must resolve',
    },
    {
      label: 'native dependency resolution',
      mutate(input) {
        input.packageLock.packages['node_modules/react-native-screens'].version = '4.26.3';
      },
      error: 'package-lock must resolve react-native-screens',
    },
    {
      label: 'patch scope',
      mutate(input) {
        input.patchSource +=
          '\ndiff --git a/node_modules/expo-router/build/other.js b/node_modules/expo-router/build/other.js\n';
      },
      error: 'must patch only the reviewed experimental stack file',
    },
    {
      label: 'durable pop patch',
      mutate(input) {
        input.patchSource = input.patchSource.replace(
          '+                            ...native_1.StackActions.pop(),\n',
          '',
        );
      },
      error: 'must carry the reviewed pop and theme repairs',
    },
    {
      label: 'installed pop bridge',
      mutate(input) {
        input.experimentalStackSource = input.experimentalStackSource.replaceAll(
          '...native_1.StackActions.pop(),',
          '...native_1.StackActions.push(),',
        );
      },
      error: 'must redispatch the exact prevented pop action',
    },
    {
      label: 'installed theme bridge',
      mutate(input) {
        input.experimentalStackSource = input.experimentalStackSource.replace(
          'style: [styles.scene, { backgroundColor: colors.background }]',
          "style: [styles.scene, { backgroundColor: 'white' }]",
        );
      },
      error: 'must use the navigation theme background',
    },
    {
      label: 'hidden native header omission',
      mutate(input) {
        input.experimentalStackSource = input.experimentalStackSource.replace(
          'headerConfigProps.hidden === true ? null :',
          'false ? null :',
        );
      },
      error: 'must omit native HeaderConfig when explicitly hidden',
    },
    {
      label: 'native patch scope',
      mutate(input) {
        input.screensPatchSource +=
          '\ndiff --git a/node_modules/react-native-screens/android/generated.txt b/node_modules/react-native-screens/android/generated.txt\n';
      },
      error: 'must patch only the reviewed gamma stack repair and tests',
    },
    {
      label: 'native identity match',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          'it.screen === popOperation.screen',
          'it.screen == popOperation.screen',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'durable native root replacement',
      mutate(input) {
        input.screensPatchSource = input.screensPatchSource.replace(
          '+                pendingPopOperations.size == 1 &&\n',
          '',
        );
      },
      error: 'must carry the reviewed uncommitted-pair, root-replacement, and ordered-pop repairs',
    },
    {
      label: 'durable native root replacement additive broadening',
      mutate(input) {
        input.screensPatchSource = input.screensPatchSource.replace(
          '+                pendingPushOperations.single().screen !== pendingPopOperations.single().screen\n',
          '+                pendingPushOperations.single().screen !== pendingPopOperations.single().screen || pendingPushOperations.isNotEmpty()\n',
        );
      },
      error: 'must preserve the exact reviewed root-replacement predicate and branches',
    },
    {
      label: 'installed native root replacement',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          'fragmentOps.add(RemoveOp(fragment))',
          'fragmentOps.add(PopBackStackOp(fragment))',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'installed native root replacement exact cardinality',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          'pendingPushOperations.size == 1 &&',
          'pendingPushOperations.isNotEmpty() &&',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'installed native root replacement single pop',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          'pendingPopOperations.size == 1 &&',
          'pendingPopOperations.isNotEmpty() &&',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'installed native root replacement pop identity',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          'stackModel.single().stackScreen === pendingPopOperations.single().screen &&',
          'stackModel.single().stackScreen == pendingPopOperations.single().screen &&',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'installed native root replacement distinct push',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          'pendingPushOperations.single().screen !== pendingPopOperations.single().screen',
          'pendingPushOperations.single().screen === pendingPopOperations.single().screen',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'installed native root replacement additive broadening',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          'pendingPushOperations.single().screen !== pendingPopOperations.single().screen\n',
          'pendingPushOperations.single().screen !== pendingPopOperations.single().screen || pendingPushOperations.isNotEmpty()\n',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'last-pop hard failure',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          '[RNScreens] Attempt to pop last screen from the stack',
          '[RNScreens] Ignoring final pop',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'native stale-operation clear ordering',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource
          .replace('        fragmentOps.clear()\n\n', '')
          .replace(
            '        pendingPopOperations.toList().forEach',
            '        fragmentOps.clear()\n        pendingPopOperations.toList().forEach',
          );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'unmatched-pop hard failure',
      mutate(input) {
        input.stackContainerSource = input.stackContainerSource.replace(
          '[RNScreens] Unable to find a fragment to pop',
          '[RNScreens] Ignoring unmatched pop',
        );
      },
      error: 'must cancel only identity-matched uncommitted pairs',
    },
    {
      label: 'root stack selection',
      mutate(input) {
        input.rootLayoutSource = input.rootLayoutSource.replace('<ExperimentalStack', '<Stack');
      },
      error: 'root layout must render Expo Router ExperimentalStack',
    },
    {
      label: 'nested stack selection',
      mutate(input) {
        input.appLayoutSource = input.appLayoutSource.replace('<ExperimentalStack', '<Stack');
      },
      error: 'authenticated layout must render Expo Router ExperimentalStack',
    },
    {
      label: 'setup stack selection',
      mutate(input) {
        input.setupLayoutSource = input.setupLayoutSource.replace('<ExperimentalStack', '<Stack');
      },
      error: 'setup layout must render Expo Router ExperimentalStack',
    },
    {
      label: 'root stack header contract',
      mutate(input) {
        input.rootLayoutSource = input.rootLayoutSource.replace(
          'screenOptions={{ headerShown: false }}',
          'screenOptions={{ headerShown: true }}',
        );
      },
      error: 'root layout must keep its experimental stack explicitly headerless',
    },
  ];

  for (const { label, mutate, error } of mutations) {
    const input = currentInput();
    const before = structuredClone(input);
    mutate(input);
    assert.notDeepEqual(input, before, `${label} mutation must change its intended input`);
    assert.ok(
      validateExpoRouterPredictiveBackBridge(input).some((message) => message.includes(error)),
      `${label} must fail closed`,
    );
  }
});

test('guards the source-built Expo background-task retry bridge against drift', () => {
  assert.deepEqual(validateExpoBackgroundTaskRetryBridge(backgroundTaskRetryInput()), []);
  assert.deepEqual(
    validateExpoBackgroundTaskRetryBridge({
      packageJson: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')),
      packageLock: JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')),
      patchSource: readFileSync(join(ROOT, 'patches/expo-background-task+57.0.21.patch'), 'utf8'),
      schedulerSource: readFileSync(
        join(
          ROOT,
          'node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskScheduler.kt',
        ),
        'utf8',
      ),
      workerSource: readFileSync(
        join(
          ROOT,
          'node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskWork.kt',
        ),
        'utf8',
      ),
    }),
    [],
  );

  const mutations = [
    {
      label: 'dependency pin',
      mutate(input) {
        input.packageJson.dependencies['expo-background-task'] = '~57.0.21';
      },
      error: 'must be pinned exactly',
    },
    {
      label: 'lockfile resolution',
      mutate(input) {
        input.packageLock.packages['node_modules/expo-background-task'].version = '57.0.17';
      },
      error: 'package-lock must resolve',
    },
    {
      label: 'source build',
      mutate(input) {
        input.packageJson.expo.autolinking.android.buildFromSource = ['expo-file-system'];
      },
      error: 'must build expo-background-task from source exactly once',
    },
    {
      label: 'durable patch',
      mutate(input) {
        input.patchSource = input.patchSource.replace(
          '+      workInfos.any { !it.state.isFinished }\n',
          '',
        );
      },
      error: 'must carry the reviewed retry',
    },
    {
      label: 'exact success result',
      mutate(input) {
        input.schedulerSource = input.schedulerSource.replace(
          'result.toDouble() == 1.0',
          'result.toInt() == 1',
        );
      },
      error: 'must preserve the reviewed retry flow',
    },
    {
      label: 'failed result propagation',
      mutate(input) {
        input.schedulerSource = input.schedulerSource.replace(
          '    if (!succeeded) {\n      return false\n    }\n',
          '',
        );
      },
      error: 'must preserve the reviewed retry flow',
    },
    {
      label: 'foreground successor result',
      mutate(input) {
        input.schedulerSource = input.schedulerSource.replace(
          '        return scheduled\n',
          '        return true\n',
        );
      },
      error: 'must preserve the reviewed retry flow',
    },
    {
      label: 'synchronous exception result',
      mutate(input) {
        input.schedulerSource = input.schedulerSource.replace(
          'taskCompletion.complete(false)',
          'taskCompletion.complete(true)',
        );
      },
      error: 'must preserve the reviewed retry flow',
    },
    {
      label: 'empty consumer completion',
      mutate(input) {
        input.schedulerSource = input.schedulerSource.replace(
          '    if (consumers.isEmpty()) {\n      return true\n    }',
          '    if (consumers.isEmpty()) {\n      return false\n    }',
        );
      },
      error: 'must preserve the reviewed retry flow',
    },
    {
      label: 'cancellation propagation',
      mutate(input) {
        input.schedulerSource = input.schedulerSource.replace(
          'catch (e: CancellationException)',
          'catch (e: IllegalStateException)',
        );
      },
      error: 'must propagate cancellation',
    },
    {
      label: 'operational retry',
      mutate(input) {
        input.workerSource = input.workerSource.replace(
          'doWork: Worker failed; requesting retry',
          'doWork: Worker failed',
        );
      },
      error: 'must fail malformed input',
    },
    {
      label: 'worker cancellation propagation',
      mutate(input) {
        input.workerSource = input.workerSource.replace(
          '  throw e\n',
          '  return Result.failure()\n',
        );
      },
      error: 'must fail malformed input',
    },
  ];

  for (const { label, mutate, error } of mutations) {
    const input = backgroundTaskRetryInput();
    mutate(input);
    assert.ok(
      validateExpoBackgroundTaskRetryBridge(input).some((message) => message.includes(error)),
      `${label} must fail closed`,
    );
  }
});

test('guards execution cancellation and continuation retention in installed code and durable patches', () => {
  assert.deepEqual(validateBackgroundExecutionLifetime(backgroundExecutionInput()), []);
  const mutations = [
    ['registry', 'if (current != null) return null', ''],
    ['deadline', '60_000L', '300_000L'],
    [
      'deadline',
      'withTimeoutOrNull(BACKGROUND_TASK_NATIVE_DEADLINE_MS)',
      'withTimeout(BACKGROUND_TASK_NATIVE_DEADLINE_MS)',
    ],
    ['deadline', 'coroutineContext.ensureActive()', 'Unit'],
    ['deadline', 'if (result == null)', 'if (result == false)'],
    ['worker', 'val succeeded = runBackgroundTaskWithDeadline(', 'val succeeded = runUnbounded('],
    ['buildGradle', 'kotlinx-coroutines-test:1.10.2', 'kotlinx-coroutines-test:1.6.4'],
    [
      'registry',
      'if (current !== execution || execution.cancelled) return',
      'if (execution.cancelled) return',
    ],
    ['registry', 'execution.retainedEvents[eventId] != leaseToken', 'false'],
    ['registry', 'listeners.values.toList()', 'listOf(listeners.values.first())'],
    ['registry', 'listeners.remove(owner)', 'listeners.clear()'],
    ['registry', '&& execution.retainedEvents.isEmpty()', ''],
    [
      'consumer',
      'putString("gatorExecutionId", executionId)',
      'putString("gatorExecutionId", "fixed")',
    ],
    ['scheduler', 'backgroundTaskExecutions.cancel(execution)', ''],
    ['scheduler', 'backgroundTaskExecutions.finishDispatch(execution)', ''],
    ['service', 'retention.resultReceived = true', 'removeExecutionLocked(appScopeKey, eventId)'],
    ['service', 'if (retention.resultReceived)', 'if (true)'],
    ['service', 'retention.manager.get() != manager', 'false'],
    [
      'service',
      'owner.context.finishTask(owner.taskId)',
      'currentContext.finishTask(owner.taskId)',
    ],
    ['service', 'sHeadlessTaskOwners.containsKey(headlessStartToken)', 'false'],
    ['taskManager', 'Function("retainTaskExecution")', 'AsyncFunction("retainTaskExecution")'],
  ];
  for (const [key, before, after] of mutations) {
    const input = backgroundExecutionInput();
    assert.ok(input.sources[key].includes(before), `mutation exists: ${key}/${before}`);
    input.sources[key] = input.sources[key].replace(before, after);
    assert.ok(validateBackgroundExecutionLifetime(input).length > 0, `${key}/${before}`);
  }
  const stalePatch = backgroundExecutionInput();
  stalePatch.backgroundPatch = stalePatch.backgroundPatch.replace(
    'listeners.values.toList()',
    'listOf()',
  );
  assert.ok(validateBackgroundExecutionLifetime(stalePatch).length > 0);
  const extraPath = backgroundExecutionInput();
  extraPath.backgroundPatch +=
    '\ndiff --git a/node_modules/expo-background-task/unreviewed b/node_modules/expo-background-task/unreviewed\n';
  assert.ok(
    validateBackgroundExecutionLifetime(extraPath).some((message) =>
      message.includes('nine reviewed'),
    ),
  );
});

test('Expo task-manager keeper waits for native completion without allocating timers', async () => {
  for (const entry of ['src/TaskManager.ts', 'build/TaskManager.js']) {
    const source = readFileSync(join(ROOT, 'node_modules/expo-task-manager', entry), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      fileName: entry,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    for (const os of ['android', 'ios']) {
      const registrations = [];
      runInNewContext(outputText, {
        exports: {},
        require(name) {
          if (name === 'expo-modules-core') return { Platform: { OS: os } };
          if (name === './ExpoTaskManager') return { __esModule: true, default: null };
          if (name === 'react-native') {
            return {
              AppRegistry: {
                registerHeadlessTask: (key, provider) => registrations.push({ key, provider }),
              },
            };
          }
          throw new Error(`Unexpected keeper dependency: ${name}`);
        },
        setTimeout: () => assert.fail('Keeper must not allocate a timer'),
        setInterval: () => assert.fail('Keeper must not allocate an interval'),
      });
      assert.equal(registrations.length, os === 'android' ? 1 : 0, `${entry}: ${os}`);
      if (os !== 'android') continue;
      const [{ key, provider }] = registrations;
      assert.equal(key, 'expo-task-manager');
      let automaticallyFinished = false;
      provider()({}).then(
        () => {
          automaticallyFinished = true;
        },
        () => assert.fail('Keeper must not reject'),
      );
      await new Promise(setImmediate);
      assert.equal(automaticallyFinished, false, `${entry}: React Native must not finish early`);
    }
  }
});

test('guards Expo task-manager pre-JavaScript failure settlement against drift', () => {
  assert.deepEqual(validateExpoTaskManagerPreJsSettlement(taskManagerSettlementInput()), []);
  assert.deepEqual(
    validateExpoTaskManagerPreJsSettlement({
      packageJson: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')),
      packageLock: JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')),
      patchSource: readFileSync(join(ROOT, 'patches/expo-task-manager+57.0.21.patch'), 'utf8'),
      utilsSource: readFileSync(
        join(
          ROOT,
          'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskManagerUtils.java',
        ),
        'utf8',
      ),
      serviceSource: readFileSync(
        join(
          ROOT,
          'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/TaskService.java',
        ),
        'utf8',
      ),
      repositorySource: readFileSync(
        join(
          ROOT,
          'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/TasksAndEventsRepository.java',
        ),
        'utf8',
      ),
      bareRepositorySource: readFileSync(
        join(
          ROOT,
          'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/BareTasksAndEventsRepository.java',
        ),
        'utf8',
      ),
      managedRepositorySource: readFileSync(
        join(
          ROOT,
          'node_modules/expo-task-manager/android/src/main/java/expo/modules/taskManager/repository/ManagedTasksAndEventsRepository.java',
        ),
        'utf8',
      ),
      taskManagerSource: readFileSync(
        join(ROOT, 'node_modules/expo-task-manager/src/TaskManager.ts'),
        'utf8',
      ),
      taskManagerRuntimeSource: readFileSync(
        join(ROOT, 'node_modules/expo-task-manager/build/TaskManager.js'),
        'utf8',
      ),
    }),
    [],
  );

  const mutations = [
    {
      label: 'dependency pin',
      mutate(input) {
        input.packageJson.dependencies['expo-task-manager'] = '~57.0.21';
      },
      error: 'must be pinned exactly',
    },
    {
      label: 'source build',
      mutate(input) {
        input.packageJson.expo.autolinking.android.buildFromSource = [
          'expo-background-task',
          'expo-file-system',
        ];
      },
      error: 'must build expo-task-manager from source exactly once',
    },
    {
      label: 'loader source build',
      mutate(input) {
        input.packageJson.expo.autolinking.android.buildFromSource =
          input.packageJson.expo.autolinking.android.buildFromSource.filter(
            (name) => name !== 'unimodules-app-loader',
          );
      },
      error: 'must build unimodules-app-loader from source exactly once',
    },
    {
      label: 'loader resolution pin',
      mutate(input) {
        input.packageLock.packages['node_modules/unimodules-app-loader'].version = '57.0.0';
      },
      error: 'must resolve unimodules-app-loader 57.0.2',
    },
    {
      label: 'headless manager retained after context destruction',
      mutate(input) {
        input.serviceSource = input.serviceSource.replace(
          'sHeadlessTaskManagers.remove(appScopeKey);',
          '',
        );
      },
      error: 'must remove both managers at context destruction',
    },
    {
      label: 'headless manager removed before context destruction',
      mutate(input) {
        input.serviceSource = input.serviceSource.replace(
          'appLoader.invalidateApp(appScopeKey);',
          'appLoader.invalidateApp(appScopeKey); sHeadlessTaskManagers.remove(appScopeKey);',
        );
      },
      error: 'must remove both managers at context destruction',
    },
    {
      label: 'patch source scope',
      mutate(input) {
        input.patchSource +=
          '\ndiff --git a/node_modules/expo-task-manager/android/build/generated.txt b/node_modules/expo-task-manager/android/build/generated.txt\n';
      },
      error: 'must patch only the ten reviewed source/test files',
    },
    {
      label: 'source keeper finishes early',
      mutate(input) {
        input.taskManagerSource = input.taskManagerSource.replace(
          '() => () => new Promise<void>(() => {})',
          '() => async () => {}',
        );
      },
      error: 'must retain one Android timer keeper until native completion',
    },
    {
      label: 'shipped runtime keeper finishes early',
      mutate(input) {
        input.taskManagerRuntimeSource = input.taskManagerRuntimeSource.replace(
          '() => () => new Promise(() => {})',
          '() => async () => {}',
        );
      },
      error: 'must retain one Android timer keeper until native completion',
    },
    {
      label: 'runtime correction absent from durable patch',
      mutate(input) {
        input.patchSource = input.patchSource.replace(
          '() => () => new Promise(() => {})',
          '() => async () => {}',
        );
      },
      error: 'must retain one Android timer keeper until native completion',
    },
    {
      label: 'commented-out keeper',
      mutate(input) {
        input.taskManagerSource = `/* ${input.taskManagerSource} */`;
      },
      error: 'must retain one Android timer keeper until native completion',
    },
    {
      label: 'truncated installed keeper block',
      mutate(input) {
        input.taskManagerSource = input.taskManagerSource.trimEnd().slice(0, -1);
      },
      error: 'must retain one Android timer keeper until native completion',
    },
    {
      label: 'durable patch',
      mutate(input) {
        input.patchSource = input.patchSource.replace(
          '+      if (pendingBody != null && !mTasksAndEventsRepository.removeEventForAppScopeKey(appScopeKey, pendingBody)) {',
          '',
        );
      },
      error: 'must carry the reviewed pre-JavaScript settlement repair',
    },
    {
      label: 'null task callback',
      mutate(input) {
        input.utilsSource = input.utilsSource.replace(
          'callback.onFinished(Collections.emptyMap());',
          'return;',
        );
      },
      error: 'must settle null-task callbacks',
    },
    {
      label: 'manager handoff lock',
      mutate(input) {
        input.serviceSource = input.serviceSource.replace(
          '  synchronized (sTaskExecutionLock) {\n    taskManagers.put',
          '  if (true) {\n    taskManagers.put',
        );
      },
      error: 'must preserve locked one-owner handoff',
    },
    {
      label: 'detach before dispatch',
      mutate(input) {
        input.serviceSource = input.serviceSource.replace(
          '    mTasksAndEventsRepository.removeEvents(appScopeKey);',
          '    // queue remains shared',
        );
      },
      error: 'must preserve locked one-owner handoff',
    },
    {
      label: 'already-running settlement',
      mutate(input) {
        input.serviceSource = input.serviceSource.replace(
          'Headless app is already running without a task manager; completing pending task with failure.',
          'Headless app is already running.',
        );
      },
      error: 'must preserve locked one-owner handoff',
    },
    {
      label: 'loader guard before listener registration',
      mutate(input) {
        input.serviceSource = input.serviceSource.replace(
          'if (appLoader == null || context == null)',
          'if (false)',
        );
      },
      error: 'must preserve locked one-owner handoff',
    },
    {
      label: 'generation-keyed task id',
      mutate(input) {
        input.serviceSource = input.serviceSource.replace(
          'sHeadlessTaskOwners.put(headlessStartToken, new HeadlessTaskOwner(headlessContext, taskId));',
          'sHeadlessTaskIds.put(appScopeKey, taskId);',
        );
      },
      error: 'must preserve locked one-owner handoff',
    },
    {
      label: 'task unregistration',
      mutate(input) {
        input.serviceSource = input.serviceSource.replace(
          'finishPendingTaskExecutionWithFailure(appScopeKey, eventId, body);',
          'unregisterAllTasksForAppScopeKey(appScopeKey);',
        );
      },
      error: 'must preserve locked one-owner handoff',
    },
    {
      label: 'false success',
      mutate(input) {
        input.serviceSource = input.serviceSource.replace(
          'response.put("eventId", eventId);',
          'response.put("result", 1);',
        );
      },
      error: 'must preserve locked one-owner handoff',
    },
    {
      label: 'exact queued event removal',
      mutate(input) {
        input.bareRepositorySource = input.bareRepositorySource.replace(
          'if (events == null || !events.remove(body))',
          'if (events == null)',
        );
      },
      error: 'must remove the exact still-queued event',
    },
  ];

  for (const { label, mutate, error } of mutations) {
    const input = taskManagerSettlementInput();
    mutate(input);
    assert.ok(
      validateExpoTaskManagerPreJsSettlement(input).some((message) => message.includes(error)),
      `${label} must fail closed`,
    );
  }
});

test('injects and retains the fail-closed Android WebSocket redirect policy', () => {
  const source = `package com.example

import android.app.Application
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative

class MainApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
`;
  const transformed = applyWebSocketRedirectPolicy(source, 'kt');

  for (const marker of [
    'import com.facebook.react.modules.websocket.WebSocketModule',
    'WebSocketModule.setCustomClientBuilder { builder ->',
    'builder.followRedirects(false)',
    'builder.followSslRedirects(false)',
  ]) {
    assert.equal(transformed.split(marker).length - 1, 1, marker);
  }
  assert.ok(
    transformed.indexOf('WebSocketModule.setCustomClientBuilder') <
      transformed.indexOf('loadReactNative(this)'),
  );
  assert.equal(applyWebSocketRedirectPolicy(transformed, 'kt'), transformed);
  assert.throws(
    () =>
      applyWebSocketRedirectPolicy(
        transformed.replace('      builder.followSslRedirects(false)\n', ''),
        'kt',
      ),
    /partial, duplicate, or late policy/,
  );
  assert.throws(
    () =>
      applyWebSocketRedirectPolicy(
        transformed.replace(
          '    loadReactNative(this)',
          '    WebSocketModule.setCustomClientBuilder(null)\n    loadReactNative(this)',
        ),
        'kt',
      ),
    /partial, duplicate, or late policy/,
  );
  assert.throws(() => applyWebSocketRedirectPolicy(source, 'java'), /only Kotlin/);

  const appConfig = readFileSync(join(ROOT, 'app.config.ts'), 'utf8');
  const registration = "'./plugins/withNoWebSocketRedirects'";
  assert.equal(appConfig.split(registration).length - 1, 1);
  const pluginListStart = appConfig.indexOf('  plugins: [');
  const registrationIndex = appConfig.indexOf(registration, pluginListStart);
  assert.ok(pluginListStart >= 0 && registrationIndex > pluginListStart);
  assert.doesNotMatch(appConfig.slice(pluginListStart, registrationIndex), /^    (?:'|\[)/m);
});

test('rejects drift anywhere in the Expo file-system redirect containment chain', () => {
  const mutations = [
    {
      label: 'dependency pin',
      mutate(input) {
        input.packageJson.dependencies['expo-file-system'] = '~57.0.7';
      },
      error: 'expo-file-system must be pinned exactly',
    },
    {
      label: 'lockfile resolution',
      mutate(input) {
        input.packageLock.packages['node_modules/expo-file-system'].version = '57.0.6';
      },
      error: 'package-lock must resolve expo-file-system',
    },
    {
      label: 'lockfile root dependency pin',
      mutate(input) {
        input.packageLock.packages[''].dependencies['expo-file-system'] = '~57.0.7';
      },
      error: 'package-lock root must pin expo-file-system exactly',
    },
    {
      label: 'patch-package pin',
      mutate(input) {
        input.packageJson.devDependencies['patch-package'] = '^8.0.1';
      },
      error: 'patch-package must be pinned exactly',
    },
    {
      label: 'lockfile patch-package resolution',
      mutate(input) {
        input.packageLock.packages['node_modules/patch-package'].version = '8.0.0';
      },
      error: 'package-lock must resolve patch-package',
    },
    {
      label: 'postinstall hook',
      mutate(input) {
        input.packageJson.scripts.postinstall = 'node scripts/noop.mjs';
      },
      error: 'postinstall must run patch-package --error-on-fail',
    },
    {
      label: 'postinstall hook that tolerates a failed patch',
      mutate(input) {
        input.packageJson.scripts.postinstall = 'patch-package';
      },
      error: 'postinstall must run patch-package --error-on-fail',
    },
    {
      label: 'source-build selection',
      mutate(input) {
        input.packageJson.expo.autolinking.android.buildFromSource = [];
      },
      error: 'must build expo-file-system from source exactly once',
    },
    {
      label: 'duplicate source-build selection',
      mutate(input) {
        input.packageJson.expo.autolinking.android.buildFromSource.push('expo-file-system');
      },
      error: 'must build expo-file-system from source exactly once',
    },
    {
      label: 'runtime redirect flag',
      mutate(input) {
        input.legacyModuleSource = input.legacyModuleSource.replace(
          '  .followRedirects(false)\n',
          '',
        );
      },
      error: 'must disable redirects exactly once',
    },
    {
      label: 'runtime SSL redirect flag',
      mutate(input) {
        input.legacyModuleSource = input.legacyModuleSource.replace(
          '  .followSslRedirects(false)\n',
          '',
        );
      },
      error: 'must disable SSL redirects exactly once',
    },
    {
      label: 'package patch',
      mutate(input) {
        input.patchSource = input.patchSource.replace('+          .followRedirects(false)\n', '');
      },
      error: 'must carry both legacy OkHttp redirect flags',
    },
    {
      label: 'native redirect trap proof',
      mutate(input) {
        input.patchSource = input.patchSource.replace(
          '+      assertEquals(0, trap.requestCount)\n',
          '',
        );
      },
      error: 'must carry the redirect trap, progress, and cancellation native proof',
    },
    {
      label: 'React Native fetch escape hatch',
      mutate(input) {
        input.appConfigSource = '';
      },
      error: 'must reject the EXPO_PUBLIC_USE_RN_FETCH',
    },
  ];

  for (const { label, mutate, error } of mutations) {
    const input = redirectContainmentInput();
    mutate(input);
    assert.ok(
      validateExpoFileSystemRedirectContainment(input).some((message) => message.includes(error)),
      `${label} must fail closed`,
    );
  }
});

test('validates the headless entry order without generated Android artifacts', () => {
  assert.deepEqual(validateHeadlessEntry({ packageJson: { main: 'index.js' }, entrySource }), []);
  assert.ok(
    validateHeadlessEntry({
      packageJson: { main: 'index.js' },
      entrySource: `import { secret } from './private';\n${entrySource}`,
    }).some((error) => error.includes('only ordered side-effect imports')),
  );
  assert.match(
    validateHeadlessEntry({
      packageJson: { main: 'index.js' },
      entrySource: `import 'expo-router/entry';\nimport './src/services/notifications/registerFcmBackgroundHandler';`,
    }).join('\n'),
    /expo-router\/entry must be the final side-effect import/,
  );
});

test('requires every intended sensitive and product permission', () => {
  for (const permission of REQUIRED_PERMISSIONS) {
    const errors = validate({
      manifest: manifest.replace(`<uses-permission android:name="${permission}" />`, ''),
    });
    assert.ok(
      errors.some((error) => error.includes(permission)),
      permission,
    );
  }
});

test('rejects a required permission when every declaration is capped to an older Android SDK', () => {
  const permission = 'android.permission.CAMERA';
  const cappedDeclaration = `<uses-permission android:name="${permission}" android:maxSdkVersion="32" />`;
  const errors = validate({
    manifest: manifest.replace(
      `<uses-permission android:name="${permission}" />`,
      cappedDeclaration,
    ),
  });
  assert.ok(
    errors.some(
      (error) => error === `required permission is capped by android:maxSdkVersion: ${permission}`,
    ),
  );

  const cappedManifestNode = structuredClone(manifestNode);
  const permissionNode = cappedManifestNode.children.find(
    (child) => child.attributes['android:name'] === permission,
  );
  assert.ok(permissionNode);
  permissionNode.attributes['android:maxSdkVersion'] = '32';
  const packagedErrors = validatePackagedAndroidBundle({
    manifestProto: encodeXmlDocument(cappedManifestNode),
  });
  assert.ok(
    packagedErrors.some((error) =>
      error.includes(`required permission is capped by android:maxSdkVersion: ${permission}`),
    ),
  );
});

test('rejects every forbidden permission', () => {
  for (const permission of FORBIDDEN_PERMISSIONS) {
    const errors = validate({
      manifest: manifest.replace(
        '</manifest>',
        `<uses-permission android:name="${permission}" /></manifest>`,
      ),
    });
    assert.ok(
      errors.some((error) => error.includes(permission)),
      permission,
    );
  }

  const debugOverlay = validate({
    debug: true,
    manifest: manifest.replace(
      '</manifest>',
      '<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" /></manifest>',
    ),
  });
  assert.ok(
    !debugOverlay.some((error) => error.includes('android.permission.SYSTEM_ALERT_WINDOW')),
  );
});

test('rejects backup enablement or an unsafe native component declaration', () => {
  const backupErrors = validate({
    manifest: manifest.replace('allowBackup="false"', 'allowBackup="true"'),
  });
  assert.ok(backupErrors.some((error) => error.includes('allowBackup')));

  const headlessErrors = validate({
    manifest: manifest.replace(
      'ReactNativeFirebaseMessagingHeadlessService" android:exported="false"',
      'ReactNativeFirebaseMessagingHeadlessService" android:exported="true"',
    ),
  });
  assert.ok(headlessErrors.some((error) => error.includes('android:exported="false"')));
});

test('requires exactly one valid Google Maps key in merged and packaged manifests', () => {
  const metadata = renderXml(
    xmlNode('meta-data', {
      'android:name': GOOGLE_MAPS_API_KEY_METADATA_NAME,
      'android:value': mapsApiKeyFixture,
    }),
  );
  const missing = manifest.replace(metadata, '');
  assert.ok(
    validate({ manifest: missing }).some((error) =>
      error.includes('exactly one Google Maps API key'),
    ),
  );

  const duplicate = manifest.replace('</application>', `${metadata}</application>`);
  assert.ok(
    validate({ manifest: duplicate }).some((error) =>
      error.includes('exactly one Google Maps API key'),
    ),
  );

  const placeholder = manifest.replace(mapsApiKeyFixture, 'YOUR_API_KEY_PLACEHOLDER');
  assert.ok(
    validate({ manifest: placeholder }).some((error) => error.includes('valid Google API key')),
  );

  const packagedNode = structuredClone(manifestNode);
  const application = packagedNode.children.find((child) => child.name === 'application');
  const mapsMetadata = application?.children.find(
    (child) => child.attributes['android:name'] === GOOGLE_MAPS_API_KEY_METADATA_NAME,
  );
  assert.ok(mapsMetadata);
  mapsMetadata.attributes['android:value'] = 'fixture-key';
  assert.ok(
    validatePackagedAndroidBundle({ manifestProto: encodeXmlDocument(packagedNode) }).some(
      (error) => error.includes('valid Google API key'),
    ),
  );
});

test('does not accept component names in comments or on the wrong XML element', () => {
  const component =
    '<service android:name="app.notifee.core.ReceiverService" android:exported="false" />';
  const commentedErrors = validate({
    manifest: manifest.replace(component, `<!-- ${component} -->`),
  });
  assert.ok(commentedErrors.some((error) => error.includes('ReceiverService')));

  const wrongElementErrors = validate({
    manifest: manifest.replace(
      component,
      '<meta-data android:name="app.notifee.core.ReceiverService" android:value="false" />',
    ),
  });
  assert.ok(wrongElementErrors.some((error) => error.includes('<service>')));
});

test('requires the notify-kit notification tap activity to stay private', () => {
  const activity =
    '<activity android:name="app.notifee.core.NotificationReceiverActivity" android:exported="false" />';
  assert.ok(manifest.includes(activity), 'the fixture must declare the private activity');

  const exported = validate({
    manifest: manifest.replace(
      activity,
      activity.replace('android:exported="false"', 'android:exported="true"'),
    ),
  });
  assert.ok(
    exported.some((error) =>
      error.includes('NotificationReceiverActivity must set android:exported="false"'),
    ),
  );

  const missing = validate({ manifest: manifest.replace(activity, '') });
  assert.ok(
    missing.some((error) =>
      error.includes('missing <activity> app.notifee.core.NotificationReceiverActivity'),
    ),
  );
});

test('requires Expo Location service to remain non-exported and location-scoped', () => {
  const service =
    '<service android:name="expo.modules.location.services.LocationTaskService" android:exported="false" android:foregroundServiceType="location" />';
  const exported = validate({
    manifest: manifest.replace(
      service,
      service.replace('android:exported="false"', 'android:exported="true"'),
    ),
  });
  assert.ok(
    exported.some((error) =>
      error.includes('LocationTaskService must set android:exported="false"'),
    ),
  );

  const unscoped = validate({
    manifest: manifest.replace(
      service,
      service.replace(
        'android:foregroundServiceType="location"',
        'android:foregroundServiceType="dataSync"',
      ),
    ),
  });
  assert.ok(
    unscoped.some((error) =>
      error.includes('LocationTaskService must set android:foregroundServiceType="location"'),
    ),
  );
});

test('requires exact owned inbound share filters and Direct Share metadata', () => {
  assert.deepEqual(validate(), []);

  for (const action of ['android.intent.action.SEND', 'android.intent.action.SEND_MULTIPLE']) {
    const errors = validate({
      manifest: manifest.replace(
        renderXml(intentFilter(action, 'android.intent.category.DEFAULT', '*/*')),
        '',
      ),
    });
    assert.ok(
      errors.some((error) => error.includes(`must declare inbound ${action} exactly once`)),
      action,
    );
  }

  const alias = renderXml(
    xmlNode('activity-alias', { 'android:name': '.ShareAlias' }, [
      intentFilter('android.intent.action.SEND', 'android.intent.category.DEFAULT', '*/*'),
    ]),
  );
  const aliasErrors = validate({
    manifest: manifest.replace('</application>', `${alias}</application>`),
  });
  assert.ok(
    aliasErrors.some((error) => error.includes('.ShareAlias must not declare owned inbound')),
  );

  const wrongMime = validate({
    manifest: manifest.replace(
      renderXml(
        intentFilter('android.intent.action.SEND', 'android.intent.category.DEFAULT', '*/*'),
      ),
      renderXml(
        intentFilter('android.intent.action.SEND', 'android.intent.category.DEFAULT', 'image/*'),
      ),
    ),
  });
  assert.ok(wrongMime.some((error) => error.includes('must contain only its action')));

  const missingMetadata = validate({
    manifest: manifest.replace(
      '<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />',
      '',
    ),
  });
  assert.ok(
    missingMetadata.some((error) =>
      error.includes('must declare android.app.shortcuts meta-data exactly once'),
    ),
  );

  const wrongMetadata = validate({
    manifest: manifest.replace('@xml/shortcuts', '@xml/not_shortcuts'),
  });
  assert.ok(wrongMetadata.some((error) => error.includes('must reference "@xml/shortcuts"')));
});

test('requires owned MainActivity share capture before ReactActivity sees either intent', () => {
  assert.deepEqual(validateShareIntakeMainActivity(shareMainActivitySource), []);

  const lateCreate = shareMainActivitySource
    .replace(
      'expo.modules.gatorshareintake.GatorShareIntakeActivityBridge.captureOnCreate(this, intent, savedInstanceState)',
      '',
    )
    .replace(
      'super.onCreate(null)',
      'super.onCreate(null)\n    expo.modules.gatorshareintake.GatorShareIntakeActivityBridge.captureOnCreate(this, intent, savedInstanceState)',
    );
  assert.ok(
    validateShareIntakeMainActivity(lateCreate).some((error) =>
      error.includes('capture the owned share before super.onCreate'),
    ),
  );

  const workBeforeCapture = shareMainActivitySource.replace(
    'override fun onNewIntent(intent: android.content.Intent) {',
    'override fun onNewIntent(intent: android.content.Intent) {\n    inspectIntent(intent)',
  );
  assert.ok(
    validateShareIntakeMainActivity(workBeforeCapture).some((error) =>
      error.includes('onNewIntent owned share capture must be its first statement'),
    ),
  );

  const duplicate = shareMainActivitySource.replace(
    'super.onNewIntent(intent)',
    'expo.modules.gatorshareintake.GatorShareIntakeActivityBridge.captureOnNewIntent(this, intent)\n    super.onNewIntent(intent)',
  );
  assert.ok(
    validateShareIntakeMainActivity(duplicate).some((error) =>
      error.includes('onNewIntent must call the owned share capture exactly once'),
    ),
  );
});

test('rejects a bypassed or late expo-router bundle entry', () => {
  const wrongMain = validate({ packageJson: { main: 'expo-router/entry' } });
  assert.ok(wrongMain.some((error) => error.includes('package.json main')));

  const missingRestartCleanup = validate({
    entrySource: entrySource.replace(
      "import './src/services/download/registerBoundedNativeDownloadCleanup';\n",
      '',
    ),
  });
  assert.ok(
    missingRestartCleanup.some((error) =>
      error.includes(
        'required startup import ./src/services/download/registerBoundedNativeDownloadCleanup',
      ),
    ),
  );

  const latePrivacyBoundary = validate({
    entrySource: entrySource
      .replace("import './src/services/errors/registerReactNativeExceptionPrivacy';\n", '')
      .replace(
        "import './src/services/notifications/backgroundEvents';\n",
        "import './src/services/notifications/backgroundEvents';\nimport './src/services/errors/registerReactNativeExceptionPrivacy';\n",
      ),
  });
  assert.ok(
    latePrivacyBoundary.some((error) => error.includes('must be the first index.js side-effect')),
  );

  const latePersistentLogs = validate({
    entrySource: entrySource
      .replace("import './src/services/logging/registerPersistentLogs';\n", '')
      .replace(
        "import './src/services/notifications/backgroundEvents';\n",
        "import './src/services/notifications/backgroundEvents';\nimport './src/services/logging/registerPersistentLogs';\n",
      ),
  });
  assert.ok(latePersistentLogs.some((error) => error.includes('before headless tasks')));

  const lateRegistration = validate({
    entrySource: `import 'expo-router/entry';\nimport './src/services/notifications/registerFcmBackgroundHandler';`,
  });
  assert.ok(lateRegistration.some((error) => error.includes('final side-effect import')));
  assert.ok(lateRegistration.some((error) => error.includes('must load before')));
});

test('validates the packaged manifest, owned share target, and native intake markers', () => {
  const manifestProto = encodeXmlDocument(manifestNode);
  const networkSecurityConfigProto = encodeXmlDocument(systemCaNetworkSecurityConfigNode);
  const shortcutsProto = encodeXmlDocument(ownedShareTargetNode());
  assert.deepEqual(
    validatePackagedAndroidBundle({
      manifestProto,
      networkSecurityConfigProto,
      shortcutsProto,
      dexBytes: cleanupDexFixture(),
    }),
    [],
  );

  const userCaPolicy = structuredClone(systemCaNetworkSecurityConfigNode);
  userCaPolicy.children[0].children[0].children[0].attributes.src = 'user';
  assert.ok(
    validatePackagedAndroidBundle({
      manifestProto,
      networkSecurityConfigProto: encodeXmlDocument(userCaPolicy),
    }).some((error) => error.includes('only Android system CAs')),
  );
  const namespaceCollisionPolicy = structuredClone(systemCaNetworkSecurityConfigNode);
  namespaceCollisionPolicy.children[0].children[0].children[0].attributes = {};
  namespaceCollisionPolicy.children[0].children[0].children[0].attributeEntries = [
    ['src', 'user', ''],
    ['src', 'system', 'urn:gator:attacker'],
  ];
  assert.ok(
    validatePackagedAndroidBundle({
      manifestProto,
      networkSecurityConfigProto: encodeXmlDocument(namespaceCollisionPolicy),
    }).some((error) => error.includes('only Android system CAs')),
  );
  const compiledCaPolicy = structuredClone(systemCaNetworkSecurityConfigNode);
  compiledCaPolicy.children[0].children[0].children[0].attributes = {};
  compiledCaPolicy.children[0].children[0].children[0].attributeEntries = [
    [
      'src',
      'system',
      '',
      encodeMessageField(1, encodeScalarField(2, networkSecurityConfigResourceId + 1)),
    ],
  ];
  assert.ok(
    validatePackagedAndroidBundle({
      manifestProto,
      networkSecurityConfigProto: encodeXmlDocument(compiledCaPolicy),
    }).some((error) => error.includes('must be a literal, uncompiled value')),
  );

  const userCaProto = encodeXmlDocument(userCaPolicy);
  assert.ok(
    validatePackagedAndroidBundle({
      manifestProto,
      networkSecurityConfigProto: Buffer.concat([networkSecurityConfigProto, userCaProto]),
    }).some((error) => error.includes('exactly one element or text value')),
  );

  const competingManifest = structuredClone(manifestNode);
  const competingApplication = competingManifest.children.find(
    (node) => node.name === 'application',
  );
  competingApplication.attributeEntries = Object.entries(competingApplication.attributes).map(
    ([name, value]) =>
      name === 'android:networkSecurityConfig'
        ? [
            name,
            value,
            undefined,
            Buffer.concat([
              encodeMessageField(1, encodeScalarField(2, networkSecurityConfigResourceId)),
              encodeMessageField(2, Buffer.alloc(0)),
            ]),
          ]
        : [name, value, undefined],
  );
  assert.ok(
    validatePackagedAndroidBundle({
      manifestProto: encodeXmlDocument(competingManifest),
      networkSecurityConfigProto,
    }).some((error) => error.includes('compiled item must have exactly one value')),
  );
  assert.ok(
    validatePackagedAndroidBundle({ manifestProto }).some((error) =>
      error.includes('network security config protobuf is missing'),
    ),
  );

  for (const marker of REQUIRED_PINNED_SHORTCUT_CLEANUP_DEX_MARKERS) {
    const missingCleanup = validatePackagedAndroidBundle({
      manifestProto,
      dexBytes: cleanupDexFixture({ omitRequiredMarker: marker }),
    });
    assert.ok(
      missingCleanup.includes(
        `packaged DEX is missing required pinned-shortcut cleanup marker: ${marker}`,
      ),
      marker,
    );
  }

  for (const marker of REQUIRED_BACKGROUND_TASK_RETRY_DEX_MARKERS) {
    const missingRetryBridge = validatePackagedAndroidBundle({
      manifestProto,
      dexBytes: cleanupDexFixture({ omitRequiredMarker: marker }),
    });
    assert.ok(
      missingRetryBridge.includes(
        `packaged DEX is missing required background-task retry marker: ${marker}`,
      ),
      marker,
    );
  }

  for (const marker of REQUIRED_TASK_MANAGER_SETTLEMENT_DEX_MARKERS) {
    const missingSettlement = validatePackagedAndroidBundle({
      manifestProto,
      dexBytes: cleanupDexFixture({ omitRequiredMarker: marker }),
    });
    assert.ok(
      missingSettlement.includes(
        `packaged DEX is missing required task-manager settlement marker: ${marker}`,
      ),
      marker,
    );
  }

  for (const marker of REQUIRED_UPLOAD_FILENAME_DEX_MARKERS) {
    const errors = validatePackagedAndroidBundle({
      manifestProto,
      dexBytes: cleanupDexFixture({ omitRequiredMarker: marker }),
    });
    assert.ok(
      errors.includes(`packaged DEX is missing required upload-filename marker: ${marker}`),
    );
  }

  for (const marker of REQUIRED_SHARE_INTAKE_DEX_MARKERS) {
    const missingOwnedIntake = validatePackagedAndroidBundle({
      manifestProto,
      shortcutsProto,
      dexBytes: cleanupDexFixture({ omitRequiredMarker: marker }),
    });
    assert.ok(
      missingOwnedIntake.includes(
        `packaged DEX is missing required owned-share intake marker: ${marker}`,
      ),
      marker,
    );
  }

  for (const marker of FORBIDDEN_LEGACY_SHORTCUT_PUBLISHER_DEX_MARKERS) {
    const legacyPublisher = validatePackagedAndroidBundle({
      manifestProto,
      dexBytes: cleanupDexFixture({ extraMarkers: [marker] }),
    });
    assert.ok(
      legacyPublisher.includes(
        `packaged DEX contains forbidden legacy shortcut-publishing marker: ${marker}`,
      ),
      marker,
    );
  }

  const wrongTarget = structuredClone(ownedShareTargetNode());
  wrongTarget.children[0].attributes['android:targetClass'] = '.MainActivity';
  const invalidTarget = validatePackagedAndroidBundle({
    manifestProto,
    shortcutsProto: encodeXmlDocument(wrongTarget),
  });
  assert.ok(invalidTarget.some((error) => error.includes('must target')));

  assert.ok(
    validatePackagedAndroidBundle({ manifestProto }).some((error) =>
      error.includes('packaged owned shortcuts.xml is missing'),
    ),
  );

  const forbiddenNativeModule = validatePackagedAndroidBundle({
    manifestProto,
    dexBytes: cleanupDexFixture({
      extraMarkers: ['Lexpo/modules/shareintent/ExpoShareIntentModule;'],
    }),
  });
  assert.ok(
    forbiddenNativeModule.some((error) => error.includes('disabled inbound-share native marker')),
  );

  const invalidShortcuts = validatePackagedAndroidBundle({
    manifestProto,
    shortcutsProto: Buffer.from('not protobuf XML'),
  });
  assert.ok(invalidShortcuts.some((error) => error.includes('shortcuts.xml protobuf is invalid')));
});

test('rejects direct community WebView code without rejecting the supported Expo DOM bridge', () => {
  const manifestProto = encodeXmlDocument(manifestNode);

  for (const marker of FORBIDDEN_COMMUNITY_WEBVIEW_DEX_MARKERS) {
    const errors = validatePackagedAndroidBundle({
      manifestProto,
      dexBytes: cleanupDexFixture({ extraMarkers: [marker] }),
    });
    assert.ok(
      errors.includes(`packaged DEX contains forbidden direct community WebView marker: ${marker}`),
      marker,
    );
  }

  assert.deepEqual(
    validatePackagedAndroidBundle({
      manifestProto,
      networkSecurityConfigProto: encodeXmlDocument(systemCaNetworkSecurityConfigNode),
      shortcutsProto: encodeXmlDocument(ownedShareTargetNode()),
      dexBytes: cleanupDexFixture({
        extraMarkers: ['Lexpo/modules/webview/DomWebViewModule;'],
      }),
    }),
    [],
  );
});

function writeTestAab(
  root,
  relativePath,
  {
    includeForbiddenShareTarget = false,
    includeForbiddenNativeModule = false,
    communityWebViewMarker,
    legacyPublisherMarker,
    omitRequiredCleanupMarker,
    absoluteUserPath,
    sensitiveArchiveEntry,
    sensitiveArchiveContents,
    omitNetworkSecurityConfig = false,
    useUserCaNetworkSecurityConfig = false,
    omitResourcesTable = false,
    networkSecurityConfigResourcePath = 'res/xml/network_security_config.xml',
    repeatedNetworkSecurityConfigResourcePath,
    networkSecurityConfigAliasResourceId,
    activeNetworkSecurityConfigValues = 1,
    qualifiedNetworkSecurityConfig = false,
    includeDisabledNetworkSecurityConfig = false,
  } = {},
) {
  const staging = join(root, 'bundle-staging');
  const absolutePath = join(root, relativePath);
  rmSync(staging, { recursive: true, force: true });
  rmSync(absolutePath, { force: true });
  mkdirSync(join(staging, 'base', 'manifest'), { recursive: true });
  mkdirSync(join(staging, 'base', 'dex'), { recursive: true });
  mkdirSync(join(staging, 'base', 'assets'), { recursive: true });
  writeFileSync(
    join(staging, 'base', 'manifest', 'AndroidManifest.xml'),
    encodeXmlDocument(manifestNode),
  );
  if (!omitResourcesTable) {
    writeFileSync(
      join(staging, 'base', 'resources.pb'),
      encodeNetworkSecurityResourceTable({
        path: networkSecurityConfigResourcePath,
        repeatedPath: repeatedNetworkSecurityConfigResourcePath,
        aliasResourceId: networkSecurityConfigAliasResourceId,
        activeValues: activeNetworkSecurityConfigValues,
        qualified: qualifiedNetworkSecurityConfig,
        includeDisabledValue: includeDisabledNetworkSecurityConfig,
      }),
    );
  }
  if (!omitNetworkSecurityConfig) {
    const networkPolicy = structuredClone(systemCaNetworkSecurityConfigNode);
    if (useUserCaNetworkSecurityConfig) {
      networkPolicy.children[0].children[0].children[0].attributes.src = 'user';
    }
    const networkSecurityConfigPath = join(staging, 'base', networkSecurityConfigResourcePath);
    mkdirSync(dirname(networkSecurityConfigPath), { recursive: true });
    writeFileSync(networkSecurityConfigPath, encodeXmlDocument(networkPolicy));
  }
  writeFileSync(
    join(staging, 'base', 'dex', 'classes.dex'),
    cleanupDexFixture({
      omitRequiredMarker: omitRequiredCleanupMarker,
      extraMarkers: [
        ...(includeForbiddenNativeModule
          ? ['Lexpo/modules/shareintent/ExpoShareIntentModule;']
          : []),
        ...(communityWebViewMarker ? [communityWebViewMarker] : []),
        ...(legacyPublisherMarker ? [legacyPublisherMarker] : []),
      ],
    }),
  );
  writeFileSync(
    join(staging, 'base', 'assets', 'app.config'),
    JSON.stringify({
      android: {
        googleServicesFile: absoluteUserPath ?? './.gator-release/google-services.json',
      },
    }),
  );
  if (sensitiveArchiveEntry) {
    const sensitivePath = join(staging, sensitiveArchiveEntry);
    mkdirSync(dirname(sensitivePath), { recursive: true });
    writeFileSync(sensitivePath, sensitiveArchiveContents);
  }
  mkdirSync(join(staging, 'base', 'res', 'xml'), { recursive: true });
  const shareTarget = ownedShareTargetNode();
  if (includeForbiddenShareTarget) {
    shareTarget.children[0].attributes['android:targetClass'] = '.MainActivity';
  }
  writeFileSync(
    join(staging, 'base', 'res', 'xml', 'shortcuts.xml'),
    encodeXmlDocument(shareTarget),
  );
  const result = spawnSync('zip', ['-q', '-X', '-r', absolutePath, 'base'], {
    cwd: staging,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test('artifact runner inspects both variants and the final release AAB contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'gator-android-guard-'));
  const debugManifestPath = 'artifacts/debug.xml';
  const releaseManifestPath = 'artifacts/release.xml';
  const releaseBundlePath = 'artifacts/app-release.aab';
  const options = {
    root,
    debugManifestPath,
    releaseManifestPath,
    releaseBundlePath,
  };

  try {
    mkdirSync(join(root, 'artifacts'));
    writeRedirectContainmentFixture(root);
    writeFileSync(join(root, 'index.js'), entrySource);
    writeFileSync(join(root, debugManifestPath), manifest);
    writeFileSync(
      join(root, releaseManifestPath),
      manifest.replace('<uses-permission android:name="android.permission.CAMERA" />', ''),
    );
    writeFileSync(join(root, releaseBundlePath), '');

    assert.throws(() => runAndroidBuildCheck(options), /release manifest:.*CAMERA/s);

    writeFileSync(join(root, releaseManifestPath), manifest);
    assert.throws(() => runAndroidBuildCheck(options), /release AAB is missing or empty/);

    writeFileSync(join(root, releaseBundlePath), 'not a ZIP-formatted AAB');
    assert.throws(() => runAndroidBuildCheck(options), /release AAB inspection failed/);

    writeTestAab(root, releaseBundlePath);
    assert.doesNotThrow(() => runAndroidBuildCheck(options));

    const experimentalStackPath = join(
      root,
      'node_modules/expo-router/build/layouts/experimental-stack/ExperimentalStackView.js',
    );
    const experimentalStackSource = readFileSync(experimentalStackPath, 'utf8');
    writeFileSync(
      experimentalStackPath,
      experimentalStackSource.replaceAll(
        '...native_1.StackActions.pop(),',
        '...native_1.StackActions.push(),',
      ),
    );
    assert.throws(
      () => runAndroidBuildCheck(options),
      /predictive Back bridge:.*exact prevented pop action/s,
    );
    writeFileSync(experimentalStackPath, experimentalStackSource);

    const backgroundSchedulerPath = join(
      root,
      'node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskScheduler.kt',
    );
    const backgroundSchedulerSource = readFileSync(backgroundSchedulerPath, 'utf8');
    const missingRetryBranch = backgroundSchedulerSource.replace(
      /\s*if \(!succeeded\) \{\s*return false\s*\}/,
      '',
    );
    assert.notEqual(missingRetryBranch, backgroundSchedulerSource);
    writeFileSync(backgroundSchedulerPath, missingRetryBranch);
    assert.throws(
      () => runAndroidBuildCheck(options),
      /background task retry bridge:.*reviewed retry flow/s,
    );
    writeFileSync(backgroundSchedulerPath, backgroundSchedulerSource);

    assert.equal(
      inspectPackagedAndroidBundle(join(root, releaseBundlePath)).googleMapsApiKeySha256,
      createHash('sha256').update(mapsApiKeyFixture).digest('hex'),
    );

    writeTestAab(root, releaseBundlePath, { omitNetworkSecurityConfig: true });
    assert.throws(
      () => runAndroidBuildCheck(options),
      /expected exactly one resolved base\/res\/xml\/network_security_config\.xml/,
    );

    writeTestAab(root, releaseBundlePath, { useUserCaNetworkSecurityConfig: true });
    assert.throws(() => runAndroidBuildCheck(options), /only Android system CAs/);

    writeTestAab(root, releaseBundlePath, { omitResourcesTable: true });
    assert.throws(() => runAndroidBuildCheck(options), /expected exactly one base\/resources\.pb/);

    writeTestAab(root, releaseBundlePath, {
      networkSecurityConfigAliasResourceId: 0x7f16000a,
    });
    assert.throws(() => runAndroidBuildCheck(options), /resource aliases are forbidden/);

    writeTestAab(root, releaseBundlePath, { activeNetworkSecurityConfigValues: 2 });
    assert.throws(() => runAndroidBuildCheck(options), /exactly one active resource value/);

    writeTestAab(root, releaseBundlePath, { qualifiedNetworkSecurityConfig: true });
    assert.throws(
      () => runAndroidBuildCheck(options),
      /must not have a qualified resource variant/,
    );

    writeTestAab(root, releaseBundlePath, { includeDisabledNetworkSecurityConfig: true });
    assert.throws(() => runAndroidBuildCheck(options), /flag-disabled resource variants/);

    writeTestAab(root, releaseBundlePath, {
      networkSecurityConfigResourcePath: 'res/8G.xml',
    });
    assert.doesNotThrow(() => runAndroidBuildCheck(options));

    writeTestAab(root, releaseBundlePath, {
      repeatedNetworkSecurityConfigResourcePath: 'res/xml/attacker_selected.xml',
    });
    assert.throws(() => runAndroidBuildCheck(options), /protobuf field 1 is unexpectedly repeated/);

    const privateUsername = 'private-person';
    const privateRemainder = 'private-checkout';
    writeTestAab(root, releaseBundlePath, {
      absoluteUserPath: `/Users/${privateUsername}/${privateRemainder}/google-services.json`,
    });
    assert.throws(
      () => runAndroidBuildCheck(options),
      (error) => {
        assert.match(error.message, /base\/assets\/app\.config: absolute-user-directory/);
        assert.equal(error.message.includes(privateUsername), false);
        assert.equal(error.message.includes(privateRemainder), false);
        return true;
      },
    );

    const reviewedPath = 'base/lib/arm64-v8a/libfixture.so';
    const reviewedContents = Buffer.from('reviewed upstream path /home/runner/work/fixture');
    const reviewedException = {
      path: reviewedPath,
      rule: 'absolute-user-directory',
      sha256: createHash('sha256').update(reviewedContents).digest('hex'),
      review: 'example.invalid:fixture:1.0.0',
    };
    writeTestAab(root, releaseBundlePath, {
      sensitiveArchiveEntry: reviewedPath,
      sensitiveArchiveContents: reviewedContents,
    });
    assert.throws(
      () =>
        inspectPackagedAndroidBundle(join(root, releaseBundlePath), {
          reviewedSensitiveMetadataExceptions: [],
        }),
      /absolute-user-directory/,
    );
    assert.doesNotThrow(() =>
      inspectPackagedAndroidBundle(join(root, releaseBundlePath), {
        reviewedSensitiveMetadataExceptions: [reviewedException],
      }),
    );

    writeTestAab(root, releaseBundlePath, {
      omitRequiredCleanupMarker: REQUIRED_PINNED_SHORTCUT_CLEANUP_DEX_MARKERS[0],
    });
    assert.throws(
      () => runAndroidBuildCheck(options),
      /packaged DEX is missing required pinned-shortcut cleanup marker/,
    );

    writeTestAab(root, releaseBundlePath, {
      legacyPublisherMarker: FORBIDDEN_LEGACY_SHORTCUT_PUBLISHER_DEX_MARKERS[0],
    });
    assert.throws(
      () => runAndroidBuildCheck(options),
      /packaged DEX contains forbidden legacy shortcut-publishing marker/,
    );

    writeTestAab(root, releaseBundlePath, {
      communityWebViewMarker: FORBIDDEN_COMMUNITY_WEBVIEW_DEX_MARKERS[0],
    });
    assert.throws(
      () => runAndroidBuildCheck(options),
      /packaged DEX contains forbidden direct community WebView marker/,
    );

    writeTestAab(root, releaseBundlePath, { includeForbiddenShareTarget: true });
    assert.throws(() => runAndroidBuildCheck(options), /packaged share-target must target/);

    writeTestAab(root, releaseBundlePath, { includeForbiddenNativeModule: true });
    assert.throws(
      () => runAndroidBuildCheck(options),
      /packaged DEX contains disabled inbound-share native marker/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
