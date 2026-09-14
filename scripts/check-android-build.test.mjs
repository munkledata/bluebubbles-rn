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

import {
  FORBIDDEN_COMMUNITY_WEBVIEW_DEX_MARKERS,
  FORBIDDEN_LEGACY_SHORTCUT_PUBLISHER_DEX_MARKERS,
  FORBIDDEN_PERMISSIONS,
  inspectPackagedAndroidBundle,
  REQUIRED_PINNED_SHORTCUT_CLEANUP_DEX_MARKERS,
  REQUIRED_PERMISSIONS,
  runAndroidBuildCheck,
  validateAndroidBuild,
  validateExpoFileSystemRedirectContainment,
  validateHeadlessEntry,
  validatePackagedAndroidBundle,
} from './check-android-build.mjs';

const require = createRequire(import.meta.url);
const { applyWebSocketRedirectPolicy } = require('../plugins/withNoWebSocketRedirects');
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const androidNamespace = 'http://schemas.android.com/apk/res/android';
const intendedPermissions = [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.READ_CONTACTS',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.CAMERA',
];

function xmlNode(name, attributes = {}, children = []) {
  return { name, attributes, children };
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
    ...intendedPermissions.map((name) => xmlNode('uses-permission', { 'android:name': name })),
    // Package visibility for sharing OUT of Gator is harmless. It is not nested below an
    // application component, so it cannot make MainActivity an inbound Android share target.
    xmlNode('queries', {}, [
      xmlNode('intent', {}, [
        xmlNode('action', { 'android:name': 'android.intent.action.SEND' }),
        xmlNode('data', { 'android:mimeType': '*/*' }),
      ]),
    ]),
    xmlNode('application', { 'android:allowBackup': 'false' }, [
      xmlNode('activity', { 'android:name': '.MainActivity', 'android:exported': 'true' }, [
        intentFilter('android.intent.action.MAIN', 'android.intent.category.LAUNCHER'),
      ]),
      xmlNode('service', {
        'android:name': 'app.notifee.core.ReceiverService',
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
    ]),
  ],
);

function forbiddenShareTargetNode() {
  return xmlNode('shortcuts', {}, [
    xmlNode('share-target', { 'android:targetClass': '.MainActivity' }, [
      xmlNode('data', { 'android:mimeType': '*/*' }),
    ]),
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

function encodeStringField(number, value) {
  return encodeMessageField(number, Buffer.from(value, 'utf8'));
}

function encodeXmlAttribute(name, value) {
  const androidName = name.startsWith('android:') ? name.slice('android:'.length) : undefined;
  return Buffer.concat([
    ...(androidName ? [encodeStringField(1, androidNamespace)] : []),
    encodeStringField(2, androidName ?? name),
    encodeStringField(3, value),
  ]);
}

function encodeXmlDocument(node) {
  const element = Buffer.concat([
    encodeStringField(3, node.name),
    ...Object.entries(node.attributes)
      .filter(([name]) => name !== 'xmlns:android')
      .map(([name, value]) => encodeMessageField(4, encodeXmlAttribute(name, value))),
    ...node.children.map((child) => encodeMessageField(5, encodeXmlDocument(child))),
  ]);
  return encodeMessageField(1, element);
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

const redirectContainmentPackageJson = {
  main: 'index.js',
  scripts: { postinstall: 'patch-package' },
  dependencies: { 'expo-file-system': '57.0.6' },
  devDependencies: { 'patch-package': '8.0.1' },
  expo: { autolinking: { android: { buildFromSource: ['expo-file-system'] } } },
};
const redirectContainmentPackageLock = {
  packages: {
    '': {
      dependencies: { 'expo-file-system': '57.0.6' },
      devDependencies: { 'patch-package': '8.0.1' },
    },
    'node_modules/expo-file-system': { version: '57.0.6' },
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
`;

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
  writeFileSync(join(root, 'package.json'), JSON.stringify(input.packageJson));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(input.packageLock));
  writeFileSync(join(root, 'app.config.ts'), input.appConfigSource);
  writeFileSync(join(root, 'patches/expo-file-system+57.0.6.patch'), input.patchSource);
  writeFileSync(
    join(
      root,
      'node_modules/expo-file-system/android/src/main/java/expo/modules/filesystem/legacy/FileSystemLegacyModule.kt',
    ),
    input.legacyModuleSource,
  );
}

function cleanupDexFixture({ omitRequiredMarker, extraMarkers = [] } = {}) {
  return Buffer.from(
    [
      ...REQUIRED_PINNED_SHORTCUT_CLEANUP_DEX_MARKERS.filter(
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

test('accepts the pinned Expo file-system redirect containment chain', () => {
  assert.deepEqual(validateExpoFileSystemRedirectContainment(redirectContainmentInput()), []);
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
        input.packageJson.dependencies['expo-file-system'] = '~57.0.6';
      },
      error: 'expo-file-system must be pinned exactly',
    },
    {
      label: 'lockfile resolution',
      mutate(input) {
        input.packageLock.packages['node_modules/expo-file-system'].version = '57.0.7';
      },
      error: 'package-lock must resolve expo-file-system',
    },
    {
      label: 'lockfile root dependency pin',
      mutate(input) {
        input.packageLock.packages[''].dependencies['expo-file-system'] = '~57.0.6';
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
      error: 'postinstall must run patch-package',
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

test('allows outbound ACTION_SEND queries but rejects inbound component filters and metadata', () => {
  assert.deepEqual(validate(), []);

  for (const action of ['android.intent.action.SEND', 'android.intent.action.SEND_MULTIPLE']) {
    const inboundFilter = renderXml(intentFilter(action, 'android.intent.category.DEFAULT', '*/*'));
    const errors = validate({
      manifest: manifest.replace('</activity>', `${inboundFilter}</activity>`),
    });
    assert.ok(
      errors.some((error) => error.includes(`must not declare inbound ${action}`)),
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
  assert.ok(aliasErrors.some((error) => error.includes('.ShareAlias must not declare inbound')));

  const metadata = renderXml(
    xmlNode('meta-data', {
      'android:name': 'android.app.shortcuts',
      'android:resource': '@xml/shortcuts',
    }),
  );
  const metadataErrors = validate({
    manifest: manifest.replace('</activity>', `${metadata}</activity>`),
  });
  assert.ok(
    metadataErrors.some((error) => error.includes('must not declare android.app.shortcuts')),
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

test('validates the packaged protobuf manifest and rejects a Direct Share resource', () => {
  const manifestProto = encodeXmlDocument(manifestNode);
  assert.deepEqual(
    validatePackagedAndroidBundle({ manifestProto, dexBytes: cleanupDexFixture() }),
    [],
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

  const forbiddenTarget = validatePackagedAndroidBundle({
    manifestProto,
    shortcutsProto: encodeXmlDocument(forbiddenShareTargetNode()),
  });
  assert.ok(forbiddenTarget.some((error) => error.includes('must not contain <share-target>')));

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
  if (includeForbiddenShareTarget) {
    mkdirSync(join(staging, 'base', 'res', 'xml'), { recursive: true });
    writeFileSync(
      join(staging, 'base', 'res', 'xml', 'shortcuts.xml'),
      encodeXmlDocument(forbiddenShareTargetNode()),
    );
  }
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
    assert.throws(
      () => runAndroidBuildCheck(options),
      /packaged shortcuts.xml must not contain <share-target>/,
    );

    writeTestAab(root, releaseBundlePath, { includeForbiddenNativeModule: true });
    assert.throws(
      () => runAndroidBuildCheck(options),
      /packaged DEX contains disabled inbound-share native marker/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
